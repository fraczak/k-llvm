#include "krt.h"

#include <stdlib.h>
#include <string.h>

typedef enum {
  K_VALUE_UNIT,
  K_VALUE_PRODUCT,
  K_VALUE_VARIANT
} k_value_kind;

typedef struct {
  char *label;
  k_value *value;
} k_field;

struct k_value {
  k_value_kind kind;
  struct k_value *next;
  union {
    struct {
      size_t count;
      size_t capacity;
      k_field *fields;
    } product;
    struct {
      char *tag;
      k_value *payload;
    } variant;
  } as;
};

struct k_rt {
  k_value *values;
};

static char *k_strdup(const char *text) {
  size_t length = strlen(text);
  char *copy = malloc(length + 1);
  if (copy == NULL) abort();
  memcpy(copy, text, length + 1);
  return copy;
}

static k_value *alloc_value(k_rt *rt, k_value_kind kind) {
  if (rt == NULL) return NULL;
  k_value *value = calloc(1, sizeof(k_value));
  if (value == NULL) abort();
  value->kind = kind;
  value->next = rt->values;
  rt->values = value;
  return value;
}

k_rt *k_rt_new(void) {
  return calloc(1, sizeof(k_rt));
}

void k_rt_free(k_rt *rt) {
  if (rt == NULL) return;
  k_value *value = rt->values;
  while (value != NULL) {
    k_value *next = value->next;
    if (value->kind == K_VALUE_PRODUCT) {
      for (size_t i = 0; i < value->as.product.count; i++) {
        free(value->as.product.fields[i].label);
      }
      free(value->as.product.fields);
    } else if (value->kind == K_VALUE_VARIANT) {
      free(value->as.variant.tag);
    }
    free(value);
    value = next;
  }
  free(rt);
}

k_value *k_unit(k_rt *rt) {
  return alloc_value(rt, K_VALUE_UNIT);
}

k_value *k_product(k_rt *rt, size_t count) {
  k_value *product = alloc_value(rt, K_VALUE_PRODUCT);
  if (product == NULL) return NULL;
  product->as.product.capacity = count;
  if (count > 0) {
    product->as.product.fields = calloc(count, sizeof(k_field));
    if (product->as.product.fields == NULL) abort();
  }
  return product;
}

void k_product_set(k_value *product, const char *label, k_value *value) {
  if (product == NULL || product->kind != K_VALUE_PRODUCT || label == NULL) return;
  for (size_t i = 0; i < product->as.product.count; i++) {
    if (strcmp(product->as.product.fields[i].label, label) == 0) {
      product->as.product.fields[i].value = value;
      return;
    }
  }

  if (product->as.product.count == product->as.product.capacity) {
    size_t capacity = product->as.product.capacity == 0 ? 1 : product->as.product.capacity * 2;
    k_field *fields = realloc(product->as.product.fields, capacity * sizeof(k_field));
    if (fields == NULL) abort();
    product->as.product.fields = fields;
    product->as.product.capacity = capacity;
  }

  size_t index = product->as.product.count++;
  product->as.product.fields[index].label = k_strdup(label);
  product->as.product.fields[index].value = value;
}

k_value *k_product_get(k_value *product, const char *label) {
  if (product == NULL || product->kind != K_VALUE_PRODUCT || label == NULL) return NULL;
  for (size_t i = 0; i < product->as.product.count; i++) {
    if (strcmp(product->as.product.fields[i].label, label) == 0) {
      return product->as.product.fields[i].value;
    }
  }
  return NULL;
}

k_value *k_variant(k_rt *rt, const char *tag, k_value *payload) {
  if (tag == NULL) return NULL;
  k_value *variant = alloc_value(rt, K_VALUE_VARIANT);
  if (variant == NULL) return NULL;
  variant->as.variant.tag = k_strdup(tag);
  variant->as.variant.payload = payload;
  return variant;
}

const char *k_variant_tag(k_value *value) {
  if (value == NULL || value->kind != K_VALUE_VARIANT) return NULL;
  return value->as.variant.tag;
}

k_value *k_variant_payload(k_value *value) {
  if (value == NULL || value->kind != K_VALUE_VARIANT) return NULL;
  return value->as.variant.payload;
}

int k_equal(k_value *a, k_value *b) {
  if (a == b) return 1;
  if (a == NULL || b == NULL) return 0;
  if (a->kind != b->kind) return 0;

  if (a->kind == K_VALUE_UNIT) return 1;

  if (a->kind == K_VALUE_VARIANT) {
    return strcmp(a->as.variant.tag, b->as.variant.tag) == 0 &&
      k_equal(a->as.variant.payload, b->as.variant.payload);
  }

  if (a->kind == K_VALUE_PRODUCT) {
    if (a->as.product.count != b->as.product.count) return 0;
    for (size_t i = 0; i < a->as.product.count; i++) {
      k_value *b_field = k_product_get(b, a->as.product.fields[i].label);
      if (!k_equal(a->as.product.fields[i].value, b_field)) return 0;
    }
    return 1;
  }

  return 0;
}

static int is_empty_product(k_value *value) {
  return value != NULL &&
    value->kind == K_VALUE_PRODUCT &&
    value->as.product.count == 0;
}

static void print_json_string(FILE *out, const char *text) {
  fputc('"', out);
  for (const unsigned char *p = (const unsigned char *)text; *p != 0; p++) {
    switch (*p) {
      case '"':
        fputs("\\\"", out);
        break;
      case '\\':
        fputs("\\\\", out);
        break;
      case '\b':
        fputs("\\b", out);
        break;
      case '\f':
        fputs("\\f", out);
        break;
      case '\n':
        fputs("\\n", out);
        break;
      case '\r':
        fputs("\\r", out);
        break;
      case '\t':
        fputs("\\t", out);
        break;
      default:
        if (*p < 0x20) {
          fprintf(out, "\\u%04x", *p);
        } else {
          fputc(*p, out);
        }
        break;
    }
  }
  fputc('"', out);
}

void k_print_json(FILE *out, k_value *value) {
  if (value == NULL) {
    fputs("null", out);
    return;
  }

  if (value->kind == K_VALUE_UNIT) {
    fputs("{}", out);
    return;
  }

  if (value->kind == K_VALUE_PRODUCT) {
    fputc('{', out);
    for (size_t i = 0; i < value->as.product.count; i++) {
      if (i > 0) fputc(',', out);
      print_json_string(out, value->as.product.fields[i].label);
      fputc(':', out);
      k_print_json(out, value->as.product.fields[i].value);
    }
    fputc('}', out);
    return;
  }

  if (value->kind == K_VALUE_VARIANT) {
    if (is_empty_product(value->as.variant.payload)) {
      print_json_string(out, value->as.variant.tag);
      return;
    }
    fputc('{', out);
    print_json_string(out, value->as.variant.tag);
    fputc(':', out);
    k_print_json(out, value->as.variant.payload);
    fputc('}', out);
  }
}

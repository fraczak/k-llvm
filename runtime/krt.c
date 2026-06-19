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

typedef struct {
  const unsigned char *bytes;
  size_t length;
  size_t byte_offset;
  int bit_offset;
  int ok;
} bit_reader;

typedef struct {
  unsigned char *bytes;
  size_t length;
  size_t capacity;
  unsigned char current;
  int bit_count;
  int ok;
} bit_writer;

typedef struct {
  const char *label;
  size_t target;
} k_pattern_edge;

typedef struct {
  int kind;
  size_t edge_count;
  k_pattern_edge *edges;
} k_pattern_node;

typedef struct {
  size_t node_count;
  k_pattern_node *nodes;
} k_pattern;

enum {
  KP_ANY,
  KP_OPEN_PRODUCT,
  KP_OPEN_UNION,
  KP_CLOSED_PRODUCT,
  KP_CLOSED_UNION
};

static k_pattern_edge core_edges_0[] = {{"cons", 1}, {"nil", 3}};
static k_pattern_edge core_edges_1[] = {{"car", 2}, {"cdr", 0}};
static k_pattern_edge core_edges_2[] = {{"any", 3}, {"closed-product", 4}, {"closed-union", 4}, {"open-product", 4}, {"open-union", 4}};
static k_pattern_edge core_edges_4[] = {{"cons", 5}, {"nil", 3}};
static k_pattern_edge core_edges_5[] = {{"car", 6}, {"cdr", 4}};
static k_pattern_edge core_edges_6[] = {{"label", 7}, {"target", 25}};
static k_pattern_edge core_edges_7[] = {{"cons", 8}, {"nil", 3}};
static k_pattern_edge core_edges_8[] = {{"car", 9}, {"cdr", 7}};
static k_pattern_edge core_edges_9[] = {{"ascii", 10}, {"bmp_common", 12}, {"bmp_private_use", 17}, {"plane0", 20}, {"supplementary_plane1", 21}, {"supplementary_planes2_16", 22}};
static k_pattern_edge core_edges_10[] = {{"0", 11}, {"1", 11}, {"2", 11}, {"3", 11}, {"4", 11}, {"5", 11}, {"6", 11}};
static k_pattern_edge core_edges_11[] = {{"0", 3}, {"1", 3}};
static k_pattern_edge core_edges_12[] = {{"hi", 13}, {"lo", 16}};
static k_pattern_edge core_edges_13[] = {{"h08_0F", 14}, {"h10_7F", 10}, {"h80_CF", 10}, {"hD0_D7", 14}, {"hF9", 3}, {"hFA_FB", 15}, {"hFC_FD", 15}, {"hFE_FF", 15}};
static k_pattern_edge core_edges_14[] = {{"0", 11}, {"1", 11}, {"2", 11}};
static k_pattern_edge core_edges_15[] = {{"0", 11}};
static k_pattern_edge core_edges_16[] = {{"0", 11}, {"1", 11}, {"2", 11}, {"3", 11}, {"4", 11}, {"5", 11}, {"6", 11}, {"7", 11}};
static k_pattern_edge core_edges_17[] = {{"hi", 18}, {"lo", 16}};
static k_pattern_edge core_edges_18[] = {{"hE0_EF", 19}, {"hF0_F7", 14}, {"hF8", 3}};
static k_pattern_edge core_edges_19[] = {{"0", 11}, {"1", 11}, {"2", 11}, {"3", 11}};
static k_pattern_edge core_edges_20[] = {{"0", 11}, {"1", 11}, {"10", 11}, {"2", 11}, {"3", 11}, {"4", 11}, {"5", 11}, {"6", 11}, {"7", 11}, {"8", 11}, {"9", 11}};
static k_pattern_edge core_edges_21[] = {{"lo", 16}, {"mid", 16}};
static k_pattern_edge core_edges_22[] = {{"lo", 16}, {"mid", 16}, {"plane", 23}};
static k_pattern_edge core_edges_23[] = {{"p02_03", 15}, {"p04_07", 24}, {"p08_0F", 14}, {"p10", 3}};
static k_pattern_edge core_edges_24[] = {{"0", 11}, {"1", 11}};
static k_pattern_edge core_edges_25[] = {{"0", 25}, {"1", 25}, {"_", 3}};

static k_pattern_node core_nodes[] = {
  {KP_CLOSED_UNION, 2, core_edges_0},
  {KP_CLOSED_PRODUCT, 2, core_edges_1},
  {KP_CLOSED_UNION, 5, core_edges_2},
  {KP_CLOSED_PRODUCT, 0, NULL},
  {KP_CLOSED_UNION, 2, core_edges_4},
  {KP_CLOSED_PRODUCT, 2, core_edges_5},
  {KP_CLOSED_PRODUCT, 2, core_edges_6},
  {KP_CLOSED_UNION, 2, core_edges_7},
  {KP_CLOSED_PRODUCT, 2, core_edges_8},
  {KP_CLOSED_UNION, 6, core_edges_9},
  {KP_CLOSED_PRODUCT, 7, core_edges_10},
  {KP_CLOSED_UNION, 2, core_edges_11},
  {KP_CLOSED_PRODUCT, 2, core_edges_12},
  {KP_CLOSED_UNION, 8, core_edges_13},
  {KP_CLOSED_PRODUCT, 3, core_edges_14},
  {KP_CLOSED_PRODUCT, 1, core_edges_15},
  {KP_CLOSED_PRODUCT, 8, core_edges_16},
  {KP_CLOSED_PRODUCT, 2, core_edges_17},
  {KP_CLOSED_UNION, 3, core_edges_18},
  {KP_CLOSED_PRODUCT, 4, core_edges_19},
  {KP_CLOSED_PRODUCT, 11, core_edges_20},
  {KP_CLOSED_PRODUCT, 2, core_edges_21},
  {KP_CLOSED_PRODUCT, 3, core_edges_22},
  {KP_CLOSED_UNION, 4, core_edges_23},
  {KP_CLOSED_PRODUCT, 2, core_edges_24},
  {KP_CLOSED_UNION, 3, core_edges_25}
};

static k_pattern core_pattern = {26, core_nodes};

static int choice_width(size_t cardinality) {
  if (cardinality <= 1) return 0;
  size_t choices = cardinality - 1;
  int width = 0;
  while (choices > 0) {
    width++;
    choices >>= 1;
  }
  return width;
}

static int br_read_bit(bit_reader *reader) {
  if (!reader->ok || reader->byte_offset >= reader->length) {
    reader->ok = 0;
    return 0;
  }
  int bit = (reader->bytes[reader->byte_offset] >> (7 - reader->bit_offset)) & 1;
  reader->bit_offset++;
  if (reader->bit_offset == 8) {
    reader->byte_offset++;
    reader->bit_offset = 0;
  }
  return bit;
}

static unsigned br_read_bits(bit_reader *reader, int width) {
  unsigned value = 0;
  for (int i = 0; i < width; i++) {
    value = (value << 1) | (unsigned)br_read_bit(reader);
  }
  return value;
}

static int br_zero_padding(bit_reader *reader) {
  while (reader->byte_offset < reader->length) {
    if (br_read_bit(reader) != 0) return 0;
  }
  return reader->ok;
}

static void bw_write_bit(bit_writer *writer, int bit) {
  if (!writer->ok) return;
  writer->current = (unsigned char)((writer->current << 1) | (bit ? 1 : 0));
  writer->bit_count++;
  if (writer->bit_count != 8) return;
  if (writer->length == writer->capacity) {
    size_t capacity = writer->capacity == 0 ? 64 : writer->capacity * 2;
    unsigned char *bytes = realloc(writer->bytes, capacity);
    if (bytes == NULL) {
      writer->ok = 0;
      return;
    }
    writer->bytes = bytes;
    writer->capacity = capacity;
  }
  writer->bytes[writer->length++] = writer->current;
  writer->current = 0;
  writer->bit_count = 0;
}

static void bw_write_bits(bit_writer *writer, unsigned value, int width) {
  for (int i = width - 1; i >= 0; i--) {
    bw_write_bit(writer, (value >> i) & 1);
  }
}

static void bw_flush(bit_writer *writer) {
  if (writer->bit_count > 0) {
    while (writer->bit_count != 0) bw_write_bit(writer, 0);
  }
}

static k_value *decode_node(bit_reader *reader, k_pattern *pattern, size_t node_id, k_rt *rt) {
  if (!reader->ok || node_id >= pattern->node_count) {
    reader->ok = 0;
    return NULL;
  }
  k_pattern_node *node = &pattern->nodes[node_id];
  if (node->kind == KP_ANY) {
    reader->ok = 0;
    return NULL;
  }
  if (node->kind == KP_OPEN_PRODUCT || node->kind == KP_CLOSED_PRODUCT) {
    k_value *product = k_product(rt, node->edge_count);
    if (product == NULL) {
      reader->ok = 0;
      return NULL;
    }
    for (size_t i = 0; i < node->edge_count; i++) {
      k_value *child = decode_node(reader, pattern, node->edges[i].target, rt);
      if (!reader->ok) return NULL;
      k_product_set(product, node->edges[i].label, child);
    }
    return product;
  }
  if (node->kind == KP_OPEN_UNION || node->kind == KP_CLOSED_UNION) {
    if (node->edge_count == 0) {
      reader->ok = 0;
      return NULL;
    }
    unsigned ordinal = br_read_bits(reader, choice_width(node->edge_count));
    if (!reader->ok || ordinal >= node->edge_count) {
      reader->ok = 0;
      return NULL;
    }
    k_pattern_edge *edge = &node->edges[ordinal];
    k_value *payload = decode_node(reader, pattern, edge->target, rt);
    if (!reader->ok) return NULL;
    return k_variant(rt, edge->label, payload);
  }
  reader->ok = 0;
  return NULL;
}

static int tag_is(k_value *value, const char *tag) {
  const char *actual = k_variant_tag(value);
  return actual != NULL && strcmp(actual, tag) == 0;
}

static unsigned bits_to_integer(k_value *value) {
  unsigned place = 1;
  unsigned result = 0;
  k_value *cursor = value;
  for (;;) {
    const char *tag = k_variant_tag(cursor);
    if (tag == NULL) return 0;
    if (strcmp(tag, "_") == 0) return result;
    if (strcmp(tag, "1") == 0) result += place;
    if (strcmp(tag, "0") != 0 && strcmp(tag, "1") != 0) return 0;
    place <<= 1;
    cursor = k_variant_payload(cursor);
  }
}

static unsigned bits_product_to_integer(k_value *value, int max_bit) {
  unsigned result = 0;
  char label[16];
  for (int i = max_bit; i >= 0; i--) {
    snprintf(label, sizeof(label), "%d", i);
    k_value *bit = k_product_get(value, label);
    result = (result << 1) | (tag_is(bit, "1") ? 1U : 0U);
  }
  return result;
}

static char *string_value_to_ascii(k_value *value) {
  size_t capacity = 16;
  size_t length = 0;
  char *text = malloc(capacity);
  if (text == NULL) abort();
  k_value *cursor = value;
  for (;;) {
    const char *tag = k_variant_tag(cursor);
    if (tag == NULL) {
      free(text);
      return NULL;
    }
    if (strcmp(tag, "nil") == 0) {
      text[length] = 0;
      return text;
    }
    if (strcmp(tag, "cons") != 0) {
      free(text);
      return NULL;
    }
    k_value *pair = k_variant_payload(cursor);
    k_value *car = k_product_get(pair, "car");
    if (!tag_is(car, "ascii")) {
      free(text);
      return NULL;
    }
    unsigned cp = bits_product_to_integer(k_variant_payload(car), 6);
    if (cp > 0x7f) {
      free(text);
      return NULL;
    }
    if (length + 2 > capacity) {
      capacity *= 2;
      char *grown = realloc(text, capacity);
      if (grown == NULL) abort();
      text = grown;
    }
    text[length++] = (char)cp;
    cursor = k_product_get(pair, "cdr");
  }
}

static k_value *list_tail(k_value *list) {
  k_value *payload = k_variant_payload(list);
  return payload == NULL ? NULL : k_product_get(payload, "cdr");
}

static k_value *list_head(k_value *list) {
  k_value *payload = k_variant_payload(list);
  return payload == NULL ? NULL : k_product_get(payload, "car");
}

static size_t list_length(k_value *list) {
  size_t count = 0;
  k_value *cursor = list;
  while (tag_is(cursor, "cons")) {
    count++;
    cursor = list_tail(cursor);
  }
  return tag_is(cursor, "nil") ? count : 0;
}

static int node_kind_from_tag(const char *tag) {
  if (strcmp(tag, "any") == 0) return KP_ANY;
  if (strcmp(tag, "open-product") == 0) return KP_OPEN_PRODUCT;
  if (strcmp(tag, "open-union") == 0) return KP_OPEN_UNION;
  if (strcmp(tag, "closed-product") == 0) return KP_CLOSED_PRODUCT;
  if (strcmp(tag, "closed-union") == 0) return KP_CLOSED_UNION;
  return -1;
}

static k_pattern *pattern_from_k_value(k_value *value) {
  size_t node_count = list_length(value);
  if (node_count == 0 && !tag_is(value, "nil")) return NULL;
  k_pattern *pattern = calloc(1, sizeof(k_pattern));
  if (pattern == NULL) abort();
  pattern->node_count = node_count;
  pattern->nodes = calloc(node_count, sizeof(k_pattern_node));
  if (node_count > 0 && pattern->nodes == NULL) abort();
  k_value *cursor = value;
  for (size_t node_index = 0; node_index < node_count; node_index++) {
    k_value *node_value = list_head(cursor);
    const char *node_tag = k_variant_tag(node_value);
    int kind = node_tag == NULL ? -1 : node_kind_from_tag(node_tag);
    if (kind < 0) return NULL;
    pattern->nodes[node_index].kind = kind;
    k_value *edges_list = k_variant_payload(node_value);
    if (kind == KP_ANY) {
      pattern->nodes[node_index].edge_count = 0;
      pattern->nodes[node_index].edges = NULL;
    } else {
      size_t edge_count = list_length(edges_list);
      pattern->nodes[node_index].edge_count = edge_count;
      pattern->nodes[node_index].edges = calloc(edge_count, sizeof(k_pattern_edge));
      if (edge_count > 0 && pattern->nodes[node_index].edges == NULL) abort();
      k_value *edge_cursor = edges_list;
      for (size_t edge_index = 0; edge_index < edge_count; edge_index++) {
        k_value *edge = list_head(edge_cursor);
        char *label = string_value_to_ascii(k_product_get(edge, "label"));
        if (label == NULL) return NULL;
        pattern->nodes[node_index].edges[edge_index].label = label;
        pattern->nodes[node_index].edges[edge_index].target = bits_to_integer(k_product_get(edge, "target"));
        edge_cursor = list_tail(edge_cursor);
      }
    }
    cursor = list_tail(cursor);
  }
  return pattern;
}

static void free_pattern(k_pattern *pattern) {
  if (pattern == NULL || pattern == &core_pattern) return;
  for (size_t i = 0; i < pattern->node_count; i++) {
    for (size_t j = 0; j < pattern->nodes[i].edge_count; j++) {
      free((void *)pattern->nodes[i].edges[j].label);
    }
    free(pattern->nodes[i].edges);
  }
  free(pattern->nodes);
  free(pattern);
}

k_value *k_read_wire(FILE *in, k_rt *rt) {
  size_t capacity = 4096;
  size_t length = 0;
  unsigned char *bytes = malloc(capacity);
  if (bytes == NULL) abort();
  for (;;) {
    if (length == capacity) {
      capacity *= 2;
      unsigned char *grown = realloc(bytes, capacity);
      if (grown == NULL) abort();
      bytes = grown;
    }
    size_t n = fread(bytes + length, 1, capacity - length, in);
    length += n;
    if (n == 0) break;
  }
  if (ferror(in)) {
    free(bytes);
    return NULL;
  }

  bit_reader reader = {bytes, length, 0, 0, 1};
  k_rt *pattern_rt = k_rt_new();
  k_value *pattern_value = decode_node(&reader, &core_pattern, 0, pattern_rt);
  k_pattern *pattern = reader.ok ? pattern_from_k_value(pattern_value) : NULL;
  k_value *value = pattern == NULL ? NULL : decode_node(&reader, pattern, 0, rt);
  int ok = reader.ok && br_zero_padding(&reader);
  free_pattern(pattern);
  k_rt_free(pattern_rt);
  free(bytes);
  return ok ? value : NULL;
}

static void encode_node(bit_writer *writer, k_pattern *pattern, size_t node_id, k_value *value) {
  if (!writer->ok || node_id >= pattern->node_count) {
    writer->ok = 0;
    return;
  }
  k_pattern_node *node = &pattern->nodes[node_id];
  if (node->kind == KP_ANY) {
    writer->ok = 0;
    return;
  }
  if (node->kind == KP_OPEN_PRODUCT || node->kind == KP_CLOSED_PRODUCT) {
    if (value == NULL || value->kind != K_VALUE_PRODUCT) {
      writer->ok = 0;
      return;
    }
    for (size_t i = 0; i < node->edge_count; i++) {
      encode_node(writer, pattern, node->edges[i].target, k_product_get(value, node->edges[i].label));
    }
    return;
  }
  if (node->kind == KP_OPEN_UNION || node->kind == KP_CLOSED_UNION) {
    const char *tag = k_variant_tag(value);
    if (tag == NULL) {
      writer->ok = 0;
      return;
    }
    size_t ordinal = node->edge_count;
    for (size_t i = 0; i < node->edge_count; i++) {
      if (strcmp(node->edges[i].label, tag) == 0) {
        ordinal = i;
        break;
      }
    }
    if (ordinal == node->edge_count) {
      writer->ok = 0;
      return;
    }
    bw_write_bits(writer, (unsigned)ordinal, choice_width(node->edge_count));
    encode_node(writer, pattern, node->edges[ordinal].target, k_variant_payload(value));
  }
}

static int compare_fields(const void *a, const void *b) {
  const k_field *fa = (const k_field *)a;
  const k_field *fb = (const k_field *)b;
  return strcmp(fa->label, fb->label);
}

static size_t derive_pattern_node(k_pattern *pattern, k_value *value) {
  size_t node_id = pattern->node_count++;
  pattern->nodes = realloc(pattern->nodes, pattern->node_count * sizeof(k_pattern_node));
  if (pattern->nodes == NULL) abort();
  pattern->nodes[node_id].edge_count = 0;
  pattern->nodes[node_id].edges = NULL;
  if (value->kind == K_VALUE_PRODUCT || value->kind == K_VALUE_UNIT) {
    pattern->nodes[node_id].kind = KP_CLOSED_PRODUCT;
    if (value->kind == K_VALUE_UNIT) return node_id;
    size_t count = value->as.product.count;
    k_field *fields = malloc(count * sizeof(k_field));
    if (count > 0 && fields == NULL) abort();
    memcpy(fields, value->as.product.fields, count * sizeof(k_field));
    qsort(fields, count, sizeof(k_field), compare_fields);
    pattern->nodes[node_id].edge_count = count;
    pattern->nodes[node_id].edges = calloc(count, sizeof(k_pattern_edge));
    if (count > 0 && pattern->nodes[node_id].edges == NULL) abort();
    for (size_t i = 0; i < count; i++) {
      pattern->nodes[node_id].edges[i].label = k_strdup(fields[i].label);
      pattern->nodes[node_id].edges[i].target = derive_pattern_node(pattern, fields[i].value);
    }
    free(fields);
    return node_id;
  }
  pattern->nodes[node_id].kind = KP_OPEN_UNION;
  pattern->nodes[node_id].edge_count = 1;
  pattern->nodes[node_id].edges = calloc(1, sizeof(k_pattern_edge));
  if (pattern->nodes[node_id].edges == NULL) abort();
  pattern->nodes[node_id].edges[0].label = k_strdup(value->as.variant.tag);
  pattern->nodes[node_id].edges[0].target = derive_pattern_node(pattern, value->as.variant.payload);
  return node_id;
}

static k_pattern *derive_pattern(k_value *value) {
  k_pattern *pattern = calloc(1, sizeof(k_pattern));
  if (pattern == NULL) abort();
  derive_pattern_node(pattern, value);
  return pattern;
}

static k_value *unit_value(k_rt *rt) {
  return k_product(rt, 0);
}

static k_value *integer_to_bits(k_rt *rt, unsigned value) {
  k_value *result = k_variant(rt, "_", unit_value(rt));
  while (value > 0) {
    result = k_variant(rt, (value & 1) ? "1" : "0", result);
    value >>= 1;
  }
  return result;
}

static k_value *ascii_string_value(k_rt *rt, const char *text) {
  k_value *result = k_variant(rt, "nil", unit_value(rt));
  size_t length = strlen(text);
  for (size_t i = length; i > 0; i--) {
    unsigned char ch = (unsigned char)text[i - 1];
    k_value *bits = k_product(rt, 7);
    char label[2] = {0, 0};
    for (int bit = 0; bit <= 6; bit++) {
      label[0] = (char)('0' + bit);
      k_product_set(bits, label, k_variant(rt, ((ch >> bit) & 1) ? "1" : "0", unit_value(rt)));
    }
    k_value *pair = k_product(rt, 2);
    k_product_set(pair, "car", k_variant(rt, "ascii", bits));
    k_product_set(pair, "cdr", result);
    result = k_variant(rt, "cons", pair);
  }
  return result;
}

static k_value *edge_to_k(k_rt *rt, k_pattern_edge *edge) {
  k_value *product = k_product(rt, 2);
  k_product_set(product, "label", ascii_string_value(rt, edge->label));
  k_product_set(product, "target", integer_to_bits(rt, (unsigned)edge->target));
  return product;
}

static k_value *list_to_k(k_rt *rt, k_value **items, size_t count) {
  k_value *result = k_variant(rt, "nil", unit_value(rt));
  for (size_t i = count; i > 0; i--) {
    k_value *pair = k_product(rt, 2);
    k_product_set(pair, "car", items[i - 1]);
    k_product_set(pair, "cdr", result);
    result = k_variant(rt, "cons", pair);
  }
  return result;
}

static const char *pattern_kind_tag(int kind) {
  switch (kind) {
    case KP_ANY: return "any";
    case KP_OPEN_PRODUCT: return "open-product";
    case KP_OPEN_UNION: return "open-union";
    case KP_CLOSED_PRODUCT: return "closed-product";
    case KP_CLOSED_UNION: return "closed-union";
    default: return NULL;
  }
}

static k_value *pattern_to_k_value(k_rt *rt, k_pattern *pattern) {
  k_value **nodes = calloc(pattern->node_count, sizeof(k_value *));
  if (pattern->node_count > 0 && nodes == NULL) abort();
  for (size_t i = 0; i < pattern->node_count; i++) {
    k_pattern_node *node = &pattern->nodes[i];
    k_value **edges = calloc(node->edge_count, sizeof(k_value *));
    if (node->edge_count > 0 && edges == NULL) abort();
    for (size_t j = 0; j < node->edge_count; j++) edges[j] = edge_to_k(rt, &node->edges[j]);
    k_value *edge_list = list_to_k(rt, edges, node->edge_count);
    free(edges);
    const char *tag = pattern_kind_tag(node->kind);
    nodes[i] = k_variant(rt, tag, node->kind == KP_ANY ? unit_value(rt) : edge_list);
  }
  k_value *result = list_to_k(rt, nodes, pattern->node_count);
  free(nodes);
  return result;
}

int k_write_wire(FILE *out, k_value *value) {
  k_pattern *pattern = derive_pattern(value);
  k_rt *pattern_rt = k_rt_new();
  k_value *pattern_value = pattern_to_k_value(pattern_rt, pattern);
  bit_writer writer = {NULL, 0, 0, 0, 0, 1};
  encode_node(&writer, &core_pattern, 0, pattern_value);
  encode_node(&writer, pattern, 0, value);
  bw_flush(&writer);
  int ok = writer.ok && fwrite(writer.bytes, 1, writer.length, out) == writer.length;
  free(writer.bytes);
  k_rt_free(pattern_rt);
  free_pattern(pattern);
  return ok;
}

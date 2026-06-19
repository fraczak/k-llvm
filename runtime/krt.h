#ifndef KRT_H
#define KRT_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

typedef struct k_rt k_rt;
typedef struct k_value k_value;

typedef struct {
  int32_t status;
  k_value *value;
} k_result;

enum {
  K_STATUS_OK = 0,
  K_STATUS_UNSUPPORTED = 1
};

k_rt *k_rt_new(void);
void k_rt_free(k_rt *rt);

k_value *k_unit(k_rt *rt);
k_value *k_product(k_rt *rt, size_t count);
void k_product_set(k_value *product, const char *label, k_value *value);
k_value *k_product_get(k_value *product, const char *label);

k_value *k_variant(k_rt *rt, const char *tag, k_value *payload);
const char *k_variant_tag(k_value *value);
k_value *k_variant_payload(k_value *value);

int k_equal(k_value *a, k_value *b);
void k_print_json(FILE *out, k_value *value);

#endif

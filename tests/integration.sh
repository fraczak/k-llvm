#!/usr/bin/env bash
set -euo pipefail

TMP_DIR=`mktemp -d`
trap 'rm -rf "$TMP_DIR"' EXIT

command -v clang >/dev/null || {
  echo "clang is required for k-llvm integration tests" >&2
  exit 1
}

node ../k.kir/objects/compile.mjs '()' "$TMP_DIR/id.ko"
printf '[["open-product",[]]]' > "$TMP_DIR/input.pattern.json"
node ./bin/k-llvm-compile.mjs --input-pattern "$TMP_DIR/input.pattern.json" "$TMP_DIR/id.ko" "$TMP_DIR/id.ll"
grep -q '@k_llvm_metadata' "$TMP_DIR/id.ll"
grep -q 'define %k_result @k_main' "$TMP_DIR/id.ll"

clang -Wno-override-module -Iruntime runtime/krt.c tests/identity-driver.c "$TMP_DIR/id.ll" -o "$TMP_DIR/id"
"$TMP_DIR/id"

node ../k.kir/objects/compile.mjs '.x' "$TMP_DIR/projection.ko"
printf '[["closed-product",[["x",1]]],["closed-product",[]]]' > "$TMP_DIR/projection.pattern.json"
node ./bin/k-llvm-compile.mjs --input-pattern "$TMP_DIR/projection.pattern.json" "$TMP_DIR/projection.ko" "$TMP_DIR/projection.ll"
grep -q 'call ptr @k_product_get' "$TMP_DIR/projection.ll"
clang -Wno-override-module -Iruntime runtime/krt.c tests/projection-driver.c "$TMP_DIR/projection.ll" -o "$TMP_DIR/projection"
"$TMP_DIR/projection"

node ../k.kir/objects/compile.mjs '{ .x fieldA, .y fieldB }' "$TMP_DIR/product.ko"
printf '[["closed-product",[["x",1],["y",2]]],["closed-product",[["valA",1]]],["closed-product",[["valB",2]]]]' > "$TMP_DIR/product.pattern.json"
node ./bin/k-llvm-compile.mjs --input-pattern "$TMP_DIR/product.pattern.json" "$TMP_DIR/product.ko" "$TMP_DIR/product.ll"
grep -q 'call ptr @k_product' "$TMP_DIR/product.ll"
grep -q 'call void @k_product_set' "$TMP_DIR/product.ll"
clang -Wno-override-module -Iruntime runtime/krt.c tests/product-driver.c "$TMP_DIR/product.ll" -o "$TMP_DIR/product"
"$TMP_DIR/product"

node ./bin/k-llvm-compile.mjs --help | grep -q 'Compile a k .ko/.klib object'

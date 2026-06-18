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

node ./bin/k-llvm-compile.mjs --help | grep -q 'Compile a k .ko/.klib object'

#!/usr/bin/env bash
set -euo pipefail

TMP_DIR=`mktemp -d`
trap 'rm -rf "$TMP_DIR"' EXIT

node ../k.kir/objects/compile.mjs '()' "$TMP_DIR/id.ko"
printf '[["open-product",[]]]' > "$TMP_DIR/input.pattern.json"
node ./bin/k-llvm-compile.mjs --input-pattern "$TMP_DIR/input.pattern.json" "$TMP_DIR/id.ko" "$TMP_DIR/id.ll"
grep -q '@k_llvm_metadata' "$TMP_DIR/id.ll"
grep -q 'define i32 @k_main' "$TMP_DIR/id.ll"

node ./bin/k-llvm-compile.mjs --help | grep -q 'Compile a k .ko/.klib object'

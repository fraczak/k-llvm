# k-llvm

Experimental LLVM backend prototype for `k`.

This repository is intentionally separate from core `k`. It consumes the
backend bridge from `@fraczak/k` and starts from compiled `.ko` objects:

```text
.k source -> .ko -> KIR-R -> LLVM IR prototype
```

The first milestone is not performance. It is a stable backend pipeline that
can load an object, specialize it through KIR-R, and produce an inspectable LLVM
module.

## Quick Start

From this checkout:

```sh
npm install --no-save --package-lock=false ../k.kir
node ../k.kir/objects/compile.mjs '()' /tmp/id.ko
node ./bin/k-llvm-compile.mjs --input-pattern '[["open-product",[]]]' /tmp/id.ko /tmp/id.ll
```

The generated `.ll` embeds the KIR-R JSON as module data and exposes the first
runtime ABI slice:

```llvm
%k_result = type { i32, ptr }

define %k_result @k_main(ptr %rt, ptr %input)
```

`%rt` is an opaque runtime handle and `%input` is an opaque boxed `k_value*`.
The first executable lowerings support identity, product field projection,
product construction, variant construction, and variant projection. Unsupported
operations return a nonzero status in `k_result`.

## CLI

```sh
k-llvm-compile [options] object.ko [output.ll]
```

Options:

- `--retype rel`: relation to specialize; defaults to the object's `main`.
- `--input-pattern json-or-file`: required KIR property-list input pattern.
- `-h`, `--help`: show usage.

Only `.ko` / `.klib` object input is supported in this first prototype.
Source compilation remains owned by core `k`.

## Scope

Current output:

- KIR-R specialization through `@fraczak/k/backend-api.mjs`;
- textual LLVM IR with embedded KIR-R JSON;
- boxed runtime ABI declarations;
- identity, product projection/construction, and variant
  construction/projection lowerings as `@k_main(k_rt*, k_value*) -> k_result`;
- a tiny C runtime under `runtime/`.

Next backend steps:

- lower filters and relation calls;
- add an executable conformance mode once the runtime ABI exists.

## Runtime ABI

The C side owns all runtime allocation:

```c
typedef struct k_rt k_rt;
typedef struct k_value k_value;

typedef struct {
  int32_t status;
  k_value *value;
} k_result;

k_result k_main(k_rt *rt, k_value *input);
```

`runtime/krt.h` provides the initial boxed helpers for units, products,
variants, and pointer equality. The representation is intentionally opaque so
future KIR specialization can add unboxed fast paths without changing the
external ABI.

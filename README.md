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

The generated `.ll` is a prototype artifact. It embeds the KIR-R JSON as module
data and provides a placeholder `@k_main` function so downstream LLVM tooling
has a concrete module to inspect.

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
- placeholder `@k_main(i32) -> i32`.

Next backend steps:

- define a real value ABI;
- lower KIR-R/KIR-M operations into LLVM functions;
- add an executable conformance mode once the runtime ABI exists.

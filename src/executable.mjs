import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isProduct, isVariant } from "@fraczak/k/Value.mjs";
import { exportPatternGraph } from "@fraczak/k/codecs/runtime/codec.mjs";
import { patternToPropertyList } from "@fraczak/k/codecs/runtime/pattern-json.mjs";
import { compileObjectToLLVM } from "./llvm.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function relationForObject(object, relationName = object.main) {
  if (!relationName) throw new Error("A relation name is required");
  if (object.rels?.[relationName]) return object.rels[relationName];
  const alias = object.relAlias?.[relationName];
  if (alias && object.rels?.[alias]) return object.rels[alias];
  throw new Error(`Relation '${relationName}' not found`);
}

export function inputPatternForObjectValue(object, value, relationName = object.main) {
  if (value.pattern) return value.pattern;
  const rel = relationForObject(object, relationName);
  const inputPatternId = rel.typePatternGraph.find(rel.def.patterns[0]);
  return patternToPropertyList(exportPatternGraph(rel.typePatternGraph, inputPatternId));
}

function cString(text) {
  return JSON.stringify(String(text));
}

function emitValueBuilder(value, ctx) {
  if (isProduct(value)) {
    const name = `v${ctx.next++}`;
    const fields = Object.entries(value.product);
    ctx.lines.push(`  k_value *${name} = k_product(rt, ${fields.length});`);
    for (const [label, child] of fields) {
      const childName = emitValueBuilder(child, ctx);
      ctx.lines.push(`  k_product_set(${name}, ${cString(label)}, ${childName});`);
    }
    return name;
  }

  if (isVariant(value)) {
    const childName = emitValueBuilder(value.value, ctx);
    const name = `v${ctx.next++}`;
    ctx.lines.push(`  k_value *${name} = k_variant(rt, ${cString(value.tag)}, ${childName});`);
    return name;
  }

  throw new Error(`Unsupported k value: ${JSON.stringify(value)}`);
}

function builderFunction(name, value) {
  const ctx = { next: 0, lines: [] };
  const result = emitValueBuilder(value, ctx);
  return [
    `static k_value *${name}(k_rt *rt) {`,
    ...ctx.lines,
    `  return ${result};`,
    "}",
    ""
  ].join("\n");
}

export function driverSource({ input, expected = null }) {
  const expectedBuilder = expected == null ? "" : builderFunction("build_expected", expected);
  const expectedCheck = expected == null
    ? []
    : [
        "  k_value *expected = build_expected(rt);",
        "  if (!k_equal(result.value, expected)) return 3;"
      ];

  return [
    '#include "krt.h"',
    "",
    "extern k_result k_main(k_rt *rt, k_value *input);",
    "",
    builderFunction("build_input", input),
    expectedBuilder,
    "int main(void) {",
    "  k_rt *rt = k_rt_new();",
    "  if (rt == 0) return 1;",
    "  k_value *input = build_input(rt);",
    "  k_result result = k_main(rt, input);",
    "  if (result.status != K_STATUS_OK) return 2;",
    ...expectedCheck,
    "  k_rt_free(rt);",
    "  return 0;",
    "}",
    ""
  ].join("\n");
}

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options
  });
  if (result.error && result.status !== 0) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}${detail ? `\n${detail}` : ""}`);
  }
  return result;
}

export function compileAndRunLLVM(llvm, { input, expected = null, tmpPrefix = "k-llvm-run-" }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  try {
    const llPath = path.join(tmpDir, "program.ll");
    const driverPath = path.join(tmpDir, "driver.c");
    const exePath = path.join(tmpDir, "program");
    fs.writeFileSync(llPath, llvm);
    fs.writeFileSync(driverPath, driverSource({ input, expected }));
    runCommand("clang", [
      "-Wno-override-module",
      "-Iruntime",
      "runtime/krt.c",
      driverPath,
      llPath,
      "-o",
      exePath
    ]);
    return runCommand(exePath, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function compileObjectAndRun(object, { relation = object.main, input, expected = null, inputPattern = null }) {
  const { llvm } = compileObjectToLLVM(object, {
    relation,
    inputPattern: inputPattern || inputPatternForObjectValue(object, input, relation)
  });
  return compileAndRunLLVM(llvm, { input, expected });
}

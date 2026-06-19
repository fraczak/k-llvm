#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { compileObjectBuffer, decodeObject } from "@fraczak/k/object.mjs";
import { parseValue } from "@fraczak/k/valueIO.mjs";
import { isProduct, isVariant } from "@fraczak/k/Value.mjs";
import { exportPatternGraph } from "@fraczak/k/codecs/runtime/codec.mjs";
import { patternToPropertyList } from "@fraczak/k/codecs/runtime/pattern-json.mjs";
import { compileObjectToLLVM } from "../src/llvm.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kRoot = path.resolve(root, "../k.kir");
const conformanceRoot = path.join(kRoot, "conformance");

function helpText() {
  return [
    "Run k-llvm executable conformance fixtures.",
    "",
    `Usage: ${argv[1]} [fixture-dir ...]`,
    "",
    "With no fixture dirs, every supported directory under ../k.kir/conformance is run."
  ].join("\n");
}

function fixtureDirs(args) {
  if (args.length > 0) return args.map((arg) => path.resolve(root, arg));
  return fs.readdirSync(conformanceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(conformanceRoot, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "case.json")))
    .sort();
}

function readFixture(dir) {
  const spec = JSON.parse(fs.readFileSync(path.join(dir, "case.json"), "utf8"));
  return {
    dir,
    name: spec.name || path.basename(dir),
    program: fs.readFileSync(path.join(dir, spec.program || "program.k"), "utf8"),
    input: parseValue(fs.readFileSync(path.join(dir, spec.input || "input.kv"), "utf8")),
    expected: parseValue(fs.readFileSync(path.join(dir, spec.expected || "expected.kv"), "utf8"))
  };
}

function inputPatternFor(object, fixture) {
  if (fixture.input.pattern) return fixture.input.pattern;
  const mainRel = object.rels[object.main];
  const inputPatternId = mainRel.typePatternGraph.find(mainRel.def.patterns[0]);
  return patternToPropertyList(exportPatternGraph(mainRel.typePatternGraph, inputPatternId));
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

  throw new Error(`Unsupported fixture value: ${JSON.stringify(value)}`);
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

function driverSource(fixture) {
  return [
    '#include "krt.h"',
    "",
    "extern k_result k_main(k_rt *rt, k_value *input);",
    "",
    builderFunction("build_input", fixture.input),
    builderFunction("build_expected", fixture.expected),
    "int main(void) {",
    "  k_rt *rt = k_rt_new();",
    "  if (rt == 0) return 1;",
    "  k_value *input = build_input(rt);",
    "  k_value *expected = build_expected(rt);",
    "  k_result result = k_main(rt, input);",
    "  if (result.status != K_STATUS_OK) return 2;",
    "  if (!k_equal(result.value, expected)) return 3;",
    "  k_rt_free(rt);",
    "  return 0;",
    "}",
    ""
  ].join("\n");
}

function run(command, args, options = {}) {
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

function runFixture(fixture) {
  const object = decodeObject(compileObjectBuffer(fixture.program, {
    source: path.relative(kRoot, fixture.dir)
  }));
  const { llvm } = compileObjectToLLVM(object, {
    inputPattern: inputPatternFor(object, fixture)
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "k-llvm-conformance-"));
  try {
    const llPath = path.join(tmpDir, "fixture.ll");
    const driverPath = path.join(tmpDir, "driver.c");
    const exePath = path.join(tmpDir, "fixture");
    fs.writeFileSync(llPath, llvm);
    fs.writeFileSync(driverPath, driverSource(fixture));
    run("clang", [
      "-Wno-override-module",
      "-Iruntime",
      "runtime/krt.c",
      driverPath,
      llPath,
      "-o",
      exePath
    ]);
    run(exePath, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

try {
  const args = argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(helpText());
    exit(0);
  }
  if (args.some((arg) => arg.startsWith("--"))) {
    throw new Error(`Unknown option: ${args.find((arg) => arg.startsWith("--"))}`);
  }

  let count = 0;
  for (const fixture of fixtureDirs(args).map(readFixture)) {
    runFixture(fixture);
    count++;
    console.log(`ok ${fixture.name}`);
  }
  console.log(`OK ${count} fixtures`);
} catch (error) {
  console.error(error.stack || error.message || String(error));
  console.error(helpText());
  exit(1);
}

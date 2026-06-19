import fs from "node:fs";
import {
  decodeObject,
  retypeObjectRelation
} from "@fraczak/k/backend-api.mjs";

const ARTIFACT_FORMAT = "k-llvm";
const ARTIFACT_VERSION = 1;

function cStringBytes(text) {
  return [...Buffer.from(text, "utf8"), 0]
    .map((byte) => {
      if (byte === 10) return "\\0A";
      if (byte === 34) return "\\22";
      if (byte === 92) return "\\5C";
      if (byte >= 32 && byte <= 126) return String.fromCharCode(byte);
      return `\\${byte.toString(16).padStart(2, "0").toUpperCase()}`;
    })
    .join("");
}

function readPattern(inputPattern) {
  if (Array.isArray(inputPattern)) return inputPattern;
  if (typeof inputPattern !== "string" || inputPattern.length === 0) {
    throw new Error("compileToLLVM requires an input pattern property list");
  }
  const text = fs.existsSync(inputPattern) ? fs.readFileSync(inputPattern, "utf8") : inputPattern;
  return JSON.parse(text);
}

export function llvmIdentifier(name) {
  return String(name || "main").replace(/[^A-Za-z0-9_$.-]/g, "_");
}

function llvmStringGlobalName(index) {
  return `@k_label_${index}`;
}

function llvmRelationFunctionName(name, index) {
  return `@k_rel_${llvmIdentifier(name)}_${index}`;
}

function runtimeDeclarations() {
  return [
    "%k_result = type { i32, ptr }",
    "",
    "declare ptr @k_unit(ptr)",
    "declare ptr @k_product(ptr, i64)",
    "declare void @k_product_set(ptr, ptr, ptr)",
    "declare ptr @k_product_get(ptr, ptr)",
    "declare ptr @k_variant(ptr, ptr, ptr)",
    "declare ptr @k_variant_tag(ptr)",
    "declare ptr @k_variant_payload(ptr)",
    "declare i32 @k_equal(ptr, ptr)",
    "declare i32 @strcmp(ptr, ptr)"
  ];
}

function createLoweringContext(functionNames = new Map(), labels = new Map()) {
  return {
    temp: 0,
    block: 0,
    functionNames,
    labels,
    lines: [],
    tempName(prefix) {
      return `%${prefix}${this.temp++}`;
    },
    blockName(prefix) {
      return `bb_${prefix}${this.block++}`;
    },
    labelPointer(label) {
      const text = String(label);
      let global = this.labels.get(text);
      if (!global) {
        const index = this.labels.size;
        global = {
          name: llvmStringGlobalName(index),
          length: Buffer.byteLength(text, "utf8") + 1,
          text
        };
        this.labels.set(text, global);
      }
      const pointer = this.tempName("label");
      this.lines.push(`  ${pointer} = getelementptr inbounds [${global.length} x i8], ptr ${global.name}, i64 0, i64 0`);
      return pointer;
    }
  };
}

function result(ctx, status, value = "null") {
  const statusValue = ctx.tempName("status");
  const resultValue = ctx.tempName("result");
  return [
    `  ${statusValue} = insertvalue %k_result undef, i32 ${status}, 0`,
    `  ${resultValue} = insertvalue %k_result ${statusValue}, ptr ${value}, 1`,
    `  ret %k_result ${resultValue}`
  ];
}

function unsupported(ctx) {
  ctx.lines.push(...result(ctx, 1));
}

function nullCheck(ctx, value) {
  const missing = ctx.tempName("missing");
  const okBlock = ctx.blockName("ok");
  const missingBlock = ctx.blockName("missing");
  ctx.lines.push(`  ${missing} = icmp eq ptr ${value}, null`);
  ctx.lines.push(`  br i1 ${missing}, label %${missingBlock}, label %${okBlock}`);
  ctx.lines.push(`${missingBlock}:`);
  ctx.lines.push(...result(ctx, 1));
  ctx.lines.push(`${okBlock}:`);
}

function statusCheck(ctx, callResult) {
  const status = ctx.tempName("status");
  const failed = ctx.tempName("failed");
  const okBlock = ctx.blockName("ok");
  const failedBlock = ctx.blockName("failed");
  ctx.lines.push(`  ${status} = extractvalue %k_result ${callResult}, 0`);
  ctx.lines.push(`  ${failed} = icmp ne i32 ${status}, 0`);
  ctx.lines.push(`  br i1 ${failed}, label %${failedBlock}, label %${okBlock}`);
  ctx.lines.push(`${failedBlock}:`);
  ctx.lines.push(...result(ctx, status));
  ctx.lines.push(`${okBlock}:`);
}

function lowerExpr(ctx, exp, input = "%input") {
  switch (exp?.op) {
    case "identity":
    case "filter":
      return input;
    case "ref": {
      const functionName = ctx.functionNames.get(exp.ref);
      if (!functionName) return null;
      const callResult = ctx.tempName("call");
      ctx.lines.push(`  ${callResult} = call %k_result ${functionName}(ptr %rt, ptr ${input})`);
      statusCheck(ctx, callResult);
      const value = ctx.tempName("ref");
      ctx.lines.push(`  ${value} = extractvalue %k_result ${callResult}, 1`);
      return value;
    }
    case "dot": {
      const label = ctx.labelPointer(exp.label);
      const value = ctx.tempName("field");
      ctx.lines.push(`  ${value} = call ptr @k_product_get(ptr ${input}, ptr ${label})`);
      nullCheck(ctx, value);
      return value;
    }
    case "div": {
      const label = ctx.labelPointer(exp.tag);
      const tag = ctx.tempName("tag");
      ctx.lines.push(`  ${tag} = call ptr @k_variant_tag(ptr ${input})`);
      nullCheck(ctx, tag);
      const compare = ctx.tempName("tagcmp");
      const matches = ctx.tempName("tagmatch");
      const matchBlock = ctx.blockName("tag_match");
      const mismatchBlock = ctx.blockName("tag_mismatch");
      ctx.lines.push(`  ${compare} = call i32 @strcmp(ptr ${tag}, ptr ${label})`);
      ctx.lines.push(`  ${matches} = icmp eq i32 ${compare}, 0`);
      ctx.lines.push(`  br i1 ${matches}, label %${matchBlock}, label %${mismatchBlock}`);
      ctx.lines.push(`${mismatchBlock}:`);
      ctx.lines.push(...result(ctx, 1));
      ctx.lines.push(`${matchBlock}:`);
      const payload = ctx.tempName("payload");
      ctx.lines.push(`  ${payload} = call ptr @k_variant_payload(ptr ${input})`);
      nullCheck(ctx, payload);
      return payload;
    }
    case "vid": {
      const label = ctx.labelPointer(exp.tag);
      const variant = ctx.tempName("variant");
      ctx.lines.push(`  ${variant} = call ptr @k_variant(ptr %rt, ptr ${label}, ptr ${input})`);
      nullCheck(ctx, variant);
      return variant;
    }
    case "comp": {
      let current = input;
      for (const item of exp.items) {
        current = lowerExpr(ctx, item, current);
        if (current == null) return null;
      }
      return current;
    }
    case "product": {
      const product = ctx.tempName("product");
      ctx.lines.push(`  ${product} = call ptr @k_product(ptr %rt, i64 ${exp.fields.length})`);
      for (const field of exp.fields) {
        const child = lowerExpr(ctx, field.expr, input);
        const label = ctx.labelPointer(field.label);
        ctx.lines.push(`  call void @k_product_set(ptr ${product}, ptr ${label}, ptr ${child})`);
      }
      return product;
    }
    default:
      return null;
  }
}

function lowerableEntryBody(kirR) {
  return kirR.entry?.body;
}

function labelGlobals(ctx) {
  return [...ctx.labels.values()].map((label) =>
    `${label.name} = private unnamed_addr constant [${label.length} x i8] c"${cStringBytes(label.text)}", align 1`);
}

function emitFunctionBody(symbol, body, ctx, linkage = "") {
  const value = lowerExpr(ctx, body);
  if (value == null) {
    unsupported(ctx);
  } else {
    ctx.lines.push(...result(ctx, 0, value));
  }
  const prefix = linkage ? `define ${linkage} %k_result` : "define %k_result";
  return [
    `${prefix} ${symbol}(ptr %rt, ptr %input) {`,
    "entry:",
    ...ctx.lines,
    "}",
    ""
  ];
}

function sortedRelationEntries(kirR) {
  return Object.entries(kirR.rels || {})
    .filter(([name]) => name !== "__main__")
    .sort(([a], [b]) => a.localeCompare(b));
}

function relationFunctionNames(kirR) {
  return new Map(sortedRelationEntries(kirR).map(([name], index) => [
    name,
    llvmRelationFunctionName(name, index)
  ]));
}

function emitRelationFunctions(kirR, functionNames, labels) {
  return sortedRelationEntries(kirR).flatMap(([name, rel]) => {
    const ctx = createLoweringContext(functionNames, labels);
    return emitFunctionBody(functionNames.get(name), rel.body, ctx, "internal");
  });
}

export function emitLLVMModule(kirR, options = {}) {
  const labels = new Map();
  const functionNames = relationFunctionNames(kirR);
  const relationFunctions = emitRelationFunctions(kirR, functionNames, labels);
  const mainContext = createLoweringContext(functionNames, labels);
  const functionBody = emitFunctionBody("@k_main", lowerableEntryBody(kirR), mainContext);
  const payload = JSON.stringify({
    format: ARTIFACT_FORMAT,
    version: ARTIFACT_VERSION,
    relation: kirR.relation,
    instanceKey: kirR.instanceKey,
    kir: kirR
  });
  const payloadBytes = Buffer.byteLength(payload, "utf8") + 1;
  const symbol = llvmIdentifier(options.symbol || kirR.relation || "main");

  return [
    "; k-llvm prototype artifact",
    `; relation: ${kirR.relation}`,
    `; instance: ${kirR.instanceKey}`,
    `source_filename = "k-llvm:${symbol}"`,
    "",
    `@k_llvm_metadata = private unnamed_addr constant [${payloadBytes} x i8] c"${cStringBytes(payload)}", align 1`,
    ...labelGlobals({ labels }),
    "",
    ...runtimeDeclarations(),
    "",
    ...relationFunctions,
    ...functionBody
  ].join("\n");
}

export function compileObjectToLLVM(object, options = {}) {
  const inputPattern = readPattern(options.inputPattern);
  const kirR = retypeObjectRelation(object, options.relation || object.main, inputPattern, {
    source: options.source || "<k-llvm>"
  });
  return {
    kirR,
    llvm: emitLLVMModule(kirR, options)
  };
}

export function compileBufferToLLVM(buffer, options = {}) {
  return compileObjectToLLVM(decodeObject(buffer), options);
}

export {
  ARTIFACT_FORMAT,
  ARTIFACT_VERSION
};

export default {
  ARTIFACT_FORMAT,
  ARTIFACT_VERSION,
  compileBufferToLLVM,
  compileObjectToLLVM,
  emitLLVMModule,
  llvmIdentifier
};

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
    "declare void @k_product_set_n(ptr, ptr, i64, ptr)",
    "declare void @k_product_set_borrowed_n(ptr, ptr, i64, ptr)",
    "declare ptr @k_product_get(ptr, ptr)",
    "declare ptr @k_product_get_n(ptr, ptr, i64)",
    "declare ptr @k_variant(ptr, ptr, ptr)",
    "declare ptr @k_variant_n(ptr, ptr, i64, ptr)",
    "declare ptr @k_variant_borrowed_n(ptr, ptr, i64, ptr)",
    "declare ptr @k_variant_tag(ptr)",
    "declare ptr @k_variant_payload(ptr)",
    "declare i32 @k_equal(ptr, ptr)",
    "declare i32 @k_variant_tag_matches(ptr, ptr, i64)"
  ];
}

function createLoweringContext(functionNames = new Map(), labels = new Map(), syntheticFunctions = []) {
  return {
    temp: 0,
    block: 0,
    functionNames,
    labels,
    syntheticFunctions,
    lines: [],
    addSyntheticFunction(body) {
      const name = `@k_union_arm_${this.syntheticFunctions.length}`;
      const index = this.syntheticFunctions.length;
      this.syntheticFunctions.push(null);
      const ctx = createLoweringContext(this.functionNames, this.labels, this.syntheticFunctions);
      this.syntheticFunctions[index] = emitFunctionBody(name, body, ctx, "internal");
      return name;
    },
    addUnionFunction(items) {
      const name = `@k_union_expr_${this.syntheticFunctions.length}`;
      const ctx = createLoweringContext(this.functionNames, this.labels, this.syntheticFunctions);
      const body = emitUnionFunctionBody(name, items, ctx, "internal");
      this.syntheticFunctions.push(body);
      return name;
    },
    tempName(prefix) {
      return `%${prefix}${this.temp++}`;
    },
    blockName(prefix) {
      return `bb_${prefix}${this.block++}`;
    },
    labelRef(label) {
      const text = String(label);
      let global = this.labels.get(text);
      if (!global) {
        const index = this.labels.size;
        global = {
          name: llvmStringGlobalName(index),
          length: Buffer.byteLength(text, "utf8") + 1,
          byteLength: Buffer.byteLength(text, "utf8"),
          text
        };
        this.labels.set(text, global);
      }
      const pointer = this.tempName("label");
      this.lines.push(`  ${pointer} = getelementptr inbounds [${global.length} x i8], ptr ${global.name}, i64 0, i64 0`);
      return { pointer, length: global.byteLength };
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

function unionBranch(ctx, functionName, input, isLast) {
  const callResult = ctx.tempName("union");
  const status = ctx.tempName("status");
  const failed = ctx.tempName("failed");
  const successBlock = ctx.blockName("union_success");
  const nextBlock = isLast ? null : ctx.blockName("union_next");
  const failureBlock = isLast ? ctx.blockName("union_failure") : nextBlock;
  ctx.lines.push(`  ${callResult} = call %k_result ${functionName}(ptr %rt, ptr ${input})`);
  ctx.lines.push(`  ${status} = extractvalue %k_result ${callResult}, 0`);
  ctx.lines.push(`  ${failed} = icmp ne i32 ${status}, 0`);
  ctx.lines.push(`  br i1 ${failed}, label %${failureBlock}, label %${successBlock}`);
  ctx.lines.push(`${successBlock}:`);
  const value = ctx.tempName("union_value");
  ctx.lines.push(`  ${value} = extractvalue %k_result ${callResult}, 1`);
  ctx.lines.push(...result(ctx, 0, value));
  if (isLast) {
    ctx.lines.push(`${failureBlock}:`);
    ctx.lines.push(...result(ctx, 1));
  } else {
    ctx.lines.push(`${nextBlock}:`);
  }
}

function emitUnionFunctionBody(symbol, items, ctx, linkage = "") {
  if (!items?.length) {
    unsupported(ctx);
  } else {
    items.forEach((item, index) => {
      unionBranch(ctx, ctx.addSyntheticFunction(item), "%input", index === items.length - 1);
    });
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

function lowerExpr(ctx, exp, input = "%input") {
  switch (exp?.op) {
    case "empty":
      return null;
    case "identity":
    case "code":
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
      const label = ctx.labelRef(exp.label);
      const value = ctx.tempName("field");
      ctx.lines.push(`  ${value} = call ptr @k_product_get_n(ptr ${input}, ptr ${label.pointer}, i64 ${label.length})`);
      nullCheck(ctx, value);
      return value;
    }
    case "div": {
      const label = ctx.labelRef(exp.tag);
      const matches = ctx.tempName("tagmatch");
      const matchBlock = ctx.blockName("tag_match");
      const mismatchBlock = ctx.blockName("tag_mismatch");
      const compare = ctx.tempName("tagcmp");
      ctx.lines.push(`  ${compare} = call i32 @k_variant_tag_matches(ptr ${input}, ptr ${label.pointer}, i64 ${label.length})`);
      ctx.lines.push(`  ${matches} = icmp ne i32 ${compare}, 0`);
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
      const label = ctx.labelRef(exp.tag);
      const variant = ctx.tempName("variant");
      ctx.lines.push(`  ${variant} = call ptr @k_variant_borrowed_n(ptr %rt, ptr ${label.pointer}, i64 ${label.length}, ptr ${input})`);
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
      if (exp.fields.length === 0) {
        const unit = ctx.tempName("unit");
        ctx.lines.push(`  ${unit} = call ptr @k_unit(ptr %rt)`);
        nullCheck(ctx, unit);
        return unit;
      }
      const product = ctx.tempName("product");
      ctx.lines.push(`  ${product} = call ptr @k_product(ptr %rt, i64 ${exp.fields.length})`);
      for (const field of exp.fields) {
        const child = lowerExpr(ctx, field.expr, input);
        if (child == null) return null;
        const label = ctx.labelRef(field.label);
        ctx.lines.push(`  call void @k_product_set_borrowed_n(ptr ${product}, ptr ${label.pointer}, i64 ${label.length}, ptr ${child})`);
      }
      return product;
    }
    case "union": {
      if (!exp.items?.length) return null;
      const functionName = ctx.addUnionFunction(exp.items);
      const callResult = ctx.tempName("union");
      ctx.lines.push(`  ${callResult} = call %k_result ${functionName}(ptr %rt, ptr ${input})`);
      statusCheck(ctx, callResult);
      const value = ctx.tempName("union_value");
      ctx.lines.push(`  ${value} = extractvalue %k_result ${callResult}, 1`);
      return value;
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
  if (value === false) {
    // The expression emitted complete control flow, including all returns.
  } else if (value == null) {
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

export function emitLLVMModule(kirR, options = {}) {
  const labels = new Map();
  const syntheticFunctions = [];
  const functionNames = relationFunctionNames(kirR);
  const relationFunctions = sortedRelationEntries(kirR).flatMap(([name, rel]) => {
    const ctx = createLoweringContext(functionNames, labels, syntheticFunctions);
    return emitFunctionBody(functionNames.get(name), rel.body, ctx, "internal");
  });
  const mainContext = createLoweringContext(functionNames, labels, syntheticFunctions);
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
    ...syntheticFunctions.flat(),
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

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
    "%k_rt_mark = type { ptr, i64 }",
    "%k_result = type { i32, ptr }",
    "",
    "declare %k_rt_mark @k_rt_mark(ptr)",
    "declare void @k_rt_rewind(ptr, %k_rt_mark)",
    "declare ptr @k_unit(ptr)",
    "declare ptr @k_bit0(ptr)",
    "declare ptr @k_bit1(ptr)",
    "declare ptr @k_product(ptr, i64)",
    "declare void @k_product_set(ptr, ptr, ptr)",
    "declare void @k_product_set_n(ptr, ptr, i64, ptr)",
    "declare void @k_product_set_borrowed_n(ptr, ptr, i64, ptr)",
    "declare void @k_product_set_at(ptr, i64, ptr, i64, ptr)",
    "declare ptr @k_product_get(ptr, ptr)",
    "declare ptr @k_product_get_n(ptr, ptr, i64)",
    "declare ptr @k_product_get_at(ptr, i64)",
    "declare ptr @k_variant(ptr, ptr, ptr)",
    "declare ptr @k_variant_n(ptr, ptr, i64, ptr)",
    "declare ptr @k_variant_borrowed_n(ptr, ptr, i64, ptr)",
    "declare ptr @k_variant_borrowed_direct_n(ptr, ptr, i64, ptr)",
    "declare ptr @k_variant_unit_borrowed_n(ptr, ptr, i64)",
    "declare ptr @k_variant_tag(ptr)",
    "declare ptr @k_variant_payload(ptr)",
    "declare i32 @k_equal(ptr, ptr)",
    "declare i32 @k_variant_tag_matches(ptr, ptr, i64)"
  ];
}

function createLoweringContext(functionNames = new Map(), labels = new Map(), syntheticFunctions = [], patternGraph = null, tail = {}) {
  return {
    temp: 0,
    block: 0,
    functionNames,
    labels,
    syntheticFunctions,
    patternGraph,
    tailRef: tail.refName || null,
    catchTail: tail.catchTail || false,
    tailInputSlot: tail.inputSlot || null,
    tailLoopBlock: tail.loopBlock || null,
    lines: [],
    addSyntheticFunction(body, tailPosition = false) {
      const name = `@k_union_arm_${this.syntheticFunctions.length}`;
      const index = this.syntheticFunctions.length;
      this.syntheticFunctions.push(null);
      const ctx = createLoweringContext(this.functionNames, this.labels, this.syntheticFunctions, this.patternGraph, {
        refName: this.tailRef
      });
      this.syntheticFunctions[index] = emitFunctionBody(name, body, ctx, "internal", { tail: tailPosition });
      return name;
    },
    addUnionFunction(items, tailPosition = false) {
      const name = `@k_union_expr_${this.syntheticFunctions.length}`;
      const ctx = createLoweringContext(this.functionNames, this.labels, this.syntheticFunctions, this.patternGraph, {
        refName: this.tailRef
      });
      const body = emitUnionFunctionBody(name, items, ctx, "internal", { tail: tailPosition });
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
      return { pointer, length: global.byteLength, text };
    }
  };
}

function patternNode(ctx, patternId) {
  if (patternId == null || ctx.patternGraph?.nodes == null) return null;
  return ctx.patternGraph.nodes.find((node) => node.id === patternId) || null;
}

function patternEdgeIndex(ctx, patternId, label) {
  const node = patternNode(ctx, patternId);
  const edges = node?.edges;
  if (!Array.isArray(edges)) return -1;
  return edges.findIndex((edge) => edge.label === label);
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
  if (ctx.catchTail) {
    const isTail = ctx.tempName("tail_status");
    const tailBlock = ctx.blockName("tail");
    const returnBlock = ctx.blockName("return_failed");
    ctx.lines.push(`  ${isTail} = icmp eq i32 ${status}, 2`);
    ctx.lines.push(`  br i1 ${isTail}, label %${tailBlock}, label %${returnBlock}`);
    ctx.lines.push(`${tailBlock}:`);
    const tailInput = ctx.tempName("tail_input");
    ctx.lines.push(`  ${tailInput} = extractvalue %k_result ${callResult}, 1`);
    ctx.lines.push(`  store ptr ${tailInput}, ptr ${ctx.tailInputSlot}`);
    ctx.lines.push(`  br label %${ctx.tailLoopBlock}`);
    ctx.lines.push(`${returnBlock}:`);
  }
  ctx.lines.push(`  ret %k_result ${callResult}`);
  ctx.lines.push(`${okBlock}:`);
}

function unionBranch(ctx, functionName, input, isLast) {
  const mark = ctx.tempName("mark");
  const callResult = ctx.tempName("union");
  const status = ctx.tempName("status");
  const failed = ctx.tempName("failed");
  const successBlock = ctx.blockName("union_success");
  const failedDispatchBlock = ctx.blockName("union_failed");
  const tailBlock = ctx.blockName("union_tail");
  const nextBlock = isLast ? null : ctx.blockName("union_next");
  const failureBlock = isLast ? ctx.blockName("union_failure") : nextBlock;
  ctx.lines.push(`  ${mark} = call %k_rt_mark @k_rt_mark(ptr %rt)`);
  ctx.lines.push(`  ${callResult} = call %k_result ${functionName}(ptr %rt, ptr ${input})`);
  ctx.lines.push(`  ${status} = extractvalue %k_result ${callResult}, 0`);
  ctx.lines.push(`  ${failed} = icmp ne i32 ${status}, 0`);
  ctx.lines.push(`  br i1 ${failed}, label %${failedDispatchBlock}, label %${successBlock}`);
  ctx.lines.push(`${failedDispatchBlock}:`);
  const isTail = ctx.tempName("tail_status");
  ctx.lines.push(`  ${isTail} = icmp eq i32 ${status}, 2`);
  ctx.lines.push(`  br i1 ${isTail}, label %${tailBlock}, label %${failureBlock}`);
  ctx.lines.push(`${tailBlock}:`);
  ctx.lines.push(`  ret %k_result ${callResult}`);
  ctx.lines.push(`${successBlock}:`);
  const value = ctx.tempName("union_value");
  ctx.lines.push(`  ${value} = extractvalue %k_result ${callResult}, 1`);
  ctx.lines.push(...result(ctx, 0, value));
  if (isLast) {
    ctx.lines.push(`${failureBlock}:`);
    ctx.lines.push(`  call void @k_rt_rewind(ptr %rt, %k_rt_mark ${mark})`);
    ctx.lines.push(...result(ctx, 1));
  } else {
    ctx.lines.push(`${nextBlock}:`);
    ctx.lines.push(`  call void @k_rt_rewind(ptr %rt, %k_rt_mark ${mark})`);
  }
}

function emitUnionFunctionBody(symbol, items, ctx, linkage = "", options = {}) {
  if (!items?.length) {
    unsupported(ctx);
  } else {
    items.forEach((item, index) => {
      unionBranch(ctx, ctx.addSyntheticFunction(item, options.tail === true), "%input", index === items.length - 1);
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

function isTailNeutral(exp) {
  if (exp == null) return false;
  if (exp.op === "identity" || exp.op === "code" || exp.op === "filter") return true;
  return exp.op === "comp" && exp.items.every(isTailNeutral);
}

function isTailSelfRef(exp, ctx) {
  return exp?.op === "ref" && exp.ref === ctx.tailRef;
}

function hasTailSelfRefSuffix(items, index, ctx) {
  let seenSelfRef = false;
  for (let i = index; i < items.length; i++) {
    const item = items[i];
    if (!seenSelfRef && isTailSelfRef(item, ctx)) {
      seenSelfRef = true;
      continue;
    }
    if (!isTailNeutral(item)) return false;
  }
  return seenSelfRef;
}

function lowerTailSelfRef(ctx, input) {
  if (ctx.catchTail) {
    ctx.lines.push(`  store ptr ${input}, ptr ${ctx.tailInputSlot}`);
    ctx.lines.push(`  br label %${ctx.tailLoopBlock}`);
  } else {
    ctx.lines.push(...result(ctx, 2, input));
  }
  return false;
}

function lowerTailSelfProduct(ctx, exp, input) {
  const outputNode = patternNode(ctx, exp.patterns?.[1]);
  const edges = outputNode?.edges;
  if (!Array.isArray(edges) || edges.length !== exp.fields.length) return null;

  const seen = new Set();
  const fields = [];
  for (const field of exp.fields) {
    const edgeIndex = patternEdgeIndex(ctx, exp.patterns?.[1], field.label);
    if (edgeIndex < 0 || seen.has(edgeIndex)) return null;
    seen.add(edgeIndex);
    const child = lowerExpr(ctx, field.expr, input);
    if (child === false || child == null) return child;
    fields.push({ field, edgeIndex, child });
  }
  if (seen.size !== edges.length) return null;

  for (const { field, edgeIndex, child } of fields) {
    const label = ctx.labelRef(field.label);
    ctx.lines.push(`  call void @k_product_set_at(ptr ${input}, i64 ${edgeIndex}, ptr ${label.pointer}, i64 ${label.length}, ptr ${child})`);
  }
  return lowerTailSelfRef(ctx, input);
}

function lowerUnitVariantConstant(ctx, tag) {
  if (tag === "0" || tag === "1") {
    const bit = ctx.tempName("bit");
    ctx.lines.push(`  ${bit} = call ptr @k_bit${tag}(ptr %rt)`);
    nullCheck(ctx, bit);
    return bit;
  }
  const label = ctx.labelRef(tag);
  const variant = ctx.tempName("variant");
  ctx.lines.push(`  ${variant} = call ptr @k_variant_unit_borrowed_n(ptr %rt, ptr ${label.pointer}, i64 ${label.length})`);
  nullCheck(ctx, variant);
  return variant;
}

function lowerExpr(ctx, exp, input = "%input", options = {}) {
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
      if (options.tail === true && exp.ref === ctx.tailRef) {
        return lowerTailSelfRef(ctx, input);
      }
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
      const edgeIndex = patternEdgeIndex(ctx, exp.patterns?.[0], exp.label);
      if (edgeIndex >= 0) {
        ctx.lines.push(`  ${value} = call ptr @k_product_get_at(ptr ${input}, i64 ${edgeIndex})`);
      } else {
        ctx.lines.push(`  ${value} = call ptr @k_product_get_n(ptr ${input}, ptr ${label.pointer}, i64 ${label.length})`);
      }
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
      ctx.lines.push(`  ${variant} = call ptr @k_variant_borrowed_direct_n(ptr %rt, ptr ${label.pointer}, i64 ${label.length}, ptr ${input})`);
      nullCheck(ctx, variant);
      return variant;
    }
    case "comp": {
      let current = input;
      for (let index = 0; index < exp.items.length; index++) {
        const item = exp.items[index];
        const next = exp.items[index + 1];
        if (item?.op === "product" && item.fields.length === 0 && next?.op === "vid") {
          current = lowerUnitVariantConstant(ctx, next.tag);
          index++;
          continue;
        }
        if (options.tail === true && item?.op === "product" && hasTailSelfRefSuffix(exp.items, index + 1, ctx)) {
          const tailProduct = lowerTailSelfProduct(ctx, item, current);
          if (tailProduct !== null) return tailProduct;
        }
        const tail = options.tail === true && exp.items.slice(index + 1).every(isTailNeutral);
        current = lowerExpr(ctx, item, current, { tail });
        if (current === false) return false;
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
        const edgeIndex = patternEdgeIndex(ctx, exp.patterns?.[1], field.label);
        if (edgeIndex >= 0) {
          ctx.lines.push(`  call void @k_product_set_at(ptr ${product}, i64 ${edgeIndex}, ptr ${label.pointer}, i64 ${label.length}, ptr ${child})`);
        } else {
          ctx.lines.push(`  call void @k_product_set_borrowed_n(ptr ${product}, ptr ${label.pointer}, i64 ${label.length}, ptr ${child})`);
        }
      }
      return product;
    }
    case "union": {
      if (!exp.items?.length) return null;
      const functionName = ctx.addUnionFunction(exp.items, options.tail === true);
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

function emitFunctionBody(symbol, body, ctx, linkage = "", options = {}) {
  const input = ctx.catchTail ? "%tail_input" : "%input";
  if (ctx.catchTail) {
    ctx.tailInputSlot = "%tail_input_slot";
    ctx.tailLoopBlock = "tail_loop";
    ctx.lines.push(`  ${ctx.tailInputSlot} = alloca ptr`);
    ctx.lines.push(`  store ptr %input, ptr ${ctx.tailInputSlot}`);
    ctx.lines.push(`  br label %${ctx.tailLoopBlock}`);
    ctx.lines.push(`${ctx.tailLoopBlock}:`);
    ctx.lines.push(`  ${input} = load ptr, ptr ${ctx.tailInputSlot}`);
  }
  const value = lowerExpr(ctx, body, input, { tail: options.tail !== false });
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
    const ctx = createLoweringContext(functionNames, labels, syntheticFunctions, rel.patternGraph || null, {
      refName: name,
      catchTail: true
    });
    return emitFunctionBody(functionNames.get(name), rel.body, ctx, "internal");
  });
  const mainContext = createLoweringContext(functionNames, labels, syntheticFunctions, kirR.entry?.patternGraph || null);
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

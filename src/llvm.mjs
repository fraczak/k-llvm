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
    "declare i32 @k_equal(ptr, ptr)"
  ];
}

function result(status, value = "null") {
  return [
    `  %status = insertvalue %k_result undef, i32 ${status}, 0`,
    `  %result = insertvalue %k_result %status, ptr ${value}, 1`,
    "  ret %k_result %result"
  ];
}

function lowerEntryBody(kirR) {
  const body = kirR.entry?.body;
  if (body?.op === "identity") return result(0, "%input");
  return result(1);
}

export function emitLLVMModule(kirR, options = {}) {
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
    "",
    ...runtimeDeclarations(),
    "",
    "define %k_result @k_main(ptr %rt, ptr %input) {",
    "entry:",
    ...lowerEntryBody(kirR),
    "}",
    ""
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

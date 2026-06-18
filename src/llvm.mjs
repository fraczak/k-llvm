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
    "define i32 @k_main(i32 %input) {",
    "entry:",
    "  ret i32 %input",
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

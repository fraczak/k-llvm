import assert from "node:assert";
import { compileObjectBuffer, decodeObject } from "@fraczak/k/object.mjs";
import { compileObjectToLLVM, emitLLVMModule, llvmIdentifier } from "../src/llvm.mjs";

const object = decodeObject(compileObjectBuffer("()", { source: "llvm-test.k" }));
const { kirR, llvm } = compileObjectToLLVM(object, {
  inputPattern: [["open-product", []]]
});

assert.equal(kirR.layer, "KIR-R");
assert.equal(kirR.relation, "__main__");
assert.match(kirR.instanceKey, /^__main__@[0-9a-f]{16}$/);
assert.match(llvm, /^; k-llvm prototype artifact/m);
assert.match(llvm, /@k_llvm_metadata = private unnamed_addr constant/);
assert.match(llvm, /%k_result = type \{ i32, ptr \}/);
assert.match(llvm, /declare ptr @k_product_get\(ptr, ptr\)/);
assert.match(llvm, /define %k_result @k_main\(ptr %rt, ptr %input\)/);
assert.match(llvm, /insertvalue %k_result undef, i32 0, 0/);
assert.match(llvm, /insertvalue %k_result %status, ptr %input, 1/);

const custom = emitLLVMModule(kirR, { symbol: "rel name!" });
assert.match(custom, /source_filename = "k-llvm:rel_name_"/);
assert.equal(llvmIdentifier("a b/c"), "a_b_c");

console.log("OK");

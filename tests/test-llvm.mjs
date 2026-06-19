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
assert.match(llvm, /insertvalue %k_result %status\d+, ptr %input, 1/);

const custom = emitLLVMModule(kirR, { symbol: "rel name!" });
assert.match(custom, /source_filename = "k-llvm:rel_name_"/);
assert.equal(llvmIdentifier("a b/c"), "a_b_c");

const filterLLVM = emitLLVMModule({
  relation: "__main__",
  instanceKey: "__main__@filter",
  entry: {
    body: {
      op: "filter",
      filter: ["closed-product", []],
      patterns: [0, 0]
    }
  }
});
assert.match(filterLLVM, /insertvalue %k_result %status\d+, ptr %input, 1/);
assert.doesNotMatch(filterLLVM, /k_filter/);

const projectionObject = decodeObject(compileObjectBuffer(".x", { source: "llvm-projection.k" }));
const { llvm: projectionLLVM } = compileObjectToLLVM(projectionObject, {
  inputPattern: [
    ["closed-product", [["x", 1]]],
    ["closed-product", []]
  ]
});
assert.match(projectionLLVM, /@k_label_0 = private unnamed_addr constant \[2 x i8\] c"x\\00"/);
assert.match(projectionLLVM, /call ptr @k_product_get\(ptr %input, ptr %label0\)/);

const productObject = decodeObject(compileObjectBuffer("{ .x fieldA, .y fieldB }", { source: "llvm-product.k" }));
const { llvm: productLLVM } = compileObjectToLLVM(productObject, {
  inputPattern: [
    ["closed-product", [["x", 1], ["y", 2]]],
    ["closed-product", [["valA", 1]]],
    ["closed-product", [["valB", 2]]]
  ]
});
assert.match(productLLVM, /call ptr @k_product\(ptr %rt, i64 2\)/);
assert.match(productLLVM, /call void @k_product_set\(ptr %product\d+, ptr %label\d+, ptr %field\d+\)/);

const variantObject = decodeObject(compileObjectBuffer("|tag", { source: "llvm-variant.k" }));
const { llvm: variantLLVM } = compileObjectToLLVM(variantObject, {
  inputPattern: [["closed-product", []]]
});
assert.match(variantLLVM, /call ptr @k_variant\(ptr %rt, ptr %label\d+, ptr %input\)/);

const variantProjectionObject = decodeObject(compileObjectBuffer("/tag", { source: "llvm-variant-projection.k" }));
const { llvm: variantProjectionLLVM } = compileObjectToLLVM(variantProjectionObject, {
  inputPattern: [
    ["closed-union", [["tag", 1]]],
    ["closed-product", []]
  ]
});
assert.match(variantProjectionLLVM, /call ptr @k_variant_tag\(ptr %input\)/);
assert.match(variantProjectionLLVM, /call i32 @strcmp\(ptr %tag\d+, ptr %label\d+\)/);
assert.match(variantProjectionLLVM, /call ptr @k_variant_payload\(ptr %input\)/);

const compositionObject = decodeObject(compileObjectBuffer("(.x .y)", { source: "llvm-composition.k" }));
const { llvm: compositionLLVM } = compileObjectToLLVM(compositionObject, {
  inputPattern: [
    ["closed-product", [["x", 1]]],
    ["closed-product", [["y", 2]]],
    ["closed-product", []]
  ]
});
assert.match(compositionLLVM, /call ptr @k_product_get\(ptr %input, ptr %label\d+\)/);
assert.match(compositionLLVM, /call ptr @k_product_get\(ptr %field\d+, ptr %label\d+\)/);

console.log("OK");

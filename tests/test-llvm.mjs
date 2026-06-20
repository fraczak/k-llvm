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
assert.match(llvm, /%k_rt_mark = type \{ ptr, i64 \}/);
assert.match(llvm, /%k_result = type \{ i32, ptr \}/);
assert.match(llvm, /declare %k_rt_mark @k_rt_mark\(ptr\)/);
assert.match(llvm, /declare void @k_rt_rewind\(ptr, %k_rt_mark\)/);
assert.match(llvm, /declare ptr @k_bit0\(ptr\)/);
assert.match(llvm, /declare ptr @k_bit1\(ptr\)/);
assert.match(llvm, /declare ptr @k_variant_borrowed_direct_n\(ptr, ptr, i64, ptr\)/);
assert.match(llvm, /declare ptr @k_variant_unit_borrowed_n\(ptr, ptr, i64\)/);
assert.match(llvm, /declare ptr @k_product_get_n\(ptr, ptr, i64\)/);
assert.match(llvm, /declare ptr @k_product_get_at\(ptr, i64\)/);
assert.match(llvm, /declare void @k_product_set_borrowed_n\(ptr, ptr, i64, ptr\)/);
assert.match(llvm, /declare void @k_product_set_at\(ptr, i64, ptr, i64, ptr\)/);
assert.match(llvm, /define %k_result @k_main\(ptr %rt, ptr %input\)/);
assert.match(llvm, /insertvalue %k_result undef, i32 0, 0/);
assert.match(llvm, /insertvalue %k_result %status\d+, ptr %input, 1/);

const custom = emitLLVMModule(kirR, { symbol: "rel name!" });
assert.match(custom, /source_filename = "k-llvm:rel_name_"/);
assert.equal(llvmIdentifier("a b/c"), "a_b_c");

const filterLLVM = emitLLVMModule({
  relation: "__main__",
  instanceKey: "__main__@typed-evidence",
  entry: {
    body: {
      op: "comp",
      items: [
        {
          op: "filter",
          filter: ["closed-product", []],
          patterns: [0, 0]
        },
        {
          op: "code",
          code: "@code",
          patterns: [0, 0]
        }
      ],
      patterns: [0, 0]
    }
  }
});
assert.match(filterLLVM, /insertvalue %k_result %status\d+, ptr %input, 1/);
assert.doesNotMatch(filterLLVM, /k_filter/);
assert.doesNotMatch(filterLLVM, /k_code/);

const projectionObject = decodeObject(compileObjectBuffer(".x", { source: "llvm-projection.k" }));
const { llvm: projectionLLVM } = compileObjectToLLVM(projectionObject, {
  inputPattern: [
    ["closed-product", [["x", 1]]],
    ["closed-product", []]
  ]
});
assert.match(projectionLLVM, /@k_label_0 = private unnamed_addr constant \[2 x i8\] c"x\\00"/);
assert.match(projectionLLVM, /call ptr @k_product_get_at\(ptr %(?:input|tail_input), i64 0\)/);

const productObject = decodeObject(compileObjectBuffer("{ .x fieldA, .y fieldB }", { source: "llvm-product.k" }));
const { llvm: productLLVM } = compileObjectToLLVM(productObject, {
  inputPattern: [
    ["closed-product", [["x", 1], ["y", 2]]],
    ["closed-product", [["valA", 1]]],
    ["closed-product", [["valB", 2]]]
  ]
});
assert.match(productLLVM, /call ptr @k_product\(ptr %rt, i64 2\)/);
assert.match(productLLVM, /call void @k_product_set_at\(ptr %product\d+, i64 \d+, ptr %label\d+, i64 \d+, ptr %field\d+\)/);

const variantObject = decodeObject(compileObjectBuffer("|tag", { source: "llvm-variant.k" }));
const { llvm: variantLLVM } = compileObjectToLLVM(variantObject, {
  inputPattern: [["closed-product", []]]
});
assert.match(variantLLVM, /call ptr @k_variant_borrowed_direct_n\(ptr %rt, ptr %label\d+, i64 3, ptr %(?:input|tail_input)\)/);

const variantProjectionObject = decodeObject(compileObjectBuffer("/tag", { source: "llvm-variant-projection.k" }));
const { llvm: variantProjectionLLVM } = compileObjectToLLVM(variantProjectionObject, {
  inputPattern: [
    ["closed-union", [["tag", 1]]],
    ["closed-product", []]
  ]
});
assert.match(variantProjectionLLVM, /call i32 @k_variant_tag_matches\(ptr %(?:input|tail_input), ptr %label\d+, i64 3\)/);
assert.match(variantProjectionLLVM, /call ptr @k_variant_payload\(ptr %(?:input|tail_input)\)/);

const bitLLVM = emitLLVMModule({
  relation: "__main__",
  instanceKey: "__main__@bit",
  entry: {
    patternGraph: {
      nodes: [
        { id: 0, kind: "closed-product", edges: [] },
        { id: 1, kind: "closed-product", edges: [] },
        { id: 2, kind: "closed-union", edges: [{ label: "1", target: 1 }] }
      ]
    },
    body: {
      op: "comp",
      items: [
        { op: "product", fields: [], patterns: [0, 1] },
        { op: "vid", tag: "1", patterns: [1, 2] }
      ],
      patterns: [0, 2]
    }
  }
});
assert.match(bitLLVM, /call ptr @k_bit1\(ptr %rt\)/);
assert.doesNotMatch(bitLLVM, /call ptr @k_unit\(ptr %rt\)/);
assert.doesNotMatch(bitLLVM, /call ptr @k_variant_borrowed_n\(ptr %rt/);

const unitVariantLLVM = emitLLVMModule({
  relation: "__main__",
  instanceKey: "__main__@unit-variant",
  entry: {
    patternGraph: {
      nodes: [
        { id: 0, kind: "closed-product", edges: [] },
        { id: 1, kind: "closed-product", edges: [] },
        { id: 2, kind: "closed-union", edges: [{ label: "nil", target: 1 }] }
      ]
    },
    body: {
      op: "comp",
      items: [
        { op: "product", fields: [], patterns: [0, 1] },
        { op: "vid", tag: "nil", patterns: [1, 2] }
      ],
      patterns: [0, 2]
    }
  }
});
assert.match(unitVariantLLVM, /call ptr @k_variant_unit_borrowed_n\(ptr %rt, ptr %label\d+, i64 3\)/);
assert.doesNotMatch(unitVariantLLVM, /call ptr @k_unit\(ptr %rt\)/);

const compositionObject = decodeObject(compileObjectBuffer("(.x .y)", { source: "llvm-composition.k" }));
const { llvm: compositionLLVM } = compileObjectToLLVM(compositionObject, {
  inputPattern: [
    ["closed-product", [["x", 1]]],
    ["closed-product", [["y", 2]]],
    ["closed-product", []]
  ]
});
assert.match(compositionLLVM, /call ptr @k_product_get_at\(ptr %(?:input|tail_input), i64 0\)/);
assert.match(compositionLLVM, /call ptr @k_product_get_at\(ptr %field\d+, i64 0\)/);

const relationObject = decodeObject(compileObjectBuffer("pick = .x; {.a pick left, .b pick right}", { source: "llvm-relation.k" }));
const { llvm: relationLLVM } = compileObjectToLLVM(relationObject, {
  inputPattern: [
    ["open-product", [["a", 1], ["b", 2]]],
    ["open-product", [["x", 3]]],
    ["open-product", [["x", 4]]],
    ["closed-product", []],
    ["closed-product", []]
  ]
});
assert.match(relationLLVM, /define internal %k_result @k_rel_pick_\d+\(ptr %rt, ptr %input\)/);
assert.match(relationLLVM, /call %k_result @k_rel_pick_\d+\(ptr %rt, ptr %field\d+\)/);
assert.match(relationLLVM, /extractvalue %k_result %call\d+, 0/);
assert.match(relationLLVM, /extractvalue %k_result %call\d+, 1/);

const emptyLLVM = emitLLVMModule({
  relation: "__main__",
  instanceKey: "__main__@empty",
  entry: {
    body: {
      op: "empty",
      patterns: [0, 1]
    }
  }
});
assert.match(emptyLLVM, /insertvalue %k_result undef, i32 1, 0/);

const unionObject = decodeObject(compileObjectBuffer("< /x |left, /y |right >", { source: "llvm-union.k" }));
const { llvm: unionLLVM } = compileObjectToLLVM(unionObject, {
  inputPattern: [
    ["closed-union", [["x", 1], ["y", 2]]],
    ["closed-product", []],
    ["closed-product", []]
  ]
});
assert.match(unionLLVM, /define internal %k_result @k_union_arm_0\(ptr %rt, ptr %input\)/);
assert.match(unionLLVM, /define internal %k_result @k_union_arm_1\(ptr %rt, ptr %input\)/);
assert.match(unionLLVM, /call %k_result @k_union_arm_0\(ptr %rt, ptr %input\)/);
assert.match(unionLLVM, /call %k_result @k_union_arm_1\(ptr %rt, ptr %input\)/);
assert.match(unionLLVM, /call %k_rt_mark @k_rt_mark\(ptr %rt\)/);
assert.match(unionLLVM, /call void @k_rt_rewind\(ptr %rt, %k_rt_mark %mark\d+\)/);

const nestedUnionObject = decodeObject(compileObjectBuffer("{ < /x |left, /y |right > z }", { source: "llvm-nested-union.k" }));
const { llvm: nestedUnionLLVM } = compileObjectToLLVM(nestedUnionObject, {
  inputPattern: [
    ["closed-union", [["x", 1], ["y", 2]]],
    ["closed-product", []],
    ["closed-product", []]
  ]
});
assert.match(nestedUnionLLVM, /define internal %k_result @k_union_expr_\d+\(ptr %rt, ptr %input\)/);
assert.match(nestedUnionLLVM, /call %k_result @k_union_expr_\d+\(ptr %rt, ptr %(?:input|tail_input)\)/);
assert.match(nestedUnionLLVM, /call void @k_product_set_at\(ptr %product\d+, i64 0, ptr %label\d+, i64 1, ptr %union_value\d+\)/);
assert.doesNotMatch(nestedUnionLLVM, /ptr false/);

console.log("OK");

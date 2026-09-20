/**
 * Unit tests for the AST-based proof cache engine, fingerprinting, and normalization.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseTypeScript,
  fingerprintAstNode,
  serializeAstNormalized,
  fingerprintTargetUnit,
  fingerprintTestUnit,
  findTargetUnitNode,
  findTestUnitNode,
  sha256Hex,
} from "../src/proof/fingerprint.js";
import {
  evaluateContracts,
  computeFileDecisions,
  loadContracts,
  loadManifest,
  saveManifest,
} from "../src/proof/engine.js";
import type { ProofContract, ProofManifest } from "../src/proof/types.js";

describe("AST Normalization & Fingerprinting", () => {
  it("generates identical fingerprints despite comment variations", async () => {
    const codeClean = `
      export function add(a: number, b: number): number {
        return a + b;
      }
    `;

    const codeWithComments = `
      /**
       * Add two numbers together.
       * @param a first number
       * @param b second number
       */
      export function add(a: number, b: number): number {
        // Compute the sum
        /* inline block comment */
        return a + b; // trailing comment
      }
    `;

    const fpClean = await fingerprintTargetUnit(codeClean, {
      targetFile: "dummy.ts",
      targetKind: "function",
      targetName: "add",
    });

    const fpComments = await fingerprintTargetUnit(codeWithComments, {
      targetFile: "dummy.ts",
      targetKind: "function",
      targetName: "add",
    });

    assert.ok(fpClean);
    assert.ok(fpComments);
    assert.equal(fpClean.fingerprint, fpComments.fingerprint);
  });

  it("generates identical fingerprints despite formatting and whitespace differences", async () => {
    const codeCompact = `function multiply(x: number, y: number) { return x * y; }`;

    const codeSparse = `
      function multiply(
        x: number,
        y: number,
      ) {

        return x * y;

      }
    `;

    const fp1 = await fingerprintTargetUnit(codeCompact, {
      targetFile: "dummy.ts",
      targetKind: "function",
      targetName: "multiply",
    });

    const fp2 = await fingerprintTargetUnit(codeSparse, {
      targetFile: "dummy.ts",
      targetKind: "function",
      targetName: "multiply",
    });

    assert.ok(fp1);
    assert.ok(fp2);
    assert.equal(fp1.fingerprint, fp2.fingerprint);
  });

  it("generates identical fingerprints with trailing commas and semicolon differences", async () => {
    const code1 = `
      function getObj() {
        return { a: 1, b: 2 };
      }
    `;

    const code2 = `
      function getObj() {
        return {
          a: 1,
          b: 2,
        }
      }
    `;

    const fp1 = await fingerprintTargetUnit(code1, {
      targetFile: "dummy.ts",
      targetKind: "function",
      targetName: "getObj",
    });

    const fp2 = await fingerprintTargetUnit(code2, {
      targetFile: "dummy.ts",
      targetKind: "function",
      targetName: "getObj",
    });

    assert.ok(fp1);
    assert.ok(fp2);
    assert.equal(fp1.fingerprint, fp2.fingerprint);
  });

  it("invalidates fingerprint on semantic code changes", async () => {
    const baseCode = `
      export function validateAge(age: number): boolean {
        return age >= 18 && age <= 120;
      }
    `;

    const changedOperator = `
      export function validateAge(age: number): boolean {
        return age > 18 && age <= 120;
      }
    `;

    const changedLiteral = `
      export function validateAge(age: number): boolean {
        return age >= 21 && age <= 120;
      }
    `;

    const changedLogic = `
      export function validateAge(age: number): boolean {
        return age >= 18 || age <= 120;
      }
    `;

    const changedIdentifier = `
      export function validateAge(years: number): boolean {
        return years >= 18 && years <= 120;
      }
    `;

    const spec = { targetFile: "dummy.ts", targetKind: "function" as const, targetName: "validateAge" };

    const fpBase = await fingerprintTargetUnit(baseCode, spec);
    const fpOp = await fingerprintTargetUnit(changedOperator, spec);
    const fpLit = await fingerprintTargetUnit(changedLiteral, spec);
    const fpLog = await fingerprintTargetUnit(changedLogic, spec);
    const fpId = await fingerprintTargetUnit(changedIdentifier, spec);

    assert.ok(fpBase);
    assert.ok(fpOp);
    assert.ok(fpLit);
    assert.ok(fpLog);
    assert.ok(fpId);

    assert.notEqual(fpBase.fingerprint, fpOp.fingerprint);
    assert.notEqual(fpBase.fingerprint, fpLit.fingerprint);
    assert.notEqual(fpBase.fingerprint, fpLog.fingerprint);
    assert.notEqual(fpBase.fingerprint, fpId.fingerprint);
  });
});

describe("Unit Extraction by Kind", () => {
  const code = `
    export function topFunction(a: string) { return a.toLowerCase(); }
    export const arrowFn = (b: number) => b * 10;
    export class Service {
      runMethod(c: boolean) { return !c; }
    }
  `;

  it("extracts function declarations", async () => {
    const fp = await fingerprintTargetUnit(code, {
      targetFile: "dummy.ts",
      targetKind: "function",
      targetName: "topFunction",
    });
    assert.ok(fp);
    assert.ok(fp.serialized.includes("identifier:topFunction"));
  });

  it("extracts arrow functions declared with const", async () => {
    const fp = await fingerprintTargetUnit(code, {
      targetFile: "dummy.ts",
      targetKind: "arrow_function",
      targetName: "arrowFn",
    });
    assert.ok(fp);
    assert.ok(fp.serialized.includes("identifier:arrowFn"));
  });

  it("extracts class declarations", async () => {
    const fp = await fingerprintTargetUnit(code, {
      targetFile: "dummy.ts",
      targetKind: "class",
      targetName: "Service",
    });
    assert.ok(fp);
    assert.ok(fp.serialized.includes("class_declaration"));
    assert.ok(fp.serialized.includes("identifier:Service"));
  });

  it("extracts method definitions inside classes", async () => {
    const fp = await fingerprintTargetUnit(code, {
      targetFile: "dummy.ts",
      targetKind: "method",
      targetName: "runMethod",
    });
    assert.ok(fp);
    assert.ok(fp.serialized.includes("method_definition"));
    assert.ok(fp.serialized.includes("property_identifier:runMethod"));
  });

  it("extracts multi_function clusters", async () => {
    const fp = await fingerprintTargetUnit(code, {
      targetFile: "dummy.ts",
      targetKind: "multi_function",
      targetName: "topFunction",
      additionalNames: ["arrowFn"],
    });
    assert.ok(fp);
    assert.ok(fp.serialized.startsWith("multi_unit("));
  });

  it("fails closed when target unit does not exist in AST", async () => {
    const fp = await fingerprintTargetUnit(code, {
      targetFile: "dummy.ts",
      targetKind: "function",
      targetName: "nonExistentFunction",
    });
    assert.equal(fp, null);
  });
});

describe("Test Block Extraction", () => {
  const testCode = `
    import { describe, it } from "node:test";
    import assert from "node:assert/strict";

    describe("validator suite", () => {
      it("validates input", () => {
        assert.equal(1, 1);
      });
    });

    describe("second suite", () => {
      it("checks second", () => {
        assert.equal(2, 2);
      });
    });
  `;

  it("extracts describe blocks by pattern", async () => {
    const contract: ProofContract = {
      id: "test.val",
      testFile: "dummy.test.ts",
      testPattern: "validator suite",
      testKind: "describe",
      target: {
        targetFile: "dummy.ts",
        targetKind: "function",
        targetName: "add",
      },
      bounded: true,
    };

    const fp = await fingerprintTestUnit(testCode, contract);
    assert.ok(fp);
    assert.ok(fp.serialized.includes("string_fragment:validator suite"));
  });

  it("detects modifications in test blocks", async () => {
    const modifiedTestCode = `
      import { describe, it } from "node:test";
      import assert from "node:assert/strict";

      describe("validator suite", () => {
        it("validates input", () => {
          assert.equal(1, 2); // changed assertion
        });
      });
    `;

    const contract: ProofContract = {
      id: "test.val",
      testFile: "dummy.test.ts",
      testPattern: "validator suite",
      testKind: "describe",
      target: {
        targetFile: "dummy.ts",
        targetKind: "function",
        targetName: "add",
      },
      bounded: true,
    };

    const fp1 = await fingerprintTestUnit(testCode, contract);
    const fp2 = await fingerprintTestUnit(modifiedTestCode, contract);

    assert.ok(fp1);
    assert.ok(fp2);
    assert.notEqual(fp1.fingerprint, fp2.fingerprint);
  });

  it("fails closed when test block is not found", async () => {
    const contract: ProofContract = {
      id: "test.missing",
      testFile: "dummy.test.ts",
      testPattern: "nonExistentDescribe",
      testKind: "describe",
      target: {
        targetFile: "dummy.ts",
        targetKind: "function",
        targetName: "add",
      },
      bounded: true,
    };

    const fp = await fingerprintTestUnit(testCode, contract);
    assert.equal(fp, null);
  });
});

describe("Proof Engine & Skip Decisions", () => {
  it("correctly computes skip decisions for eligible and ineligible files", () => {
    const contracts: ProofContract[] = [
      {
        id: "c1",
        testFile: "tests/foo.test.ts",
        testPattern: "foo",
        testKind: "describe",
        target: { targetFile: "src/foo.ts", targetKind: "function", targetName: "foo" },
        bounded: true,
      },
      {
        id: "c2",
        testFile: "tests/foo.test.ts",
        testPattern: "bar",
        testKind: "describe",
        target: { targetFile: "src/foo.ts", targetKind: "function", targetName: "bar" },
        bounded: true,
      },
    ];

    const evalsValid = [
      {
        contractId: "c1",
        contract: contracts[0],
        status: "VALID_CACHED" as const,
        canSkip: true,
        reason: "Valid",
      },
      {
        contractId: "c2",
        contract: contracts[1],
        status: "VALID_CACHED" as const,
        canSkip: true,
        reason: "Valid",
      },
    ];

    const files = ["testbuild/tests/foo.test.js", "testbuild/tests/server.test.js"];
    const decisions = computeFileDecisions(files, evalsValid);

    assert.equal(decisions.length, 2);

    const fooDec = decisions.find((d) => d.testBuildFile === "testbuild/tests/foo.test.js");
    assert.ok(fooDec);
    assert.equal(fooDec.eligible, true);
    assert.equal(fooDec.canSkip, true);
    assert.equal(fooDec.validContracts, 2);

    const serverDec = decisions.find((d) => d.testBuildFile === "testbuild/tests/server.test.js");
    assert.ok(serverDec);
    assert.equal(serverDec.eligible, false);
    assert.equal(serverDec.canSkip, false);
    assert.ok(serverDec.reason.includes("Ineligible"));
  });

  it("refuses to skip a file if even one unit proof is stale", () => {
    const contracts: ProofContract[] = [
      {
        id: "c1",
        testFile: "tests/foo.test.ts",
        testPattern: "foo",
        testKind: "describe",
        target: { targetFile: "src/foo.ts", targetKind: "function", targetName: "foo" },
        bounded: true,
      },
      {
        id: "c2",
        testFile: "tests/foo.test.ts",
        testPattern: "bar",
        testKind: "describe",
        target: { targetFile: "src/foo.ts", targetKind: "function", targetName: "bar" },
        bounded: true,
      },
    ];

    const evalsPartial = [
      {
        contractId: "c1",
        contract: contracts[0],
        status: "VALID_CACHED" as const,
        canSkip: true,
        reason: "Valid",
      },
      {
        contractId: "c2",
        contract: contracts[1],
        status: "STALE_CODE_CHANGED" as const,
        canSkip: false,
        reason: "Code unit changed",
      },
    ];

    const files = ["testbuild/tests/foo.test.js"];
    const decisions = computeFileDecisions(files, evalsPartial);

    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].eligible, true);
    assert.equal(decisions[0].canSkip, false);
    assert.equal(decisions[0].validContracts, 1);
    assert.equal(decisions[0].staleContracts, 1);
  });
});

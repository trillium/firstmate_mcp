/**
 * Unit tests for src/envelope.ts — the single internal result shape.
 * Contract referee: adapter/envelope.py via tests/mcp-adapter.test.py.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { err, isErr, isOk, ok } from "../src/envelope.js";

describe("ok envelope", () => {
  it("carries exactly one shape for success", () => {
    const result = ok({ snapshot: { a: 1 } });
    assert.equal(result.ok, true);
    assert.deepEqual(result["snapshot"], { a: 1 });
    assert.equal(isOk(result), true);
    assert.equal(isErr(result), false);
  });
  it("defaults to bare success", () => {
    const result = ok();
    assert.equal(isOk(result), true);
  });
});

describe("err envelope", () => {
  it("carries a stable code, a message, and extras", () => {
    const result = err("unknown-tool", "unknown tool: nope", {
      expect: "a known tool name",
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "unknown-tool");
    assert.equal(result.error.message, "unknown tool: nope");
    assert.equal(result.error["expect"], "a known tool name");
    assert.equal(isErr(result), true);
    assert.equal(isOk(result), false);
  });
  it("rejects non-envelopes", () => {
    assert.equal(isOk({}), false);
    assert.equal(isErr(null), false);
    assert.equal(isErr("nope"), false);
  });
});

/**
 * Unit tests for src/runner.ts — the fail-closed subprocess runner.
 *
 * Uses small timeoutS overrides so the timeout path is proved in ~1s
 * instead of waiting out the 30s server budget. Uses /bin/sleep
 * absolutely (bare `sleep` may be a guard shim).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRunResult, runScript } from "../src/runner.js";

describe("runScript timeout", () => {
  it("reports a typed timeout error when the budget fires", { timeout: 30000 }, async () => {
    const res = await runScript(["/bin/sleep", "5"], { timeoutS: 1 });
    assert.deepEqual(res, { error: "timed out", timeout_s: 1 });
  });
  it("a killed child close never surfaces as a downstream failure", { timeout: 30000 }, async () => {
    // Regression: the SIGTERM-killed shell's close event (exitCode null)
    // routinely beats the kill-grace wait; the run must still answer the
    // typed timeout error, never a result shaped like a script failure.
    for (let i = 0; i < 3; i++) {
      const res = await runScript(["/bin/sleep", "5"], { timeoutS: 1 });
      assert.equal(isRunResult(res), false);
      assert.deepEqual(res, { error: "timed out", timeout_s: 1 });
    }
  });
  it("fast commands still resolve as results", { timeout: 30000 }, async () => {
    const res = await runScript(["/bin/echo", "hi"], { timeoutS: 10 });
    assert.equal(isRunResult(res), true);
    if (isRunResult(res)) {
      assert.equal(res.exitCode, 0);
      assert.equal(res.stdout.trim(), "hi");
    }
  });
});

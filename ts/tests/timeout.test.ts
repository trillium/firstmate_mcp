/**
 * Subprocess timeout, server envelope budget, and process group kill proofs.
 *
 * Covers:
 * 1. Low-level fail-closed runner timeouts (runScript timeout).
 * 2. MCP server fail-closed budget: slow calls time out inside 30s.
 * 3. Process group isolation: timeout kills the entire process group, leaving no orphan compute.
 *
 * NOTE: These are live timing/kill proofs. They must NEVER be cached or skipped.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isRunResult, runScript } from "../src/runner.js";
import {
  Client,
  isError,
  makeEnvelopeStubHome,
  makeOrphanStubHome,
  payload,
  removeHome,
} from "./helpers.js";

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

describe("fail-closed budget: slow calls time out inside 30s", () => {
  let ebox: Client;
  let envelope: string;
  before(() => {
    envelope = makeEnvelopeStubHome();
    ebox = new Client({ FM_HOME: envelope });
  });
  after(async () => {
    await ebox.close();
    removeHome(envelope);
  });

  it("slow snapshot fails closed with a typed timeout", { timeout: 60000 }, async () => {
    const started = Date.now();
    const resp = await ebox.call("fleet_snapshot", {});
    const elapsedS = (Date.now() - started) / 1000;
    const snap = payload(resp);
    assert.equal(isError(resp), true);
    assert.equal(snap["error"], "timed out");
    assert.equal(snap["timeout_s"], 30);
    assert.ok(elapsedS >= 30 && elapsedS < 45, `no call blocks past 30s, took ${elapsedS.toFixed(1)}s`);
  });
  it("timed-out call is audited as allow with the failure in the payload", async () => {
    const lines = fs
      .readFileSync(path.join(envelope, "state", "mcp-audit.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(
      lines.some((l) => l["tool"] === "fleet_snapshot" && l["decision"] === "allow"),
      "expected an allow audit line for the timed-out fleet_snapshot",
    );
  });
  it("backlog derives counts from a >128KB snapshot", async () => {
    const back = payload(await ebox.call("backlog", {}));
    assert.equal(
      ((back["task_counts"] as Record<string, unknown>)["total"] as number),
      800,
    );
  });
  it("fleet_poll bounds output from a >128KB snapshot", async () => {
    const resp = await ebox.call("fleet_poll", { count: 1, interval_s: 0 });
    const polled = payload(resp);
    assert.equal(isError(resp), false);
    assert.equal(((polled["polls"] as unknown[]) ?? []).length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(polled), "utf8") <= 8192);
  });
});

describe("timeout kills the whole process group", () => {
  let obox: Client;
  let orphanHome: string;
  before(() => {
    orphanHome = makeOrphanStubHome();
    obox = new Client({ FM_HOME: orphanHome });
  });
  after(async () => {
    await obox.close();
    removeHome(orphanHome);
  });

  it("timed-out group leaves no orphan compute", { timeout: 90000 }, async () => {
    const started = Date.now();
    const resp = await obox.call("fleet_snapshot", {});
    assert.equal(isError(resp), true);
    assert.equal(payload(resp)["error"], "timed out");
    while (Date.now() - started < 40000) await sleepMs(1000);
    assert.equal(fs.existsSync(path.join(orphanHome, "orphan-marker")), false);
  });
});

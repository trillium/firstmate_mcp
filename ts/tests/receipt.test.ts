/**
 * Asynchronous receipts lifecycle, isolation, and expiry proofs.
 *
 * Covers:
 * 1. Immediate detachment with pending receipt.
 * 2. Background task completion and large result attachment (>128KB).
 * 3. Error attachment on failure.
 * 4. Auth & traversal protection.
 * 5. Isolation across different homes.
 * 6. TTL expiry and eviction.
 *
 * NOTE: These are live lifecycle proofs. They must NEVER be cached or skipped.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  Client,
  isError,
  makeEnvelopeStubHome,
  makeReceiptStubHome,
  payload,
  removeHome,
} from "./helpers.js";

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("async receipts: submit, lifecycle, isolation, expiry", () => {
  let rbox: Client;
  let receiptHome: string;
  let envelopeHome: string;
  let other: Client;
  before(() => {
    receiptHome = makeReceiptStubHome();
    rbox = new Client({ FM_HOME: receiptHome });
    envelopeHome = makeEnvelopeStubHome();
    other = new Client({ FM_HOME: envelopeHome });
  });
  after(async () => {
    await rbox.close();
    await other.close();
    removeHome(receiptHome);
    removeHome(envelopeHome);
  });

  let receiptId = "";
  it("receipt_submit detaches immediately with a pending receipt", { timeout: 30000 }, async () => {
    const started = Date.now();
    const resp = await rbox.call("receipt_submit", { tool: "fleet_snapshot", arguments: {} });
    const elapsedS = (Date.now() - started) / 1000;
    const sub = payload(resp);
    assert.equal(isError(resp), false);
    assert.equal(sub["status"], "pending");
    assert.ok(String(sub["receipt_id"]).startsWith("rcpt-"));
    assert.equal(sub["ttl_s"], 3600);
    assert.ok(elapsedS < 10, `submit must return far inside 30s, took ${elapsedS.toFixed(1)}s`);
    assert.deepEqual(sub["check"], {
      tool: "receipt_status",
      arguments: { receipt_id: sub["receipt_id"] },
    });
    receiptId = sub["receipt_id"] as string;
  });
  it("receipt reaches done with the >128KB result attached", { timeout: 150000 }, async () => {
    let done: Record<string, unknown> | null = null;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const state = payload(await rbox.call("receipt_status", { receipt_id: receiptId }));
      if (state["status"] !== "running") {
        done = state;
        break;
      }
      await sleepMs(2000);
    }
    assert.ok(done !== null, "receipt never left running");
    assert.equal(done["status"], "done");
    const result = done["result"] as Record<string, unknown>;
    assert.equal(result["generated"], "envelope-slow-large");
    assert.equal(((result["tasks"] as unknown[]) ?? []).length, 800);
  });
  it("failed receipt attaches its error record", { timeout: 60000 }, async () => {
    const sub = payload(
      await rbox.call("receipt_submit", { tool: "status_tail", arguments: { id: "../escape" } }),
    );
    let failed: Record<string, unknown> | null = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = payload(
        await rbox.call("receipt_status", { receipt_id: sub["receipt_id"] as string }),
      );
      if (state["status"] !== "running") {
        failed = state;
        break;
      }
      await sleepMs(500);
    }
    assert.ok(failed !== null, "receipt never left running");
    assert.equal(failed["status"], "failed");
    assert.ok(String(JSON.stringify(failed["error_record"])).includes("invalid id"));
  });
  it("submit refuses unknown tools and missing nested approval", async () => {
    assert.equal(isError(await rbox.call("receipt_submit", { tool: "nope", arguments: {} })), true);
    const resp = await rbox.call("receipt_submit", {
      tool: "lifecycle_interrupt",
      arguments: { id: "x" },
    });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("status rejects traversal receipt ids", async () => {
    assert.equal(isError(await rbox.call("receipt_status", { receipt_id: "../escape" })), true);
  });
  it("receipts never leak across homes", async () => {
    const resp = await other.call("receipt_status", { receipt_id: receiptId });
    assert.ok(isError(resp));
    assert.equal(payload(resp)["error"], "unknown receipt");
  });
  it("expired receipts report expired with their TTL and are removed", async () => {
    const expiredId = "rcpt-expired-proof";
    const dir = path.join(receiptHome, "state", "mcp-receipts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${expiredId}.json`),
      JSON.stringify({
        receipt_id: expiredId, tool: "fleet_snapshot", status: "done",
        created: "stub", created_epoch: Date.now() / 1000 - 7200,
        ttl_s: 3600, result: {},
      }),
    );
    const resp = await rbox.call("receipt_status", { receipt_id: expiredId });
    assert.ok(isError(resp));
    assert.equal(payload(resp)["error"], "receipt expired");
    assert.equal(payload(resp)["ttl_s"], 3600);
    assert.equal(fs.existsSync(path.join(dir, `${expiredId}.json`)), false);
  });
});

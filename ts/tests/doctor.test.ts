/**
 * Unit tests for doctor — the doorway's self-check on a home.
 *
 * Built after two silent failures: 18 of 55 declared contracts have no script on
 * the served fork line, and the orientation cache expired an hour after it was
 * warmed so reads quietly became 35s timeouts. Both were found by measuring from
 * outside. doctor makes the same facts visible from inside, to any client.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  RECEIPT_TIMEOUT_S,
  SNAPSHOT_DIRNAME,
  SNAPSHOT_TTL_S,
  SUBPROCESS_TIMEOUT_S,
} from "../src/constants.js";
import { TOOL_TIERS, TIER_OPEN } from "../src/auth.js";
import { TOOLS, toolDoctor, type ToolContext } from "../src/tools.js";
import { mintGrant, revokeGrant } from "../src/grants.js";
import { makeStubHome, removeHome } from "./helpers.js";

function ctxFor(home: string): ToolContext {
  return {
    binDir: path.join(home, "bin"),
    stateDir: path.join(home, "state"),
    dataDir: path.join(home, "data"),
    run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
}

function cacheSnapshot(home: string, id: string, ageS: number): void {
  const dir = path.join(home, "state", SNAPSHOT_DIRNAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      snapshot_id: id,
      created: "2026-09-22T00:00:00Z",
      created_epoch: Date.now() / 1000 - ageS,
      ttl_s: SNAPSHOT_TTL_S,
      snapshot: { schema: "fm-fleet-snapshot.v1", generated: "x", backlog: {}, tasks: [] },
    }),
  );
}

describe("doctor", () => {
  it("is an open read with no required arguments", () => {
    assert.equal(TOOL_TIERS["doctor"], TIER_OPEN);
    assert.deepEqual(TOOLS["doctor"].inputSchema["required"], undefined);
  });

  it("reports bindings, budgets, the surface, and authority state", async () => {
    const home = makeStubHome();
    try {
      const res = await toolDoctor({}, ctxFor(home));
      assert.equal(res.isError, false, JSON.stringify(res.payload));
      const p = res.payload as Record<string, never>;
      assert.equal((p["bindings"] as Record<string, unknown>)["bin_dir"], path.join(home, "bin"));
      assert.equal((p["budgets"] as Record<string, unknown>)["subprocess_timeout_s"], SUBPROCESS_TIMEOUT_S);
      assert.equal((p["budgets"] as Record<string, unknown>)["receipt_timeout_s"], RECEIPT_TIMEOUT_S);
      const authority = p["authority"] as Record<string, unknown>;
      assert.equal(authority["tools_registered"], Object.keys(TOOLS).length);
      assert.equal(
        (authority["tier_counts"] as Record<string, number>)["open"],
        Object.values(TOOL_TIERS).filter((t) => t === TIER_OPEN).length,
      );
      assert.ok(Number(authority["code_forbidden"]) > 0, "the forbidden set must be reported");
    } finally {
      removeHome(home);
    }
  });

  it("names dead contracts instead of hiding them", async () => {
    const home = makeStubHome();
    try {
      const res = await toolDoctor({}, ctxFor(home));
      const contracts = (res.payload as Record<string, unknown>)["contracts"] as Record<string, unknown>;
      assert.equal(
        contracts["index_read"],
        true,
        "schema/contracts.index.json must be readable from the checkout",
      );
      assert.ok(
        Number(contracts["total"]) > 60,
        `expected the full declared surface (matrix.md alone hid the decision family), saw ${contracts["total"]}`,
      );
      // The stub home ships a script per tool but not every upstream command, so
      // there must be dead ones to report — that is the point of the check.
      assert.ok(Array.isArray(contracts["dead"]));
      assert.equal(
        Number(contracts["resolvable"]) + (contracts["dead"] as string[]).length,
        Number(contracts["total"]),
      );
    } finally {
      removeHome(home);
    }
  });

  it("reports a stale snapshot rather than assuming warmth", async () => {
    const home = makeStubHome();
    try {
      cacheSnapshot(home, "snap-doctor0000001", SNAPSHOT_TTL_S * 3);
      const res = await toolDoctor({}, ctxFor(home));
      const snap = ((res.payload as Record<string, unknown>)["freshness"] as Record<string, unknown>)[
        "snapshot"
      ] as Record<string, unknown>;
      assert.equal(snap["cached"], true);
      assert.equal(snap["stale"], true);
      assert.ok(Number(snap["age_s"]) > SNAPSHOT_TTL_S);
      assert.equal((res.payload as Record<string, unknown>)["status"], "degraded");
    } finally {
      removeHome(home);
    }
  });

  it("degrades with named reasons on a bare home and stays a non-error read", async () => {
    const home = makeStubHome();
    try {
      const res = await toolDoctor({}, ctxFor(home));
      assert.equal(res.isError, false, "a degraded verdict is an answer, not a failure");
      const reasons = (res.payload as Record<string, unknown>)["reasons"] as string[];
      assert.equal((res.payload as Record<string, unknown>)["status"], "degraded");
      assert.ok(reasons.some((r) => /snapshot/.test(r)), `expected a snapshot reason, saw ${reasons}`);
      assert.ok(reasons.some((r) => /ledger/.test(r)), `expected a ledger reason, saw ${reasons}`);
      assert.ok(reasons.some((r) => /grant/.test(r)), `expected a grant reason, saw ${reasons}`);
    } finally {
      removeHome(home);
    }
  });
});

describe("doctor: grant counting", () => {
  it("counts only usable grants, never revoked or expired records", async () => {
    const home = makeStubHome();
    try {
      const ctx = ctxFor(home);
      const minted = mintGrant(
        { grantee: "doctor-test", tier_limit: 3, ttl_s: 3600, note: "usable" },
        ctx,
      );
      let res = await toolDoctor({}, ctx);
      let authority = (res.payload as Record<string, unknown>)["authority"] as Record<string, unknown>;
      assert.equal(authority["active_grants"], 1);

      revokeGrant(minted.grant_id, "doctor test", ctx);
      res = await toolDoctor({}, ctx);
      authority = (res.payload as Record<string, unknown>)["authority"] as Record<string, unknown>;
      assert.equal(
        authority["active_grants"],
        0,
        "a revoked grant must not be reported as active (caught live on the served home)",
      );
      const reasons = (res.payload as Record<string, unknown>)["reasons"] as string[];
      assert.ok(reasons.some((r) => /grant/.test(r)), `expected a grant reason, saw ${reasons}`);
    } finally {
      removeHome(home);
    }
  });
});

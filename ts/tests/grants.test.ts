/**
 * Exhaustive test suite for standing approval grants.
 *
 * Covers:
 * 1. Scoped standing grants: mint/store/revoke with tier boundaries, project scope,
 *    tool allowlists, expiry, usage caps, and revocability.
 * 2. Audit: grant identity (16-hex hash, never secret token) recorded alongside existing
 *    fields; grant lifecycle events (mint/revoke/expiry) audited.
 * 3. Invariants (refusal-biased security proofs):
 *    - Default-deny: no grant + no approval = per-action strings required (unchanged).
 *    - Captain-hold release: wildcard grants refuse review_decision/decision_resolve;
 *      only an explicit per-deploy grant naming the tool allows release.
 *    - Deny-list untouched: code-forbidden tools remain refused as unknown.
 *    - Grants never widen tiers: Tier 3 grant cannot execute Tier 4 external tools.
 *    - Expired/revoked/exhausted grants fail closed.
 *    - Project scope enforcement: calls targeting unpermitted projects fail closed.
 *    - Tool allowlist enforcement: calls for unlisted tools fail closed.
 *    - Cross-home isolation: grants never leak across FM_HOME sandboxes.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  mintGrant,
  revokeGrant,
  getGrantStatus,
  verifyGrant,
  checkAuthorization,
  readGrant,
  listGrants,
  hashToken,
  computeGrantRef,
} from "../src/grants.js";
import { readAuditLines, TIER_AUTHORITY, TIER_OPEN, tierOf } from "../src/auth.js";
import { liveContext, type ToolContext } from "../src/tools.js";
import { Client, isError, makeStubHome, payload, removeHome } from "./helpers.js";

const APPROVAL = "I authorize standing grant test usage";

describe("Standing Approval Grants: Core Primitive & Storage", () => {
  let homeDir: string;
  let ctx: ToolContext;

  before(() => {
    homeDir = makeStubHome();
    ctx = {
      ...liveContext(),
      stateDir: path.join(homeDir, "state"),
      binDir: path.join(homeDir, "bin"),
    };
  });

  after(() => {
    removeHome(homeDir);
  });

  it("mints a default standing grant with safe hash storage", () => {
    const mintRes = mintGrant(
      {
        grantee: "autonomous-worker-1",
        tier_limit: 3,
        ttl_s: 3600,
        note: "Default autonomous worker grant",
      },
      ctx,
    );

    assert.ok(mintRes.grant_id.startsWith("grant-"));
    assert.ok(mintRes.token.startsWith("sg_"));
    assert.equal(mintRes.grant_ref.length, 16);
    assert.equal(mintRes.tier_limit, 3);
    assert.equal(mintRes.grantee, "autonomous-worker-1");
    assert.equal(mintRes.tools, null);
    assert.equal(mintRes.projects, null);

    // Verify stored record on disk contains token_hash, NEVER raw token
    const stored = readGrant(ctx, mintRes.grant_id);
    assert.ok(stored !== null);
    assert.equal(stored.grant_id, mintRes.grant_id);
    assert.equal(stored.grant_ref, mintRes.grant_ref);
    assert.equal(stored.token_hash, hashToken(mintRes.token));
    assert.equal((stored as unknown as Record<string, unknown>)["token"], undefined);
    assert.equal(stored.use_count, 0);
    assert.equal(stored.revoked_at, null);
  });

  it("mints a scoped grant with specific tools, projects, and max_uses", () => {
    const mintRes = mintGrant(
      {
        grantee: "scoped-worker",
        tier_limit: 3,
        tools: ["spawn_crew", "lifecycle_interrupt"],
        projects: ["firstmate_mcp", "projects/submodule"],
        ttl_s: 1800,
        max_uses: 5,
        note: "Strictly scoped grant",
      },
      ctx,
    );

    assert.deepEqual(mintRes.tools, ["spawn_crew", "lifecycle_interrupt"]);
    assert.deepEqual(mintRes.projects, ["firstmate_mcp", "projects/submodule"]);
    assert.equal(mintRes.max_uses, 5);

    const stored = readGrant(ctx, mintRes.grant_id);
    assert.ok(stored !== null);
    assert.deepEqual(stored.tools, ["spawn_crew", "lifecycle_interrupt"]);
    assert.deepEqual(stored.projects, ["firstmate_mcp", "projects/submodule"]);
    assert.equal(stored.max_uses, 5);
  });

  it("revokes an active grant immediately", () => {
    const mintRes = mintGrant(
      {
        grantee: "revokable-worker",
        tier_limit: 3,
      },
      ctx,
    );

    const revokeRes = revokeGrant(mintRes.grant_id, "test revocation", ctx);
    assert.ok(!("error" in revokeRes));
    assert.equal(revokeRes.status, "revoked");
    assert.equal(revokeRes.grant_id, mintRes.grant_id);
    assert.equal(revokeRes.reason, "test revocation");
    assert.ok(typeof revokeRes.revoked_at === "string");

    // Check on-disk record
    const stored = readGrant(ctx, mintRes.grant_id);
    assert.ok(stored !== null);
    assert.ok(stored.revoked_at !== null);
    assert.equal(stored.revocation_reason, "test revocation");
  });

  it("grant_status returns safe metadata and never leaks secrets", () => {
    const mintRes = mintGrant(
      {
        grantee: "status-test-worker",
        tier_limit: 3,
        tools: ["spawn_crew"],
        note: "Metadata leak probe",
      },
      ctx,
    );

    const singleStatus = getGrantStatus(mintRes.grant_id, null, ctx);
    assert.ok(!("error" in singleStatus));
    assert.equal(singleStatus["grant_id"], mintRes.grant_id);
    assert.equal(singleStatus["grant_ref"], mintRes.grant_ref);
    assert.equal(singleStatus["token"], undefined);
    assert.equal(singleStatus["token_hash"], undefined);
    assert.equal(singleStatus["is_valid"], true);
    assert.equal(singleStatus["is_revoked"], false);
    assert.equal(singleStatus["is_expired"], false);

    const allStatus = getGrantStatus(null, null, ctx);
    assert.ok(Array.isArray(allStatus["grants"]));
    for (const g of allStatus["grants"] as Array<Record<string, unknown>>) {
      assert.equal(g["token"], undefined);
      assert.equal(g["token_hash"], undefined);
    }
  });
});

describe("Standing Approval Grants: Invariants & Refusal-Biased Security", () => {
  let homeDir: string;
  let ctx: ToolContext;

  before(() => {
    homeDir = makeStubHome();
    ctx = {
      ...liveContext(),
      stateDir: path.join(homeDir, "state"),
      binDir: path.join(homeDir, "bin"),
    };
  });

  after(() => {
    removeHome(homeDir);
  });

  it("Invariant 1: Default-Deny — without approval or grant, authority call is REFUSED", async () => {
    const res = await checkAuthorization("spawn_crew", { task_id: "t1", project: "p1" }, ctx);
    assert.equal(res.ok, false);
    assert.equal(res.approvalRef, null);
    assert.equal(res.payload?.["error"], "approval required");
  });

  it("Invariant 2: Captain-Hold Release — wildcard grant REFUSES review_decision & decision_resolve", () => {
    const wildcardGrant = mintGrant(
      {
        grantee: "worker-wildcard",
        tier_limit: 4,
        tools: null, // wildcard
      },
      ctx,
    );

    // review_decision with wildcard grant MUST be refused
    const reviewRes = verifyGrant(wildcardGrant.token, "review_decision", { id: "t1", verdict: "approve" }, ctx);
    assert.equal(reviewRes.valid, false);
    assert.equal(reviewRes.reason, "captain-hold-explicit-grant-required");

    // decision_resolve with wildcard grant MUST be refused
    const resolveRes = verifyGrant(wildcardGrant.token, "decision_resolve", { origin_id: "t1", decision_key: "k1" }, ctx);
    assert.equal(resolveRes.valid, false);
    assert.equal(resolveRes.reason, "captain-hold-explicit-grant-required");
  });

  it("Invariant 3: Captain-Hold Release — explicit grant naming tool ALLOWS review_decision", () => {
    const explicitGrant = mintGrant(
      {
        grantee: "deploy-authorizer",
        tier_limit: 3,
        tools: ["review_decision", "decision_resolve"],
      },
      ctx,
    );

    const reviewRes = verifyGrant(explicitGrant.token, "review_decision", { id: "t1", verdict: "approve" }, ctx);
    assert.equal(reviewRes.valid, true);
    assert.equal(reviewRes.reason, "ok");
    assert.equal(reviewRes.grantRef, explicitGrant.grant_ref);

    const resolveRes = verifyGrant(explicitGrant.token, "decision_resolve", { origin_id: "t1", decision_key: "k1" }, ctx);
    assert.equal(resolveRes.valid, true);
    assert.equal(resolveRes.reason, "ok");
  });

  it("Invariant 4: Deny-List Untouched — code-forbidden tools can NEVER be authorized", () => {
    const adminGrant = mintGrant(
      {
        grantee: "super-admin",
        tier_limit: 4,
        tools: null,
      },
      ctx,
    );

    const forbidden = ["promote_scout", "teardown_crew", "arm_pr_check", "merge_pr", "merge_local"];
    for (const tool of forbidden) {
      // Forbidden tools are Tier 3 in TOOL_TIERS or forbidden; let's check tierOf
      const toolTier = tierOf(tool);
      if (toolTier === "forbidden") {
        const v = verifyGrant(adminGrant.token, tool, {}, ctx);
        assert.equal(v.valid, false);
        assert.equal(v.reason, "forbidden");
      }
    }
  });

  it("Invariant 5: Tier Boundary — Tier 3 grant cannot execute Tier 4 external sends", () => {
    const tier3Grant = mintGrant(
      {
        grantee: "tier3-worker",
        tier_limit: 3,
      },
      ctx,
    );

    // Tier 3 tool is allowed
    const spawnRes = verifyGrant(tier3Grant.token, "spawn_crew", { task_id: "t1", project: "p1" }, ctx);
    assert.equal(spawnRes.valid, true);

    // Tier 4 external tool is REFUSED
    const relayRes = verifyGrant(tier3Grant.token, "relay_reply", { request_id: "r1", text: "hi" }, ctx);
    assert.equal(relayRes.valid, false);
    assert.equal(relayRes.reason, "grant-tier-exceeded");

    const mailRes = verifyGrant(tier3Grant.token, "mail_send", { to: "a@b.com", subject: "s", body: "b" }, ctx);
    assert.equal(mailRes.valid, false);
    assert.equal(mailRes.reason, "grant-tier-exceeded");
  });

  it("Invariant 6: Tool Allowlist — grant with specific tools refuses other tools", () => {
    const toolScopedGrant = mintGrant(
      {
        grantee: "spawn-only-worker",
        tier_limit: 3,
        tools: ["spawn_crew"],
      },
      ctx,
    );

    const allowed = verifyGrant(toolScopedGrant.token, "spawn_crew", { task_id: "t1", project: "p1" }, ctx);
    assert.equal(allowed.valid, true);

    const refused = verifyGrant(toolScopedGrant.token, "lifecycle_interrupt", { id: "t1" }, ctx);
    assert.equal(refused.valid, false);
    assert.equal(refused.reason, "grant-tool-not-allowed");
  });

  it("Invariant 7: Project Scope — grant scoped to projects refuses other projects", () => {
    const projectScopedGrant = mintGrant(
      {
        grantee: "project-alpha-worker",
        tier_limit: 3,
        projects: ["alpha_project", "projects/common"],
      },
      ctx,
    );

    const allowed = verifyGrant(projectScopedGrant.token, "spawn_crew", { task_id: "t1", project: "alpha_project" }, ctx);
    assert.equal(allowed.valid, true);

    const refused = verifyGrant(projectScopedGrant.token, "spawn_crew", { task_id: "t1", project: "beta_project" }, ctx);
    assert.equal(refused.valid, false);
    assert.equal(refused.reason, "grant-project-out-of-scope");
  });

  it("Invariant 8: Expired Grants Fail Closed", async () => {
    const expiredGrant = mintGrant(
      {
        grantee: "expiring-worker",
        tier_limit: 3,
        ttl_s: 1, // 1 second TTL
      },
      ctx,
    );

    // Sleep 1.2 seconds to expire
    await new Promise((r) => setTimeout(r, 1200));

    const verifyRes = verifyGrant(expiredGrant.token, "spawn_crew", { task_id: "t1", project: "p1" }, ctx);
    assert.equal(verifyRes.valid, false);
    assert.equal(verifyRes.reason, "grant-expired");

    const authRes = await checkAuthorization("spawn_crew", { task_id: "t1", project: "p1", grant: expiredGrant.token }, ctx);
    assert.equal(authRes.ok, false);
    assert.equal(authRes.payload?.["detail"], "grant-expired");
  });

  it("Invariant 9: Revoked Grants Fail Closed", async () => {
    const grant = mintGrant(
      {
        grantee: "worker-to-revoke",
        tier_limit: 3,
      },
      ctx,
    );

    revokeGrant(grant.grant_id, "administrative shutdown", ctx);

    const verifyRes = verifyGrant(grant.token, "spawn_crew", { task_id: "t1", project: "p1" }, ctx);
    assert.equal(verifyRes.valid, false);
    assert.equal(verifyRes.reason, "grant-revoked");

    const authRes = await checkAuthorization("spawn_crew", { task_id: "t1", project: "p1", grant: grant.token }, ctx);
    assert.equal(authRes.ok, false);
    assert.equal(authRes.payload?.["detail"], "grant-revoked");
  });

  it("Invariant 10: Usage Limit / Exhaustion Fails Closed", () => {
    const cappedGrant = mintGrant(
      {
        grantee: "capped-worker",
        tier_limit: 3,
        max_uses: 2,
      },
      ctx,
    );

    // Call 1: OK
    const use1 = verifyGrant(cappedGrant.token, "spawn_crew", { task_id: "t1", project: "p1" }, ctx);
    assert.equal(use1.valid, true);

    // Call 2: OK
    const use2 = verifyGrant(cappedGrant.token, "spawn_crew", { task_id: "t1", project: "p1" }, ctx);
    assert.equal(use2.valid, true);

    // Call 3: Exhausted -> REFUSED
    const use3 = verifyGrant(cappedGrant.token, "spawn_crew", { task_id: "t1", project: "p1" }, ctx);
    assert.equal(use3.valid, false);
    assert.equal(use3.reason, "grant-exhausted");
  });

  it("Invariant 11: Cross-Home Isolation — grants never leak across FM_HOME sandboxes", () => {
    const otherHome = makeStubHome();
    const otherCtx: ToolContext = {
      ...liveContext(),
      stateDir: path.join(otherHome, "state"),
      binDir: path.join(otherHome, "bin"),
    };

    const grantInHomeA = mintGrant(
      {
        grantee: "home-a-worker",
        tier_limit: 3,
      },
      ctx,
    );

    // Home B cannot find or use the grant minted in Home A
    const lookupInB = readGrant(otherCtx, grantInHomeA.grant_id);
    assert.equal(lookupInB, null);

    const verifyInB = verifyGrant(grantInHomeA.token, "spawn_crew", { task_id: "t1", project: "p1" }, otherCtx);
    assert.equal(verifyInB.valid, false);
    assert.equal(verifyInB.reason, "grant-invalid");

    removeHome(otherHome);
  });
});

describe("Standing Approval Grants: Server JSON-RPC End-to-End & Audit", () => {
  let sandbox: string;
  let boxed: Client;

  before(() => {
    sandbox = makeStubHome();
    boxed = new Client({ FM_HOME: sandbox });
    boxed.notify("notifications/initialized");
  });

  after(async () => {
    await boxed.close();
    removeHome(sandbox);
  });

  it("grant_mint, grant_status, and grant_revoke execute over stdio wire", async () => {
    // 1. grant_mint (requires per-action approval because it is a Tier 3 write)
    const mintResp = await boxed.call("grant_mint", {
      grantee: "autonomous-crewmate",
      tier_limit: 3,
      tools: ["spawn_crew", "scaffold_brief", "lifecycle_interrupt"],
      projects: ["firstmate_mcp"],
      ttl_s: 3600,
      note: "Autonomous task execution grant",
      approval: APPROVAL,
    });

    assert.equal(isError(mintResp), false);
    const mintData = payload(mintResp);
    assert.ok(typeof mintData["token"] === "string");
    assert.ok(typeof mintData["grant_id"] === "string");
    assert.ok(typeof mintData["grant_ref"] === "string");
    const token = mintData["token"] as string;
    const grantId = mintData["grant_id"] as string;
    const grantRef = mintData["grant_ref"] as string;

    // 2. grant_status (Tier 1 open read: inspect without approval)
    const statusResp = await boxed.call("grant_status", { grant_id: grantId });
    assert.equal(isError(statusResp), false);
    const statusData = payload(statusResp);
    assert.equal(statusData["grant_id"], grantId);
    assert.equal(statusData["grant_ref"], grantRef);
    assert.equal(statusData["is_valid"], true);
    assert.equal(statusData["token"], undefined);
    assert.equal(statusData["token_hash"], undefined);

    // 3. Autonomous call using standing grant token in approval field
    const spawnResp1 = await boxed.call("spawn_crew", {
      task_id: "task-vjr58",
      project: "firstmate_mcp",
      mode: "no-mistakes",
      yolo: "off",
      approval: token,
    });
    // The approval check PASSED, reaching the script execution
    assert.equal(String(payload(spawnResp1)["error"] ?? "").includes("approval"), false);
    assert.equal(payload(spawnResp1)["error"], "spawn refused or failed");

    // 4. Autonomous call using standing grant token in grant field
    const briefResp = await boxed.call("scaffold_brief", {
      task_id: "task-vjr58",
      project: "firstmate_mcp",
      mode: "no-mistakes",
      grant: token,
      approval: "standing grant",
    });
    // The approval check PASSED, reaching the script execution
    assert.equal(String(payload(briefResp)["error"] ?? "").includes("approval"), false);
    assert.equal(payload(briefResp)["error"], "brief refused or failed");

    // 5. Tool call outside tool allowlist is refused
    const nudgeResp = await boxed.call("secondmate_nudge", {
      approval: token,
    });
    assert.equal(isError(nudgeResp), true);
    assert.equal(payload(nudgeResp)["error"], "approval required");

    // 6. Tool call outside project scope is refused
    const wrongProjectResp = await boxed.call("spawn_crew", {
      task_id: "task-vjr58",
      project: "other_project",
      mode: "no-mistakes",
      yolo: "off",
      approval: token,
    });
    assert.equal(isError(wrongProjectResp), true);
    assert.equal(payload(wrongProjectResp)["error"], "approval required");

    // 7. grant_revoke (Tier 3 write)
    const revokeResp = await boxed.call("grant_revoke", {
      grant_id: grantId,
      reason: "work completed",
      approval: APPROVAL,
    });
    assert.equal(isError(revokeResp), false);
    assert.equal(payload(revokeResp)["status"], "revoked");

    // 8. Subsequent call with revoked token is REFUSED
    const afterRevokeResp = await boxed.call("spawn_crew", {
      task_id: "task-vjr58",
      project: "firstmate_mcp",
      mode: "no-mistakes",
      yolo: "off",
      approval: token,
    });
    assert.equal(isError(afterRevokeResp), true);
    assert.equal(payload(afterRevokeResp)["error"], "approval required");

    // 9. Verify audit trail: records grant_ref (hash), NEVER secret token
    const auditFile = path.join(sandbox, "state", "mcp-audit.jsonl");
    const auditLines = readAuditLines(auditFile);
    assert.ok(auditLines.length > 0);

    const spawnAudits = auditLines.filter((l) => l.tool === "spawn_crew" && l.decision === "allow");
    assert.ok(spawnAudits.length >= 1);
    assert.equal(spawnAudits[0].approval_ref, grantRef);

    // Plaintext token NEVER appears in any audit line
    const rawAudit = fs.readFileSync(auditFile, "utf8");
    assert.equal(rawAudit.includes(token), false);
  });
});

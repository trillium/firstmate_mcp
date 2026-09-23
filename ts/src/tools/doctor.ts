/**
 * Self-check read + contract-script resolution. (slice 15c of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. Both exported in tools.ts (server + tests import them), re-exported via tools.ts.
 */
import fs from "node:fs";
import path from "node:path";
import {
  MAX_OUTPUT_BYTES,
  RECEIPT_TIMEOUT_S,
  RECEIPT_TTL_S,
  SNAPSHOT_TTL_S,
  SUBPROCESS_TIMEOUT_S,
  resolveGhBin,
} from "../constants.js";
import {
  contractScriptIndex,
  missingContractScript,
} from "./contract-resolve.js";
export { missingContractScript };
import {
  FORBIDDEN_TOOLS,
  TIER_AUTHORITY,
  TIER_EXTERNAL,
  TIER_OPEN,
  TIER_STEER,
  TOOL_TIERS,
} from "../auth.js";
import { listGrants } from "../grants.js";
import { TOOLS } from "../tools.js";
import { classifyCall } from "./pr-reads.js";
import {
  latestCachedSnapshotId,
  readCachedSnapshot,
} from "./fleet-cache.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";


/**
 * One call that answers "can this doorway actually work on this home?".
 *
 * Built because today's failures were all silent: 18 of 55 declared contracts have
 * no implementation on the served fork line, and the orientation cache expired an
 * hour after anyone warmed it so reads quietly became 35s timeouts. Both were
 * found by measuring by hand from outside. A read-only self-check makes them
 * visible from inside the doorway, to any client, without trusting a report.
 *
 * Tier 1: it reads files and reports; it never mutates, spawns, or refreshes.
 */
export async function toolDoctor(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const reasons: string[] = [];

  // 1. Bindings — the paths every other answer depends on.
  const bindings = {
    home: ctx.binDir.replace(/\/bin\/?$/, ""),
    bin_dir: ctx.binDir,
    state_dir: ctx.stateDir,
    audit_log: process.env.FM_AUDIT_LOG ?? path.join(ctx.stateDir, "mcp-audit.jsonl"),
  };

  // 2. Contract resolution: a declared surface with no script on this home can
  //    only ever fail, and the matrix view is the dependency-free source for it.
  const resolution = {
    total: 0,
    resolvable: 0,
    dead: [] as string[],
    index_read: false,
    source: "schema/contracts.index.json",
  };
  const index = contractScriptIndex();
  resolution.index_read = index.size > 0;
  if (index.size === 0) {
    reasons.push("could not read the contract index; contract resolution unknown");
  }
  resolution.total = index.size;
  for (const [surface, script] of [...index.entries()].sort()) {
    if (fs.existsSync(path.join(ctx.binDir, script))) resolution.resolvable += 1;
    else resolution.dead.push(surface);
  }
  if (resolution.dead.length > 0) {
    reasons.push(
      `${resolution.dead.length} of ${resolution.total} declared contracts have no script on this home`,
    );
  }

  // 3. Budgets — the envelope every call lives inside.
  const budgets = {
    subprocess_timeout_s: SUBPROCESS_TIMEOUT_S,
    max_output_bytes: MAX_OUTPUT_BYTES,
    receipt_timeout_s: RECEIPT_TIMEOUT_S,
    receipt_ttl_s: RECEIPT_TTL_S,
    snapshot_ttl_s: SNAPSHOT_TTL_S,
  };

  // 4. Freshness — a warm cache that expired is the difference between 7ms and a
  //    35s timeout, so it is reported rather than assumed.
  const freshness: Record<string, unknown> = {
    snapshot: { cached: false, snapshot_id: null as string | null, age_s: null as number | null, stale: null as boolean | null },
    ledger: { present: false, age_s: null as number | null, has_generated_epoch: false },
  };
  const latest = latestCachedSnapshotId(ctx);
  if (latest !== null) {
    const cached = readCachedSnapshot(ctx, latest);
    freshness["snapshot"] = {
      cached: cached.snapshot !== null,
      snapshot_id: latest,
      age_s: cached.ageS === null ? null : Math.round(cached.ageS),
      stale: cached.stale,
    };
    if (cached.stale) reasons.push("the cached fleet snapshot is stale; reads carry an age instead of recomputing");
  } else {
    reasons.push("no cached fleet snapshot; the first whole-fleet read must go through receipt_submit");
  }
  try {
    const ledger = JSON.parse(
      fs.readFileSync(path.join(ctx.stateDir, "home-summary.json"), "utf8"),
    ) as Record<string, unknown>;
    let ageS: number | null = null;
    if (typeof ledger["generated_epoch"] === "number") {
      ageS = Math.round(Date.now() / 1000 - (ledger["generated_epoch"] as number));
    } else if (typeof ledger["generated"] === "string") {
      const parsed = Date.parse(ledger["generated"] as string);
      if (Number.isFinite(parsed)) ageS = Math.round((Date.now() - parsed) / 1000);
    }
    freshness["ledger"] = {
      present: true,
      age_s: ageS,
      has_generated_epoch: typeof ledger["generated_epoch"] === "number",
    };
  } catch {
    reasons.push("no published home-summary ledger; home_summary will report nothing");
  }

  // 5. Authority state: grants and the code-forbidden set.
  //    Count USABLE grants, not records: listGrants returns revoked and expired
  //    ones too, so counting records reported "1 active grant" for a grant that
  //    was revoked and expired (caught live 2026-09-22).
  let activeGrants = 0;
  try {
    const now = Date.now();
    activeGrants = listGrants(ctx).filter((g) => {
      if (g.revoked_at !== null && g.revoked_at !== undefined) return false;
      const expires = Date.parse(g.expires_at);
      if (!Number.isFinite(expires) || expires <= now) return false;
      if (typeof g.max_uses === "number" && g.use_count >= g.max_uses) return false;
      return true;
    }).length;
  } catch {
    /* grant store unreadable is reported by grant_status */
  }
  const authority = {
    active_grants: activeGrants,
    code_forbidden: FORBIDDEN_TOOLS.length,
    tier_counts: {
      open: Object.values(TOOL_TIERS).filter((t) => t === TIER_OPEN).length,
      steer: Object.values(TOOL_TIERS).filter((t) => t === TIER_STEER).length,
      authority: Object.values(TOOL_TIERS).filter((t) => t === TIER_AUTHORITY).length,
      external: Object.values(TOOL_TIERS).filter((t) => t === TIER_EXTERNAL).length,
    },
    tools_registered: Object.keys(TOOLS).length,
  };
  if (activeGrants === 0) {
    reasons.push("no usable standing grant; every authority write needs a per-call approval string");
  }

  // 6. Audit trail and the gh binary the landing chain depends on.
  const auditLog = bindings.audit_log;
  let auditBytes: number | null = null;
  let auditLastTs: string | null = null;
  try {
    auditBytes = fs.statSync(auditLog).size;
    const text = fs.readFileSync(auditLog, "utf8").trimEnd();
    const lastLine = text.slice(text.lastIndexOf("\n") + 1);
    const parsed = JSON.parse(lastLine) as Record<string, unknown>;
    auditLastTs = typeof parsed["ts"] === "string" ? (parsed["ts"] as string) : null;
  } catch {
    reasons.push("no readable audit log; allow/refuse decisions are not being recorded here");
  }
  const ghPath = resolveGhBin();
  let ghExecutable = false;
  try {
    fs.accessSync(ghPath, fs.constants.X_OK);
    ghExecutable = true;
  } catch {
    reasons.push("gh does not resolve to an executable; pr_open and the pr_* reads cannot run");
  }

  return {
    payload: {
      status: reasons.length === 0 ? "healthy" : "degraded",
      reasons,
      bindings,
      contracts: resolution,
      budgets,
      freshness,
      authority,
      audit: { bytes: auditBytes, last_ts: auditLastTs },
      gh: { resolved: ghPath, executable: ghExecutable },
    },
    isError: false,
  };
}

// PR pipeline reads live in ./tools/pr-reads.ts (slice 12, task-8pqjb).
// Imported for the TOOLS registry below; module-private as before.

/**
 * Authorization tiers + JSON-lines audit log.
 *
 * Contract (shared with auth/tiers.py and auth/audit.py):
 * - Tier 1 (open reads): fleet_snapshot, backlog, crew_state, status_tail,
 *   fleet_poll — no approval.
 * - Tier 2 (reversible steer): send_message — no approval, validated text.
 * - Tier 3 (launch-authorized writes): lifecycle_*, spawn_crew,
 *   scaffold_brief, decision_hold, decision_resolve, review_decision —
 *   explicit per-call approval required.
 * - Tier 4 (external sends): relay_reply, relay_dismiss, relay_followup —
 *   approval plus relay consent inside the owning scripts.
 * - Forbidden: promote_scout, teardown_crew, arm_pr_check, merge_pr,
 *   merge_local — no tool, refused as unknown.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const APPROVAL_PREFIX = "I authorize";
export const APPROVAL_MAX_CHARS = 500;

export const TIER_OPEN = 1;
export const TIER_STEER = 2;
export const TIER_AUTHORITY = 3;
export const TIER_EXTERNAL = 4;
export const TIER_FORBIDDEN = "forbidden" as const;

export type Tier = 1 | 2 | 3 | 4 | "forbidden";

export const TOOL_TIERS: Record<string, Tier> = {
  fleet_snapshot: TIER_OPEN,
  backlog: TIER_OPEN,
  crew_state: TIER_OPEN,
  status_tail: TIER_OPEN,
  fleet_poll: TIER_OPEN,
  send_message: TIER_STEER,
  lifecycle_interrupt: TIER_AUTHORITY,
  lifecycle_exit: TIER_AUTHORITY,
  lifecycle_relaunch: TIER_AUTHORITY,
  lifecycle_suspend: TIER_AUTHORITY,
  lifecycle_resume: TIER_AUTHORITY,
  spawn_crew: TIER_AUTHORITY,
  scaffold_brief: TIER_AUTHORITY,
  decision_hold: TIER_AUTHORITY,
  decision_resolve: TIER_AUTHORITY,
  review_decision: TIER_AUTHORITY,
  relay_reply: TIER_EXTERNAL,
  relay_dismiss: TIER_EXTERNAL,
  relay_followup: TIER_EXTERNAL,
};

export const FORBIDDEN_TOOLS = [
  "promote_scout",
  "teardown_crew",
  "arm_pr_check",
  "merge_pr",
  "merge_local",
] as const;

export const TIER_NAMES: Record<string, string> = {
  [TIER_OPEN]: "open reads",
  [TIER_STEER]: "reversible steers",
  [TIER_AUTHORITY]: "authority writes",
  [TIER_EXTERNAL]: "external sends",
  [TIER_FORBIDDEN]: "code-forbidden",
};

export function tierOf(tool: string): Tier | null {
  if (tool in TOOL_TIERS) return TOOL_TIERS[tool];
  if ((FORBIDDEN_TOOLS as readonly string[]).includes(tool)) return TIER_FORBIDDEN;
  return null;
}

export function requiresApproval(tool: string): boolean {
  return tierOf(tool) !== TIER_OPEN && tierOf(tool) !== TIER_STEER;
}

export function validApproval(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(APPROVAL_PREFIX) &&
    value.length <= APPROVAL_MAX_CHARS
  );
}

/** Stable 16-hex short hash of an approval token (never log the token). */
export function approvalRef(approval: unknown): string | null {
  if (typeof approval !== "string" || approval === "") return null;
  return createHash("sha256").update(approval, "utf8").digest("hex").slice(0, 16);
}

export type CheckReason =
  | "ok"
  | "unknown-tool"
  | "forbidden"
  | "approval-required"
  | "approval-invalid";

export function check(tool: string, approval?: unknown): [boolean, CheckReason] {
  const tier = tierOf(tool);
  if (tier === null) return [false, "unknown-tool"];
  if (tier === TIER_FORBIDDEN) return [false, "forbidden"];
  if (tier === TIER_OPEN || tier === TIER_STEER) return [true, "ok"];
  if (validApproval(approval)) return [true, "ok"];
  if (approval === undefined || approval === null) return [false, "approval-required"];
  return [false, "approval-invalid"];
}

// --- Audit log (JSON lines) ---

export const AUDIT_VERSION = 1;

export const AUDIT_KEYS = [
  "v",
  "ts",
  "actor",
  "tool",
  "tier",
  "decision",
  "reason",
  "approval_ref",
  "target",
] as const;

export interface AuditLine {
  v: number;
  ts: string;
  actor: string;
  tool: string;
  tier: Tier | null;
  decision: string;
  reason: string;
  approval_ref: string | null;
  target: string | null;
}

function utcStamp(date: Date = new Date()): string {
  // 2026-09-13T18:00:00Z — no millis, matching the Python strftime format.
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildLine(
  actor: string,
  tool: string,
  decision: string,
  reason: string,
  opts: { approval?: unknown; target?: string | null; ts?: string } = {},
): AuditLine {
  return {
    v: AUDIT_VERSION,
    ts: opts.ts ?? utcStamp(),
    actor,
    tool,
    tier: tierOf(tool),
    decision,
    reason,
    approval_ref: approvalRef(opts.approval),
    target: opts.target ?? null,
  };
}

/** Single JSON line with sorted keys; the approval token never appears. */
export function formatLine(line: AuditLine): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(line).sort()) {
    sorted[key] = (line as unknown as Record<string, unknown>)[key];
  }
  return JSON.stringify(sorted);
}

export function appendAudit(filePath: string, line: AuditLine): string {
  const dest = path.resolve(filePath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.appendFileSync(dest, formatLine(line) + "\n", "utf8");
  return dest;
}

export function readAuditLines(filePath: string): AuditLine[] {
  const out: AuditLine[] = [];
  const raw = fs.readFileSync(filePath, "utf8");
  for (const row of raw.split("\n")) {
    const trimmed = row.trim();
    if (trimmed) out.push(JSON.parse(trimmed) as AuditLine);
  }
  return out;
}

/**
 * Authorization tiers + JSON-lines audit log.
 *
 * Contract (shared with auth/tiers.py and auth/audit.py):
 * - Tier 1 (open reads): fleet_snapshot, backlog, crew_state, status_tail,
 *   fleet_poll, peek, fleet_view, review_diff, bearings_snapshot,
 *   wake_drain, guard_check, remote_doctor, remote_file, remote_delta,
 *   handoff_status, harness_detect, project_mode, lock_status,
 *   lease_check, bearings_board_path, inbox_status, inbox_list,
 *   home_summary, home_summary_refresh, contributions_snapshot, contributions_pending,
 *   mail_status, mail_read, mail_check, voice_status, lint_versions,
 *   tool_update_check, vendor_auth_probe, startup_memory, pr_state,
 *   relay_poll, public_followup_pending, public_followup_collect,
 *   receipt_submit, receipt_status — no approval.
 *   (receipt_submit detaches one call past the 30s budget; authority
 *   targets still need their own nested approval string.)
 * - Tier 2 (reversible steer): send_message — no approval, validated text.
 * - Tier 3 (launch-authorized writes): lifecycle_*, spawn_crew,
 *   scaffold_brief, decision_hold, decision_resolve, decision_release,
 *   decision_complete, review_decision,
 *   secondmate_nudge, secondmate_restart, secondmate_report,
 *   remote_control, handoff_move, voice_queue — explicit per-call approval required.
 * - Tier 4 (external sends): relay_reply, relay_dismiss, relay_followup,
 *   mail_send —
 *   approval plus relay consent inside the owning scripts.
 * - Forbidden: promote_scout, teardown_crew, arm_pr_check, merge_pr,
 *   merge_local, public_followup_emit, relay_link — no tool, refused as unknown.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Context, Effect, Layer } from "effect";
import {
  ApprovalInvalidError,
  ApprovalRequiredError,
  AuditError,
  ForbiddenToolError,
  UnknownToolError,
} from "./errors.js";

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
  peek: TIER_OPEN,
  fleet_view: TIER_OPEN,
  review_diff: TIER_OPEN,
  bearings_snapshot: TIER_OPEN,
  wake_drain: TIER_OPEN,
  guard_check: TIER_OPEN,
  remote_doctor: TIER_OPEN,
  remote_file: TIER_OPEN,
  remote_delta: TIER_OPEN,
  handoff_status: TIER_OPEN,
  harness_detect: TIER_OPEN,
  project_mode: TIER_OPEN,
  lock_status: TIER_OPEN,
  lease_check: TIER_OPEN,
  bearings_board_path: TIER_OPEN,
  inbox_status: TIER_OPEN,
  inbox_list: TIER_OPEN,
  home_summary: TIER_OPEN,
  home_summary_refresh: TIER_OPEN,
  contributions_snapshot: TIER_OPEN,
  contributions_pending: TIER_OPEN,
  mail_status: TIER_OPEN,
  mail_read: TIER_OPEN,
  mail_check: TIER_OPEN,
  voice_status: TIER_OPEN,
  lint_versions: TIER_OPEN,
  tool_update_check: TIER_OPEN,
  vendor_auth_probe: TIER_OPEN,
  startup_memory: TIER_OPEN,
  pr_state: TIER_OPEN,
  relay_poll: TIER_OPEN,
  public_followup_pending: TIER_OPEN,
  public_followup_collect: TIER_OPEN,
  receipt_submit: TIER_OPEN,
  receipt_status: TIER_OPEN,
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
  decision_release: TIER_AUTHORITY,
  decision_complete: TIER_AUTHORITY,
  decision_verify: TIER_OPEN,
  decision_open: TIER_OPEN,
  decision_diverged: TIER_OPEN,
  review_decision: TIER_AUTHORITY,
  secondmate_nudge: TIER_AUTHORITY,
  secondmate_restart: TIER_AUTHORITY,
  secondmate_report: TIER_AUTHORITY,
  remote_control: TIER_AUTHORITY,
  handoff_move: TIER_AUTHORITY,
  voice_queue: TIER_AUTHORITY,
  promote_scout: TIER_AUTHORITY,
  teardown_crew: TIER_AUTHORITY,
  arm_pr_check: TIER_AUTHORITY,
  merge_pr: TIER_AUTHORITY,
  merge_local: TIER_AUTHORITY,
  repo_edit: TIER_AUTHORITY,
  repo_commit: TIER_AUTHORITY,
  repo_push: TIER_AUTHORITY,
  repo_merge: TIER_AUTHORITY,
  daemon_start: TIER_AUTHORITY,
  daemon_stop: TIER_AUTHORITY,
  watch_start: TIER_AUTHORITY,
  watch_stop: TIER_AUTHORITY,
  daemon_status: TIER_OPEN,
  daemon_restart: TIER_EXTERNAL,
  task_intake: TIER_AUTHORITY,
  worktree_allocate: TIER_AUTHORITY,
  lifecycle_drive: TIER_AUTHORITY,
  review_gate: TIER_AUTHORITY,
  reconcile_upstream: TIER_AUTHORITY,
  public_followup_emit: TIER_AUTHORITY,
  relay_link: TIER_AUTHORITY,
  mail_send: TIER_EXTERNAL,
  relay_reply: TIER_EXTERNAL,
  relay_dismiss: TIER_EXTERNAL,
  relay_followup: TIER_EXTERNAL,
  grant_mint: TIER_AUTHORITY,
  grant_revoke: TIER_AUTHORITY,
  grant_status: TIER_OPEN,
};

export const FORBIDDEN_TOOLS: readonly string[] = [
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

export function check(
  tool: string,
  approval?: unknown,
  grantRef?: string | null,
): [boolean, CheckReason] {
  const tier = tierOf(tool);
  if (tier === null) return [false, "unknown-tool"];
  if (tier === TIER_FORBIDDEN) return [false, "forbidden"];
  if (tier === TIER_OPEN || tier === TIER_STEER) return [true, "ok"];
  if (validApproval(approval) || (typeof grantRef === "string" && grantRef.length > 0)) {
    return [true, "ok"];
  }
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
  "duration_ms",
  "transport",
  "decision_digest",
] as const;

export type TransportType = "stdio" | "http";

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
  duration_ms: number | null;
  transport: TransportType;
  decision_digest: string | null;
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
  opts: {
    approval?: unknown;
    grant_ref?: string | null;
    target?: string | null;
    ts?: string;
    duration_ms?: number | null;
    transport?: TransportType;
    decision_digest?: string | null;
  } = {},
): AuditLine {
  return {
    v: AUDIT_VERSION,
    ts: opts.ts ?? utcStamp(),
    actor,
    tool,
    tier: tierOf(tool),
    decision,
    reason,
    approval_ref: opts.grant_ref ?? approvalRef(opts.approval),
    target: opts.target ?? null,
    duration_ms:
      typeof opts.duration_ms === "number"
        ? Math.max(0, Math.round(opts.duration_ms))
        : (opts.duration_ms ?? null),
    transport: opts.transport ?? "stdio",
    decision_digest: opts.decision_digest ?? null,
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

// --- Effect composition: Audit Service + typed approval checks ---

export type AuthCheckError =
  | UnknownToolError
  | ForbiddenToolError
  | ApprovalRequiredError
  | ApprovalInvalidError;

/** Effect core: tier check with typed errors instead of tuples. */
export function checkEffect(
  tool: string,
  approval?: unknown,
  grantRef?: string | null,
): Effect.Effect<void, AuthCheckError> {
  const tier = tierOf(tool);
  if (tier === null) {
    return Effect.fail(new UnknownToolError({ tool }));
  }
  if (tier === TIER_FORBIDDEN) {
    return Effect.fail(new ForbiddenToolError({ tool }));
  }
  if (tier === TIER_OPEN || tier === TIER_STEER) {
    return Effect.void;
  }
  if (validApproval(approval) || (typeof grantRef === "string" && grantRef.length > 0)) {
    return Effect.void;
  }
  if (approval === undefined || approval === null) {
    return Effect.fail(
      new ApprovalRequiredError({
        expect: "explicit approval string starting with 'I authorize' or valid standing grant",
      }),
    );
  }
  return Effect.fail(
    new ApprovalInvalidError({
      expect: "explicit approval string starting with 'I authorize' or valid standing grant",
    }),
  );
}

/** Effect core: best-effort audit append with a typed error channel. */
export function appendAuditEffect(
  filePath: string,
  line: AuditLine,
): Effect.Effect<string, AuditError> {
  return Effect.try({
    try: () => appendAudit(filePath, line),
    catch: (exc) => new AuditError({ detail: String(exc) }),
  });
}

export interface AuditApi {
  readonly append: (
    filePath: string,
    line: AuditLine,
  ) => Effect.Effect<string, AuditError>;
  readonly check: (
    tool: string,
    approval?: unknown,
  ) => Effect.Effect<void, AuthCheckError>;
}

export class AuditService extends Context.Tag("AuditService")<
  AuditService,
  AuditApi
>() {}

/** Live audit: file appends + pure tier checks. */
export const AuditLive: Layer.Layer<AuditService> = Layer.succeed(
  AuditService,
  AuditService.of({
    append: (filePath, line) => appendAuditEffect(filePath, line),
    check: (tool, approval) => checkEffect(tool, approval),
  }),
);

/** Test audit layer (records lines in memory, never touches disk). */
export function makeTestAuditLayer(
  lines: AuditLine[] = [],
): Layer.Layer<AuditService> {
  return Layer.succeed(
    AuditService,
    AuditService.of({
      append: (filePath, line) =>
        Effect.sync(() => {
          lines.push(line);
          return filePath;
        }),
      check: (tool, approval) => checkEffect(tool, approval),
    }),
  );
}

/**
 * Feature-area validators: handoff backlog, probes, voice, mail, PR URL. (slice 20 of the validators.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/validators.ts. Exported there, re-exported via
 * validators.ts so the `./validators.js` public surface is unchanged.
 */
import path from "node:path";
import {
  APPROVAL_PREFIX,
  CORR_RE,
  CURSOR_RE,
  DELTA_WAIT_MAX,
  DELTA_WAIT_MIN,
  HANDOFF_LINES_MAX,
  HANDOFF_LINES_MIN,
  ID_RE,
  ISOLATION_POOL_RE,
  MAIL_BODY_MAX_CHARS,
  MAIL_SUBJECT_MAX_CHARS,
  MAIL_TO_MAX_CHARS,
  PROJECT_RE,
  PR_URL_RE,
  POLICY_COMMAND_MAX_CHARS,
  PR_BODY_MAX_BYTES,
  PR_TITLE_MAX_CHARS,
  QUOTA_CANDIDATE_RE,
  QUOTA_CANDIDATES_MAX,
  QUOTA_SNAPSHOT_MAX_CHARS,
  REL_PATH_RE,
  REMOTE_FILE_BYTES_MAX,
  REMOTE_FILE_BYTES_MIN,
  SEND_TEXT_MAX_CHARS,
  SHA256_RE,
  SNAPSHOT_DEFAULT_LIMIT,
  SNAPSHOT_MAX_LIMIT,
  SNAPSHOT_MIN_LIMIT,
  STARTUP_MEMORY_MODES,
  SUBAGENT_TOOL_MAX_CHARS,
  SUPERVISION_AFK_MODES,
  SUPERVISION_INSTRUCTIONS_HARNESSES,
  TEST_ISOLATION_LIST_MODES,
  TEST_RUN_LIST_MODES,
  VENDOR_AUTH_PROBES,
  VOICE_QUEUE_MAX_CHARS,
  VOICE_SCOPES,
} from "../constants.js";
import { validId, validSingleLine } from "./core.js";


/** Non-empty list of id slugs capped at maxItems; null when not one. */
export function validIdList(value: unknown, maxItems: number): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) return null;
  if (!value.every((item) => validId(item))) return null;
  return [...value] as string[];
}

/** Named vendor auth probe: closed allowlist, nothing else. */
/** Beads mirror view name: [a-z0-9_-]+, non-empty, bounded. Mirrors
 * fm_beads_mirror_view_name_ok (empty or out-of-class is invalid). */
/** Ledger stale-days window: integer 1..30. Bounds the doorway sweep so
 * one call cannot scan a year of store history (project-pv66 divergence). */
export function validStaleDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 30
  );
}

export function validMirrorView(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > 64) return false;
  return /^[a-z0-9_-]+$/.test(value);
}

export function validProbe(value: unknown): value is string {
  return typeof value === "string" && (VENDOR_AUTH_PROBES as readonly string[]).includes(value);
}

/** Voice read scope: counts (default, safe by construction) or full. */
export function validVoiceScope(value: unknown): value is string {
  return typeof value === "string" && (VOICE_SCOPES as readonly string[]).includes(value);
}

/** Startup-memory mode: read (budget) or report (estimate). */
export function validStartupMode(value: unknown): value is string {
  return typeof value === "string" && (STARTUP_MEMORY_MODES as readonly string[]).includes(value);
}

/** Test isolation-proof list mode: proven candidates or kept-serial exclusions. */
export function validTestIsolationMode(value: unknown): value is string {
  return typeof value === "string" && (TEST_ISOLATION_LIST_MODES as readonly string[]).includes(value);
}

/** Test-runner list mode: families, lanes, concurrent-safe families, or coverage. */
export function validTestRunListMode(value: unknown): value is string {
  return typeof value === "string" && (TEST_RUN_LIST_MODES as readonly string[]).includes(value);
}

/** Isolation pool: portable or a test-runner family name (upstream re-validates). */
export function validIsolationPool(value: unknown): value is string {
  return typeof value === "string" && ISOLATION_POOL_RE.test(value);
}

/** Supervision-instructions harness: one of the eight tracked protocol snippets. */
export function validSupervisionHarness(value: unknown): value is string {
  return typeof value === "string" && (SUPERVISION_INSTRUCTIONS_HARNESSES as readonly string[]).includes(value);
}

/** Supervision away-mode wording: away (default) or quiet. */
export function validSupervisionAfkMode(value: unknown): value is string {
  return typeof value === "string" && (SUPERVISION_AFK_MODES as readonly string[]).includes(value);
}

/**
 * Shell command for the arm/cd policy classifiers: bounded text passed as
 * one argv (the scripts never execute it). Multiline commands are
 * legitimate shell; NUL is never legitimate in argv.
 */
export function validPolicyCommand(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > POLICY_COMMAND_MAX_CHARS) return false;
  // eslint-disable-next-line no-control-regex
  if (/\x00/.test(value)) return false;
  return true;
}

/** Harness tool name for the subagent policy classifier: short single line. */
export function validSubagentTool(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > SUBAGENT_TOOL_MAX_CHARS) return false;
  if (/[\r\n]/.test(value)) return false;
  return true;
}

/**
 * Quota-axi snapshot for the quota-choose selector: bounded captured text
 * (JSON schemaVersion 5 or the TOON rendering) piped on stdin, never a path.
 */
export function validQuotaSnapshot(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > QUOTA_SNAPSHOT_MAX_CHARS) return false;
  return true;
}

/**
 * Ordered dispatch candidate: <harness>:<model> token owned by
 * bin/fm-quota-choose.sh (mirrors its reject of empty, leading-colon,
 * and unsafe-character candidates; the script re-validates).
 */
export function validQuotaCandidate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > SUBAGENT_TOOL_MAX_CHARS) return false;
  if (value.startsWith(":")) return false;
  return QUOTA_CANDIDATE_RE.test(value);
}

/** Ordered dispatch candidates: at least one, bounded count. */
export function validQuotaCandidates(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (value.length < 1 || value.length > QUOTA_CANDIDATES_MAX) return false;
  return value.every(validQuotaCandidate);
}

/** SMTP recipient: single line, no whitespace, must contain @. */
export function validMailTo(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 3 || value.length > MAIL_TO_MAX_CHARS) return false;
  if (value.includes("\n") || value.includes("\r")) return false;
  if (value.includes(" ") || value.includes("\t")) return false;
  return value.includes("@");
}

/** SMTP subject: single line, 1..200 chars. */
export function validMailSubject(value: unknown): value is string {
  return validSingleLine(value, MAIL_SUBJECT_MAX_CHARS);
}

/** SMTP body: 1..5000 chars, newlines allowed (piped via stdin). */
export function validMailBody(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAIL_BODY_MAX_CHARS &&
    !value.includes("\r")
  );
}

/** Handover request text: single line, 1..500 chars. */
export function validVoiceQueueText(value: unknown): value is string {
  return validSingleLine(value, VOICE_QUEUE_MAX_CHARS);
}

/**
 * GitHub pull-request URL only: the exact shape fm-pr-state.sh owns.
 * Mirrors bin/fm-pr-lib.sh fm_pr_url_parse's github branch, so the
 * handler refuses before spawning what the script would refuse after.
 */
export function validPrUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = PR_URL_RE.exec(value);
  if (!match) return false;
  if (match[1].includes("--")) return false;
  if (match[2] === "." || match[2] === "..") return false;
  return true;
}

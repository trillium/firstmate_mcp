/**
 * Core scalar validators: ids, projects, text, approval, steer, lines. (slice 20 of the validators.ts folder split, task-8pqjb; pattern: brain-ws6lr).
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

export const NOTE_MAX_CHARS = 500;
export const TITLE_MAX_CHARS = 200;
export const REASON_MAX_CHARS = 1000;
export const DECISION_TEXT_MAX_CHARS = 2000;
export const STATUS_LINES_MIN = 1;
export const STATUS_LINES_MAX = 50;
export const PEEK_LINES_MIN = 1;
export const PEEK_LINES_MAX = 100;
export function validId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

export function validProject(value: unknown): value is string {
  if (typeof value !== "string" || !PROJECT_RE.test(value)) return false;
  if (value.includes("..") || value.startsWith("/")) return false;
  return true;
}

export function validSingleLine(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxChars &&
    !value.includes("\n") &&
    !value.includes("\r")
  );
}

export function validNote(value: unknown, cap: number = NOTE_MAX_CHARS): value is string {
  return validSingleLine(value, cap);
}

export function validApproval(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(APPROVAL_PREFIX) &&
    value.length <= NOTE_MAX_CHARS
  );
}

export function validGrantToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= 8 &&
    value.length <= NOTE_MAX_CHARS &&
    !value.includes("\n") &&
    !value.includes("\r")
  );
}

export function validSteerText(
  value: unknown,
  maxChars: number = SEND_TEXT_MAX_CHARS,
): value is string {
  if (!validSingleLine(value, maxChars)) return false;
  return !(value as string).trimStart().startsWith("/");
}

/** Coerce a peek lines count into the 1..100 window; null when not an integer. */
export function validPeekLines(value: unknown): number | null {
  let lines: number;
  if (typeof value === "number" && Number.isInteger(value)) {
    lines = value;
  } else if (typeof value === "string" && value.trim() !== "" && Number.isInteger(Number(value))) {
    lines = Number(value);
  } else {
    return null;
  }
  if (!Number.isFinite(lines)) return null;
  return Math.max(PEEK_LINES_MIN, Math.min(PEEK_LINES_MAX, lines));
}

/** Coerce a lines count into the 1..50 window; null when not an integer. */
export function validStatusLines(value: unknown): number | null {
  let lines: number;
  if (typeof value === "number" && Number.isInteger(value)) {
    lines = value;
  } else if (typeof value === "string" && value.trim() !== "" && Number.isInteger(Number(value))) {
    lines = Number(value);
  } else {
    return null;
  }
  if (!Number.isFinite(lines)) return null;
  return Math.max(STATUS_LINES_MIN, Math.min(STATUS_LINES_MAX, lines));
}

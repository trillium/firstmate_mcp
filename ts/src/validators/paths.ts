/**
 * Path, cursor-window, id-list and confinement validators. (slice 20 of the validators.ts folder split, task-8pqjb; pattern: brain-ws6lr).
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
import { validId } from "./core.js";

/**
 * Home-relative file path: no absolute paths, no traversal, no controls.
 * Mirrors the confinement bin/fm-remote-file.sh resolve_file enforces.
 */
export function validRelpath(value: unknown): value is string {
  if (typeof value !== "string" || !REL_PATH_RE.test(value)) return false;
  if (value.includes("//")) return false;
  if (value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return false;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\t")) return false;
  return true;
}

/** 64 hex chars: a continuity-check prefix hash, nothing else. */
export function validSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

/** Correlated-request token: 16 hex chars, optional corr= prefix. */
export function validCorr(value: unknown): value is string {
  return typeof value === "string" && CORR_RE.test(value);
}

/** Nonnegative integer cursor (remote delta offset); null when not one. */
export function validNonnegInt(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  let offset: number;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return null;
    offset = value;
  } else if (typeof value === "string" && value.trim() !== "" && Number.isInteger(Number(value))) {
    offset = Number(value);
  } else {
    return null;
  }
  if (!Number.isFinite(offset) || offset < 0) return null;
  return offset;
}

function coerceBoundedInt(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (typeof value === "boolean") return null;
  let n: number;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return null;
    n = value;
  } else if (typeof value === "string" && value.trim() !== "" && Number.isInteger(Number(value))) {
    n = Number(value);
  } else {
    return null;
  }
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

/** Coerce a delta-read wait into the 0..10s window; null when not an integer. */
export function validDeltaWait(value: unknown): number | null {
  return coerceBoundedInt(value, DELTA_WAIT_MIN, DELTA_WAIT_MAX);
}

/** Coerce a remote-file byte bound into the 1..256KB window; null when bad. */
export function validRemoteMaxBytes(value: unknown): number | null {
  return coerceBoundedInt(value, REMOTE_FILE_BYTES_MIN, REMOTE_FILE_BYTES_MAX);
}

/** Coerce / validate a page limit into the 1..200 window; null when out of bounds or not an integer. */
export function validPageLimit(
  value: unknown,
  defaultLimit: number = SNAPSHOT_DEFAULT_LIMIT,
): number | null {
  if (value === undefined || value === null) return defaultLimit;
  if (typeof value === "boolean") return null;
  let n: number;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return null;
    n = value;
  } else if (typeof value === "string" && value.trim() !== "" && Number.isInteger(Number(value))) {
    n = Number(value);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < SNAPSHOT_MIN_LIMIT || n > SNAPSHOT_MAX_LIMIT) return null;
  return n;
}

export interface ParsedCursorSuccess {
  readonly ok: true;
  readonly snapshotId: string | null;
  readonly offset: number;
}

export interface ParsedCursorFailure {
  readonly ok: false;
  readonly error: string;
  readonly expect: string;
}

export type ParsedCursor = ParsedCursorSuccess | ParsedCursorFailure;

/** Coerce an outbox line count into the 1..20 window; null when not an integer. */
export function validHandoffLines(value: unknown): number | null {
  return coerceBoundedInt(value, HANDOFF_LINES_MIN, HANDOFF_LINES_MAX);
}
/**
 * Resolve state/<taskId>.status confined under stateDir.
 * Returns the resolved path, or null when the id is invalid or the resolved
 * path escapes the state directory.
 */
export function confineStatePath(stateDir: string, taskId: unknown): string | null {
  if (!validId(taskId)) return null;
  const root = path.resolve(stateDir);
  const candidate = path.resolve(root, `${taskId}.status`);
  if (path.dirname(candidate) !== root) return null;
  return candidate;
}

/**
 * Resolve data/handoff/<taskId>.outbox.md confined under dataDir.
 * Returns the resolved path, or null when the id is invalid or the
 * resolved path escapes the handoff directory.
 */
export function confineHandoffPath(dataDir: string, taskId: unknown): string | null {
  if (!validId(taskId)) return null;
  const root = path.resolve(dataDir);
  const handoff = path.join(root, "handoff");
  const candidate = path.resolve(handoff, `${taskId}.outbox.md`);
  if (path.dirname(candidate) !== path.resolve(handoff)) return null;
  return candidate;
}


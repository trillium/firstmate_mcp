/**
 * Pure input validators.
 *
 * Contract: short ids with no slashes or traversal, project confinement
 * (no absolute paths, no ".."), single-line bounded human text, explicit
 * "I authorize" approval strings, the 1..50 status-lines window, and
 * state-path confinement under the served home.
 *
 * No subprocess, no filesystem writes, no reimplementation of script
 * behavior. Rejections name the expected shape so tool handlers can return
 * it verbatim in the error payload.
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
  REL_PATH_RE,
  REMOTE_FILE_BYTES_MAX,
  REMOTE_FILE_BYTES_MIN,
  SEND_TEXT_MAX_CHARS,
  SHA256_RE,
  SNAPSHOT_DEFAULT_LIMIT,
  SNAPSHOT_MAX_LIMIT,
  SNAPSHOT_MIN_LIMIT,
  STARTUP_MEMORY_MODES,
  TEST_ISOLATION_LIST_MODES,
  TEST_RUN_LIST_MODES,
  VENDOR_AUTH_PROBES,
  VOICE_QUEUE_MAX_CHARS,
  VOICE_SCOPES,
} from "./constants.js";

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

export function parseSnapshotCursor(
  cursor: unknown,
  snapshotIdArg?: unknown,
): ParsedCursor {
  let explicitSnapId: string | null = null;
  if (snapshotIdArg !== undefined) {
    if (!validId(snapshotIdArg)) {
      return {
        ok: false,
        error: "invalid snapshot_id",
        expect: "short snapshot id, no slashes or traversal",
      };
    }
    explicitSnapId = snapshotIdArg;
  }

  if (cursor === undefined || cursor === null) {
    return { ok: true, snapshotId: explicitSnapId, offset: 0 };
  }

  if (typeof cursor === "boolean") {
    return {
      ok: false,
      error: "invalid cursor",
      expect: "cursor string in format <snapshot_id>:<offset> or integer offset",
    };
  }

  if (typeof cursor === "number") {
    if (!Number.isInteger(cursor) || cursor < 0) {
      return {
        ok: false,
        error: "invalid cursor",
        expect: "nonnegative integer cursor or <snapshot_id>:<offset>",
      };
    }
    if (cursor === 0) {
      return { ok: true, snapshotId: explicitSnapId, offset: 0 };
    }
    if (explicitSnapId === null) {
      return {
        ok: false,
        error: "invalid cursor",
        expect: "cursor must include snapshot_id (<snapshot_id>:<offset>) when offset > 0",
      };
    }
    return { ok: true, snapshotId: explicitSnapId, offset: cursor };
  }

  if (typeof cursor === "string") {
    const trimmed = cursor.trim();
    if (trimmed.length === 0) {
      return {
        ok: false,
        error: "invalid cursor",
        expect: "non-empty cursor string",
      };
    }

    const match = CURSOR_RE.exec(trimmed);
    if (match) {
      const snapId = match[1]!;
      const offset = parseInt(match[2]!, 10);
      if (explicitSnapId !== null && explicitSnapId !== snapId) {
        return {
          ok: false,
          error: "cursor snapshot_id mismatch",
          expect: "cursor snapshot_id must match snapshot_id argument",
        };
      }
      return { ok: true, snapshotId: snapId, offset };
    }

    if (/^\d+$/.test(trimmed)) {
      const offset = parseInt(trimmed, 10);
      if (offset === 0) {
        return { ok: true, snapshotId: explicitSnapId, offset: 0 };
      }
      if (explicitSnapId === null) {
        return {
          ok: false,
          error: "invalid cursor",
          expect: "cursor must include snapshot_id (<snapshot_id>:<offset>) when offset > 0",
        };
      }
      return { ok: true, snapshotId: explicitSnapId, offset };
    }

    return {
      ok: false,
      error: "invalid cursor",
      expect: "cursor in format <snapshot_id>:<offset> or integer offset",
    };
  }

  return {
    ok: false,
    error: "invalid cursor",
    expect: "cursor string in format <snapshot_id>:<offset> or integer offset",
  };
}

/** Coerce an outbox line count into the 1..20 window; null when not an integer. */
export function validHandoffLines(value: unknown): number | null {
  return coerceBoundedInt(value, HANDOFF_LINES_MIN, HANDOFF_LINES_MAX);
}

/** Non-empty list of id slugs capped at maxItems; null when not one. */
export function validIdList(value: unknown, maxItems: number): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) return null;
  if (!value.every((item) => validId(item))) return null;
  return [...value] as string[];
}

/** Named vendor auth probe: closed allowlist, nothing else. */
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

export function validMergeMethod(value: unknown): value is "squash" | "merge" | "rebase" {
  return value === "squash" || value === "merge" || value === "rebase";
}

/**
 * Extension binding id: the exact shape fm-extension.mjs owns.
 * Mirrors boundedString(<id>, 128, ID_RE) in bin/fm-extension.mjs, so the
 * handler refuses before spawning what the script would refuse after.
 */
const EXTENSION_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export function validExtensionId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || Buffer.byteLength(value, "utf8") > 128) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  return EXTENSION_ID_RE.test(value);
}

export function validCommitMessage(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > 500) return false;
  if (/[\r\n]/.test(value)) return false;
  return true;
}

export function validBranchName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > 100) return false;
  if (value === "main" || value === "master") return false;
  if (!/^[a-zA-Z0-9._/-]+$/.test(value)) return false;
  if (value.includes("..") || value.startsWith("/") || value.endsWith("/")) return false;
  return true;
}

export function validFileContent(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return byteLength(value) <= 256 * 1024;
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

// --- Effect composition: typed validators ---
//
// The boolean helpers above stay the contract referee. The Effect
// variants below return the same rejections as typed ValidationError /
// Approval errors so tool handlers compose without throwing.

import { Effect } from "effect";
import {
  ApprovalInvalidError,
  ApprovalRequiredError,
  ValidationError,
} from "./errors.js";
import { byteLength } from "./runner.js";

/** Require a valid task/id slug, else a typed invalid-id error. */
export function requireId(
  value: unknown,
  code = "invalid id",
  expect = "short task id, no slashes or traversal",
): Effect.Effect<string, ValidationError> {
  if (validId(value)) return Effect.succeed(value);
  return Effect.fail(new ValidationError({ code, expect }));
}

/** Require a valid project, else a typed invalid-project error. */
export function requireProject(
  value: unknown,
): Effect.Effect<string, ValidationError> {
  if (validProject(value)) return Effect.succeed(value);
  return Effect.fail(
    new ValidationError({
      code: "invalid project",
      expect: "bare name or projects/<name>, no absolute paths or traversal",
    }),
  );
}

/** Require a single-line note within cap, else a typed error. */
export function requireNote(
  value: unknown,
  code: string,
  cap: number,
  expect: string,
): Effect.Effect<string, ValidationError> {
  if (validNote(value, cap)) return Effect.succeed(value);
  return Effect.fail(new ValidationError({ code, expect }));
}

/** Require explicit "I authorize" approval, else a typed approval error. */
export function requireApproval(
  value: unknown,
): Effect.Effect<string, ApprovalRequiredError | ApprovalInvalidError> {
  if (validApproval(value)) return Effect.succeed(value);
  if (value === undefined || value === null) {
    return Effect.fail(
      new ApprovalRequiredError({
        expect: "explicit approval string starting with 'I authorize'",
      }),
    );
  }
  return Effect.fail(
    new ApprovalInvalidError({
      expect: "explicit approval string starting with 'I authorize'",
    }),
  );
}

/** Require a confined state path, else a typed invalid-id error. */
export function requireStatePath(
  stateDir: string,
  taskId: unknown,
): Effect.Effect<string, ValidationError> {
  const confined = confineStatePath(stateDir, taskId);
  if (confined !== null) return Effect.succeed(confined);
  return Effect.fail(
    new ValidationError({
      code: "invalid id",
      expect: "short task id, no slashes or traversal",
    }),
  );
}

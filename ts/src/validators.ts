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
  DELTA_WAIT_MAX,
  DELTA_WAIT_MIN,
  HANDOFF_LINES_MAX,
  HANDOFF_LINES_MIN,
  ID_RE,
  PROJECT_RE,
  REL_PATH_RE,
  REMOTE_FILE_BYTES_MAX,
  REMOTE_FILE_BYTES_MIN,
  SEND_TEXT_MAX_CHARS,
  SHA256_RE,
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

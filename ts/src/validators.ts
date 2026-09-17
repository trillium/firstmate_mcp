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
  ID_RE,
  PROJECT_RE,
  SEND_TEXT_MAX_CHARS,
} from "./constants.js";

export const NOTE_MAX_CHARS = 500;
export const TITLE_MAX_CHARS = 200;
export const REASON_MAX_CHARS = 1000;
export const DECISION_TEXT_MAX_CHARS = 2000;
export const STATUS_LINES_MIN = 1;
export const STATUS_LINES_MAX = 50;

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

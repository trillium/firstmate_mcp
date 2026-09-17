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

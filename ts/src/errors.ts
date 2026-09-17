/**
 * Typed errors for the Effect composition.
 *
 * Contract: every failure that used to be a thrown exception or an ad-hoc
 * `{ error: ... }` payload now has a stable tagged variant. The stdio
 * wire shapes are unchanged — each error maps back to the exact legacy
 * payload via the `toPayload` helpers so py/ts parity holds byte-for-byte.
 *
 * Layers/Services in config.ts, runner.ts, auth.ts, and envelope.ts
 * communicate through these tags instead of `throw`.
 */
import { Data } from "effect";

/** A denied argv flag reached the builder (replaces `throw` in argv). */
export class DeniedFlagError extends Data.TaggedError("DeniedFlagError")<{
  readonly flag: string;
}> {
  get message(): string {
    return `denied flag: ${this.flag}`;
  }
}

/** A pure input check failed (invalid id/project/note/lines/...). */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly code: string;
  readonly expect: string;
}> {}

/** Approval missing for an authority/external write. */
export class ApprovalRequiredError extends Data.TaggedError(
  "ApprovalRequiredError",
)<{
  readonly expect: string;
}> {}

/** Approval present but malformed for an authority/external write. */
export class ApprovalInvalidError extends Data.TaggedError(
  "ApprovalInvalidError",
)<{
  readonly expect: string;
}> {}

/** The script executable could not be started (ENOENT and friends). */
export class ExecutableNotFoundError extends Data.TaggedError(
  "ExecutableNotFoundError",
)<{
  readonly detail: string;
}> {}

/** The subprocess exceeded its envelope timeout. */
export class SubprocessTimeoutError extends Data.TaggedError(
  "SubprocessTimeoutError",
)<{
  readonly timeoutS: number;
}> {}

/** A tool script exited nonzero (fail-closed owned call). */
export class SubprocessFailedError extends Data.TaggedError(
  "SubprocessFailedError",
)<{
  readonly label: string;
  readonly exit: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {}

/** Best-effort audit write failed (never breaks a tool call). */
export class AuditError extends Data.TaggedError("AuditError")<{
  readonly detail: string;
}> {}

/** Unknown tool name at the dispatch boundary. */
export class UnknownToolError extends Data.TaggedError("UnknownToolError")<{
  readonly tool: string;
}> {}

/** Tool is code-forbidden (no tool, refused as unknown on the wire). */
export class ForbiddenToolError extends Data.TaggedError(
  "ForbiddenToolError",
)<{
  readonly tool: string;
}> {}

/** Union of runner failures (the Effect error channel for runScript). */
export type RunnerError = ExecutableNotFoundError | SubprocessTimeoutError;

/** Union of tool failures (validators + approval + runner). */
export type ToolError =
  | ValidationError
  | ApprovalRequiredError
  | ApprovalInvalidError
  | DeniedFlagError
  | RunnerError
  | SubprocessFailedError
  | UnknownToolError
  | ForbiddenToolError;

/** Legacy wire payload for a validation failure (byte-identical). */
export function validationPayload(code: string, expect: string): Record<string, unknown> {
  return { error: code, expect };
}

/** Legacy wire payload for a missing approval (byte-identical). */
export function approvalRequiredPayload(): Record<string, unknown> {
  return {
    error: "approval required",
    expect: "explicit approval string starting with 'I authorize'",
  };
}

/** Map a typed tool error back to its legacy wire payload. */
export function toolErrorPayload(error: ToolError): Record<string, unknown> {
  switch (error._tag) {
    case "ValidationError":
      return validationPayload(error.code, error.expect);
    case "ApprovalRequiredError":
    case "ApprovalInvalidError":
      return approvalRequiredPayload();
    case "DeniedFlagError":
      return { error: error.message };
    case "ExecutableNotFoundError":
      return { error: "executable not found", detail: error.detail };
    case "SubprocessTimeoutError":
      return { error: "timed out", timeout_s: error.timeoutS };
    case "SubprocessFailedError":
      return {
        error: error.label,
        exit: error.exit,
        stdout: error.stdout,
        stderr: error.stderr,
      };
    case "UnknownToolError":
      return { error: `unknown tool: ${error.tool}` };
    case "ForbiddenToolError":
      return { error: `unknown tool: ${error.tool}` };
  }
}

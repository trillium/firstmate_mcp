/**
 * Typed result/error envelope for internal dispatch returns.
 *
 * Exactly one shape leaves internal dispatch so callers never branch on
 * ad-hoc script output:
 *
 *   ok:  { ok: true, ...fields }
 *   err: { ok: false, error: { code, message, ...extra } }
 *
 * The error code is a stable machine-readable slug; message is
 * human-readable and may carry the PoC-style "expect" hint naming the
 * valid shape.
 *
 * Wire note: the MCP stdio wire format matches the Python server exactly
 * (raw tool payloads with isError at the JSON-RPC layer). This envelope is
 * the internal dispatch contract shared with the adapter boundary; the
 * server layer unwraps it onto the wire in tools.ts/server.ts.
 */

export interface OkEnvelope {
  ok: true;
  [key: string]: unknown;
}

export interface ErrDetail {
  code: string;
  message: string;
  [key: string]: unknown;
}

export interface ErrEnvelope {
  ok: false;
  error: ErrDetail;
}

export type Envelope = OkEnvelope | ErrEnvelope;

/** Success envelope carrying the tool result fields. */
export function ok(fields: Record<string, unknown> = {}): OkEnvelope {
  return { ok: true, ...fields };
}

/** Error envelope with a stable code, a message, and optional detail. */
export function err(code: string, message: string, extra: Record<string, unknown> = {}): ErrEnvelope {
  return { ok: false, error: { code, message, ...extra } };
}

/** True when the envelope is a success result. */
export function isOk(envelope: unknown): envelope is OkEnvelope {
  return (
    typeof envelope === "object" &&
    envelope !== null &&
    (envelope as Record<string, unknown>).ok === true
  );
}

/** True when the envelope is an error result. */
export function isErr(envelope: unknown): envelope is ErrEnvelope {
  return (
    typeof envelope === "object" &&
    envelope !== null &&
    (envelope as Record<string, unknown>).ok === false
  );
}

// --- Effect composition: Envelope Service ---
//
// The pure ok/err constructors above stay the single internal shape.
// The service exposes them through the Effect graph so Layers can
// compose envelope construction with runner + audit without throwing.

import { Context, Effect, Layer } from "effect";
import type { ToolError } from "./errors.js";
import { toolErrorPayload } from "./errors.js";

export interface EnvelopeApi {
  readonly ok: (fields?: Record<string, unknown>) => Effect.Effect<OkEnvelope>;
  readonly fail: (
    code: string,
    message: string,
    extra?: Record<string, unknown>,
  ) => Effect.Effect<ErrEnvelope>;
  readonly fromToolError: (error: ToolError) => Effect.Effect<ErrEnvelope>;
}

export class EnvelopeService extends Context.Tag("EnvelopeService")<
  EnvelopeService,
  EnvelopeApi
>() {}

/** Map a typed tool error to its stable envelope code/message. */
export function toolErrorToEnvelope(error: ToolError): ErrEnvelope {
  switch (error._tag) {
    case "ValidationError":
      return err(error.code, error.code, { expect: error.expect });
    case "ApprovalRequiredError":
      return err("approval-required", "approval required", {
        expect: error.expect,
      });
    case "ApprovalInvalidError":
      return err("approval-invalid", "approval required", {
        expect: error.expect,
      });
    case "DeniedFlagError":
      return err("denied-flag", error.message, { flag: error.flag });
    case "ExecutableNotFoundError":
      return err("executable-not-found", "executable not found", {
        detail: error.detail,
      });
    case "SubprocessTimeoutError":
      return err("timed-out", "timed out", { timeout_s: error.timeoutS });
    case "SubprocessFailedError":
      return err("subprocess-failed", error.label, {
        exit: error.exit,
        stdout: error.stdout,
        stderr: error.stderr,
      });
    case "UnknownToolError":
      return err("unknown-tool", `unknown tool: ${error.tool}`, {
        tool: error.tool,
      });
    case "ForbiddenToolError":
      return err("forbidden", `unknown tool: ${error.tool}`, {
        tool: error.tool,
      });
  }
}

export const EnvelopeLive: Layer.Layer<EnvelopeService> = Layer.succeed(
  EnvelopeService,
  EnvelopeService.of({
    ok: (fields = {}) => Effect.succeed(ok(fields)),
    fail: (code, message, extra = {}) => Effect.succeed(err(code, message, extra)),
    fromToolError: (error) => Effect.succeed(toolErrorToEnvelope(error)),
  }),
);

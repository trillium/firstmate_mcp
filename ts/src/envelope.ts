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

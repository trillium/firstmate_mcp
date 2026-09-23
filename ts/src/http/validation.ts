/**
 * Origin/host/auth validation + constant-time compare. (slice 22 of the http.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/http.ts. Exported there, re-exported via
 * http.ts so the `./http.js` public surface is unchanged.
 */
import crypto from "node:crypto";
import { URL } from "node:url";

/** Constant-time string comparison using SHA-256 digests. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const hashA = crypto.createHash("sha256").update(a, "utf8").digest();
  const hashB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(hashA, hashB) && a === b;
}

/** Check whether an origin is allowed (localhost / 127.0.0.1 / [::1] or explicitly listed). */
export function validateOrigin(
  originHeader: string | undefined,
  allowedOrigins?: readonly string[],
): boolean {
  if (!originHeader) return true; // Non-browser clients (curl, python, sdk) omit Origin
  try {
    const parsed = new URL(originHeader);
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
      return true;
    }
    if (allowedOrigins && allowedOrigins.includes(parsed.origin.toLowerCase())) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Check whether Host header is valid (localhost / 127.0.0.1 / [::1] or explicitly listed). */
export function validateHost(
  hostHeader: string | undefined,
  allowedHosts?: readonly string[],
): boolean {
  if (!hostHeader) return false;
  const hostWithoutPort = hostHeader.replace(/:\d+$/, "").toLowerCase();
  if (
    hostWithoutPort === "localhost" ||
    hostWithoutPort === "127.0.0.1" ||
    hostWithoutPort === "[::1]" ||
    hostWithoutPort === "::1"
  ) {
    return true;
  }
  if (allowedHosts && allowedHosts.map((h) => h.toLowerCase()).includes(hostWithoutPort)) {
    return true;
  }
  return false;
}

/** Validate Bearer token authentication against the expected secret token. */
export function validateAuth(
  authHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (!authHeader) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const presented = match[1].trim();
  if (!presented) return false;
  return timingSafeEqualStr(presented, expectedToken);
}

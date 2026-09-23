/**
 * Tier queries, approval validation + reference, check(). (slice 23 of the auth.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/auth.ts. Exported there, re-exported via
 * auth.ts so the `./auth.js` public surface is unchanged.
 */
import { createHash } from "node:crypto";
import {
  APPROVAL_MAX_CHARS,
  APPROVAL_PREFIX,
  FORBIDDEN_TOOLS,
  TIER_FORBIDDEN,
  TIER_OPEN,
  TIER_STEER,
  TOOL_TIERS,
  type Tier,
} from "./tiers.js";

export function tierOf(tool: string): Tier | null {
  // Forbidden FIRST: a stale TOOL_TIERS entry must never shadow a code-forbidden
  // tool. That precedence is the entire point of the list, and getting it
  // backwards left every documented-denied surface reachable with an approval
  // string.
  if ((FORBIDDEN_TOOLS as readonly string[]).includes(tool)) return TIER_FORBIDDEN;
  if (tool in TOOL_TIERS) return TOOL_TIERS[tool];
  return null;
}

export function requiresApproval(tool: string): boolean {
  return tierOf(tool) !== TIER_OPEN && tierOf(tool) !== TIER_STEER;
}

export function validApproval(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(APPROVAL_PREFIX) &&
    value.length <= APPROVAL_MAX_CHARS
  );
}

/** Stable 16-hex short hash of an approval token (never log the token). */
export function approvalRef(approval: unknown): string | null {
  if (typeof approval !== "string" || approval === "") return null;
  return createHash("sha256").update(approval, "utf8").digest("hex").slice(0, 16);
}

export type CheckReason =
  | "ok"
  | "unknown-tool"
  | "forbidden"
  | "approval-required"
  | "approval-invalid";

export function check(
  tool: string,
  approval?: unknown,
  grantRef?: string | null,
): [boolean, CheckReason] {
  const tier = tierOf(tool);
  if (tier === null) return [false, "unknown-tool"];
  if (tier === TIER_FORBIDDEN) return [false, "forbidden"];
  if (tier === TIER_OPEN || tier === TIER_STEER) return [true, "ok"];
  if (validApproval(approval) || (typeof grantRef === "string" && grantRef.length > 0)) {
    return [true, "ok"];
  }
  if (approval === undefined || approval === null) return [false, "approval-required"];
  return [false, "approval-invalid"];
}

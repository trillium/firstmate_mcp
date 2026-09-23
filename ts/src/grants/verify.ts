/**
 * Token verification + authorization check. (slice 18 of the grants.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/grants.ts. Exported there, re-exported via
 * grants.ts so the `./grants.js` public surface is unchanged.
 */
import {
  computeGrantRef,
  findGrantByTokenHash,
  hashToken,
  writeGrant,
} from "./store.js";
import {
  APPROVAL_PREFIX,
  FORBIDDEN_TOOLS,
  TIER_FORBIDDEN,
  TIER_OPEN,
  TIER_STEER,
  approvalRef,
  tierOf,
} from "../auth.js";
import { validApproval } from "../validators.js";
import type {
  GrantTier,
  GrantVerificationReason,
  GrantVerificationResult,
  MintGrantParams,
} from "../grants.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

/** Sensitive captain-hold release tools that require explicit tool naming (cannot be authorized by wildcard grants). */
export const SENSITIVE_RELEASE_TOOLS: readonly string[] = [
  "review_decision",
  "decision_resolve",
] as const;

/** Verify a standing grant token against a tool call within scope. */
export function verifyGrant(
  token: string,
  tool: string,
  args: ToolArgs,
  ctx: ToolContext,
): GrantVerificationResult {
  if (typeof token !== "string" || token.trim() === "") {
    return { valid: false, reason: "grant-invalid" };
  }

  const tokenHash = hashToken(token);
  const grant = findGrantByTokenHash(ctx, tokenHash);
  if (!grant) {
    return { valid: false, reason: "grant-invalid" };
  }

  const grantRef = grant.grant_ref;

  // 1. Revocation check
  if (grant.revoked_at !== null) {
    return { valid: false, reason: "grant-revoked", grant, grantRef };
  }

  // 2. Expiry check
  const nowEpoch = Date.now();
  const expiresEpoch = new Date(grant.expires_at).getTime();
  if (isNaN(expiresEpoch) || nowEpoch >= expiresEpoch) {
    return { valid: false, reason: "grant-expired", grant, grantRef };
  }

  // 3. Usage limit check
  if (grant.max_uses !== null && typeof grant.max_uses === "number" && grant.use_count >= grant.max_uses) {
    return { valid: false, reason: "grant-exhausted", grant, grantRef };
  }

  // 4. Forbidden check (code-forbidden tools can never be authorized)
  const toolTier = tierOf(tool);
  if (toolTier === TIER_FORBIDDEN || (FORBIDDEN_TOOLS as readonly string[]).includes(tool)) {
    return { valid: false, reason: "forbidden", grant, grantRef };
  }
  if (toolTier === null) {
    return { valid: false, reason: "unknown-tool", grant, grantRef };
  }

  // 5. Tier limit check (grants never widen tiers)
  if (typeof toolTier === "number" && typeof grant.tier_limit === "number") {
    if (toolTier > grant.tier_limit) {
      return { valid: false, reason: "grant-tier-exceeded", grant, grantRef };
    }
  }

  // 6. Captain-hold release invariant (must be explicitly listed in grant.tools; wildcard not allowed)
  if (SENSITIVE_RELEASE_TOOLS.includes(tool)) {
    if (!grant.tools || !grant.tools.includes(tool)) {
      return { valid: false, reason: "captain-hold-explicit-grant-required", grant, grantRef };
    }
  }

  // 7. Allowed tools check
  if (grant.tools !== null && !grant.tools.includes("*")) {
    if (!grant.tools.includes(tool)) {
      return { valid: false, reason: "grant-tool-not-allowed", grant, grantRef };
    }
  }

  // 8. Project scope check
  if (grant.projects !== null && !grant.projects.includes("*")) {
    const projectArg = args["project"];
    if (typeof projectArg === "string" && projectArg.trim() !== "") {
      if (!grant.projects.includes(projectArg.trim())) {
        return { valid: false, reason: "grant-project-out-of-scope", grant, grantRef };
      }
    }
  }

  // Update use count atomically
  grant.use_count += 1;
  writeGrant(ctx, grant);

  return { valid: true, reason: "ok", grant, grantRef };
}

/** Check authorization for a tool call: satisfies via explicit per-action approval string or scoped standing grant. */
export async function checkAuthorization(
  tool: string,
  args: ToolArgs,
  ctx: ToolContext,
): Promise<{ ok: boolean; approvalRef: string | null; payload?: Record<string, unknown> }> {
  const toolTier = tierOf(tool);
  // Code-forbidden is checked before anything else and is never satisfiable:
  // neither an explicit approval string nor a standing grant may authorize it.
  if (toolTier === TIER_FORBIDDEN) {
    return {
      ok: false,
      approvalRef: null,
      payload: {
        error: "forbidden",
        expect: "a tool the doorway may call at all; this surface is code-forbidden and cannot be granted",
      },
    };
  }
  if (toolTier === TIER_OPEN || toolTier === TIER_STEER) {
    return { ok: true, approvalRef: null };
  }

  const approval = args["approval"];
  const grantArg = args["grant"];

  // 1. Explicit per-action "I authorize" string
  if (validApproval(approval)) {
    return { ok: true, approvalRef: approvalRef(approval) };
  }

  // 2. Standing grant token (from args.grant, args.approval token, or ambient FM_STANDING_GRANT/FM_GRANT_TOKEN)
  const candidateToken =
    typeof grantArg === "string" && grantArg.trim() !== ""
      ? grantArg.trim()
      : typeof approval === "string" && !approval.startsWith(APPROVAL_PREFIX)
        ? approval.startsWith("grant:")
          ? approval.slice(6).trim()
          : approval.trim()
        : (process.env.FM_STANDING_GRANT ?? process.env.FM_GRANT_TOKEN);

  if (typeof candidateToken === "string" && candidateToken.trim() !== "") {
    const v = verifyGrant(candidateToken.trim(), tool, args, ctx);
    if (v.valid && v.grantRef) {
      // Stash grantRef on args for server audit logging
      (args as Record<string, unknown>)["_grant_ref"] = v.grantRef;
      return { ok: true, approvalRef: v.grantRef };
    }
    // Return typed rejection detail
    return {
      ok: false,
      approvalRef: v.grantRef ?? computeGrantRef(candidateToken),
      payload: {
        error: "approval required",
        expect: "explicit approval string starting with 'I authorize' or valid standing grant within scope",
        detail: v.reason,
      },
    };
  }

  // 3. Default deny
  return {
    ok: false,
    approvalRef: null,
    payload: {
      error: "approval required",
      expect: "explicit approval string starting with 'I authorize'",
    },
  };
}

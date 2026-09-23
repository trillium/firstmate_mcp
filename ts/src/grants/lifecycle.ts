/**
 * Grant mint/revoke/status + summaries. (slice 18 of the grants.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/grants.ts. Exported there, re-exported via
 * grants.ts so the `./grants.js` public surface is unchanged.
 */
import { randomBytes } from "node:crypto";
import { GRANT_DEFAULT_TTL_S, GRANT_TOKEN_PREFIX } from "../constants.js";
import {
  findGrantByIdOrRef,
  hashToken,
  listGrants,
  utcStamp,
  writeGrant,
} from "./store.js";
import type {
  GrantTier,
  MintGrantParams,
  MintGrantResult,
  GrantStatusSummary,
  StandingGrant,
} from "../grants.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

/** Mint a new standing grant and store its hash in the home's grant store. */
export function mintGrant(params: MintGrantParams, ctx: ToolContext): MintGrantResult {
  const token = `${GRANT_TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
  const tokenHash = hashToken(token);
  const grantRef = tokenHash.slice(0, 16);
  const grantId = `grant-${randomBytes(8).toString("hex")}`;
  const now = new Date();
  const ttlS = params.ttl_s ?? GRANT_DEFAULT_TTL_S;
  const createdAt = utcStamp(now);
  const expiresAt = utcStamp(new Date(now.getTime() + ttlS * 1000));
  const tierLimit = (params.tier_limit ?? 3) as GrantTier;

  const grant: StandingGrant = {
    v: 1,
    grant_id: grantId,
    grant_ref: grantRef,
    token_hash: tokenHash,
    issuer: params.issuer ?? "captain",
    grantee: params.grantee,
    tier_limit: tierLimit,
    tools: params.tools ?? null,
    projects: params.projects ?? null,
    created_at: createdAt,
    expires_at: expiresAt,
    ttl_s: ttlS,
    max_uses: params.max_uses ?? null,
    use_count: 0,
    revoked_at: null,
    revocation_reason: null,
    note: params.note ?? null,
  };

  writeGrant(ctx, grant);

  return {
    grant_id: grantId,
    grant_ref: grantRef,
    token,
    issuer: grant.issuer,
    grantee: grant.grantee,
    tier_limit: grant.tier_limit,
    tools: grant.tools,
    projects: grant.projects,
    created_at: grant.created_at,
    expires_at: grant.expires_at,
    ttl_s: grant.ttl_s,
    max_uses: grant.max_uses,
    note: grant.note,
  };
}

/** Revoke an existing standing grant by grant_id or grant_ref. */
export function revokeGrant(
  grantIdOrRef: string,
  reason: string | null,
  ctx: ToolContext,
):
  | { status: "revoked"; grant_id: string; grant_ref: string; revoked_at: string; reason: string | null }
  | { error: "unknown grant"; grant_id: string } {
  const grant = findGrantByIdOrRef(ctx, grantIdOrRef);
  if (!grant) {
    return { error: "unknown grant", grant_id: grantIdOrRef };
  }
  if (grant.revoked_at === null) {
    grant.revoked_at = utcStamp();
    grant.revocation_reason = reason ?? "revoked by authorizer";
    writeGrant(ctx, grant);
  }
  return {
    status: "revoked",
    grant_id: grant.grant_id,
    grant_ref: grant.grant_ref,
    revoked_at: grant.revoked_at,
    reason: grant.revocation_reason,
  };
}

/** Format a grant into a safe public summary (never reveals tokens or hashes). */
export function formatGrantSummary(grant: StandingGrant): GrantStatusSummary {
  const isExpired = Date.now() >= new Date(grant.expires_at).getTime();
  const isRevoked = grant.revoked_at !== null;
  const isExhausted = grant.max_uses !== null && grant.use_count >= grant.max_uses;
  const isValid = !isExpired && !isRevoked && !isExhausted;

  return {
    grant_id: grant.grant_id,
    grant_ref: grant.grant_ref,
    issuer: grant.issuer,
    grantee: grant.grantee,
    tier_limit: grant.tier_limit,
    tools: grant.tools,
    projects: grant.projects,
    created_at: grant.created_at,
    expires_at: grant.expires_at,
    is_expired: isExpired,
    revoked_at: grant.revoked_at,
    is_revoked: isRevoked,
    use_count: grant.use_count,
    max_uses: grant.max_uses,
    is_valid: isValid,
    note: grant.note,
  };
}

/** Get status of one grant or list all grants in the home. */
export function getGrantStatus(
  grantIdOrRef: string | null,
  granteeFilter: string | null,
  ctx: ToolContext,
): Record<string, unknown> {
  if (grantIdOrRef) {
    const grant = findGrantByIdOrRef(ctx, grantIdOrRef);
    if (!grant) {
      return { error: "unknown grant", grant_id: grantIdOrRef };
    }
    return formatGrantSummary(grant) as unknown as Record<string, unknown>;
  }
  const all = listGrants(ctx, granteeFilter);
  return {
    grants: all.map(formatGrantSummary),
  };
}

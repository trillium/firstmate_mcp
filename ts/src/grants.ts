/**
 * Scoped standing approval grants for autonomous MCP workflows.
 *
 * Contract:
 * - Scoped standing grants: mint/store/revoke operations with tier boundaries,
 *   tool allowlists, project scopes, expiry (TTL), usage limits (max_uses),
 *   and instant revocability.
 * - Granted callers pass authority tool approval gates within stated grant scope
 *   without requiring per-action "I authorize" strings.
 * - Outside scope behaves exactly as before (default-deny preserved).
 * - Code-forbidden tools remain untouched and can never be granted.
 * - Captain-hold release (review_decision, decision_resolve) requires an explicit
 *   per-deploy grant (naming the tool explicitly), refusing wildcard grants.
 * - Secret grant tokens are generated with high entropy, returned ONCE at mint time,
 *   and hashed (SHA-256) on disk. Plaintext tokens are NEVER stored, logged, or exposed.
 * - Grants are confined to the serving home's state dir (`state/mcp-grants/`)
 *   and never leak across homes.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Context, Effect, Layer } from "effect";
import {
  APPROVAL_PREFIX,
  GRANT_DIRNAME,
  GRANT_DEFAULT_TTL_S,
  GRANT_MAX_TTL_S,
  GRANT_TOKEN_PREFIX,
} from "./constants.js";
import {
  TIER_FORBIDDEN,
  TIER_OPEN,
  TIER_STEER,
  tierOf,
  FORBIDDEN_TOOLS,
  type Tier,
  approvalRef,
  validApproval,
} from "./auth.js";
import { validId, validNote, validProject } from "./validators.js";
import type { ToolArgs, ToolContext } from "./tools.js";
import { ValidationError, type ToolError } from "./errors.js";

export type GrantTier = 1 | 2 | 3 | 4;

export interface StandingGrant {
  v: number;
  grant_id: string;
  grant_ref: string;
  token_hash: string;
  issuer: string;
  grantee: string;
  tier_limit: GrantTier;
  tools: string[] | null;
  projects: string[] | null;
  created_at: string;
  expires_at: string;
  ttl_s: number;
  max_uses: number | null;
  use_count: number;
  revoked_at: string | null;
  revocation_reason: string | null;
  note: string | null;
}

export interface MintGrantParams {
  issuer?: string;
  grantee: string;
  tier_limit?: GrantTier | number;
  tools?: string[] | null;
  projects?: string[] | null;
  ttl_s?: number;
  max_uses?: number | null;
  note?: string | null;
}

export interface MintGrantResult {
  grant_id: string;
  grant_ref: string;
  token: string;
  issuer: string;
  grantee: string;
  tier_limit: GrantTier;
  tools: string[] | null;
  projects: string[] | null;
  created_at: string;
  expires_at: string;
  ttl_s: number;
  max_uses: number | null;
  note: string | null;
}

export interface GrantStatusSummary {
  grant_id: string;
  grant_ref: string;
  issuer: string;
  grantee: string;
  tier_limit: GrantTier;
  tools: string[] | null;
  projects: string[] | null;
  created_at: string;
  expires_at: string;
  is_expired: boolean;
  revoked_at: string | null;
  is_revoked: boolean;
  use_count: number;
  max_uses: number | null;
  is_valid: boolean;
  note: string | null;
}

export type GrantVerificationReason =
  | "ok"
  | "grant-invalid"
  | "grant-revoked"
  | "grant-expired"
  | "grant-exhausted"
  | "grant-tier-exceeded"
  | "grant-tool-not-allowed"
  | "grant-project-out-of-scope"
  | "captain-hold-explicit-grant-required"
  | "forbidden"
  | "unknown-tool";

export interface GrantVerificationResult {
  valid: boolean;
  reason: GrantVerificationReason;
  grant?: StandingGrant;
  grantRef?: string;
}

export function grantDir(ctx: ToolContext): string {
  return path.join(ctx.stateDir, GRANT_DIRNAME);
}

function utcStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export function computeGrantRef(tokenOrHash: string): string {
  const hash = tokenOrHash.length === 64 ? tokenOrHash : hashToken(tokenOrHash);
  return hash.slice(0, 16);
}

/** Confined write of one grant record; returns true on success. */
export function writeGrant(ctx: ToolContext, grant: StandingGrant): boolean {
  const dir = grantDir(ctx);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.resolve(dir, `${grant.grant_id}.json`);
  if (path.dirname(file) !== path.resolve(dir)) return false;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(grant, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

/** Confined read of one grant record by grant_id. */
export function readGrant(ctx: ToolContext, grantId: unknown): StandingGrant | null {
  if (!validId(grantId)) return null;
  const dir = path.resolve(grantDir(ctx));
  const file = path.resolve(dir, `${grantId}.json`);
  if (path.dirname(file) !== dir) return null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as StandingGrant;
    if (parsed && typeof parsed === "object" && parsed.grant_id === grantId) {
      return parsed;
    }
  } catch {
    /* missing or corrupt */
  }
  return null;
}

/** Find grant record by token hash or grant id or grant_ref across the home's grant store. */
export function findGrantByTokenHash(ctx: ToolContext, tokenHash: string): StandingGrant | null {
  const dir = path.resolve(grantDir(ctx));
  try {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, entry), "utf8");
        const parsed = JSON.parse(raw) as StandingGrant;
        if (parsed && parsed.token_hash === tokenHash) {
          return parsed;
        }
      } catch {
        /* skip corrupt */
      }
    }
  } catch {
    /* dir read failed */
  }
  return null;
}

export function findGrantByIdOrRef(ctx: ToolContext, idOrRef: string): StandingGrant | null {
  const byId = readGrant(ctx, idOrRef);
  if (byId) return byId;
  const dir = path.resolve(grantDir(ctx));
  try {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, entry), "utf8");
        const parsed = JSON.parse(raw) as StandingGrant;
        if (parsed && (parsed.grant_id === idOrRef || parsed.grant_ref === idOrRef)) {
          return parsed;
        }
      } catch {
        /* skip corrupt */
      }
    }
  } catch {
    /* dir read failed */
  }
  return null;
}

export function listGrants(ctx: ToolContext, granteeFilter?: string | null): StandingGrant[] {
  const dir = path.resolve(grantDir(ctx));
  const out: StandingGrant[] = [];
  try {
    if (!fs.existsSync(dir)) return out;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, entry), "utf8");
        const parsed = JSON.parse(raw) as StandingGrant;
        if (parsed && typeof parsed.grant_id === "string") {
          if (granteeFilter && parsed.grantee !== granteeFilter) continue;
          out.push(parsed);
        }
      } catch {
        /* skip corrupt */
      }
    }
  } catch {
    /* dir read failed */
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

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

// --- Effect composition: Grant Service ---

export interface GrantApi {
  readonly mint: (
    params: MintGrantParams,
    ctx: ToolContext,
  ) => Effect.Effect<MintGrantResult, ToolError>;
  readonly revoke: (
    grantIdOrRef: string,
    reason: string | null,
    ctx: ToolContext,
  ) => Effect.Effect<{ status: string; grant_id: string; grant_ref: string; revoked_at: string; reason: string | null }, ToolError>;
  readonly status: (
    grantIdOrRef: string | null,
    grantee: string | null,
    ctx: ToolContext,
  ) => Effect.Effect<Record<string, unknown>, ToolError>;
  readonly verify: (
    token: string,
    tool: string,
    args: ToolArgs,
    ctx: ToolContext,
  ) => Effect.Effect<GrantVerificationResult, never>;
  readonly checkAuth: (
    tool: string,
    args: ToolArgs,
    ctx: ToolContext,
  ) => Effect.Effect<{ ok: boolean; approvalRef: string | null; payload?: Record<string, unknown> }, never>;
}

export class GrantService extends Context.Tag("GrantService")<
  GrantService,
  GrantApi
>() {}

export const GrantLive: Layer.Layer<GrantService> = Layer.succeed(
  GrantService,
  GrantService.of({
    mint: (params, ctx) =>
      Effect.sync(() => mintGrant(params, ctx)),
    revoke: (grantIdOrRef, reason, ctx) =>
      Effect.sync(() => {
        const res = revokeGrant(grantIdOrRef, reason, ctx);
        if ("error" in res) {
          throw new ValidationError({ code: "unknown grant", expect: `grant ${grantIdOrRef} exists` });
        }
        return res;
      }),
    status: (grantIdOrRef, grantee, ctx) =>
      Effect.sync(() => {
        const res = getGrantStatus(grantIdOrRef, grantee, ctx);
        if ("error" in res) {
          throw new ValidationError({ code: "unknown grant", expect: `grant ${grantIdOrRef} exists` });
        }
        return res;
      }),
    verify: (token, tool, args, ctx) =>
      Effect.sync(() => verifyGrant(token, tool, args, ctx)),
    checkAuth: (tool, args, ctx) =>
      Effect.promise(() => checkAuthorization(tool, args, ctx)),
  }),
);

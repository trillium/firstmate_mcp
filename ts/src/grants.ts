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
import { isRunResult } from "./runner.js";
import { argv } from "./tools.js";
import type { ToolArgs, ToolContext, ToolResult } from "./tools.js";
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

// Grant store lives in ./grants/store.ts (slice 18, task-8pqjb).
// Imported where needed and re-exported, public as before.
export {
  grantDir,
  hashToken,
  computeGrantRef,
  writeGrant,
  readGrant,
  findGrantByTokenHash,
  findGrantByIdOrRef,
  listGrants,
} from "./grants/store.js";

// Grant mint/revoke/status live in ./grants/lifecycle.ts (slice 18, task-8pqjb).
// Imported where needed and re-exported, public as before.
export {
  mintGrant,
  revokeGrant,
  formatGrantSummary,
  getGrantStatus,
} from "./grants/lifecycle.js";

// Token verification + authorization live in ./grants/verify.ts (slice 18, task-8pqjb).
// Imported where needed and re-exported, public as before.
export {
  SENSITIVE_RELEASE_TOOLS,
  verifyGrant,
  checkAuthorization,
} from "./grants/verify.js";

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

import {
  checkAuthorization,
  verifyGrant,
} from "./grants/verify.js";
import {
  getGrantStatus,
  mintGrant,
  revokeGrant,
} from "./grants/lifecycle.js";

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

/**
 * Per-call approval gate shared by all authority handlers (moved from
 * tools.ts, slice 3 of task-8pqjb). Returns ok:false with a ToolResult the
 * caller returns directly, so handlers stay branch-flat.
 */
// Per-call approval gate + release-grant helpers live in ./grants/auth-gate.ts (slice 18, task-8pqjb).
// Imported where needed and re-exported, public as before.
export {
  approvalError,
  requireAuth,
  isReleaseGrantEnabled,
  isReleaseAuthorized,
} from "./grants/auth-gate.js";

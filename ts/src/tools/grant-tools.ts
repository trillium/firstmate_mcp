/**
 * Standing-grant mint/revoke/status. (slice 14d of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. Exported there, re-exported via
 * tools.ts so the `./tools.js` public surface is unchanged.
 */
import { FORBIDDEN_TOOLS, TIER_FORBIDDEN, tierOf } from "../auth.js";
import {
  getGrantStatus,
  mintGrant,
  requireAuth,
  revokeGrant,
  type GrantTier,
} from "../grants.js";
import { validId, validNote, validProject } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolGrantMint(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const auth = await requireAuth("grant_mint", args, ctx);
  if (!auth.ok) return auth.result;

  const grantee = args["grantee"];
  if (typeof grantee !== "string" || !grantee.trim() || grantee.length > 64) {
    return {
      payload: { error: "invalid grantee", expect: "non-empty string, max 64 chars" },
      isError: true,
    };
  }

  const tierLimit = args["tier_limit"] !== undefined ? Number(args["tier_limit"]) : 3;
  if (!Number.isInteger(tierLimit) || tierLimit < 1 || tierLimit > 4) {
    return {
      payload: { error: "invalid tier_limit", expect: "integer between 1 and 4" },
      isError: true,
    };
  }

  let tools: string[] | null = null;
  if (args["tools"] !== undefined && args["tools"] !== null) {
    if (!Array.isArray(args["tools"])) {
      return {
        payload: { error: "invalid tools", expect: "array of tool name strings or null" },
        isError: true,
      };
    }
    tools = [];
    for (const t of args["tools"]) {
      if (typeof t !== "string" || !t.trim()) {
        return {
          payload: { error: "invalid tools", expect: "array of tool name strings" },
          isError: true,
        };
      }
      const trimmed = t.trim();
      if (trimmed === "*") {
        tools.push("*");
        continue;
      }
      if (tierOf(trimmed) === TIER_FORBIDDEN || (FORBIDDEN_TOOLS as readonly string[]).includes(trimmed)) {
        return {
          payload: { error: "cannot grant forbidden tool", tool: trimmed },
          isError: true,
        };
      }
      tools.push(trimmed);
    }
  }

  let projects: string[] | null = null;
  if (args["projects"] !== undefined && args["projects"] !== null) {
    if (!Array.isArray(args["projects"])) {
      return {
        payload: { error: "invalid projects", expect: "array of project strings or null" },
        isError: true,
      };
    }
    projects = [];
    for (const p of args["projects"]) {
      if (typeof p !== "string" || !validProject(p)) {
        return {
          payload: { error: "invalid projects", expect: "array of valid project names" },
          isError: true,
        };
      }
      projects.push(p);
    }
  }

  let ttlS = 3600;
  if (args["ttl_s"] !== undefined && args["ttl_s"] !== null) {
    const parsed = Number(args["ttl_s"]);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2592000) {
      return {
        payload: { error: "invalid ttl_s", expect: "integer between 1 and 2592000 seconds (max 30 days)" },
        isError: true,
      };
    }
    ttlS = parsed;
  }

  let maxUses: number | null = null;
  if (args["max_uses"] !== undefined && args["max_uses"] !== null) {
    const parsed = Number(args["max_uses"]);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return {
        payload: { error: "invalid max_uses", expect: "positive integer" },
        isError: true,
      };
    }
    maxUses = parsed;
  }

  let note: string | null = null;
  if (args["note"] !== undefined && args["note"] !== null) {
    if (!validNote(args["note"], 200)) {
      return {
        payload: { error: "invalid note", expect: "single line, 1..200 chars" },
        isError: true,
      };
    }
    note = args["note"] as string;
  }

  const issuer = (typeof args["issuer"] === "string" && args["issuer"].trim()) ? args["issuer"].trim() : "captain";

  const result = mintGrant(
    {
      issuer,
      grantee: grantee.trim(),
      tier_limit: tierLimit as GrantTier,
      tools,
      projects,
      ttl_s: ttlS,
      max_uses: maxUses,
      note,
    },
    ctx,
  );

  return { payload: result as unknown as Record<string, unknown>, isError: false };
}

export async function toolGrantRevoke(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const auth = await requireAuth("grant_revoke", args, ctx);
  if (!auth.ok) return auth.result;

  const grantId = args["grant_id"];
  if (typeof grantId !== "string" || !grantId.trim()) {
    return {
      payload: { error: "invalid grant_id", expect: "non-empty grant ID or grant_ref" },
      isError: true,
    };
  }

  let reason: string | null = null;
  if (args["reason"] !== undefined && args["reason"] !== null) {
    if (!validNote(args["reason"], 200)) {
      return {
        payload: { error: "invalid reason", expect: "single line, 1..200 chars" },
        isError: true,
      };
    }
    reason = args["reason"] as string;
  }

  const res = revokeGrant(grantId.trim(), reason, ctx);
  if ("error" in res) {
    return { payload: res, isError: true };
  }
  return { payload: res, isError: false };
}

export async function toolGrantStatus(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const grantId = typeof args["grant_id"] === "string" && args["grant_id"].trim() ? args["grant_id"].trim() : null;
  const grantee = typeof args["grantee"] === "string" && args["grantee"].trim() ? args["grantee"].trim() : null;
  const res = getGrantStatus(grantId, grantee, ctx);
  if ("error" in res) {
    return { payload: res, isError: true };
  }
  return { payload: res, isError: false };
}

/**
 * Per-call approval gate + release-grant helpers. (slice 18 of the grants.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/grants.ts. Exported there, re-exported via
 * grants.ts so the `./grants.js` public surface is unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { argv } from "../tools.js";
import { isRunResult } from "../runner.js";
import { checkAuthorization } from "./verify.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export function approvalError(): Record<string, unknown> {
  return {
    error: "approval required",
    expect: "explicit approval string starting with 'I authorize'",
  };
}

export async function requireAuth(
  tool: string,
  args: ToolArgs,
  ctx: ToolContext,
): Promise<{ ok: true } | { ok: false; result: ToolResult }> {
  const auth = await checkAuthorization(tool, args, ctx);
  if (!auth.ok) {
    return {
      ok: false,
      result: {
        payload: auth.payload ?? approvalError(),
        isError: true,
      },
    };
  }
  return { ok: true };
}

/**
 * Deploy-level release-grant helpers (slice 17, task-8pqjb).
 * Moved verbatim from src/tools.ts; this is their natural home.
 */
export function isReleaseGrantEnabled(): boolean {
  const grant = process.env.FM_RELEASE_GRANT;
  if (!grant) return false;
  const normalized = grant.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "on" ||
    normalized === "yes" ||
    normalized === "all" ||
    normalized === "enable" ||
    normalized === "enabled"
  );
}

/**
 * Determine if release of a hold is authorized under the SAFETY CORE:
 * Default scope permits releasing ONLY holds the calling agent opened itself.
 * Captain-opened or third-party holds refuse unless explicit deploy release grant is ON.
 */
export async function isReleaseAuthorized(
  callerActor: string,
  originId: string | undefined,
  taskId: string | undefined,
  ctx: ToolContext,
): Promise<{ authorized: boolean; reason?: string; author?: string | null }> {
  if (isReleaseGrantEnabled()) {
    return { authorized: true, author: "(grant-enabled)" };
  }

  // If originId was provided explicitly:
  if (originId) {
    if (callerActor === originId) {
      return { authorized: true, author: originId };
    }
    return {
      authorized: false,
      author: originId,
      reason: `release refused: caller '${callerActor}' did not author hold for origin '${originId}' (default scope permits self-holds only; captain-opened or third-party holds require FM_RELEASE_GRANT=1)`,
    };
  }

  // If taskId was provided:
  if (taskId) {
    // Check if taskId matches <origin>-decision-<key> format:
    const match = taskId.match(/^([a-zA-Z0-9._-]+)-decision-[a-zA-Z0-9._-]+$/);
    if (match) {
      const author = match[1];
      if (callerActor === author) {
        return { authorized: true, author };
      }
      return {
        authorized: false,
        author,
        reason: `release refused: caller '${callerActor}' did not author hold '${taskId}' (authored by '${author}'; default scope permits self-holds only; captain-opened or third-party holds require FM_RELEASE_GRANT=1)`,
      };
    }

    // Otherwise check if task metadata or task body carries Origin: <origin>
    // 1. Check if state/<taskId>.meta has origin=
    const metaPath = path.join(ctx.stateDir, `${taskId}.meta`);
    try {
      if (fs.existsSync(metaPath)) {
        const content = fs.readFileSync(metaPath, "utf8");
        const originMatch = content.match(/^origin=([a-zA-Z0-9._-]+)/m);
        if (originMatch) {
          const author = originMatch[1];
          if (callerActor === author) {
            return { authorized: true, author };
          }
          return {
            authorized: false,
            author,
            reason: `release refused: caller '${callerActor}' did not author hold '${taskId}' (authored by '${author}'; default scope permits self-holds only; captain-opened or third-party holds require FM_RELEASE_GRANT=1)`,
          };
        }
      }
    } catch {
      /* ignore file read error, fall through to task check */
    }

    // 2. Query task show
    try {
      const res = await ctx.run(argv(path.join(ctx.binDir, "fm-tasks-axi.sh"), "show", taskId, "--full"));
      if (isRunResult(res) && res.exitCode === 0) {
        const bodyMatch = res.stdout.match(/Origin:\s*([a-zA-Z0-9._-]+)/);
        if (bodyMatch) {
          const author = bodyMatch[1];
          if (callerActor === author) {
            return { authorized: true, author };
          }
          return {
            authorized: false,
            author,
            reason: `release refused: caller '${callerActor}' did not author hold '${taskId}' (authored by '${author}'; default scope permits self-holds only; captain-opened or third-party holds require FM_RELEASE_GRANT=1)`,
          };
        }
      }
    } catch {
      /* task query failed */
    }

    // No origin found -> captain-opened hold
    return {
      authorized: false,
      author: null,
      reason: `release refused: captain-opened hold '${taskId}' cannot be released by caller '${callerActor}' (default scope permits self-holds only; captain-opened holds require FM_RELEASE_GRANT=1)`,
    };
  }

  return {
    authorized: false,
    author: null,
    reason: "release refused: cannot determine hold authorship (origin_id or task id required)",
  };
}

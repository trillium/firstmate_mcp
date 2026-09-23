/**
 * Reap-triage + forge reads (2gvx port, task-8pqjb pattern).
 *
 * Tier-1 reads dispatching through the owning fork scripts. reap_triage is
 * fail-closed by construction (the script classifies, never reaps); there is
 * no reap verb to refuse. coderabbit_state reports the reviews list, never
 * the status check (a green check is not evidence of a review).
 */
import path from "node:path";
import { ownedCall } from "../runner.js";
import { argv } from "../tools.js";
import { validId, validNonnegInt } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolReapTriage(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const cmd = [path.join(ctx.binDir, "fm-agent-axi.sh"), "--json"];
  return ownedCall(cmd, "reap triage failed", ctx.run);
}

export async function toolCoderabbitState(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const owner = args["owner"];
  const repo = args["repo"];
  const pr = args["pr"];
  if (!validId(owner) || !validId(repo)) {
    return {
      payload: {
        error: "invalid owner/repo",
        expect: "forge owner and repo slugs, no slashes or traversal",
      },
      isError: true,
    };
  }
  const prNum = validNonnegInt(pr);
  if (prNum === null || prNum < 1) {
    return {
      payload: { error: "invalid pr", expect: "positive integer PR number" },
      isError: true,
    };
  }
  const cmd = [
    path.join(ctx.binDir, "fm-coderabbit-review-state.sh"),
    owner as string,
    repo as string,
    String(prNum),
  ];
  return ownedCall(cmd, "coderabbit state failed", ctx.run);
}

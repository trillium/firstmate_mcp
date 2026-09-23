/**
 * Home-summary refresh + contributions. (slice 9b of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. All handlers were module-private there
 * and stay module-private here; tools.ts imports them for the TOOLS registry.
 * No re-export: the `./tools.js` public surface is unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { MAX_OUTPUT_BYTES } from "../constants.js";
import { requireAuth } from "../grants.js";
import { byteLength, isRunResult, ownedCall, truncate } from "../runner.js";
import { argv } from "../tools.js";
import { removeTempFile, writeTempFile } from "./tempfiles.js";
import { publishHomeSummary } from "./digests.js";
import { validId, validNote } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolHomeSummaryRefresh(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const bestEffort = args["best_effort"] ?? false;
  if (typeof bestEffort !== "boolean") {
    return { payload: { error: "invalid best_effort", expect: "boolean" }, isError: true };
  }
  const publisher = path.join(ctx.binDir, "fm-home-summary-refresh.sh");
  // Prefer the firstmate-owned publisher wherever the line ships it: it stays
  // authoritative, and the fallback is only for lines that do not.
  if (!fs.existsSync(publisher)) {
    return publishHomeSummary(ctx, bestEffort);
  }
  const cmd = argv(publisher);
  if (bestEffort) cmd.push("--best-effort");
  const { payload, isError } = await ownedCall(cmd, "home summary refresh failed", ctx.run);
  if (!isError) return { payload: { ...payload, best_effort: bestEffort }, isError: false };
  return { payload, isError: true };
}

export async function contributionInput(
  ctx: ToolContext,
): Promise<{ staged: string | null; error: Record<string, unknown> | null }> {
  const res = await ctx.run([
    path.join(ctx.binDir, "fm-fleet-snapshot.sh"),
    "--contribution-input",
  ]);
  if (!isRunResult(res)) return { staged: null, error: res as Record<string, unknown> };
  if (res.exitCode !== 0) {
    const [out] = truncate(res.stderr || res.stdout || "");
    return {
      staged: null,
      error: { error: "contribution input failed", exit: res.exitCode, output: out },
    };
  }
  if (byteLength(res.stdout) > MAX_OUTPUT_BYTES) {
    return {
      staged: null,
      error: {
        error: "contribution input failed",
        detail: "contribution input too large for envelope",
      },
    };
  }
  return { staged: res.stdout, error: null };
}

export async function toolContributionsSnapshot(
  args: ToolArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Default only when the key is absent: an explicit null is invalid,
  // exactly as the Python server's args.get("all", False) treats it.
  const rawAll = args["all"];
  const wantAll = rawAll === undefined ? false : rawAll;
  if (typeof wantAll !== "boolean") {
    return { payload: { error: "invalid all", expect: "boolean" }, isError: true };
  }
  const { staged, error } = await contributionInput(ctx);
  if (error !== null || staged === null) {
    return { payload: error as Record<string, unknown>, isError: true };
  }
  const tmp = writeTempFile(staged);
  try {
    const cmd = argv(path.join(ctx.binDir, "fm-contributions.sh"), "snapshot", tmp);
    if (wantAll) cmd.push("--all");
    const res = await ctx.run(cmd);
    if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
    if (res.exitCode !== 0) {
      const [out] = truncate(res.stderr || res.stdout || "");
      return {
        payload: { error: "contributions snapshot failed", exit: res.exitCode, output: out },
        isError: true,
      };
    }
    if (byteLength(res.stdout) > MAX_OUTPUT_BYTES) {
      return { payload: { error: "contributions too large for envelope" }, isError: true };
    }
    let projection: Record<string, unknown>;
    try {
      projection = JSON.parse(res.stdout) as Record<string, unknown>;
    } catch {
      const [out] = truncate(res.stdout);
      return { payload: { error: "contributions was not JSON", output: out }, isError: true };
    }
    if (typeof projection !== "object" || projection === null || Array.isArray(projection)) {
      const [out] = truncate(res.stdout);
      return { payload: { error: "contributions was not JSON", output: out }, isError: true };
    }
    return { payload: { ...projection, all: wantAll }, isError: false };
  } finally {
    removeTempFile(tmp);
  }
}

export async function toolContributionsPending(
  _args: ToolArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const res = await ctx.run([path.join(ctx.binDir, "fm-contributions.sh"), "pending"]);
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  if (res.exitCode !== 0) {
    const [out] = truncate(res.stderr || res.stdout || "");
    return {
      payload: { error: "contributions pending failed", exit: res.exitCode, output: out },
      isError: true,
    };
  }
  if (byteLength(res.stdout) > MAX_OUTPUT_BYTES) {
    return { payload: { error: "contributions too large for envelope" }, isError: true };
  }
  let pending: unknown;
  try {
    pending = JSON.parse(res.stdout) as unknown;
  } catch {
    const [out] = truncate(res.stdout);
    return {
      payload: { error: "contributions pending was not JSON", output: out },
      isError: true,
    };
  }
  if (!Array.isArray(pending)) {
    const [out] = truncate(res.stdout);
    return {
      payload: { error: "contributions pending was not JSON", output: out },
      isError: true,
    };
  }
  return { payload: { pending }, isError: false };
}

// --- CHANGED: approval-gated writes ---

export async function lifecycleTool(
  args: ToolArgs,
  ctx: ToolContext,
  verb: string,
  needsNote: boolean,
): Promise<ToolResult> {
  const taskId = args["id"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  const auth = await requireAuth(`lifecycle_${verb}`, args, ctx);
  if (!auth.ok) return auth.result;
  const cmd = argv(path.join(ctx.binDir, "fm-control.sh"), taskId as string, verb);
  if (needsNote) {
    const note = args["note"];
    if (!validNote(note)) {
      return {
        payload: { error: "invalid note", expect: "single line, 1..500 chars" },
        isError: true,
      };
    }
    cmd.push("--note", note as string);
  }
  const { payload, isError } = await ownedCall(cmd, `${verb} refused or failed`, ctx.run);
  if (!isError) return { payload: { ...payload, verb, id: taskId }, isError: false };
  return { payload, isError: true };
}

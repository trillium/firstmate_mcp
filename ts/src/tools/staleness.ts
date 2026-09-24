/**
 * Staleness triage filing (n9o3.3 mirror, task-8pqjb pattern).
 *
 * Tier-3 write dispatching bin/fm-staleness-file.sh behind approval, with
 * fail-open filing discipline: validation failures return typed errors, and
 * the owning script itself warns-and-exits-0 so a filing problem never
 * blocks the reclaim already under way.
 */
import path from "node:path";
import { ownedCall } from "../runner.js";
import { argv } from "../tools.js";
import {
  validId,
  validNonnegInt,
  validProject,
  validReadBranch,
  validSingleLine,
} from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolStalenessFile(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const purpose = args["purpose"] ?? "unknown";
  const worktree = args["worktree"];
  const branch = args["branch"] ?? "unknown";
  const project = args["project"] ?? "unknown";
  const harness = args["harness"] ?? "unknown";
  const idleSince = args["idle_since"];
  const summary = args["summary"] ?? "";
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid task_id", expect: "short slug, no slashes" },
      isError: true,
    };
  }
  if (!validSingleLine(purpose, 64)) {
    return {
      payload: { error: "invalid purpose", expect: "single line, 1..64 chars" },
      isError: true,
    };
  }
  if (
    typeof worktree !== "string" ||
    worktree.length === 0 ||
    worktree.length > 256 ||
    worktree.startsWith("/")
  ) {
    return {
      payload: { error: "invalid worktree", expect: "home-relative path, no traversal" },
      isError: true,
    };
  }
  const home = path.normalize(path.join(ctx.stateDir, ".."));
  const resolvedWt = path.normalize(path.join(home, worktree as string));
  if (resolvedWt !== home && !resolvedWt.startsWith(home + path.sep)) {
    return {
      payload: { error: "invalid worktree", expect: "path must stay inside the home" },
      isError: true,
    };
  }
  if (!validReadBranch(branch) || !validProject(project)) {
    return {
      payload: { error: "invalid branch/project", expect: "names without traversal" },
      isError: true,
    };
  }
  if (!validSingleLine(harness, 32)) {
    return {
      payload: { error: "invalid harness", expect: "single line, 1..32 chars" },
      isError: true,
    };
  }
  const idle = validNonnegInt(idleSince);
  if (idle === null) {
    return {
      payload: { error: "invalid idle_since", expect: "non-negative integer epoch" },
      isError: true,
    };
  }
  if (typeof summary !== "string" || summary.length > 2000 || summary.includes("\0")) {
    return {
      payload: { error: "invalid summary", expect: "string <= 2000 chars" },
      isError: true,
    };
  }
  const cmd = [
    path.join(ctx.binDir, "fm-staleness-file.sh"),
    taskId as string,
    purpose as string,
    resolvedWt,
    branch as string,
    project as string,
    harness as string,
    String(idle),
    summary as string,
  ];
  const { payload, isError } = await ownedCall(cmd, "staleness file failed", ctx.run);
  if (isError) return { payload, isError: true };
  return { payload: { ...payload, task_id: taskId }, isError: false };
}

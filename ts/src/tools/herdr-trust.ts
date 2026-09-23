/**
 * Herdr cleanup, trust preregistration, event wait, workspace move. (slice 14b of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. Exported there, re-exported via
 * tools.ts so the `./tools.js` public surface is unchanged.
 */
import path from "node:path";
import { approvalError } from "../grants.js";
import { ownedCall } from "../runner.js";
import { confineHomePath } from "../tools.js";
import { validApproval, validId, validRelpath } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

function validPlainArg(value: unknown, max = 500): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max &&
    !value.includes("\0") && !value.includes("\n") && !value.includes("\r");
}
export async function toolHerdrCiCleanup(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const command = args["command"];
  const relPath = args["path"];
  if (command !== "snapshot" && command !== "teardown") {
    return { payload: { error: "invalid command", expect: "snapshot or teardown" }, isError: true };
  }
  if (!validRelpath(relPath)) {
    return { payload: { error: "invalid path", expect: "home-relative snapshot path, no traversal" }, isError: true };
  }
  const confined = confineHomePath(ctx, relPath as string);
  if (confined === null) {
    return { payload: { error: "invalid path", expect: "home-relative snapshot path, no traversal" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [path.join(ctx.binDir, "fm-herdr-ci-cleanup.sh"), command as string, confined];
  return ownedCall(cmd, "herdr_ci_cleanup", ctx.run);
}

export async function toolSessionCleanup(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [path.join(ctx.binDir, "fm-herdr-session-cleanup.sh")];
  return ownedCall(cmd, "session_cleanup", ctx.run);
}

export async function toolClaudeTrust(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const worktree = args["worktree"];
  const project = args["project"];
  const home = args["home"];
  const id = args["id"];
  const worktreeMode = worktree !== undefined || project !== undefined;
  const homeMode = home !== undefined || id !== undefined;
  if (worktreeMode === homeMode) {
    return { payload: { error: "invalid mode", expect: "worktree+project or home+id, exactly one" }, isError: true };
  }
  let cmd: string[];
  if (worktreeMode) {
    if (!validPlainArg(worktree) || !validPlainArg(project)) {
      return { payload: { error: "invalid worktree", expect: "worktree and project paths, 1..500 chars" }, isError: true };
    }
    cmd = [path.join(ctx.binDir, "fm-claude-trust.sh"), worktree as string, project as string];
  } else {
    if (!validPlainArg(home) || !validId(id)) {
      return { payload: { error: "invalid home", expect: "secondmate home path plus short id" }, isError: true };
    }
    cmd = [path.join(ctx.binDir, "fm-claude-trust.sh"), "--secondmate-home", home as string, id as string];
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  return ownedCall(cmd, "claude_trust", ctx.run);
}

export async function toolAgyTrust(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const worktree = args["worktree"];
  const project = args["project"];
  if (!validPlainArg(worktree) || !validPlainArg(project)) {
    return { payload: { error: "invalid worktree", expect: "worktree and project paths, 1..500 chars" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [path.join(ctx.binDir, "fm-agy-trust.sh"), worktree as string, project as string];
  return ownedCall(cmd, "agy_trust", ctx.run);
}

export async function toolClaudeStopAutoarm(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [path.join(ctx.binDir, "fm-claude-stop-autoarm.sh")];
  return ownedCall(cmd, "claude_stop_autoarm", ctx.run);
}

export async function toolHerdrEventwait(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const socket = args["socket"];
  const timeoutS = args["timeout_s"];
  const paneIds = args["pane_ids"];
  if (!validPlainArg(socket)) {
    return { payload: { error: "invalid socket", expect: "control socket path, 1..500 chars" }, isError: true };
  }
  if (typeof timeoutS !== "number" || !Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > 300) {
    return { payload: { error: "invalid timeout_s", expect: "integer between 1 and 300" }, isError: true };
  }
  if (!Array.isArray(paneIds) || paneIds.length < 1 || paneIds.length > 8 ||
    !paneIds.every((p) => typeof p === "number" && Number.isInteger(p) && p > 0 && p < 2147483647)) {
    return { payload: { error: "invalid pane_ids", expect: "1..8 positive integer pane ids" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [
    path.join(ctx.binDir, "backends", "herdr-eventwait.py"),
    socket as string,
    String(timeoutS),
    ...(paneIds as number[]).map(String),
  ];
  return ownedCall(cmd, "herdr_eventwait", ctx.run);
}

export async function toolHerdrWorkspaceMove(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const socket = args["socket"];
  const workspaceId = args["workspace_id"];
  const insertIndex = args["insert_index"];
  if (!validPlainArg(socket)) {
    return { payload: { error: "invalid socket", expect: "control socket path, 1..500 chars" }, isError: true };
  }
  if (typeof workspaceId !== "number" || !Number.isInteger(workspaceId) || workspaceId <= 0 || workspaceId >= 2147483647) {
    return { payload: { error: "invalid workspace_id", expect: "positive integer workspace id" }, isError: true };
  }
  if (typeof insertIndex !== "number" || !Number.isInteger(insertIndex) || insertIndex < 0 || insertIndex > 1000000) {
    return { payload: { error: "invalid insert_index", expect: "non-negative integer <= 1000000" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [
    path.join(ctx.binDir, "backends", "herdr-workspace-move.py"),
    socket as string,
    String(workspaceId),
    String(insertIndex),
  ];
  return ownedCall(cmd, "herdr_workspace_move", ctx.run);
}

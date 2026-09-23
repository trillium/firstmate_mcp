/**
 * Landing-chain handlers: scout promotion, teardown, PR checks/merges,
 * repo edit/commit/push/merge, pr_open (slice 2 of the tools.ts folder
 * split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts; the TOOLS registry entries still live in
 * tools.ts and reference these imports, and tools.ts re-exports them so the
 * `./tools.js` public surface is unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PR_BASE,
  MODES,
  PR_BODY_MAX_BYTES,
  PR_TITLE_MAX_CHARS,
  YOLO,
  resolveGhBin,
} from "../constants.js";
import { byteLength, ownedCall } from "../runner.js";
import {
  validBaseBranch,
  validBranchName,
  validCommitMessage,
  validFileContent,
  validId,
  validMergeMethod,
  validPrBody,
  validPrTitle,
  validRelpath,
} from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolPromoteScout(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const mode = args["mode"];
  const yolo = args["yolo"];
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!MODES.includes(mode as (typeof MODES)[number])) {
    return { payload: { error: "invalid mode", expect: `must be one of ${MODES.join(", ")}` }, isError: true };
  }
  if (!YOLO.includes(yolo as (typeof YOLO)[number])) {
    return { payload: { error: "invalid yolo", expect: "must be on or off" }, isError: true };
  }
  const cmd = [path.join(ctx.binDir, "fm-promote.sh"), taskId as string, "--mode", mode as string, "--yolo", yolo as string];
  return ownedCall(cmd, "promote_scout", ctx.run);
}

export async function toolTeardownCrew(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  const cmd = [path.join(ctx.binDir, "fm-teardown.sh"), taskId as string];
  return ownedCall(cmd, "teardown_crew", ctx.run);
}

export async function toolArmPrCheck(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  const cmd = [path.join(ctx.binDir, "fm-arm-pretool-check.sh"), "--command", `fm-pr-check.sh ${taskId}`];
  return ownedCall(cmd, "arm_pr_check", ctx.run);
}

export async function toolMergePr(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const method = args["method"] !== undefined ? args["method"] : "squash";
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!validMergeMethod(method)) {
    return { payload: { error: "invalid method", expect: "must be squash, merge, or rebase" }, isError: true };
  }
  const cmd = [path.join(ctx.binDir, "fm-pr-merge.sh"), taskId as string, "--", `--${method}`];
  return ownedCall(cmd, "merge_pr", ctx.run);
}

export async function toolMergeLocal(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  const cmd = [path.join(ctx.binDir, "fm-merge-local.sh"), taskId as string];
  return ownedCall(cmd, "merge_local", ctx.run);
}

export async function toolRepoEdit(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const relpath = args["path"];
  const content = args["content"];
  if (!validRelpath(relpath)) {
    return { payload: { error: "invalid path", expect: "home-relative path required" }, isError: true };
  }
  if (!validFileContent(content)) {
    return { payload: { error: "invalid content", expect: "string <= 256KB" }, isError: true };
  }
  const targetPath = path.resolve(ctx.dataDir, "..", relpath as string);
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content as string, "utf8");
    return {
      payload: { status: "edited", path: relpath, bytes: byteLength(content as string) },
      isError: false,
    };
  } catch (err) {
    return { payload: { error: "failed to edit file", detail: String(err) }, isError: true };
  }
}

export async function toolRepoCommit(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const message = args["message"];
  if (!validCommitMessage(message)) {
    return { payload: { error: "invalid message", expect: "1..500 chars, single line required" }, isError: true };
  }
  const cmd = ["git", "commit", "-m", message as string];
  return ownedCall(cmd, "repo_commit", ctx.run);
}

export async function toolRepoPush(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const branch = args["branch"];
  if (!validBranchName(branch)) {
    return { payload: { error: "invalid branch", expect: "non-default branch name, no traversal" }, isError: true };
  }
  const cmd = ["git", "push", "origin", branch as string];
  return ownedCall(cmd, "repo_push", ctx.run);
}

export async function toolRepoMerge(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const branch = args["branch"];
  if (!validBranchName(branch)) {
    return { payload: { error: "invalid branch", expect: "valid branch name" }, isError: true };
  }
  const cmd = ["git", "merge", "--no-ff", "-m", `Merge branch ${branch}`, branch as string];
  return ownedCall(cmd, "repo_merge", ctx.run);
}

/**
 * Open a pull request for an already-pushed branch.
 *
 * Completes the delivery chain: repo_commit and repo_push could publish a
 * branch but nothing could open the PR, so an agent had to shell out to gh
 * outside the doorway. merge_pr stays forbidden by design — this tool stops at
 * opening, and never merges.
 */
export async function toolPrOpen(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const title = args["title"];
  if (!validPrTitle(title)) {
    return {
      payload: {
        error: "invalid title",
        expect: `1..${PR_TITLE_MAX_CHARS} chars, single line required`,
      },
      isError: true,
    };
  }
  const body = args["body"];
  if (!validPrBody(body)) {
    return {
      payload: { error: "invalid body", expect: `non-empty, <= ${PR_BODY_MAX_BYTES} bytes` },
      isError: true,
    };
  }
  const head = args["head"];
  if (!validBranchName(head)) {
    return {
      payload: { error: "invalid head", expect: "non-default source branch name, no traversal" },
      isError: true,
    };
  }
  const base = args["base"] ?? DEFAULT_PR_BASE;
  if (!validBaseBranch(base)) {
    return { payload: { error: "invalid base", expect: "branch name, no traversal" }, isError: true };
  }
  const draft = args["draft"] ?? false;
  if (typeof draft !== "boolean") {
    return { payload: { error: "invalid draft", expect: "boolean" }, isError: true };
  }
  const cmd = [
    // Resolved, not a bare "gh": the serving process has a launchd PATH.
    resolveGhBin(),
    "pr",
    "create",
    "--title",
    title,
    "--body",
    body,
    "--head",
    head,
    "--base",
    base,
  ];
  if (draft) cmd.push("--draft");
  return ownedCall(cmd, "pr_open", ctx.run);
}

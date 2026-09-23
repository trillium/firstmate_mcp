/**
 * PR pipeline reads: state, poll, relay poll, reviewers. (slice 12b of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. All four handlers were module-private there
 * and stay module-private here; tools.ts imports them for the TOOLS registry.
 * No re-export: the `./tools.js` public surface is unchanged.
 */
import path from "node:path";
import { PR_URL_RE } from "../constants.js";
import { isRunResult, ownedCall, runScript, truncate } from "../runner.js";
import { argv } from "../tools.js";
import { validPrUrl } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolPrState(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const url = args["url"];
  if (!validPrUrl(url)) {
    return {
      payload: {
        error: "invalid url",
        expect: "https://github.com/<owner>/<repo>/pull/<number>",
      },
      isError: true,
    };
  }
  // One-shot read-only blockers read; never posts, requests, or merges.
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-pr-state.sh"), url as string),
    "pr state failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, url }, isError: false };
  return { payload, isError: true };
}

export async function toolPrPoll(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const url = args["url"];
  if (!validPrUrl(url)) {
    return {
      payload: {
        error: "invalid url",
        expect: "https://github.com/<owner>/<repo>/pull/<number>",
      },
      isError: true,
    };
  }
  const match = PR_URL_RE.exec(url as string);
  if (!match) {
    return {
      payload: {
        error: "invalid url",
        expect: "https://github.com/<owner>/<repo>/pull/<number>",
      },
      isError: true,
    };
  }
  const owner = match[1];
  const repo = match[2];
  const number = match[3];

  const cmd = [
    path.join(ctx.binDir, "fm-pr-poll.sh"),
    "--validated",
    "github",
    url as string,
    "github.com",
    `${owner}/${repo}`,
    number,
  ];
  const { payload, isError } = await ownedCall(cmd, "pr poll failed", ctx.run);
  if (!isError) return { payload: { ...payload, url }, isError: false };
  return { payload, isError: true };
}

export async function toolRelayPoll(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Short bounded poll; hard no-op without relay consent (FMX token).
  return ownedCall(argv(path.join(ctx.binDir, "fm-x-poll.sh")), "relay poll failed", ctx.run);
}

export async function toolPrReviewers(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const url = args["url"];
  if (!validPrUrl(url)) {
    return {
      payload: {
        error: "invalid url",
        expect: "https://github.com/<owner>/<repo>/pull/<number>",
      },
      isError: true,
    };
  }
  // Read-only advisory reviewer candidates from the PR's changed files
  // and recent authorship; never requests, assigns, or posts reviews.
  // Wide PRs cost one API read per changed path and may time out past
  // the envelope instead of completing.
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-pr-reviewers.sh"), url as string),
    "pr reviewers failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, url }, isError: false };
  return { payload, isError: true };
}

/**
 * Shared PreToolUse classifier shape: the guard never executes the
 * submitted command or tool name, it only classifies. Exit 0 is an
 * allow, exit 2 is a deny with the reason on its outputs, anything
 * else is a failed classification. Both verdicts are answers, not errors.
 */
export async function classifyCall(
  cmd: string[],
  label: string,
  run: typeof runScript,
): Promise<ToolResult> {
  const res = await run(cmd);
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  const [out, outTrunc] = truncate(res.stdout ?? "");
  const [errOut, errTrunc] = truncate(res.stderr ?? "");
  if (res.exitCode === 0) {
    return {
      payload: { verdict: "allow", stdout: out, stdout_truncated: outTrunc },
      isError: false,
    };
  }
  if (res.exitCode === 2) {
    return {
      payload: {
        verdict: "deny",
        stdout: out,
        stdout_truncated: outTrunc,
        stderr: errOut,
        stderr_truncated: errTrunc,
      },
      isError: false,
    };
  }
  return {
    payload: { error: label, exit: res.exitCode, stdout: out, stderr: errOut },
    isError: true,
  };
}

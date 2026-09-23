/**
 * Session/harness handlers: detect, project mode, lock status, lease check
 * (slice 8 of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. All four were module-private there and
 * stay module-private here; tools.ts imports them for the TOOLS registry.
 * No re-export: the `./tools.js` public surface is unchanged.
 */
import path from "node:path";
import { HARNESS_MODES } from "../constants.js";
import { isRunResult, ownedCall, truncate } from "../runner.js";
import { argv } from "../tools.js";
import { validId, validProject } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolHarnessDetect(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Default only when the key is absent: an explicit null is invalid,
  // exactly as the Python server's args.get("mode", "own") treats it.
  const rawMode = args["mode"];
  const mode = rawMode === undefined ? "own" : rawMode;
  if (!(HARNESS_MODES as readonly unknown[]).includes(mode)) {
    return {
      payload: {
        error: "invalid mode",
        expect: "one of own, crew, secondmate, secondmate-model, secondmate-effort",
      },
      isError: true,
    };
  }
  const cmd =
    mode === "own"
      ? argv(path.join(ctx.binDir, "fm-harness.sh"))
      : argv(path.join(ctx.binDir, "fm-harness.sh"), mode as string);
  const { payload, isError } = await ownedCall(cmd, "harness detection failed", ctx.run);
  if (isError) return { payload, isError: true };
  const first = ((payload["stdout"] as string) || "").trim().split("\n");
  return { payload: { ...payload, mode, harness: first[0] ?? "" }, isError: false };
}

export async function toolProjectMode(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const project = args["project"];
  if (!validProject(project)) {
    return {
      payload: {
        error: "invalid project",
        expect: "bare name or projects/<name>, no absolute paths or traversal",
      },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-project-mode.sh"), project as string),
    "project mode refused or failed",
    ctx.run,
  );
  if (isError) return { payload, isError: true };
  // Mirror the Python projection exactly: exactly two tokens map to
  // mode/yolo, anything else maps to null/null.
  const tokens = ((payload["stdout"] as string) || "").trim().split(/\s+/).filter(Boolean);
  const mode = tokens.length === 2 ? tokens[0] : null;
  const yolo = tokens.length === 2 ? tokens[1] : null;
  return { payload: { ...payload, project, mode, yolo }, isError: false };
}

export async function toolLockStatus(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-lock.sh"), "status"),
    "lock status failed",
    ctx.run,
  );
  if (isError) return { payload, isError: true };
  const lines = ((payload["stdout"] as string) || "").trim().split("\n");
  const line = lines[0] ?? "";
  let status = "unknown";
  if (line === "lock: free") status = "free";
  else if (line.startsWith("lock: held")) status = "held";
  else if (line.startsWith("lock: stale")) status = "stale";
  else if (line.startsWith("lock: unreadable")) status = "unreadable";
  return { payload: { ...payload, status, raw: line }, isError: false };
}

export async function toolLeaseCheck(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["id"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  const res = await ctx.run([
    path.join(ctx.binDir, "fm-lease.sh"),
    "check",
    taskId as string,
  ]);
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  const [out, outTrunc] = truncate(res.stdout || "");
  const [, errTrunc] = truncate(res.stderr || "");
  if (res.exitCode === 0) {
    const holderLines = out.trim().split("\n");
    const holder = holderLines[0] ?? "";
    const record: Record<string, unknown> = {
      task_id: taskId,
      leased: true,
      holder,
      stdout_truncated: outTrunc,
      stderr_truncated: errTrunc,
    };
    const parts = holder.split(/\s+/).filter(Boolean);
    if (parts.length === 4) {
      const [actor, pid, epoch, live] = parts;
      const pidNum = /^\d+$/.test(pid) ? Number(pid) : null;
      const epochNum = /^\d+$/.test(epoch) ? Number(epoch) : null;
      record["actor"] = actor;
      record["pid"] = pidNum;
      record["epoch"] = epochNum;
      record["live"] = live === "live";
    }
    return { payload: record, isError: false };
  }
  if (res.exitCode === 1 && out.trim() === "") {
    return { payload: { task_id: taskId, leased: false }, isError: false };
  }
  const [errOut] = truncate(res.stderr || "");
  return {
    payload: {
      error: "lease check failed",
      exit: res.exitCode,
      stdout: out,
      stderr: errOut,
    },
    isError: true,
  };
}

// Refused stub: herdr_spur is code-forbidden (TIER_FORBIDDEN). The
// authorization gate refuses it before this body ever runs; the body
// exists so the name resolves in TOOLS and refuses as forbidden,
// never as unknown.
export async function toolHerdrSpur(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  void ctx;
  return { payload: { error: "forbidden" }, isError: true };
}

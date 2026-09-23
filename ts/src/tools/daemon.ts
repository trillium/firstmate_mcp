/**
 * Daemon & watch orchestration handlers (slice 1 of the tools.ts folder split,
 * task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts; the TOOLS registry entries still live in
 * tools.ts and reference these imports, and tools.ts re-exports them so the
 * `./tools.js` public surface is unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { ownedCall } from "../runner.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolDaemonStart(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const cmd = [path.join(ctx.binDir, "fm-supervise-daemon.sh")];
  return ownedCall(cmd, "daemon_start", ctx.run);
}

export async function toolDaemonStop(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const afkPath = path.join(ctx.stateDir, ".afk");
  try {
    if (fs.existsSync(afkPath)) {
      fs.unlinkSync(afkPath);
    }
    return { payload: { status: "stopped", afk: false }, isError: false };
  } catch (err) {
    return { payload: { error: "failed to stop daemon", detail: String(err) }, isError: true };
  }
}

export async function toolDaemonRestart(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const afkPath = path.join(ctx.stateDir, ".afk");
  try {
    fs.writeFileSync(afkPath, "", "utf8");
    return { payload: { status: "restarted", afk: true }, isError: false };
  } catch (err) {
    return { payload: { error: "failed to restart daemon", detail: String(err) }, isError: true };
  }
}

export async function toolDaemonStatus(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const afkPath = path.join(ctx.stateDir, ".afk");
  const isAfk = fs.existsSync(afkPath);
  return {
    payload: {
      status: isAfk ? "running" : "stopped",
      afk: isAfk,
    },
    isError: false,
  };
}

export async function toolWatchStart(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const cmd = [path.join(ctx.binDir, "fm-watch.sh")];
  return ownedCall(cmd, "watch_start", ctx.run);
}

export async function toolWatchStop(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  return { payload: { status: "stopped" }, isError: false };
}

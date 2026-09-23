/**
 * Session start/run/cursor + herdr lab. (slice 14a of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. Exported there, re-exported via
 * tools.ts so the `./tools.js` public surface is unchanged.
 */
import path from "node:path";
import { approvalError } from "../grants.js";
import { ownedCall } from "../runner.js";
import { argv } from "../tools.js";
import { validApproval } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

function validSessionSource(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(value);
}

function validLabSession(value: unknown): value is string {
  return typeof value === "string" && /^fm-lab-[A-Za-z0-9-]{1,48}$/.test(value);
}
export async function toolSessionStart(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const reemit = args["reemit"];
  const source = args["source"];
  if (reemit !== undefined && typeof reemit !== "boolean") {
    return { payload: { error: "invalid reemit", expect: "boolean" }, isError: true };
  }
  if (source !== undefined && !validSessionSource(source)) {
    return { payload: { error: "invalid source", expect: "short harness source slug" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [
    path.join(ctx.binDir, "fm-session-start.sh"),
    ...(reemit ? ["--reemit"] : []),
    ...(source ? ["--source", source as string] : []),
  ];
  return ownedCall(cmd, "session_start", ctx.run);
}

export async function toolSessionstartRun(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const source = args["source"];
  if (source !== undefined && !validSessionSource(source)) {
    return { payload: { error: "invalid source", expect: "short harness source slug" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  // --pi-prerequisite is an internal provider-preflight gate and stays out.
  const cmd = [
    path.join(ctx.binDir, "fm-sessionstart-run.sh"),
    ...(source ? ["--source", source as string] : []),
  ];
  return ownedCall(cmd, "sessionstart_run", ctx.run);
}

export async function toolSessionstartCursor(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const source = args["source"];
  if (!validSessionSource(source)) {
    return { payload: { error: "invalid source", expect: "short harness source slug" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [path.join(ctx.binDir, "fm-sessionstart-cursor.sh"), "--source", source as string];
  return ownedCall(cmd, "sessionstart_cursor", ctx.run);
}

export async function toolHerdrLab(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const subcommand = args["subcommand"];
  const session = args["session"];
  const label = args["label"];
  const action = args["action"];
  if (typeof subcommand !== "string" || !["name", "prepare", "provision", "run", "viewer", "stop", "teardown"].includes(subcommand)) {
    return { payload: { error: "invalid subcommand", expect: "name, prepare, provision, run, viewer, stop, or teardown" }, isError: true };
  }
  if (subcommand === "name") {
    if (typeof label !== "string" || !/^[A-Za-z0-9-]{1,16}$/.test(label)) {
      return { payload: { error: "invalid label", expect: "1..16 chars, letters/digits/dashes" }, isError: true };
    }
  } else {
    if (!validLabSession(session)) {
      return { payload: { error: "invalid session", expect: "fm-lab-<label>, never default" }, isError: true };
    }
    if (subcommand === "viewer" && action !== "start" && action !== "stop") {
      return { payload: { error: "invalid action", expect: "start or stop" }, isError: true };
    }
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  // run's trailing Herdr passthrough argv stays out: free-form Herdr
  // server/lifecycle operations never pass the doorway.
  let cmd: string[];
  if (subcommand === "name") {
    cmd = [path.join(ctx.binDir, "fm-herdr-lab.sh"), "name", label as string];
  } else if (subcommand === "viewer") {
    cmd = [path.join(ctx.binDir, "fm-herdr-lab.sh"), "viewer", action as string, session as string];
  } else {
    cmd = [path.join(ctx.binDir, "fm-herdr-lab.sh"), subcommand as string, session as string];
  }
  return ownedCall(cmd, "herdr_lab", ctx.run);
}

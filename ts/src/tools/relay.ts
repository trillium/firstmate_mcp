/**
 * Relay handlers: reply, dismiss, followup (slice 5 of the tools.ts folder
 * split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. All three were module-private there and
 * stay module-private here; tools.ts imports them for the TOOLS registry.
 * No re-export: the `./tools.js` public surface is unchanged.
 */
import path from "node:path";
import { requireAuth } from "../grants.js";
import { ownedCall } from "../runner.js";
import { argv } from "../tools.js";
import { removeTempFile, writeTempFile } from "./tempfiles.js";
import { validId } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolRelayReply(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const requestId = args["request_id"];
  const text = args["text"];
  if (!validId(requestId)) {
    return {
      payload: { error: "invalid request_id", expect: "short slug, no slashes or traversal" },
      isError: true,
    };
  }
  if (typeof text !== "string" || text.length < 1 || text.length > 2000) {
    return { payload: { error: "invalid text", expect: "1..2000 chars" }, isError: true };
  }
  const auth = await requireAuth("relay_reply", args, ctx);
  if (!auth.ok) return auth.result;
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-x-reply.sh"), requestId as string, text),
    "relay reply refused or failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, request_id: requestId }, isError: false };
  return { payload, isError: true };
}

export async function toolRelayDismiss(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const requestId = args["request_id"];
  if (!validId(requestId)) {
    return {
      payload: { error: "invalid request_id", expect: "short slug, no slashes or traversal" },
      isError: true,
    };
  }
  const auth = await requireAuth("relay_dismiss", args, ctx);
  if (!auth.ok) return auth.result;
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-x-dismiss.sh"), requestId as string),
    "relay dismiss refused or failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, request_id: requestId }, isError: false };
  return { payload, isError: true };
}

export async function toolRelayFollowup(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const text = args["text"];
  const final = args["final"] ?? false;
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid task_id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (typeof text !== "string" || text.length < 1 || text.length > 2000) {
    return { payload: { error: "invalid text", expect: "1..2000 chars" }, isError: true };
  }
  if (typeof final !== "boolean") {
    return { payload: { error: "invalid final", expect: "boolean" }, isError: true };
  }
  const auth = await requireAuth("relay_followup", args, ctx);
  if (!auth.ok) return auth.result;
  const tmp = writeTempFile(text);
  try {
    const cmd = argv(path.join(ctx.binDir, "fm-x-followup.sh"), taskId as string, "--text-file", tmp);
    if (final) cmd.push("--final");
    const { payload, isError } = await ownedCall(cmd, "relay followup refused or failed", ctx.run);
    if (!isError) return { payload: { ...payload, task_id: taskId }, isError: false };
    return { payload, isError: true };
  } finally {
    removeTempFile(tmp);
  }
}

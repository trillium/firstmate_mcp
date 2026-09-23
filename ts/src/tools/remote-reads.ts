/**
 * Wake/guard, remote, extension, handoff reads. (slice 11b of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. All eight were module-private there and stay module-private here; tools.ts imports them for the
 * TOOLS registry.
 */
import fs from "node:fs";
import path from "node:path";
import {
  HANDOFF_DEFAULT_LINES,
  REMOTE_FILE_DEFAULT_MAX_BYTES,
} from "../constants.js";
import { ownedCall } from "../runner.js";
import { argv } from "../tools.js";
import {
  confineHandoffPath,
  validDeltaWait,
  validExtensionId,
  validHandoffLines,
  validId,
  validNonnegInt,
  validRelpath,
  validRemoteMaxBytes,
  validSha256,
} from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolWakeDrain(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  return ownedCall(argv(path.join(ctx.binDir, "fm-wake-drain.sh")), "wake drain failed", ctx.run);
}

export async function toolGuardCheck(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const guardRun: typeof ctx.run = (argvIn, opts = {}) =>
    ctx.run(argvIn, { ...opts, env: { ...process.env, FM_GUARD_READ_ONLY: "1" } });
  return ownedCall(argv(path.join(ctx.binDir, "fm-guard.sh")), "guard check failed", guardRun);
}

// --- SUPPORTED: secondmate / remote reads (Tier 1, no approval) ---

export async function toolRemoteDoctor(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Check mode only: the --fix repair path stays out of scope.
  return ownedCall(argv(path.join(ctx.binDir, "fm-remote-doctor.sh")), "doctor failed", ctx.run);
}

export async function toolRemoteFile(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const relpath = args["path"];
  if (!validRelpath(relpath)) {
    return {
      payload: { error: "invalid path", expect: "relative path under the home, no traversal" },
      isError: true,
    };
  }
  const maxBytes = validRemoteMaxBytes(args["max_bytes"] ?? REMOTE_FILE_DEFAULT_MAX_BYTES);
  if (maxBytes === null) {
    return {
      payload: { error: "invalid max_bytes", expect: "integer 1..262144" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-remote-file.sh"), "get", relpath, String(maxBytes)),
    "remote file read failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, path: relpath, max_bytes: maxBytes }, isError: false };
  return { payload, isError: true };
}

export async function toolRemoteDelta(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const relLog = args["log"];
  if (!validRelpath(relLog)) {
    return {
      payload: { error: "invalid path", expect: "relative log path under the home, no traversal" },
      isError: true,
    };
  }
  const offset = validNonnegInt(args["offset"] ?? 0);
  if (offset === null) {
    return {
      payload: { error: "invalid offset", expect: "nonnegative integer byte cursor" },
      isError: true,
    };
  }
  const sha = args["sha256"];
  if (!validSha256(sha)) {
    return {
      payload: { error: "invalid sha256", expect: "64 hex chars of the exact prefix" },
      isError: true,
    };
  }
  const wait = validDeltaWait(args["wait"] ?? 0);
  if (wait === null) {
    return {
      payload: { error: "invalid wait", expect: "integer 0..10 seconds" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-remote-delta-read.sh"), relLog, String(offset), sha, String(wait)),
    "remote delta read failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, log: relLog, offset }, isError: false };
  return { payload, isError: true };
}

export async function toolExtensionList(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // List only: binding, retirement, verify, process-event, and remote-bind
  // facets stay out of scope (see extension_inspect divergence).
  return ownedCall(argv(path.join(ctx.binDir, "fm-extension.sh"), "list"), "extension list failed", ctx.run);
}

export async function toolExtensionInspect(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const id = args["id"];
  if (!validExtensionId(id)) {
    return {
      payload: { error: "invalid id", expect: "extension id [a-z0-9]+([.-][a-z0-9]+)*, max 128 bytes" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-extension.sh"), "inspect", id),
    "extension inspect failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, id }, isError: false };
  return { payload, isError: true };
}

export async function toolHandoffStatus(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["id"];
  if (taskId !== undefined && !validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  const lines = validHandoffLines(args["lines"] ?? HANDOFF_DEFAULT_LINES);
  if (lines === null) {
    return { payload: { error: "invalid lines", expect: "integer 1..20" }, isError: true };
  }
  const handoffDir = path.join(ctx.dataDir, "handoff");
  if (taskId === undefined) {
    let names: string[];
    try {
      names = fs.readdirSync(handoffDir)
        .filter((name) => {
          if (!name.endsWith(".outbox.md")) return false;
          try {
            const st = fs.lstatSync(path.join(handoffDir, name));
            return st.isFile() && !st.isSymbolicLink();
          } catch {
            return false;
          }
        })
        .sort();
    } catch (exc) {
      const nodeErr = exc as NodeJS.ErrnoException;
      if (nodeErr?.code === "ENOENT") return { payload: { outboxes: [] }, isError: false };
      return { payload: { error: "cannot read handoff", detail: String(exc) }, isError: true };
    }
    const outboxes: Array<Record<string, unknown>> = [];
    for (const name of names) {
      try {
        const raw = fs.readFileSync(path.join(handoffDir, name), "utf8");
        const text = raw.split("\n");
        if (text.length > 0 && text[text.length - 1] === "") text.pop();
        const size = fs.statSync(path.join(handoffDir, name)).size;
        outboxes.push({
          id: name.slice(0, -".outbox.md".length),
          bytes: size,
          total_lines: text.length,
        });
      } catch (exc) {
        return { payload: { error: "cannot read handoff", detail: String(exc) }, isError: true };
      }
    }
    return { payload: { outboxes }, isError: false };
  }
  const confined = confineHandoffPath(ctx.dataDir, taskId);
  if (confined === null) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  let content: string[];
  let size: number;
  try {
    const raw = fs.readFileSync(confined, "utf8");
    content = raw.split("\n");
    if (content.length > 0 && content[content.length - 1] === "") content.pop();
    size = fs.statSync(confined).size;
  } catch (exc) {
    const nodeErr = exc as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") {
      return { payload: { error: "no handoff for id", id: taskId }, isError: true };
    }
    return { payload: { error: "cannot read handoff", detail: String(exc) }, isError: true };
  }
  return {
    payload: { id: taskId, bytes: size, total_lines: content.length, lines: content.slice(-lines) },
    isError: false,
  };
}

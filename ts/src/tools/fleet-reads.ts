/**
 * Crew-state, status-tail, send-message, peek reads. (slice 10d of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. Private as before; tools.ts imports them for the
 * TOOLS registry.
 */
import fs from "node:fs";
import path from "node:path";
import { SEND_TEXT_MAX_CHARS } from "../constants.js";
import { isRunResult, ownedCall, truncate } from "../runner.js";
import { argv } from "../tools.js";
import {
  confineStatePath,
  validId,
  validPeekLines,
  validStatusLines,
} from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

const CREW_STATE_RE = /state:\s*(\S+)\s+·\s*source:\s*(\S+)\s+·\s*(.*)/;

export async function toolCrewState(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["id"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  const res = await ctx.run([path.join(ctx.binDir, "fm-crew-state.sh"), taskId]);
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  const rawLines = (res.stdout || "").trim().split("\n");
  const line = rawLines[0] ?? "";
  let parsed: Record<string, unknown> = { state: "unknown", source: "none", detail: line };
  const match = CREW_STATE_RE.exec(line);
  if (match) {
    parsed = { state: match[1], source: match[2], detail: match[3] };
  }
  return { payload: { id: taskId, current: parsed, raw: line }, isError: false };
}

export async function toolStatusTail(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["id"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  let lines: number;
  const rawLines = args["lines"] ?? 10;
  if (typeof rawLines === "number" && Number.isInteger(rawLines)) {
    lines = rawLines;
  } else if (typeof rawLines === "string" && rawLines.trim() !== "" && Number.isInteger(Number(rawLines))) {
    lines = Number(rawLines);
  } else {
    return { payload: { error: "invalid lines", expect: "integer 1..50" }, isError: true };
  }
  lines = Math.max(1, Math.min(50, lines));
  void validStatusLines;
  let stateResolved: string;
  try {
    stateResolved = fs.realpathSync(ctx.stateDir);
  } catch {
    return { payload: { error: "no status log for id", id: taskId }, isError: true };
  }
  void stateResolved;
  const confined = confineStatePath(ctx.stateDir, taskId);
  if (confined === null) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  let content: string[];
  try {
    content = fs.readFileSync(confined, "utf8").split("\n");
    // Drop the trailing empty element from a final newline, matching
    // Python's str.splitlines() semantics.
    if (content.length > 0 && content[content.length - 1] === "") content.pop();
  } catch (exc) {
    const nodeErr = exc as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") {
      return { payload: { error: "no status log for id", id: taskId }, isError: true };
    }
    return {
      payload: { error: "cannot read status log", detail: String(exc) },
      isError: true,
    };
  }
  return {
    payload: {
      id: taskId,
      events: content.slice(-lines),
      warning:
        "wake-event history only, never current state; use crew_state for current state",
    },
    isError: false,
  };
}

export async function toolSendMessage(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const target = args["target"];
  const text = args["text"];
  if (!validId(target)) {
    return {
      payload: { error: "invalid target", expect: "exact task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (typeof text !== "string" || text.length < 1 || text.length > SEND_TEXT_MAX_CHARS) {
    return {
      payload: {
        error: "invalid text",
        expect: `single line, 1..${SEND_TEXT_MAX_CHARS} chars`,
      },
      isError: true,
    };
  }
  if (text.includes("\n") || text.includes("\r")) {
    return {
      payload: { error: "invalid text", expect: "single line, no newlines" },
      isError: true,
    };
  }
  if (text.trimStart().startsWith("/")) {
    return {
      payload: { error: "slash commands refused", expect: "plain prose steer only" },
      isError: true,
    };
  }
  const res = await ctx.run([path.join(ctx.binDir, "fm-send.sh"), target as string, text]);
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  const [out, outTrunc] = truncate(res.stdout || "");
  const [errOut, errTrunc] = truncate(res.stderr || "");
  if (res.exitCode !== 0) {
    return {
      payload: {
        error: "steer refused or failed",
        target,
        exit: res.exitCode,
        stdout: out,
        stderr: errOut,
      },
      isError: true,
    };
  }
  return {
    payload: {
      delivered: true,
      target,
      note: "verified submit per fm-send contract; delivery is not reply",
      stdout: out,
      stdout_truncated: outTrunc,
      stderr_truncated: errTrunc,
    },
    isError: false,
  };
}

// --- SUPPORTED: diagnostic reads (Tier 1, no approval) ---

export async function toolPeek(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const target = args["target"];
  if (!validId(target)) {
    return {
      payload: { error: "invalid target", expect: "exact task id, no slashes or traversal" },
      isError: true,
    };
  }
  const lines = validPeekLines(args["lines"] ?? 40);
  if (lines === null) {
    return {
      payload: { error: "invalid lines", expect: "integer 1..100" },
      isError: true,
    };
  }
  void validStatusLines;
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-peek.sh"), target as string, String(lines)),
    "peek failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, target, lines }, isError: false };
  return { payload, isError: true };
}

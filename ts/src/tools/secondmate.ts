/**
 * Secondmate/remote/handoff handlers: nudge, restart, report, remote
 * control, handoff move, fleet poll (slice 6 of the tools.ts folder split,
 * task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. All six were module-private there and
 * stay module-private here; tools.ts imports them for the TOOLS registry.
 * No re-export: the `./tools.js` public surface is unchanged.
 */
import path from "node:path";
import {
  HANDOFF_KEYS_MAX,
  MAX_OUTPUT_BYTES,
  REMOTE_CONTROL_VERBS,
  RESTART_IDS_MAX,
  SEND_TEXT_MAX_CHARS,
} from "../constants.js";
import { requireAuth } from "../grants.js";
import { byteLength, ownedCall } from "../runner.js";
import { argv, toolFleetSnapshot } from "../tools.js";
import {
  validCorr,
  validId,
  validIdList,
  validNote,
} from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

function sleepSyncMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function toolSecondmateNudge(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Notify-only subset: the backstop asks mismatched secondmates to
  // reconcile through the cooldown-guarded notify path.
  const auth = await requireAuth("secondmate_nudge", args, ctx);
  if (!auth.ok) return auth.result;
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-secondmate-reconcile.sh"), "notify"),
    "reconcile notify refused or failed",
    ctx.run,
  );
}

export async function toolSecondmateRestart(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const ids = validIdList(args["ids"], RESTART_IDS_MAX);
  if (ids === null) {
    return {
      payload: { error: "invalid id", expect: "1..8 secondmate ids, no slashes or traversal" },
      isError: true,
    };
  }
  const auth = await requireAuth("secondmate_restart", args, ctx);
  if (!auth.ok) return auth.result;
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-secondmate-restart.sh"), ...ids),
    "secondmate restart refused or failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, ids }, isError: false };
  return { payload, isError: true };
}

export async function toolSecondmateReport(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const verb = args["verb"];
  if (!validId(verb)) {
    return {
      payload: { error: "invalid verb", expect: "short slug, no slashes or traversal" },
      isError: true,
    };
  }
  const corr = args["corr"];
  if (!validCorr(corr)) {
    return {
      payload: { error: "invalid corr", expect: "16 hex chars, optional corr= prefix" },
      isError: true,
    };
  }
  const note = args["note"];
  if (!validNote(note)) {
    return {
      payload: { error: "invalid note", expect: "single line, 1..500 chars" },
      isError: true,
    };
  }
  const auth = await requireAuth("secondmate_report", args, ctx);
  if (!auth.ok) return auth.result;
  // Note-only form: --doc stays out, and the helper resolves the parent
  // channel itself, so no status path ever crosses this boundary.
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-secondmate-report.sh"), verb, corr, note),
    "secondmate report refused or failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, verb, corr }, isError: false };
  return { payload, isError: true };
}

export async function toolRemoteControl(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const verb = args["verb"];
  if (typeof verb !== "string" || !(REMOTE_CONTROL_VERBS as readonly string[]).includes(verb)) {
    return {
      payload: { error: "invalid verb", expect: "one of state, route, observe, send" },
      isError: true,
    };
  }
  const taskId = args["id"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  const auth = await requireAuth("remote_control", args, ctx);
  if (!auth.ok) return auth.result;
  const cmd = argv(path.join(ctx.binDir, "fm-remote-secondmate-control.sh"), verb, taskId);
  if (verb === "send") {
    const text = args["text"];
    if (typeof text !== "string" || text.length < 1 || text.length > SEND_TEXT_MAX_CHARS) {
      return {
        payload: { error: "invalid text", expect: `single line, 1..${SEND_TEXT_MAX_CHARS} chars` },
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
    cmd.push(text);
  }
  // Closed verb subset: launch/relaunch (firstmate-owned provisioning),
  // key/capture (raw pane access), and sync/update/retire (remote code
  // and pane teardown) stay out.
  const { payload, isError } = await ownedCall(cmd, "remote control refused or failed", ctx.run);
  if (!isError) return { payload: { ...payload, verb, id: taskId }, isError: false };
  return { payload, isError: true };
}

export async function toolHandoffMove(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["id"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  const resume = args["resume"] ?? false;
  if (typeof resume !== "boolean") {
    return { payload: { error: "invalid resume", expect: "boolean" }, isError: true };
  }
  const auth = await requireAuth("handoff_move", args, ctx);
  if (!auth.ok) return auth.result;
  if (resume) {
    const keys = args["keys"] ?? [];
    if (!(Array.isArray(keys) && keys.length === 0)) {
      return {
        payload: { error: "invalid keys", expect: "resume takes no keys" },
        isError: true,
      };
    }
    const { payload, isError } = await ownedCall(
      argv(path.join(ctx.binDir, "fm-backlog-handoff.sh"), "--resume-pending"),
      "handoff refused or failed",
      ctx.run,
    );
    if (!isError) return { payload: { ...payload, id: taskId, resumed: true }, isError: false };
    return { payload, isError: true };
  }
  const keys = validIdList(args["keys"], HANDOFF_KEYS_MAX);
  if (keys === null) {
    return {
      payload: { error: "invalid keys", expect: "1..20 backlog item keys, no slashes or traversal" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-backlog-handoff.sh"), taskId, ...keys),
    "handoff refused or failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, id: taskId, keys }, isError: false };
  return { payload, isError: true };
}

export async function toolFleetPoll(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  let count: number;
  const rawCount = args["count"] ?? 2;
  if (typeof rawCount === "number" && Number.isInteger(rawCount)) {
    count = rawCount;
  } else if (typeof rawCount === "string" && rawCount.trim() !== "" && Number.isInteger(Number(rawCount))) {
    count = Number(rawCount);
  } else {
    return { payload: { error: "invalid count", expect: "integer 1..3" }, isError: true };
  }
  let intervalS: number;
  const rawInterval = args["interval_s"] ?? 0;
  if (typeof rawInterval === "number" && Number.isFinite(rawInterval)) {
    intervalS = rawInterval;
  } else if (typeof rawInterval === "string" && rawInterval.trim() !== "" && Number.isFinite(Number(rawInterval))) {
    intervalS = Number(rawInterval);
  } else {
    return { payload: { error: "invalid interval_s", expect: "number 0..2" }, isError: true };
  }
  count = Math.max(1, Math.min(3, count));
  intervalS = Math.max(0, Math.min(2, intervalS));
  const polls: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    const { payload: snapshot, isError } = await toolFleetSnapshot({}, ctx);
    if (isError) return { payload: snapshot, isError: true };
    polls.push({
      generated: snapshot["generated"],
      tasks: ((snapshot["tasks"] as unknown[]) ?? []).length,
    });
    if (intervalS > 0) await sleepSyncMs(intervalS * 1000);
  }
  const payload: Record<string, unknown> = {
    polls,
    warning: "polling convenience only; fleet_snapshot stays canonical",
  };
  if (byteLength(JSON.stringify(payload)) > MAX_OUTPUT_BYTES) {
    return {
      payload: { error: "poll output too large for PoC envelope", polls: polls.length },
      isError: true,
    };
  }
  return { payload, isError: false };
}

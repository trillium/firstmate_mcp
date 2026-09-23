/**
 * Intake, worktree, lifecycle drive, review gate, reconcile. (slice 14c of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. Exported there, re-exported via
 * tools.ts so the `./tools.js` public surface is unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { MODES, VERDICTS } from "../constants.js";
import { ownedCall } from "../runner.js";
import { toolSpawnCrew, toolScaffoldBrief } from "./spawn.js";
import { toolReviewDecision } from "./decisions-review.js";
import { toolCrewState } from "./fleet-reads.js";
import { toolReviewDiff } from "./fleet-views.js";
import { validId, validProject } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolTaskIntake(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const project = args["project"];
  const mode = args["mode"] !== undefined ? args["mode"] : "no-mistakes";
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!validProject(project)) {
    return { payload: { error: "invalid project", expect: "bare name or projects/<name>" }, isError: true };
  }
  const briefRes = await toolScaffoldBrief({ task_id: taskId, project, mode, approval: args["approval"] }, ctx);
  if (briefRes.isError) return briefRes;
  return {
    payload: {
      status: "intake_complete",
      task_id: taskId,
      project,
      mode,
      brief: briefRes.payload,
    },
    isError: false,
  };
}

export async function toolWorktreeAllocate(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const project = args["project"];
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!validProject(project)) {
    return { payload: { error: "invalid project", expect: "bare name or projects/<name>" }, isError: true };
  }
  const wtPath = path.resolve(ctx.stateDir, "worktrees", taskId as string);
  try {
    fs.mkdirSync(wtPath, { recursive: true });
    return {
      payload: {
        status: "allocated",
        task_id: taskId,
        worktree_path: wtPath,
      },
      isError: false,
    };
  } catch (err) {
    return { payload: { error: "failed to allocate worktree", detail: String(err) }, isError: true };
  }
}

export async function toolLifecycleDrive(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const project = args["project"];
  const mode = (args["mode"] as (typeof MODES)[number]) || "no-mistakes";
  const yolo = (args["yolo"] as "on" | "off") || "off";
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!validProject(project)) {
    return { payload: { error: "invalid project", expect: "bare name or projects/<name>" }, isError: true };
  }
  const spawnRes = await toolSpawnCrew({ task_id: taskId, project, mode, yolo, approval: args["approval"] }, ctx);
  if (spawnRes.isError) return spawnRes;
  const stateRes = await toolCrewState({ id: taskId }, ctx);
  return {
    payload: {
      status: "lifecycle_driven",
      task_id: taskId,
      spawn: spawnRes.payload,
      current_state: stateRes.payload,
    },
    isError: false,
  };
}

export async function toolReviewGate(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const verdict = args["verdict"] as (typeof VERDICTS)[number];
  const comment = args["comment"] as string | undefined;
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!VERDICTS.includes(verdict)) {
    return { payload: { error: "invalid verdict", expect: `must be one of ${VERDICTS.join(", ")}` }, isError: true };
  }
  const diffRes = await toolReviewDiff({ id: taskId, stat: true }, ctx);
  if (diffRes.isError) return diffRes;
  const decRes = await toolReviewDecision({ id: taskId, verdict, comment, approval: args["approval"] }, ctx);
  if (decRes.isError) return decRes;
  return {
    payload: {
      status: "review_gate_passed",
      task_id: taskId,
      verdict,
      diff: diffRes.payload,
      decision: decRes.payload,
    },
    isError: false,
  };
}

export async function toolReconcileUpstream(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const cmd = ["python3", path.join(ctx.binDir, "..", "drift", "shift.py"), "--format", "json"];
  return ownedCall(cmd, "reconcile_upstream", ctx.run);
}

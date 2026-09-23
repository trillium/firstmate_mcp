/**
 * Crew spawn + brief scaffolding. (slice 12a of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. Both handlers were module-private there
 * and stay module-private here; tools.ts imports them for the TOOLS registry.
 * No re-export: the `./tools.js` public surface is unchanged.
 */
import path from "node:path";
import { BRIEF_MODES, MODES, YOLO } from "../constants.js";
import { requireAuth } from "../grants.js";
import { ownedCall } from "../runner.js";
import { argv } from "../tools.js";
import { validId, validProject } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolSpawnCrew(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const project = args["project"];
  const mode = args["mode"];
  const yolo = args["yolo"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid task_id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (!validProject(project)) {
    return {
      payload: {
        error: "invalid project",
        expect: "bare name or projects/<name>, no absolute paths or traversal",
      },
      isError: true,
    };
  }
  if (!(MODES as readonly unknown[]).includes(mode)) {
    return {
      payload: { error: "invalid mode", expect: "one of no-mistakes, direct-PR, local-only" },
      isError: true,
    };
  }
  if (!(YOLO as readonly unknown[]).includes(yolo)) {
    return { payload: { error: "invalid yolo", expect: "one of on, off" }, isError: true };
  }
  const auth = await requireAuth("spawn_crew", args, ctx);
  if (!auth.ok) return auth.result;
  const { payload, isError } = await ownedCall(
    argv(
      path.join(ctx.binDir, "fm-spawn.sh"),
      taskId as string,
      project as string,
      "--mode",
      mode as string,
      "--yolo",
      yolo as string,
    ),
    "spawn refused or failed",
    ctx.run,
  );
  if (!isError) {
    return { payload: { ...payload, task_id: taskId, project, mode }, isError: false };
  }
  return { payload, isError: true };
}

export async function toolScaffoldBrief(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const project = args["project"];
  const mode = args["mode"];
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid task_id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (!validProject(project)) {
    return {
      payload: {
        error: "invalid project",
        expect: "bare name or projects/<name>, no absolute paths or traversal",
      },
      isError: true,
    };
  }
  if (!(BRIEF_MODES as readonly unknown[]).includes(mode)) {
    return {
      payload: {
        error: "invalid mode",
        expect: "one of no-mistakes, direct-PR, local-only, scout",
      },
      isError: true,
    };
  }
  const auth = await requireAuth("scaffold_brief", args, ctx);
  if (!auth.ok) return auth.result;
  const base = [path.join(ctx.binDir, "fm-brief.sh"), taskId as string, project as string];
  const cmd =
    mode === "scout" ? argv(...base, "--scout") : argv(...base, "--mode", mode as string);
  const { payload, isError } = await ownedCall(cmd, "brief refused or failed", ctx.run);
  if (!isError) {
    return { payload: { ...payload, task_id: taskId, project, mode }, isError: false };
  }
  return { payload, isError: true };
}

/**
 * Registry fragment: spawn (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { lifecycleTool } from "../digests-write.js";
import { toolSpawnCrew, toolScaffoldBrief } from "../spawn.js";
import { BRIEF_MODES, MODES } from "../../constants.js";
import { approvalSchema, idApprovalSchema } from "./shared.js";
import type { ToolDef } from "./shared.js";

export const SpawnRegistry: Record<string, ToolDef> = {
  lifecycle_interrupt: {
    description:
      "Authority write: deliver the harness interrupt sequence to one crew; agent keeps running.",
    inputSchema: idApprovalSchema(),
    handler: (args, ctx) => lifecycleTool(args, ctx, "interrupt", false),
  },
  lifecycle_exit: {
    description:
      "Authority write: stop one agent, preserving its endpoint, worktree, and uncommitted changes.",
    inputSchema: idApprovalSchema(),
    handler: (args, ctx) => lifecycleTool(args, ctx, "exit", false),
  },
  lifecycle_relaunch: {
    description:
      "Authority write: transactionally replace one running agent in the same endpoint and worktree.",
    inputSchema: approvalSchema({
      id: { type: "string", description: "Task id" },
      note: { type: "string", description: "Progress note, single line 1..500 chars" },
    }),
    handler: (args, ctx) => lifecycleTool(args, ctx, "relaunch", true),
  },
  lifecycle_suspend: {
    description: "Authority write: park one persistent secondmate with a durable note.",
    inputSchema: approvalSchema({
      id: { type: "string", description: "Task id" },
      note: { type: "string", description: "Park note, single line 1..500 chars" },
    }),
    handler: (args, ctx) => lifecycleTool(args, ctx, "suspend", true),
  },
  lifecycle_resume: {
    description: "Authority write: restore one parked secondmate with a durable note.",
    inputSchema: approvalSchema({
      id: { type: "string", description: "Task id" },
      note: { type: "string", description: "Resume note, single line 1..500 chars" },
    }),
    handler: (args, ctx) => lifecycleTool(args, ctx, "resume", true),
  },
  spawn_crew: {
    description:
      "Authority write: spawn one direct report via fm-spawn.sh with an explicit delivery contract.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      project: { type: "string", description: "Bare name or projects/<name>" },
      mode: { type: "string", enum: [...MODES] },
      yolo: { type: "string", enum: ["on", "off"] },
    }),
    handler: toolSpawnCrew,
  },
  scaffold_brief: {
    description:
      "Authority write: scaffold one crewmate brief via fm-brief.sh; does not launch anything.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      project: { type: "string", description: "Bare name or projects/<name>" },
      mode: { type: "string", enum: [...BRIEF_MODES] },
    }),
    handler: toolScaffoldBrief,
  },
};

/**
 * Registry fragment: landing-daemon (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolDaemonStart, toolDaemonStop, toolDaemonRestart, toolDaemonStatus, toolWatchStart, toolWatchStop } from "../daemon.js";
import { toolPromoteScout, toolTeardownCrew, toolArmPrCheck, toolMergePr, toolMergeLocal, toolRepoEdit, toolRepoCommit, toolRepoPush, toolRepoMerge } from "../landing.js";
import { MODES } from "../../constants.js";
import { approvalSchema, idApprovalSchema } from "./shared.js";
import type { ToolDef } from "./shared.js";

export const LandingDaemonRegistry: Record<string, ToolDef> = {
  promote_scout: {
    description: "Authority write: promote a scout task to a ship task in place.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      mode: { type: "string", enum: [...MODES] },
      yolo: { type: "string", enum: ["on", "off"] },
    }),
    handler: toolPromoteScout,
  },
  teardown_crew: {
    description: "Authority write: tear down one completed crew and release resources.",
    inputSchema: idApprovalSchema("task_id"),
    handler: toolTeardownCrew,
  },
  arm_pr_check: {
    description: "Authority write: arm watcher PR check for a landed crew task.",
    inputSchema: idApprovalSchema("task_id"),
    handler: toolArmPrCheck,
  },
  merge_pr: {
    description: "Authority write: merge a task PR or MR via fm-pr-merge.sh.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      method: { type: "string", enum: ["squash", "merge", "rebase"], default: "squash" },
    }),
    handler: toolMergePr,
  },
  merge_local: {
    description: "Authority write: fast-forward local default branch for mode=local-only tasks.",
    inputSchema: idApprovalSchema("task_id"),
    handler: toolMergeLocal,
  },
  repo_edit: {
    description: "Authority write: edit or create a bounded file within the workspace.",
    inputSchema: approvalSchema({
      path: { type: "string", description: "Home-relative path" },
      content: { type: "string", description: "File content (<= 256KB)" },
    }),
    handler: toolRepoEdit,
  },
  repo_commit: {
    description: "Authority write: commit workspace changes with a single-line message.",
    inputSchema: approvalSchema({
      message: { type: "string", description: "Commit message 1..500 chars" },
    }),
    handler: toolRepoCommit,
  },
  repo_push: {
    description: "Authority write: push a non-default branch to origin.",
    inputSchema: approvalSchema({
      branch: { type: "string", description: "Target branch name" },
    }),
    handler: toolRepoPush,
  },
  repo_merge: {
    description: "Authority write: merge a branch with --no-ff.",
    inputSchema: approvalSchema({
      branch: { type: "string", description: "Branch to merge" },
    }),
    handler: toolRepoMerge,
  },
  daemon_start: {
    description: "Authority write: start the away-mode supervisor daemon.",
    inputSchema: approvalSchema({}),
    handler: toolDaemonStart,
  },
  daemon_stop: {
    description: "Authority write: stop the away-mode supervisor daemon by clearing .afk.",
    inputSchema: approvalSchema({}),
    handler: toolDaemonStop,
  },
  daemon_restart: {
    description: "External write: restart the away-mode supervisor daemon.",
    inputSchema: approvalSchema({}),
    handler: toolDaemonRestart,
  },
  daemon_status: {
    description: "Read-only check on the supervisor daemon state and away posture.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolDaemonStatus,
  },
  watch_start: {
    description: "Authority write: run one watcher polling cycle.",
    inputSchema: approvalSchema({}),
    handler: toolWatchStart,
  },
  watch_stop: {
    description: "Authority write: stop watcher cycle.",
    inputSchema: approvalSchema({}),
    handler: toolWatchStop,
  },
};

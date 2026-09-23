/**
 * Registry fragment: tasks (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolPublicFollowupEmit, toolRelayLink, toolFleetSync, toolInactiveReconcile } from "../denied.js";
import { toolPublicFollowupPending, toolPublicFollowupCollect } from "../policy.js";
import { toolRelayPoll } from "../pr-reads.js";
import { toolTasksList, toolTasksShow, toolTasksReady, toolDispatchResolve, toolSessionstartNudge } from "../tasks.js";
import { approvalSchema } from "./shared.js";
import type { ToolDef } from "./shared.js";

export const TasksRegistry: Record<string, ToolDef> = {
  relay_poll: {
    description: "Read-only short-poll of the relay connector; hard no-op without relay consent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolRelayPoll,
  },
  public_followup_pending: {
    description:
      "Open public-followup loop digest; reports unresolved and delivered public loops without mutating state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolPublicFollowupPending,
  },
  public_followup_collect: {
    description:
      "Non-destructively read typed terminal events staged in this home's outbox for an obligation.",
    inputSchema: {
      type: "object",
      properties: {
        obligation_id: {
          type: "string",
          description: "tasks-axi public-followup obligation id (short slug)",
        },
      },
      required: ["obligation_id"],
      additionalProperties: false,
    },
    handler: toolPublicFollowupCollect,
  },
  public_followup_emit: {
    description:
      "Authority write: emit a structured terminal event for work bound to a public commitment.",
    inputSchema: approvalSchema({
      obligation_id: { type: "string" },
      relation_id: { type: "string" },
      source_home: { type: "string" },
      work_id: { type: "string" },
      generation: { type: "integer", minimum: 1 },
      outcome: { type: "string" },
      outcome_text: { type: "string" },
    }),
    handler: toolPublicFollowupEmit,
  },
  relay_link: {
    description: "Authority write: link a task to the relay mention that triggered it.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      request_id: { type: "string" },
    }),
    handler: toolRelayLink,
  },
  fleet_sync: {
    description: "Authority write: refresh project clones with safe fast-forwards, self-heals, and branch pruning.",
    inputSchema: approvalSchema({
      project: { type: "string", description: "Optional project name or relative path" },
    }, []),
    handler: toolFleetSync,
  },
  inactive_reconcile: {
    description: "Authority write: run bounded reconciliation of inactive crewmate terminal outcomes.",
    inputSchema: approvalSchema({
      mode: { type: "string", enum: ["scan", "report", "acknowledge"], description: "Reconciliation mode" },
      startup: { type: "boolean", description: "Run startup scan immediately" },
      task_id: { type: "string", description: "Task ID for report mode" },
      fingerprint: { type: "string", description: "Outcome fingerprint for acknowledge mode" },
    }, []),
    handler: toolInactiveReconcile,
  },
  tasks_list: {
    description: "Read-only backlog item listing via fm-tasks-axi.sh list.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["queued", "in_flight", "done", "held", "all"], description: "Filter by task state" },
        repo: { type: "string", description: "Filter by repository name" },
        kind: { type: "string", description: "Filter by task kind" },
        blocked: { type: "boolean", description: "Filter to blocked tasks" },
        limit: { type: "integer", description: "Maximum number of items to list (1..1000)" },
        fields: { type: "string", description: "Comma-separated field list" },
      },
      additionalProperties: false,
    },
    handler: toolTasksList,
  },
  tasks_show: {
    description: "Read-only inspection of one task in the backlog via fm-tasks-axi.sh show.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID slug" },
        full: { type: "boolean", description: "Include full body notes" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolTasksShow,
  },
  tasks_ready: {
    description: "Read-only list of dependency-cleared ready queued work via fm-tasks-axi.sh ready.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Filter by repository name" },
        include_held: { type: "boolean", description: "Include held work in a separate section" },
      },
      additionalProperties: false,
    },
    handler: toolTasksReady,
  },
  dispatch_resolve: {
    description: "Read-only dispatch resolution for one task brief; prints a dispatch plan without launching anything.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id whose data/<id>/brief.md is resolved" },
        project: { type: "string", description: "Bare name or projects/<name>" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    handler: toolDispatchResolve,
  },
  sessionstart_nudge: {
    description: "Read-only session-start nudge read; prints the one-line start instruction or nothing, exits 0.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolSessionstartNudge,
  },
};

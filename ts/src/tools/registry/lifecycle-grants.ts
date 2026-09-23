/**
 * Registry fragment: lifecycle-grants (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolGrantMint, toolGrantRevoke, toolGrantStatus } from "../grant-tools.js";
import { toolTaskIntake, toolWorktreeAllocate, toolLifecycleDrive, toolReviewGate, toolReconcileUpstream } from "../lifecycle.js";
import { BRIEF_MODES, MODES, VERDICTS } from "../../constants.js";
import { approvalSchema } from "./shared.js";
import type { ToolDef } from "./shared.js";

export const LifecycleGrantsRegistry: Record<string, ToolDef> = {
  task_intake: {
    description: "Authority composite: ingest task and scaffold brief.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      project: { type: "string", description: "Bare name or projects/<name>" },
      mode: { type: "string", enum: [...BRIEF_MODES], default: "no-mistakes" },
    }),
    handler: toolTaskIntake,
  },
  worktree_allocate: {
    description: "Authority write: allocate isolated worktree slot for task.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      project: { type: "string" },
    }),
    handler: toolWorktreeAllocate,
  },
  lifecycle_drive: {
    description: "Authority composite: spawn crew and capture initial state.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      project: { type: "string" },
      mode: { type: "string", enum: [...MODES], default: "no-mistakes" },
      yolo: { type: "string", enum: ["on", "off"], default: "off" },
    }),
    handler: toolLifecycleDrive,
  },
  review_gate: {
    description: "Authority composite: inspect diff and record captain review decision.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      verdict: { type: "string", enum: [...VERDICTS] },
      comment: { type: "string" },
    }),
    handler: toolReviewGate,
  },
  reconcile_upstream: {
    description: "Authority composite: run upstream drift/shift report for reconciliation.",
    inputSchema: approvalSchema({}),
    handler: toolReconcileUpstream,
  },
  grant_mint: {
    description:
      "Authority write: mint a new scoped standing approval grant for autonomous loops.",
    inputSchema: approvalSchema({
      grantee: { type: "string", description: "Identity receiving the grant (e.g. task id or agent name)" },
      tier_limit: { type: "integer", minimum: 1, maximum: 4, default: 3, description: "Maximum tier allowed by grant" },
      tools: { type: "array", items: { type: "string" }, description: "Optional allowlist of tool names" },
      projects: { type: "array", items: { type: "string" }, description: "Optional allowlist of projects" },
      ttl_s: { type: "integer", minimum: 1, maximum: 2592000, default: 3600, description: "Grant lifetime in seconds" },
      max_uses: { type: "integer", minimum: 1, description: "Optional maximum usage count" },
      note: { type: "string", description: "Optional description or note for the grant" },
    }),
    handler: toolGrantMint,
  },
  grant_revoke: {
    description: "Authority write: revoke an active standing approval grant immediately.",
    inputSchema: approvalSchema({
      grant_id: { type: "string", description: "Grant ID or grant_ref to revoke" },
      reason: { type: "string", description: "Optional revocation reason" },
    }),
    handler: toolGrantRevoke,
  },
  grant_status: {
    description:
      "Read-only inspection of standing approval grants (safe metadata only, never exposes secrets).",
    inputSchema: {
      type: "object",
      properties: {
        grant_id: { type: "string", description: "Optional grant ID or grant_ref to inspect" },
        grantee: { type: "string", description: "Optional grantee filter" },
      },
      additionalProperties: false,
    },
    handler: toolGrantStatus,
  },
};

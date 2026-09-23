/**
 * Registry fragment: decisions (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolDecisionComplete, toolDecisionVerify, toolDecisionOpen, toolDecisionDiverged } from "../decisions-attest.js";
import { toolDecisionHold } from "../decisions-hold.js";
import { toolDecisionResolve, toolDecisionRelease } from "../decisions-release.js";
import { toolReviewDecision } from "../decisions-review.js";
import { VERDICTS } from "../../constants.js";
import { approvalSchema } from "./shared.js";
import type { ToolDef } from "./shared.js";

export const DecisionsRegistry: Record<string, ToolDef> = {
  decision_hold: {
    description:
      "Authority write: record one durable captain-held decision via fm-decision-hold.sh hold.",
    inputSchema: approvalSchema({
      origin_id: { type: "string" },
      decision_key: { type: "string", description: "Short slug" },
      title: { type: "string" },
      reason: { type: "string" },
    }),
    handler: toolDecisionHold,
  },
  decision_resolve: {
    description:
      "Authority write: resolve one held decision via fm-decision-hold.sh resolve with a decision file.",
    inputSchema: approvalSchema({
      origin_id: { type: "string" },
      decision_key: { type: "string" },
      routed_to: { type: "string", description: "Task id receiving the decision" },
      decision_text: { type: "string", description: "Decision record, 1..2000 chars" },
    }),
    handler: toolDecisionResolve,
  },
  decision_release: {
    description:
      "Authority write: release one captain hold via fm-decision-hold.sh resolve or fm-captain-hold.sh answer --release with a durable decision record.",
    inputSchema: approvalSchema({
      origin_id: { type: "string", description: "Origin task id for composed hold" },
      decision_key: { type: "string", description: "Short slug when origin_id is given" },
      id: { type: "string", description: "Direct task id to release" },
      routed_to: { type: "string", description: "Task id receiving the decision" },
      decision_text: { type: "string", description: "Decision record, 1..2000 chars" },
    }),
    handler: toolDecisionRelease,
  },
  decision_complete: {
    description:
      "Authority write: attest the reviewed inventory of captain-held tasks for an origin via fm-captain-hold.sh complete.",
    inputSchema: approvalSchema({
      origin_id: { type: "string", description: "Origin task id" },
      none: { type: "boolean", description: "Explicit attestation that no captain decisions remain" },
      task_ids: {
        type: "array",
        items: { type: "string" },
        description: "List of captain-held task ids or keys",
      },
    }),
    handler: toolDecisionComplete,
  },
  decision_verify: {
    description:
      "Open read: verify that an origin has completed its captain-call inventory and no open keyed decisions remain via fm-captain-hold.sh verify.",
    inputSchema: {
      type: "object",
      properties: {
        origin_id: { type: "string", description: "Origin task id" },
      },
      required: ["origin_id"],
      additionalProperties: false,
    },
    handler: toolDecisionVerify,
  },
  decision_open: {
    description:
      "Open read: check if a captain-held task is still open, optionally retrieving its lifecycle identity via fm-captain-hold.sh open.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id" },
        identity: { type: "boolean", description: "Retrieve lifecycle identity" },
        distinguish_absent: { type: "boolean", description: "Distinguish absent tasks from not-open tasks" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolDecisionOpen,
  },
  decision_diverged: {
    description:
      "Open read: check for divergence between status log decisions and durable captain holds via fm-captain-hold.sh diverged.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: toolDecisionDiverged,
  },
  review_decision: {
    description:
      "Authority write: record one captain approve, decline, or comment via fm-captain-hold.sh answer with a decision file.",
    inputSchema: approvalSchema({
      id: { type: "string" },
      verdict: { type: "string", enum: [...VERDICTS] },
      comment: { type: "string", description: "Optional single-line comment" },
      release: { type: "boolean", description: "Release hold so held work resumes (tasks-axi unhold) instead of closing task" },
    }),
    handler: toolReviewDecision,
  },
};

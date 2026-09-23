/**
 * Registry fragment: mixed (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolReceiptSubmit, toolReceiptStatus } from "../receipts.js";
import { toolFleetPoll } from "../secondmate.js";
import { toolBacklogReceive } from "../tasks.js";
import { approvalSchema } from "./shared.js";
import type { ToolDef } from "./shared.js";

export const MixedRegistry: Record<string, ToolDef> = {
  backlog_receive: {
    description: "Authority write: receive one delivered remote-secondmate outbox into this home's backlog.",
    inputSchema: approvalSchema({
      path: { type: "string", description: "Delivered outbox path (state/handoff/<id>.outbox.md)" },
      bytes: { type: "integer", description: "Expected byte size" },
      sha256: { type: "string", description: "Expected SHA-256 digest" },
      generation: { type: "integer", description: "Upload generation" },
    }, ["path", "bytes", "sha256", "generation"]),
    handler: toolBacklogReceive,
  },
  receipt_submit: {
    description:
      "Detach one tool call past the 30s fail-closed budget; returns a pending receipt to poll with receipt_status.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Name of the tool to run detached" },
        arguments: {
          type: "object",
          description:
            "Arguments for the named tool, including its approval when it requires one",
        },
      },
      required: ["tool", "arguments"],
      additionalProperties: false,
    },
    handler: toolReceiptSubmit,
  },
  receipt_status: {
    description:
      "Read-only check on one detached receipt; reports running, done with the result attached, failed, or expired.",
    inputSchema: {
      type: "object",
      properties: {
        receipt_id: {
          type: "string",
          description: "Receipt id from a receipt_submit pending response",
        },
      },
      required: ["receipt_id"],
      additionalProperties: false,
    },
    handler: toolReceiptStatus,
  },
  fleet_poll: {
    description:
      "Read-only convenience poller over fleet_snapshot for clients that need push-like updates.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, maximum: 3, default: 2 },
        interval_s: { type: "number", minimum: 0, maximum: 2, default: 0 },
      },
      additionalProperties: false,
    },
    handler: toolFleetPoll,
  },
};

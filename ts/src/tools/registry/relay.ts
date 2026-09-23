/**
 * Registry fragment: relay (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolRelayReply, toolRelayDismiss, toolRelayFollowup } from "../relay.js";
import { toolSecondmateNudge, toolSecondmateRestart, toolSecondmateReport, toolRemoteControl, toolHandoffMove } from "../secondmate.js";
import { REMOTE_CONTROL_VERBS } from "../../constants.js";
import { approvalSchema, idApprovalSchema } from "./shared.js";
import type { ToolDef } from "./shared.js";

export const RelayRegistry: Record<string, ToolDef> = {
  relay_reply: {
    description: "External send: post one public-safe reply to the relay via fm-x-reply.sh.",
    inputSchema: approvalSchema({
      request_id: { type: "string" },
      text: { type: "string", description: "Reply text, 1..2000 chars" },
    }),
    handler: toolRelayReply,
  },
  relay_dismiss: {
    description:
      "External send: dismiss one pending relay mention without replying via fm-x-dismiss.sh.",
    inputSchema: idApprovalSchema("request_id"),
    handler: toolRelayDismiss,
  },
  relay_followup: {
    description:
      "External send: post one completion follow-up for a relay-linked task via fm-x-followup.sh.",
    inputSchema: approvalSchema({
      task_id: { type: "string" },
      text: { type: "string", description: "Follow-up text, 1..2000 chars" },
      final: { type: "boolean", description: "Clear the link after this post" },
    }),
    handler: toolRelayFollowup,
  },
  secondmate_nudge: {
    description:
      "Authority write: ask mismatched secondmates to reconcile via the cooldown-guarded notify path.",
    inputSchema: approvalSchema({}),
    handler: toolSecondmateNudge,
  },
  secondmate_restart: {
    description:
      "Authority write: restart secondmates onto current wiring after persist; ids only.",
    inputSchema: approvalSchema({
      ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
    }),
    handler: toolSecondmateRestart,
  },
  secondmate_report: {
    description:
      "Authority write: append one correlated report to the parent channel; the helper resolves the destination.",
    inputSchema: approvalSchema({
      verb: { type: "string", description: "Report verb slug" },
      corr: { type: "string", description: "16 hex chars, optional corr= prefix" },
      note: { type: "string", description: "Report note, single line 1..500 chars" },
    }),
    handler: toolSecondmateReport,
  },
  remote_control: {
    description:
      "Authority write: closed state/route/observe/send subset of remote secondmate control.",
    inputSchema: approvalSchema({
      verb: { type: "string", enum: [...REMOTE_CONTROL_VERBS] },
      id: { type: "string", description: "Secondmate id" },
      text: { type: "string", description: "Prose steer for send, 1..500 chars" },
    }),
    handler: toolRemoteControl,
  },
  handoff_move: {
    description:
      "Authority write: hand queued backlog items to a secondmate, or resume pending wakes.",
    inputSchema: approvalSchema({
      id: { type: "string", description: "Secondmate id" },
      keys: { type: "array", items: { type: "string" }, description: "1..20 backlog item keys" },
      resume: {
        type: "boolean",
        description: "Resume pending wakes; takes no keys",
        default: false,
      },
    }),
    handler: toolHandoffMove,
  },
};

/**
 * Registry fragment: voicemail (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolMailStatus, toolMailRead, toolMailCheck, toolMailSend, toolVoiceStatus, toolVoiceQueue } from "../voicemail.js";
import { approvalSchema } from "./shared.js";
import type { ToolDef } from "./shared.js";

export const VoicemailRegistry: Record<string, ToolDef> = {
  mail_status: {
    description: "Read-only mail configuration and last poll cursor; no network, no wake.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolMailStatus,
  },
  mail_read: {
    description:
      "Read-only unseen-INBOX digest over BODY.PEEK; mail stays unseen until firstmate answers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolMailRead,
  },
  mail_check: {
    description:
      "Read-only inbound received-mail check; arming/disarming the watcher check stays out of MCP.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolMailCheck,
  },
  mail_send: {
    description: "External send: one SMTP message via fm-mail.sh send; credentials live outside MCP.",
    inputSchema: approvalSchema({
      to: { type: "string", description: "Recipient address with @" },
      subject: { type: "string", description: "Subject, single line 1..200 chars" },
      body: { type: "string", description: "Body, 1..5000 chars, piped via stdin" },
    }),
    handler: toolMailSend,
  },
  voice_status: {
    description:
      "Read-only voice-agent status answer from durable records; no mic, no Bedrock, no audio.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["counts", "full"], default: "counts" },
      },
      additionalProperties: false,
    },
    handler: toolVoiceStatus,
  },
  voice_queue: {
    description: "Authority write: hand one request to firstmate through the voice handover queue.",
    inputSchema: approvalSchema({
      text: { type: "string", description: "Request text, single line 1..500 chars" },
    }),
    handler: toolVoiceQueue,
  },
};

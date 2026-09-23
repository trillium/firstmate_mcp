/**
 * Registry fragment: remote (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolWakeDrain, toolGuardCheck, toolRemoteDoctor, toolRemoteFile, toolRemoteDelta, toolExtensionList, toolExtensionInspect, toolHandoffStatus } from "../remote-reads.js";
import type { ToolDef } from "./shared.js";

export const RemoteRegistry: Record<string, ToolDef> = {
  wake_drain: {
    description: "Read-only drained-wake records from the durable watcher queue.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolWakeDrain,
  },
  guard_check: {
    description: "Read-only watcher liveness and worktree-tangle verdict.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolGuardCheck,
  },
  remote_doctor: {
    description:
      "Read-only remote-home readiness diagnostic (check mode; repairs stay out).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolRemoteDoctor,
  },
  remote_file: {
    description:
      "Read-only bounded read of one home-relative file (get only; intake stays out).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Home-relative file path" },
        max_bytes: { type: "integer", minimum: 1, maximum: 262144, default: 8192 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: toolRemoteFile,
  },
  remote_delta: {
    description: "Read-only continuity-checked delta read of one append-only log.",
    inputSchema: {
      type: "object",
      properties: {
        log: { type: "string", description: "Home-relative log path" },
        offset: { type: "integer", minimum: 0, description: "Byte cursor", default: 0 },
        sha256: { type: "string", description: "64 hex chars of the exact prefix" },
        wait: { type: "integer", minimum: 0, maximum: 10, default: 0 },
      },
      required: ["log", "sha256"],
      additionalProperties: false,
    },
    handler: toolRemoteDelta,
  },
  extension_list: {
    description: "Read-only list of enabled home-local extension bindings (bind/retire/verify/process-event stay out).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolExtensionList,
  },
  extension_inspect: {
    description: "Read-only deterministic JSON for one enabled home-local extension binding.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Extension id [a-z0-9]+([.-][a-z0-9]+)*" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolExtensionInspect,
  },
  handoff_status: {
    description:
      "Read-only staged handoff outboxes: list staged moves, or read one outbox tail.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Secondmate id" },
        lines: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      additionalProperties: false,
    },
    handler: toolHandoffStatus,
  },
};

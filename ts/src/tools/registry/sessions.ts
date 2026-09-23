/**
 * Registry fragment: sessions (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolHarnessDetect, toolProjectMode, toolLockStatus, toolLeaseCheck } from "../sessions.js";
import type { ToolDef } from "./shared.js";

export const SessionsRegistry: Record<string, ToolDef> = {
  harness_detect: {
    description:
      "Read-only harness detection for this home; closed mode subset, never walks process ancestry.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["own", "crew", "secondmate", "secondmate-model", "secondmate-effort"],
          default: "own",
        },
      },
      additionalProperties: false,
    },
    handler: toolHarnessDetect,
  },
  project_mode: {
    description: "Read-only registered delivery posture (mode + yolo) for one project.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Bare name or projects/<name>" } },
      required: ["project"],
      additionalProperties: false,
    },
    handler: toolProjectMode,
  },
  lock_status: {
    description: "Read-only per-home session lock status; acquiring stays out.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolLockStatus,
  },
  lease_check: {
    description: "Read-only per-task supervision lease check; claim/release/sweep stay out.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Task id" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolLeaseCheck,
  },
};

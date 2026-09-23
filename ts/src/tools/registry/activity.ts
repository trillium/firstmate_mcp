/**
 * Registry fragment: activity (gap ports).
 *
 * Appended after archaeology; canonical order otherwise unchanged.
 */
import { toolDevinConfig, toolFleetLedger } from "../fleet-ledger.js";
import type { ToolDef } from "./shared.js";

export const ActivityRegistry: Record<string, ToolDef> = {
  fleet_ledger: {
    description:
      "Read-only tail over the opt-in fleet activity ledger (event records with timestamps). Typed degraded state when absent or off.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Maximum records from the tail",
        },
      },
      additionalProperties: false,
    },
    handler: toolFleetLedger,
  },
  devin_config: {
    description:
      "Authority write: scoped per-worker Devin config in the served home's state dir (disables Claude-hook inheritance + attribution). Approval required.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "Worker task id",
        },
        busy_gen: {
          type: "string",
          description: "Busy generation token",
        },
        approval: {
          type: "string",
          description: "Explicit authorization starting with 'I authorize'",
        },
      },
      required: ["task_id", "busy_gen", "approval"],
      additionalProperties: false,
    },
    handler: toolDevinConfig,
  },
};

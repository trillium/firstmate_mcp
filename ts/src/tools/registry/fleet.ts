/**
 * Registry fragment: fleet (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolBacklog } from "../fleet-backlog.js";
import { toolCrewState, toolStatusTail, toolPeek } from "../fleet-reads.js";
import { toolFleetSnapshot } from "../fleet-snapshot.js";
import type { ToolDef } from "./shared.js";

export const FleetRegistry: Record<string, ToolDef> = {
  fleet_snapshot: {
    description:
      "Read-only canonical fleet snapshot (backlog plus per-task state), with optional cursor pagination.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description:
            "Optional pagination cursor (<snapshot_id>:<offset> or integer offset) into a cached snapshot",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
          description: "Maximum task rows per page",
        },
        snapshot_id: {
          type: "string",
          description:
            "Optional cached snapshot id to paginate across without re-running the snapshot script",
        },
      },
      additionalProperties: false,
    },
    handler: toolFleetSnapshot,
  },
  backlog: {
    description:
      "Read-only backlog records plus per-state task counts, derived from the fleet snapshot, with optional cursor pagination.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description:
            "Optional pagination cursor (<snapshot_id>:<offset> or integer offset) into a cached snapshot",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
          description: "Maximum task rows per page",
        },
        snapshot_id: {
          type: "string",
          description:
            "Optional cached snapshot id to paginate across without re-running the snapshot script",
        },
      },
      additionalProperties: false,
    },
    handler: toolBacklog,
  },
  crew_state: {
    description:
      "Read-only deterministic current state of one crew; never infer state from the status log tail.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Task id" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolCrewState,
  },
  status_tail: {
    description: "Read-only tail of one task wake-event log; history only, not current state.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id" },
        lines: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolStatusTail,
  },
  peek: {
    description: "Read-only bounded tail of one crew endpoint for cheap diagnosis.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Exact task id" },
        lines: { type: "integer", minimum: 1, maximum: 100, default: 40 },
      },
      required: ["target"],
      additionalProperties: false,
    },
    handler: toolPeek,
  },
};

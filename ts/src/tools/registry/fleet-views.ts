/**
 * Registry fragment: fleet-views (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolFleetView, toolReviewDiff, toolBearingsSnapshot } from "../fleet-views.js";
import type { ToolDef } from "./shared.js";

export const FleetViewsRegistry: Record<string, ToolDef> = {
  fleet_view: {
    description: "Read-only human render of the fleet snapshot for operators.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolFleetView,
  },
  review_diff: {
    description: "Read-only branch-vs-base diff for one task worktree.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id" },
        stat: { type: "boolean", description: "Stat summary only", default: false },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolReviewDiff,
  },
  bearings_snapshot: {
    description:
      "Read-only compact pick-up digest projected from the fleet snapshot (local-only).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolBearingsSnapshot,
  },
};

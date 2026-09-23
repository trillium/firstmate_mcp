/**
 * Registry fragment: digests (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolBearingsBoardPath, toolInboxStatus, toolInboxList, toolHomeSummary } from "../digests.js";
import { toolHomeSummaryRefresh, toolContributionsSnapshot, toolContributionsPending } from "../digests-write.js";
import { toolSendMessage } from "../fleet-reads.js";
import type { ToolDef } from "./shared.js";

export const DigestsRegistry: Record<string, ToolDef> = {
  bearings_board_path: {
    description:
      "Read-only stable path of the captain's bearings board; building/arming stays out.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolBearingsBoardPath,
  },
  inbox_status: {
    description: "Read-only captain inbox status from durable records; sends no wake.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolInboxStatus,
  },
  inbox_list: {
    description: "Read-only list of queued captain inbox notes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolInboxList,
  },
  home_summary: {
    description: "Read-only published home-summary ledger; refresh stays firstmate-owned.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolHomeSummary,
  },
  home_summary_refresh: {
    description:
      "Atomically refresh and publish state/home-summary.json for this FM_HOME.",
    inputSchema: {
      type: "object",
      properties: {
        best_effort: {
          type: "boolean",
          description: "Log failures to .home-summary-refresh.log and exit 0",
          default: false,
        },
      },
      additionalProperties: false,
    },
    handler: toolHomeSummaryRefresh,
  },
  contributions_snapshot: {
    description:
      "Read-only owned-contribution coverage projected from the fleet snapshot; never contacts a forge.",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Include rows for supervisor inspection", default: false },
      },
      additionalProperties: false,
    },
    handler: toolContributionsSnapshot,
  },
  contributions_pending: {
    description: "Read-only pending contribution event tokens from saved records.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolContributionsPending,
  },
  send_message: {
    description:
      "Steer one crew with a single verified prose line; slash commands, keys, raw panes, and lifecycle verbs are refused.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Exact task id" },
        text: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["target", "text"],
      additionalProperties: false,
    },
    handler: toolSendMessage,
  },
};

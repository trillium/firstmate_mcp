/**
 * Registry fragment: beads (s00r port, task-8pqjb pattern).
 *
 * Moved verbatim structure from the TOOLS literal convention: key order is
 * final (new tools append at the fragment end). Assembled by index.ts in
 * canonical order.
 */
import {
  toolBeadsBackup,
  toolBeadsMirror,
  toolBeadsQueue,
  toolLedgerList,
} from "../beads.js";
import type { ToolDef } from "./shared.js";

export const BeadsRegistry: Record<string, ToolDef> = {
  beads_mirror: {
    description:
      "Read-only beads durability mirror: a previously captured beads view with freshness age. Typed degraded state when absent.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          description: "Mirror view name ([a-z0-9_-], e.g. ready, inflight, fleet)",
        },
      },
      required: ["view"],
      additionalProperties: false,
    },
    handler: toolBeadsMirror,
  },
  beads_queue: {
    description:
      "Read-only beads write-queue status: pending count plus oldest entry (task, description, age). Pending-write argv never surfaces.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: toolBeadsQueue,
  },
  ledger_list: {
    description:
      "Read-only leaked-bead safety net: claimed, unclosed beads quiet longer than the stale-days window. Close verbs are not exposed.",
    inputSchema: {
      type: "object",
      properties: {
        stale_days: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          default: 2,
          description: "Quiet threshold in days (doorway-bounded 1..30)",
        },
      },
      additionalProperties: false,
    },
    handler: toolLedgerList,
  },
  beads_backup: {
    description:
      "Read-only verify of the fleet task store off-box copy: reachable and correctly wired, or the named reason it is not. Repair stays out.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: toolBeadsBackup,
  },
};

/**
 * Registry fragment: fork-checks (curator-authorized port).
 *
 * Appended after activity; canonical order otherwise unchanged.
 */
import { toolForkOriginCheck } from "../fork-checks.js";
import type { ToolDef } from "./shared.js";

export const ForkChecksRegistry: Record<string, ToolDef> = {
  fork_origin_check: {
    description:
      "Read-only advisory scan: registered project clones whose remotes look like unswapped fork-contribution setups. Never blocks, edits, or fails the build.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: toolForkOriginCheck,
  },
};

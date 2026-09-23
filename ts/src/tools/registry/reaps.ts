/**
 * Registry fragment: reaps (2gvx port, task-8pqjb pattern).
 *
 * Appended after grant keys; canonical order otherwise unchanged.
 */
import { toolCoderabbitState, toolReapTriage } from "../reaps.js";
import type { ToolDef } from "./shared.js";

export const ReapsRegistry: Record<string, ToolDef> = {
  reap_triage: {
    description:
      "Read-only agent-surface triage: which sessions are safe to reap, with liveness, unlanded-work, and pipeline gates per pane. Never reaps.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: toolReapTriage,
  },
  coderabbit_state: {
    description:
      "Forge read reporting whether CodeRabbit actually reviewed a PR (reviewed, rate-limited, pending, absent). Never reads the status check.",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Forge owner slug",
        },
        repo: {
          type: "string",
          description: "Forge repo slug",
        },
        pr: {
          type: "integer",
          minimum: 1,
          description: "PR number",
        },
      },
      required: ["owner", "repo", "pr"],
      additionalProperties: false,
    },
    handler: toolCoderabbitState,
  },
};

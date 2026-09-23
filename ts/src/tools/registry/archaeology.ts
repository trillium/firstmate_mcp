/**
 * Registry fragment: archaeology (2od.4 port).
 *
 * Appended after reaps; canonical order otherwise unchanged.
 */
import {
  toolCiHistory,
  toolGitBlame,
  toolGitHistory,
} from "../archaeology.js";
import type { ToolDef } from "./shared.js";

export const ArchaeologyRegistry: Record<string, ToolDef> = {
  git_history: {
    description:
      "Read-only git log for a repo: bounded oneline history, optionally scoped to paths staying inside the repo.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Absolute or home-relative repo path under $HOME with .git (default: FM_HOME)",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 20,
          description: "Maximum commits",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Up to 20 repo-relative paths, no traversal",
        },
      },
      additionalProperties: false,
    },
    handler: toolGitHistory,
  },
  git_blame: {
    description:
      "Read-only blame excerpt for a line range of a repo file, in line-porcelain form. At most 200 lines.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Absolute or home-relative repo path under $HOME with .git (default: FM_HOME)",
        },
        file: {
          type: "string",
          description: "Repo-relative file path, no traversal",
        },
        start: {
          type: "integer",
          minimum: 1,
          description: "First line",
        },
        end: {
          type: "integer",
          minimum: 1,
          description: "Last line (at most 200 lines per call)",
        },
      },
      required: ["file", "start", "end"],
      additionalProperties: false,
    },
    handler: toolGitBlame,
  },
  ci_history: {
    description:
      "Read-only CI run conclusions per branch over time (gh run list), for flake-vs-regression verdicts.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Absolute or home-relative repo path under $HOME with .git (default: FM_HOME)",
        },
        branch: {
          type: "string",
          description: "Branch name, no traversal",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 20,
          description: "Maximum runs",
        },
      },
      required: ["branch"],
      additionalProperties: false,
    },
    handler: toolCiHistory,
  },
};

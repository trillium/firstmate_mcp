/**
 * Registry fragment: doctor-pr (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolDoctor } from "../doctor.js";
import { toolPrOpen } from "../landing.js";
import { toolPrState, toolPrPoll, toolPrReviewers } from "../pr-reads.js";
import { DEFAULT_PR_BASE, PR_BODY_MAX_BYTES, PR_TITLE_MAX_CHARS } from "../../constants.js";
import { approvalSchema } from "./shared.js";
import type { ToolDef } from "./shared.js";

export const DoctorPrRegistry: Record<string, ToolDef> = {
  doctor: {
    description:
      "Read-only self-check for this home: contract resolution, envelope budgets, cache and ledger freshness, grant state, audit trail, and gh availability, with a verdict and reasons.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolDoctor,
  },
  pr_state: {
    description: "Read-only blockers on one GitHub pull request; never posts, requests, or merges.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https://github.com/<owner>/<repo>/pull/<number>" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: toolPrState,
  },
  pr_poll: {
    description: "Read-only static merge-poll watcher check source; returns merged when merged, silent otherwise.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https://github.com/<owner>/<repo>/pull/<number>" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: toolPrPoll,
  },
  pr_reviewers: {
    description: "Read-only advisory reviewer candidates from a PR's changed files and recent authorship; never requests or assigns reviews.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https://github.com/<owner>/<repo>/pull/<number>" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: toolPrReviewers,
  },
  pr_open: {
    description:
      "Authority write: open a pull request for an already-pushed non-default branch; never merges.",
    inputSchema: approvalSchema(
      {
        title: { type: "string", description: `PR title, 1..${PR_TITLE_MAX_CHARS} chars, single line` },
        body: { type: "string", description: `PR body, non-empty, <= ${PR_BODY_MAX_BYTES} bytes` },
        head: { type: "string", description: "Source branch (non-default, already pushed)" },
        base: { type: "string", description: `Target branch (default ${DEFAULT_PR_BASE})` },
        draft: { type: "boolean", description: "Open as a draft PR" },
      },
      ["title", "body", "head"],
    ),
    handler: toolPrOpen,
  },
};

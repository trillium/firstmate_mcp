/**
 * Registry fragment: policy (slice 16 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from the TOOLS literal in src/tools.ts. Key order
 * within this fragment matches the canonical order; index.ts spreads
 * fragments in canonical order so tools/list output is unchanged.
 */
import { toolArmPolicyCheck, toolCdPolicyCheck, toolSubagentPolicyCheck, toolSupervisionInstructions, toolQuotaChoose } from "../policy.js";
import type { ToolDef } from "./shared.js";

export const PolicyRegistry: Record<string, ToolDef> = {
  arm_policy_check: {
    description: "Read-only watcher-arm command-policy verdict (allow or deny) for one shell command; never executes it.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "shell text to classify, 1..4000 chars" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    handler: toolArmPolicyCheck,
  },
  cd_policy_check: {
    description: "Read-only cd-guard command-policy verdict (allow or deny) for one shell command; never executes it.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "shell text to classify, 1..4000 chars" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    handler: toolCdPolicyCheck,
  },
  subagent_policy_check: {
    description: "Read-only subagent-guard verdict (allow or deny) for one harness tool name; never delegates.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "harness tool name to classify, single line" },
      },
      required: ["tool"],
      additionalProperties: false,
    },
    handler: toolSubagentPolicyCheck,
  },
  supervision_instructions: {
    description: "Read-only render of the tracked supervision operating block for one harness, or its one-line repair instruction.",
    inputSchema: {
      type: "object",
      properties: {
        harness: { type: "string", enum: ["claude", "codex", "opencode", "pi", "pi-signed", "grok", "cursor", "omp"] },
        read_only: { type: "boolean" },
        afk: { type: "boolean" },
        afk_mode: { type: "string", enum: ["away", "quiet"] },
        x_mode: { type: "boolean" },
        queue_pending: { type: "boolean" },
        repair_line: { type: "boolean" },
      },
      additionalProperties: false,
    },
    handler: toolSupervisionInstructions,
  },
  quota_choose: {
    description: "Deterministic first quota-eligible dispatch candidate from an already-captured quota snapshot; never takes a fresh snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        snapshot: { type: "string", description: "captured quota-axi JSON (schemaVersion 5) or TOON text, 1..65536 chars" },
        candidates: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16, description: "ordered <harness>:<model> tokens" },
      },
      required: ["snapshot", "candidates"],
      additionalProperties: false,
    },
    handler: toolQuotaChoose,
  },
};

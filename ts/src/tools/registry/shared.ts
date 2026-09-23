/**
 * Registry shared surface: ToolDef + schema helpers (slice 16, task-8pqjb).
 *
 * Moved verbatim from src/tools.ts. Used only by the registry fragments;
 * tools.ts re-exports nothing from here (no external users).
 */
import type { ToolHandler } from "../../tools.js";

export interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

export function approvalSchema(extra: Record<string, unknown>, required?: string[]): Record<string, unknown> {
  const properties = { ...extra };
  (properties as Record<string, unknown>)["approval"] = {
    type: "string",
    description: "Explicit authorization starting with 'I authorize'",
  };
  return {
    type: "object",
    properties,
    required: required !== undefined ? [...required, "approval"] : [...Object.keys(extra), "approval"],
    additionalProperties: false,
  };
}

export function idApprovalSchema(idField = "id"): Record<string, unknown> {
  return approvalSchema({ [idField]: { type: "string", description: "Task id" } });
}

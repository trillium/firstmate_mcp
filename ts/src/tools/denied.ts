/**
 * Denied-by-design authority handlers (emit, link, sync, reconcile). (slice 13b of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. All handlers were module-private there and stay module-private here; tools.ts imports them for the
 * TOOLS registry.
 */
import path from "node:path";
import { approvalError } from "../grants.js";
import { ownedCall } from "../runner.js";
import { validApproval, validId } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolPublicFollowupEmit(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const obligationId = args["obligation_id"];
  const relationId = args["relation_id"];
  const sourceHome = args["source_home"];
  const workId = args["work_id"];
  const generation = args["generation"];
  const outcome = args["outcome"];
  const outcomeText = args["outcome_text"];
  if (!validId(obligationId)) {
    return { payload: { error: "invalid obligation_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!validId(relationId)) {
    return { payload: { error: "invalid relation_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (typeof sourceHome !== "string" || (!sourceHome.startsWith("secondmate:") && sourceHome !== "main")) {
    return { payload: { error: "invalid source_home", expect: "main or secondmate:<id>" }, isError: true };
  }
  if (!validId(workId)) {
    return { payload: { error: "invalid work_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (typeof generation !== "number" || generation < 1 || !Number.isInteger(generation)) {
    return { payload: { error: "invalid generation", expect: "integer >= 1" }, isError: true };
  }
  if (!validId(outcome)) {
    return { payload: { error: "invalid outcome", expect: "short slug" }, isError: true };
  }
  if (typeof outcomeText !== "string" || outcomeText.length < 1 || outcomeText.length > 2000) {
    return { payload: { error: "invalid outcome_text", expect: "1..2000 chars" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [
    path.join(ctx.binDir, "fm-public-followup-emit.sh"),
    "--obligation", obligationId as string,
    "--relation", relationId as string,
    "--source-home", sourceHome as string,
    "--work-id", workId as string,
    "--generation", String(generation),
    "--outcome", outcome as string,
    "--outcome-text", outcomeText as string,
  ];
  return ownedCall(cmd, "public_followup_emit", ctx.run);
}

export async function toolRelayLink(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const requestId = args["request_id"];
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!validId(requestId)) {
    return { payload: { error: "invalid request_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [path.join(ctx.binDir, "fm-x-link.sh"), taskId as string, requestId as string];
  return ownedCall(cmd, "relay_link", ctx.run);
}

export async function toolFleetSync(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const project = args["project"];
  if (project !== undefined && typeof project !== "string") {
    return { payload: { error: "invalid project", expect: "string" }, isError: true };
  }
  if (typeof project === "string" && (project.includes("..") || project.startsWith("/"))) {
    return { payload: { error: "invalid project", expect: "project name or relative path without traversal" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [path.join(ctx.binDir, "fm-fleet-sync.sh"), ...(project ? [project as string] : [])];
  return ownedCall(cmd, "fleet_sync", ctx.run);
}

export async function toolInactiveReconcile(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const mode = args["mode"] !== undefined ? args["mode"] : "scan";
  const startup = args["startup"];
  const taskId = args["task_id"];
  const fingerprint = args["fingerprint"];
  if (typeof mode !== "string" || !["scan", "report", "acknowledge"].includes(mode)) {
    return { payload: { error: "invalid mode", expect: "must be scan, report, or acknowledge" }, isError: true };
  }
  if (mode === "report") {
    if (!validId(taskId)) {
      return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
    }
  } else if (mode === "acknowledge") {
    if (typeof fingerprint !== "string" || !/^[A-Fa-f0-9]+$/.test(fingerprint)) {
      return { payload: { error: "invalid fingerprint", expect: "hex string" }, isError: true };
    }
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  let cmd: string[];
  if (mode === "report") {
    cmd = [path.join(ctx.binDir, "fm-inactive-reconcile.sh"), "report", taskId as string];
  } else if (mode === "acknowledge") {
    cmd = [path.join(ctx.binDir, "fm-inactive-reconcile.sh"), "acknowledge", fingerprint as string];
  } else {
    cmd = [path.join(ctx.binDir, "fm-inactive-reconcile.sh"), "scan", ...(startup ? ["--startup"] : [])];
  }
  return ownedCall(cmd, "inactive_reconcile", ctx.run);
}

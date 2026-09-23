/**
 * Task-store reads + backlog receive, dispatch resolve, nudge. (slice 13c of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. All handlers were module-private there and stay module-private here; tools.ts imports them for the
 * TOOLS registry.
 */
import path from "node:path";
import { approvalError } from "../grants.js";
import { ownedCall } from "../runner.js";
import { argv } from "../tools.js";
import { validApproval, validId, validProject } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolTasksList(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const state = args["state"];
  const repo = args["repo"];
  const kind = args["kind"];
  const blocked = args["blocked"];
  const limit = args["limit"];
  const fields = args["fields"];

  if (state !== undefined && (typeof state !== "string" || !["queued", "in_flight", "done", "held", "all"].includes(state))) {
    return { payload: { error: "invalid state", expect: "queued, in_flight, done, held, or all" }, isError: true };
  }
  if (repo !== undefined) {
    if (typeof repo !== "string" || repo.includes("..") || repo.startsWith("/")) {
      return { payload: { error: "invalid repo", expect: "repo name without traversal" }, isError: true };
    }
  }
  if (kind !== undefined) {
    if (typeof kind !== "string" || !validId(kind)) {
      return { payload: { error: "invalid kind", expect: "short slug, no slashes" }, isError: true };
    }
  }
  if (blocked !== undefined && typeof blocked !== "boolean") {
    return { payload: { error: "invalid blocked", expect: "boolean" }, isError: true };
  }
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return { payload: { error: "invalid limit", expect: "integer between 1 and 1000" }, isError: true };
    }
  }
  if (fields !== undefined) {
    if (typeof fields !== "string" || fields.includes(" ") || fields.includes("\n") || fields.length > 200) {
      return { payload: { error: "invalid fields", expect: "comma-separated field names without spaces" }, isError: true };
    }
  }

  const cmd = [
    path.join(ctx.binDir, "fm-tasks-axi.sh"),
    "list",
    ...(state ? ["--state", state] : []),
    ...(repo ? ["--repo", repo] : []),
    ...(kind ? ["--kind", kind] : []),
    ...(blocked ? ["--blocked"] : []),
    ...(limit !== undefined ? ["--limit", String(limit)] : []),
    ...(fields ? ["--fields", fields] : []),
  ];
  return ownedCall(cmd, "tasks list failed", ctx.run);
}

export async function toolTasksShow(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const id = args["id"];
  const full = args["full"];
  if (!validId(id)) {
    return { payload: { error: "invalid id", expect: "short slug, no slashes" }, isError: true };
  }
  if (full !== undefined && typeof full !== "boolean") {
    return { payload: { error: "invalid full", expect: "boolean" }, isError: true };
  }
  const cmd = [
    path.join(ctx.binDir, "fm-tasks-axi.sh"),
    "show",
    id as string,
    ...(full ? ["--full"] : []),
  ];
  return ownedCall(cmd, "tasks show failed", ctx.run);
}

export async function toolTasksReady(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const repo = args["repo"];
  const includeHeld = args["include_held"];
  if (repo !== undefined) {
    if (typeof repo !== "string" || repo.includes("..") || repo.startsWith("/")) {
      return { payload: { error: "invalid repo", expect: "repo name without traversal" }, isError: true };
    }
  }
  if (includeHeld !== undefined && typeof includeHeld !== "boolean") {
    return { payload: { error: "invalid include_held", expect: "boolean" }, isError: true };
  }
  const cmd = [
    path.join(ctx.binDir, "fm-tasks-axi.sh"),
    "ready",
    ...(repo ? ["--repo", repo] : []),
    ...(includeHeld ? ["--include-held"] : []),
  ];
  return ownedCall(cmd, "tasks ready failed", ctx.run);
}

export async function toolBacklogReceive(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const relPath = args["path"];
  const bytes = args["bytes"];
  const sha256 = args["sha256"];
  const generation = args["generation"];

  if (typeof relPath !== "string" || !relPath.startsWith("state/handoff/") || !relPath.endsWith(".outbox.md") || relPath.includes("..")) {
    return { payload: { error: "invalid path", expect: "state/handoff/<id>.outbox.md without traversal" }, isError: true };
  }
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0 || bytes > 1048576) {
    return { payload: { error: "invalid bytes", expect: "non-negative integer <= 1048576" }, isError: true };
  }
  if (typeof sha256 !== "string" || !/^[A-Fa-f0-9]{64}$/.test(sha256)) {
    return { payload: { error: "invalid sha256", expect: "64 hex chars" }, isError: true };
  }
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
    return { payload: { error: "invalid generation", expect: "positive integer" }, isError: true };
  }
  if (!validApproval(args["approval"])) return { payload: approvalError(), isError: true };
  const cmd = [
    path.join(ctx.binDir, "fm-backlog-receive.sh"),
    relPath,
    String(bytes),
    sha256,
    String(generation),
  ];
  return ownedCall(cmd, "backlog_receive", ctx.run);
}

// --- Sessions gap area: dispatch resolution + session-start nudge reads ---
//
// The session-launch and lifecycle machinery behind these tools never runs
// through the doorway except as explicitly approval-gated denied-by-design
// verbs (below): spawning, trusting, cleaning up, arming, or switching a
// real session/backend stays firstmate-owned. The two reads here print a
// plan without launching anything.

export async function toolDispatchResolve(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["task_id"];
  const project = args["project"];
  if (!validId(taskId)) {
    return { payload: { error: "invalid task_id", expect: "short slug, no slashes" }, isError: true };
  }
  if (project !== undefined && !validProject(project)) {
    return { payload: { error: "invalid project", expect: "bare name or projects/<name>, no absolute paths or traversal" }, isError: true };
  }
  // Canonical brief path only (data/<task-id>/brief.md, where fm-brief.sh
  // scaffolds it): arbitrary brief-file argv stays out so the resolver can
  // never be pointed at files outside this home.
  const brief = path.join(ctx.dataDir, taskId as string, "brief.md");
  const cmd = [
    path.join(ctx.binDir, "fm-dispatch-resolve.sh"),
    brief,
    ...(project ? ["--project", project as string] : []),
  ];
  const { payload, isError } = await ownedCall(cmd, "dispatch resolve failed", ctx.run);
  if (isError) return { payload, isError: true };
  return { payload: { ...payload, task_id: taskId, ...(project ? { project } : {}) }, isError: false };
}

export async function toolSessionstartNudge(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-sessionstart-nudge.sh")),
    "session-start nudge failed",
    ctx.run,
  );
  if (isError) return { payload, isError: true };
  const line = ((payload["stdout"] as string) || "").trim();
  return { payload: { ...payload, fired: line.length > 0 }, isError: false };
}


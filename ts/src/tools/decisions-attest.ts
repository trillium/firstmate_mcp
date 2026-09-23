/**
 * Decision complete, verify, open, diverged (attestation surface). (slice 7d of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. All handlers were module-private there
 * and stay module-private here; tools.ts imports them for the TOOLS registry.
 * No re-export: the `./tools.js` public surface is unchanged.
 */
import path from "node:path";
import { requireAuth } from "../grants.js";
import { isRunResult, ownedCall } from "../runner.js";
import { argv } from "../tools.js";
import { validId, validIdList } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolDecisionComplete(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const originId = args["origin_id"];
  const none = args["none"];
  const taskIds = args["task_ids"];
  if (!validId(originId)) {
    return {
      payload: { error: "invalid origin_id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (none !== undefined && typeof none !== "boolean") {
    return {
      payload: { error: "invalid none", expect: "boolean" },
      isError: true,
    };
  }
  if (none === true && taskIds !== undefined && Array.isArray(taskIds) && taskIds.length > 0) {
    return {
      payload: { error: "invalid task_ids", expect: "none cannot be combined with task_ids" },
      isError: true,
    };
  }
  let ids: string[] = [];
  if (taskIds !== undefined) {
    const parsed = validIdList(taskIds, 64);
    if (!parsed) {
      return {
        payload: { error: "invalid task_ids", expect: "array of 1..64 valid task ids" },
        isError: true,
      };
    }
    ids = parsed;
  }
  if (none !== true && ids.length === 0) {
    return {
      payload: { error: "invalid task_ids", expect: "either none: true or non-empty task_ids required" },
      isError: true,
    };
  }
  const auth = await requireAuth("decision_complete", args, ctx);
  if (!auth.ok) return auth.result;

  const cmdArgs = [path.join(ctx.binDir, "fm-captain-hold.sh"), "complete", originId as string];
  if (none === true) {
    cmdArgs.push("--none");
  } else {
    cmdArgs.push(...ids);
  }

  const { payload, isError } = await ownedCall(
    argv(...cmdArgs),
    "decision complete refused or failed",
    ctx.run,
  );
  if (!isError) {
    return {
      payload: { ...payload, origin_id: originId, none: none ?? false, task_ids: ids },
      isError: false,
    };
  }
  return { payload, isError: true };
}

export async function toolDecisionVerify(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const originId = args["origin_id"];
  if (!validId(originId)) {
    return {
      payload: { error: "invalid origin_id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-captain-hold.sh"), "verify", originId as string),
    "decision verify refused or failed",
    ctx.run,
  );
  if (!isError) {
    return { payload: { ...payload, origin_id: originId, verified: true }, isError: false };
  }
  return { payload, isError: true };
}

export async function toolDecisionOpen(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const taskId = args["id"];
  const identity = args["identity"] === true;
  const distinguishAbsent = args["distinguish_absent"] === true;
  if (!validId(taskId)) {
    return {
      payload: { error: "invalid id", expect: "short task id, no slashes or traversal" },
      isError: true,
    };
  }
  if (args["identity"] !== undefined && typeof args["identity"] !== "boolean") {
    return {
      payload: { error: "invalid identity", expect: "boolean" },
      isError: true,
    };
  }
  if (args["distinguish_absent"] !== undefined && typeof args["distinguish_absent"] !== "boolean") {
    return {
      payload: { error: "invalid distinguish_absent", expect: "boolean" },
      isError: true,
    };
  }
  const cmdArgs = [path.join(ctx.binDir, "fm-captain-hold.sh"), "open", taskId as string];
  if (identity) cmdArgs.push("--identity");
  if (distinguishAbsent) cmdArgs.push("--distinguish-absent");

  const res = await ctx.run(argv(...cmdArgs));
  if (!isRunResult(res)) {
    return { payload: res as unknown as Record<string, unknown>, isError: true };
  }
  if (res.exitCode === 0) {
    const out: Record<string, unknown> = { id: taskId, open: true };
    if (identity && res.stdout.trim()) {
      out["identity"] = res.stdout.trim();
    }
    return { payload: out, isError: false };
  }
  if (res.exitCode === 1) {
    return { payload: { id: taskId, open: false }, isError: false };
  }
  if (res.exitCode === 3) {
    return { payload: { id: taskId, open: false, absent: true }, isError: false };
  }
  return {
    payload: {
      error: "decision open refused or failed",
      exitCode: res.exitCode,
      stderr: res.stderr.trim(),
    },
    isError: true,
  };
}

export async function toolDecisionDiverged(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-captain-hold.sh"), "diverged"),
    "decision diverged check refused or failed",
    ctx.run,
  );
  if (!isError) {
    const raw = typeof payload["stdout"] === "string" ? payload["stdout"] : "";
    const lines = raw.trim() ? raw.trim().split("\n") : [];
    const records = lines.map((l: string) => {
      const [id, origin, key, title] = l.split("\t");
      return { id, origin, key, title };
    });
    return {
      payload: {
        ...payload,
        diverged: records.length > 0,
        count: records.length,
        records,
      },
      isError: false,
    };
  }
  return { payload, isError: true };
}

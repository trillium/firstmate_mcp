/**
 * Policy checks, supervision instructions, quota, followup collect. (slice 13a of the tools.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. All handlers were module-private there and stay module-private here; tools.ts imports them for the
 * TOOLS registry.
 */
import path from "node:path";
import { isRunResult, ownedCall, truncate } from "../runner.js";
import { argv } from "../tools.js";
import { classifyCall } from "./pr-reads.js";
import {
  validId,
  validPolicyCommand,
  validQuotaCandidates,
  validQuotaSnapshot,
  validSubagentTool,
  validSupervisionAfkMode,
  validSupervisionHarness,
} from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolArmPolicyCheck(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const command = args["command"];
  if (!validPolicyCommand(command)) {
    return {
      payload: { error: "invalid command", expect: "shell text, 1..4000 chars, no NUL" },
      isError: true,
    };
  }
  // Classification only: the hook never executes, sources, evaluates,
  // or expands the submitted command. Fail-open (missing node/policy)
  // reports allow with empty outputs, exactly like the hook.
  const result = await classifyCall(
    argv(path.join(ctx.binDir, "fm-arm-pretool-check.sh"), "--command", command as string),
    "arm policy check failed",
    ctx.run,
  );
  if (!result.isError) return { payload: { ...result.payload, command }, isError: false };
  return result;
}

export async function toolCdPolicyCheck(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const command = args["command"];
  if (!validPolicyCommand(command)) {
    return {
      payload: { error: "invalid command", expect: "shell text, 1..4000 chars, no NUL" },
      isError: true,
    };
  }
  // Classification only, scoped to the real primary checkout: outside
  // it the guard is inert (allow), exactly like the hook.
  const result = await classifyCall(
    argv(path.join(ctx.binDir, "fm-cd-pretool-check.sh"), "--command", command as string),
    "cd policy check failed",
    ctx.run,
  );
  if (!result.isError) return { payload: { ...result.payload, command }, isError: false };
  return result;
}

export async function toolSubagentPolicyCheck(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const tool = args["tool"];
  if (!validSubagentTool(tool)) {
    return {
      payload: { error: "invalid tool", expect: "harness tool name, 1..128 chars, single line" },
      isError: true,
    };
  }
  // Classification only: matches the delegation shape of the tool name.
  // FM_ALLOW_SUBAGENT=1 escapes in the hook; the tool reports the
  // guard as configured without setting it.
  const result = await classifyCall(
    argv(path.join(ctx.binDir, "fm-subagent-pretool-check.sh"), "--tool", tool as string),
    "subagent policy check failed",
    ctx.run,
  );
  if (!result.isError) return { payload: { ...result.payload, tool }, isError: false };
  return result;
}

export async function toolSupervisionInstructions(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Pure render of the tracked supervision protocol for one harness;
  // no state read beyond the optional x-mode env file, no writes.
  // An omitted harness auto-detects, exactly like the script.
  const parts: string[] = [path.join(ctx.binDir, "fm-supervision-instructions.sh")];
  const echoed: Record<string, unknown> = {};
  const harness = args["harness"];
  if (harness !== undefined) {
    if (!validSupervisionHarness(harness)) {
      return {
        payload: {
          error: "invalid harness",
          expect: "one of claude, codex, opencode, pi, pi-signed, grok, cursor, omp",
        },
        isError: true,
      };
    }
    parts.push("--harness", harness as string);
    echoed["harness"] = harness;
  }
  for (const [key, flag] of [
    ["read_only", "--read-only"],
    ["afk", "--afk"],
    ["x_mode", "--x-mode"],
    ["queue_pending", "--queue-pending"],
  ] as const) {
    const value = args[key];
    if (value !== undefined) {
      if (typeof value !== "boolean") {
        return {
          payload: { error: `invalid ${key}`, expect: "boolean" },
          isError: true,
        };
      }
      parts.push(flag, value ? "1" : "0");
      echoed[key] = value;
    }
  }
  const afkMode = args["afk_mode"];
  if (afkMode !== undefined) {
    if (!validSupervisionAfkMode(afkMode)) {
      return {
        payload: { error: "invalid afk_mode", expect: "away or quiet" },
        isError: true,
      };
    }
    parts.push("--afk-mode", afkMode as string);
    echoed["afk_mode"] = afkMode;
  }
  const repairLine = args["repair_line"];
  if (repairLine !== undefined) {
    if (typeof repairLine !== "boolean") {
      return {
        payload: { error: "invalid repair_line", expect: "boolean" },
        isError: true,
      };
    }
    if (repairLine) parts.push("--repair-line");
    echoed["repair_line"] = repairLine;
  }
  const { payload, isError } = await ownedCall(
    argv(...parts),
    "supervision instructions failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, ...echoed }, isError: false };
  return { payload, isError: true };
}

export async function toolQuotaChoose(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const snapshot = args["snapshot"];
  if (!validQuotaSnapshot(snapshot)) {
    return {
      payload: { error: "invalid snapshot", expect: "captured quota-axi text, 1..65536 chars" },
      isError: true,
    };
  }
  const candidates = args["candidates"];
  if (!validQuotaCandidates(candidates)) {
    return {
      payload: {
        error: "invalid candidates",
        expect: "1..16 <harness>:<model> tokens, no leading colon",
      },
      isError: true,
    };
  }
  // Deterministic selection over an already-captured snapshot piped on
  // stdin (never a path, never a fresh quota-axi run): no side effects.
  // Exit 0 prints "<harness> <model>"; exit 1 prints "none".
  const list = candidates as string[];
  const cmd = [path.join(ctx.binDir, "fm-quota-choose.sh")];
  for (const candidate of list) cmd.push("--candidate", candidate);
  const res = await ctx.run(argv(...cmd), { input: snapshot as string });
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  const [out, outTrunc] = truncate(res.stdout ?? "");
  const [errOut, errTrunc] = truncate(res.stderr ?? "");
  if (res.exitCode === 0) {
    const [harness, model] = out.trim().split(/\s+/, 2);
    return {
      payload: {
        eligible: true,
        harness,
        model,
        stdout: out,
        stdout_truncated: outTrunc,
      },
      isError: false,
    };
  }
  if (res.exitCode === 1 && out.trim() === "none") {
    return {
      payload: { eligible: false, stdout: out, stdout_truncated: outTrunc },
      isError: false,
    };
  }
  return {
    payload: { error: "quota choose failed", exit: res.exitCode, stdout: out, stderr: errOut },
    isError: true,
  };
}

export async function toolPublicFollowupPending(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Open public-followup loop digest; reports unresolved and delivered public loops without mutating state.
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-public-followup.sh"), "pending"),
    "public followup pending failed",
    ctx.run,
  );
}

export async function toolPublicFollowupCollect(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Non-destructively read typed terminal events staged in this home's outbox.
  const obligationId = args["obligation_id"];
  if (!validId(obligationId)) {
    return {
      payload: { error: "invalid obligation_id", expect: "short slug, no slashes or traversal" },
      isError: true,
    };
  }
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-public-followup-collect.sh"), "drain", obligationId as string),
    "public followup collect failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, obligation_id: obligationId }, isError: false };
  return { payload, isError: true };
}

/**
 * Voice/mail handlers (slice 3 of the tools.ts folder split, task-8pqjb;
 * pattern: brain-ws6lr).
 *
 * Moved verbatim from src/tools.ts. These six were module-private there and
 * stay module-private here; tools.ts imports them for the TOOLS registry.
 * No re-export: the `./tools.js` public surface is unchanged.
 */
import path from "node:path";
import { requireAuth } from "../grants.js";
import { isRunResult, ownedCall, truncate } from "../runner.js";
import { argv } from "../tools.js";
import {
  validMailBody,
  validMailSubject,
  validMailTo,
  validVoiceQueueText,
  validVoiceScope,
} from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export async function toolMailStatus(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Config + cursor only: no network, no wake.
  return ownedCall(argv(path.join(ctx.binDir, "fm-mail.sh"), "status"), "mail status failed", ctx.run);
}

export async function toolMailRead(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // BODY.PEEK digest: mail stays unseen until firstmate answers.
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm-mail.sh"), "read"),
    "mail read failed",
    ctx.run,
  );
  if (!isError) {
    return {
      payload: {
        ...payload,
        warning: "BODY.PEEK digest; mail stays unseen until firstmate answers",
      },
      isError: false,
    };
  }
  return { payload, isError: true };
}

export async function toolMailCheck(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  // Inbound received-mail check only; arm/disarm mutate watcher trust state and stay out of MCP.
  return ownedCall(
    argv(path.join(ctx.binDir, "fm-mail-check.sh"), "check"),
    "mail check failed",
    ctx.run,
  );
}

export async function toolMailSend(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const to = args["to"];
  const subject = args["subject"];
  const body = args["body"];
  if (!validMailTo(to)) {
    return {
      payload: {
        error: "invalid to",
        expect: "single-line recipient address with @, 3..200 chars, no whitespace",
      },
      isError: true,
    };
  }
  if (!validMailSubject(subject)) {
    return {
      payload: { error: "invalid subject", expect: "single line, 1..200 chars" },
      isError: true,
    };
  }
  if (!validMailBody(body)) {
    return { payload: { error: "invalid body", expect: "1..5000 chars" }, isError: true };
  }
  const auth = await requireAuth("mail_send", args, ctx);
  if (!auth.ok) return auth.result;
  // Body via stdin ("-" form), exactly like the owning script: never argv.
  const res = await ctx.run(
    argv(path.join(ctx.binDir, "fm-mail.sh"), "send", to as string, subject as string, "-"),
    { input: body as string },
  );
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  const [out, outTrunc] = truncate(res.stdout ?? "");
  const [errOut, errTrunc] = truncate(res.stderr ?? "");
  if (res.exitCode !== 0) {
    return {
      payload: { error: "mail send refused or failed", exit: res.exitCode, stdout: out, stderr: errOut },
      isError: true,
    };
  }
  return {
    payload: {
      ok: true,
      to,
      subject,
      stdout: out,
      stdout_truncated: outTrunc,
      stderr: errOut,
      stderr_truncated: errTrunc,
    },
    isError: false,
  };
}

export async function toolVoiceStatus(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const scope = args["scope"] ?? "counts";
  if (!validVoiceScope(scope)) {
    return {
      payload: { error: "invalid scope", expect: "one of counts, full" },
      isError: true,
    };
  }
  // Counts is safe by construction; full only via the captain's own
  // read-scope with the helper's deny list enforced inside.
  const res = await ctx.run(
    argv(path.join(ctx.binDir, "fm_voice_records.py"), "status", "--scope", scope as string),
  );
  if (!isRunResult(res)) return { payload: res as Record<string, unknown>, isError: true };
  if (res.exitCode !== 0) {
    const [out] = truncate(res.stderr || res.stdout || "");
    return {
      payload: { error: "voice status failed", exit: res.exitCode, output: out },
      isError: true,
    };
  }
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(res.stdout) as Record<string, unknown>;
  } catch {
    const [out] = truncate(res.stdout);
    return { payload: { error: "voice status was not JSON", output: out }, isError: true };
  }
  if (typeof status !== "object" || status === null || Array.isArray(status)) {
    const [out] = truncate(res.stdout);
    return { payload: { error: "voice status was not JSON", output: out }, isError: true };
  }
  return { payload: status, isError: false };
}

export async function toolVoiceQueue(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const text = args["text"];
  if (!validVoiceQueueText(text)) {
    return {
      payload: { error: "invalid text", expect: "single line, 1..500 chars" },
      isError: true,
    };
  }
  const auth = await requireAuth("voice_queue", args, ctx);
  if (!auth.ok) return auth.result;
  // Handover queue only: no microphone, no audio, no Bedrock session.
  const { payload, isError } = await ownedCall(
    argv(path.join(ctx.binDir, "fm_voice_records.py"), "queue", text as string),
    "voice queue refused or failed",
    ctx.run,
  );
  if (!isError) return { payload: { ...payload, queued: true }, isError: false };
  return { payload, isError: true };
}

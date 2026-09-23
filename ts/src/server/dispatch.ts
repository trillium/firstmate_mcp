/**
 * tools/call dispatch (promise + Effect) with audit + follow-ons. (slice 21 of the server.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/server.ts. Exported there, re-exported where public.
 */
import { Effect } from "effect";
import { FollowOnService } from "../followon.js";
import { requireAuth } from "../grants.js";
import { MainLive } from "../layers.js";
import { TOOLS } from "../tools.js";
import type { ToolContext } from "../tools.js";
import { AuditService, type TransportType } from "../auth.js";
import { writeLine } from "./rpc.js";
import {
  auditAppend,
  auditAppendEffect,
  auditDecision,
  auditTarget,
  authorizeOrRefuse,
} from "./audit.js";

export async function handleToolsCall(
  msgId: string | number | null | undefined,
  params: Record<string, unknown>,
  ctx: ToolContext,
  send: (value: unknown) => void = writeLine,
  transport: TransportType = "stdio",
  actorOverride?: string,
): Promise<void> {
  const start = performance.now();
  const name = params?.["name"] as string | undefined;
  const args = (params?.["arguments"] as Record<string, unknown> | undefined) ?? {};
  const toolLabel = typeof name === "string" ? name : "unknown";
  if (typeof name !== "string" || !(name in TOOLS)) {
    const duration_ms = Math.max(0, Math.round(performance.now() - start));
    auditAppend(ctx, toolLabel, "refuse", "unknown-tool",
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)["approval"]
        : undefined,
      auditTarget(args),
      duration_ms,
      transport,
      actorOverride);
    send({
      jsonrpc: "2.0",
      id: msgId ?? null,
      error: { code: -32602, message: `unknown tool: ${name}` },
    });
    return;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    const duration_ms = Math.max(0, Math.round(performance.now() - start));
    auditAppend(ctx, toolLabel, "refuse", "validation-failed", undefined, null, duration_ms, transport, actorOverride);
    send({
      jsonrpc: "2.0",
      id: msgId ?? null,
      error: { code: -32602, message: "arguments must be an object" },
    });
    return;
  }
  let payload: Record<string, unknown>;
  let isError: boolean;
  // Central gate: every tool is authorized here, not only the handlers that
  // remember to call requireAuth (see authorizeOrRefuse).
  const refusal = await authorizeOrRefuse(name, args, ctx);
  if (refusal !== null) {
    payload = refusal;
    isError = true;
  } else {
    try {
      ({ payload, isError } = await TOOLS[name].handler(args, ctx));
    } catch (exc) {
      payload = { error: "tool crashed", detail: String(exc) };
      isError = true;
    }
  }
  const duration_ms = Math.max(0, Math.round(performance.now() - start));
  const decisionDigest =
    typeof payload === "object" && payload !== null && typeof payload["decision_digest"] === "string"
      ? (payload["decision_digest"] as string)
      : null;
  {
    const [decision, reason] = auditDecision(args, payload, isError);
    let approval = (args as Record<string, unknown>)["approval"];
    if (approval === undefined && toolLabel === "receipt_submit") {
      const nested = (args as Record<string, unknown>)["arguments"];
      if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
        approval = (nested as Record<string, unknown>)["approval"];
      }
    }
    const grantRef = (args as Record<string, unknown>)["_grant_ref"] as string | undefined;
    auditAppend(ctx, toolLabel, decision, reason, approval, auditTarget(args), duration_ms, transport, actorOverride, decisionDigest, grantRef);
  }
  const result: Record<string, unknown> = {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
  if (isError) result["isError"] = true;
  send({ jsonrpc: "2.0", id: msgId ?? null, result });

  // Execute configured follow-on actions with complete failure isolation
  try {
    const followOnProgram = Effect.gen(function* () {
      const followOn = yield* FollowOnService;
      yield* followOn.executeFollowOns(
        { tool: name, args, payload, isError },
        ctx,
      );
    }).pipe(
      Effect.provide(MainLive),
      Effect.catchAll(() => Effect.void),
    );
    await Effect.runPromise(followOnProgram);
  } catch {
    /* follow-ons are isolated; never throw */
  }
}

/**
 * Effect core for tools/call: same wire logic, audit through the
 * AuditService and tool execution as an Effect (typed crash mapping).
 * Legacy handleToolsCall below delegates to this graph via the Effect
 * runtime so there is a single source of truth.
 */
export function handleToolsCallEffect(
  msgId: string | number | null | undefined,
  params: Record<string, unknown>,
  ctx: ToolContext,
  send: (value: unknown) => void = writeLine,
  transport: TransportType = "stdio",
  actorOverride?: string,
): Effect.Effect<void, never, AuditService> {
  return Effect.gen(function* () {
    const start = performance.now();
    const name = params?.["name"] as string | undefined;
    const args = (params?.["arguments"] as Record<string, unknown> | undefined) ?? {};
    const toolLabel = typeof name === "string" ? name : "unknown";
    const append = (
      decision: string,
      reason: string,
      approval: unknown,
      target: string | null,
      durationMs: number | null,
      decisionDigest: string | null = null,
      grantRef?: string | null,
    ) => auditAppendEffect(ctx, toolLabel, decision, reason, approval, target, durationMs, transport, actorOverride, decisionDigest, grantRef);
    if (typeof name !== "string" || !(name in TOOLS)) {
      const duration_ms = Math.max(0, Math.round(performance.now() - start));
      yield* append(
        "refuse",
        "unknown-tool",
        typeof args === "object" && args !== null && !Array.isArray(args)
          ? (args as Record<string, unknown>)["approval"]
          : undefined,
        auditTarget(args),
        duration_ms,
      );
      send({
        jsonrpc: "2.0",
        id: msgId ?? null,
        error: { code: -32602, message: `unknown tool: ${name}` },
      });
      return;
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      const duration_ms = Math.max(0, Math.round(performance.now() - start));
      yield* append("refuse", "validation-failed", undefined, null, duration_ms);
      send({
        jsonrpc: "2.0",
        id: msgId ?? null,
        error: { code: -32602, message: "arguments must be an object" },
      });
      return;
    }
    let payload: Record<string, unknown>;
    let isError: boolean;
    // Same central gate as the legacy path: an approval-gated tool must not
    // execute just because its handler forgot to ask.
    const refusal = yield* Effect.promise(() => authorizeOrRefuse(name, args, ctx));
    if (refusal !== null) {
      payload = refusal;
      isError = true;
    } else {
      const outcome = yield* Effect.promise(() =>
        TOOLS[name].handler(args, ctx).then(
          (ok) => ({ ok: true as const, value: ok }),
          (exc) => ({ ok: false as const, error: exc }),
        ),
      );
      if (outcome.ok) {
        ({ payload, isError } = outcome.value);
      } else {
        payload = { error: "tool crashed", detail: String(outcome.error) };
        isError = true;
      }
    }
    const duration_ms = Math.max(0, Math.round(performance.now() - start));
    const decisionDigest =
      typeof payload === "object" && payload !== null && typeof payload["decision_digest"] === "string"
        ? (payload["decision_digest"] as string)
        : null;
    {
      const [decision, reason] = auditDecision(args, payload, isError);
      let approval = (args as Record<string, unknown>)["approval"];
      if (approval === undefined && toolLabel === "receipt_submit") {
        const nested = (args as Record<string, unknown>)["arguments"];
        if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
          approval = (nested as Record<string, unknown>)["approval"];
        }
      }
      const grantRef = (args as Record<string, unknown>)["_grant_ref"] as string | undefined;
      yield* append(decision, reason, approval, auditTarget(args), duration_ms, decisionDigest, grantRef);
    }
    const result: Record<string, unknown> = {
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
    if (isError) result["isError"] = true;
    send({ jsonrpc: "2.0", id: msgId ?? null, result });

    // Execute configured follow-on actions with complete failure isolation
    const followOnOpt = yield* Effect.serviceOption(FollowOnService);
    if (followOnOpt._tag === "Some") {
      yield* followOnOpt.value
        .executeFollowOns({ tool: name, args, payload, isError }, ctx)
        .pipe(Effect.catchAll(() => Effect.void));
    }
  });
}

/**
 * Effect core for dispatch: pure methods stay synchronous, tools/call
 * flows through the audit service graph.
 */

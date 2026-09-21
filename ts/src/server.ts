#!/usr/bin/env node
/**
 * First Mate MCP smarts-only server (TypeScript sibling, Effect composition).
 *
 * stdio parity with fm_mcp_server.py: newline-delimited JSON-RPC on stdin,
 * responses on stdout, logs on stderr. Effect is the composition layer
 * (Layers/Services for config, runner, audit, envelope; typed errors;
 * scope-managed subprocess lifecycle) — the stdio wire stays byte-identical.
 * No SSE / streamable HTTP (out of scope, same as the Python path).
 */
import readline from "node:readline";
import path from "node:path";
import { Effect } from "effect";
import {
  SERVER_NAME,
  SERVER_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./constants.js";
import { AuditService, appendAudit, buildLine, type TransportType } from "./auth.js";
import { FollowOnService, FollowOnLive } from "./followon.js";
import { TOOLS, liveContext, type ToolContext } from "./tools.js";
import { MainLive } from "./layers.js";
import type { HttpServerHandle } from "./http.js";

export { MainLive };

export interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

function writeLine(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

export function reply(msgId: string | number | null | undefined, result: unknown): void {
  writeLine({ jsonrpc: "2.0", id: msgId ?? null, result });
}

export function replyError(
  msgId: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): void {
  const err: Record<string, unknown> = { code, message };
  if (data !== undefined) err["data"] = data;
  writeLine({ jsonrpc: "2.0", id: msgId ?? null, error: err });
}

export function handleInitialize(
  msgId: string | number | null | undefined,
  params: Record<string, unknown>,
  send: (value: unknown) => void = writeLine,
): void {
  const requested = params?.["protocolVersion"];
  const version = (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];
  send({
    jsonrpc: "2.0",
    id: msgId ?? null,
    result: {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    },
  });
}

export function handleToolsList(
  msgId: string | number | null | undefined,
  send: (value: unknown) => void = writeLine,
): void {
  send({
    jsonrpc: "2.0",
    id: msgId ?? null,
    result: {
      tools: Object.entries(TOOLS).map(([name, def]) => ({
        name,
        description: def.description,
        inputSchema: def.inputSchema,
      })),
    },
  });
}

// --- JSON-lines audit log (side-channel; never touches wire payloads). ---
// Mirrors the Python server's inline audit block, which mirrors
// auth/tiers.py + auth/audit.py: one line per tools/call, allow or refuse.

const AUDIT_VALIDATION_ERRORS: ReadonlySet<string> = new Set([
  "invalid id",
  "invalid target",
  "invalid text",
  "slash commands refused",
  "invalid lines",
  "invalid note",
  "invalid task_id",
  "invalid project",
  "invalid mode",
  "invalid yolo",
  "invalid origin_id",
  "invalid decision_key",
  "invalid title",
  "invalid reason",
  "invalid routed_to",
  "invalid decision_text",
  "invalid verdict",
  "invalid comment",
  "invalid request_id",
  "invalid final",
  "invalid count",
  "invalid interval_s",
  "invalid stat",
  "invalid path",
  "invalid max_bytes",
  "invalid offset",
  "invalid sha256",
  "invalid wait",
  "invalid verb",
  "invalid corr",
  "invalid keys",
  "invalid resume",
  "no handoff for id",
  "cannot read handoff",
  "invalid all",
  "contributions was not JSON",
  "contributions pending was not JSON",
  "contributions too large for envelope",
  "no home summary",
  "cannot read home summary",
  "home summary was not JSON",
  "unexpected home summary schema",
  "home summary too large for envelope",
  "bearings was not JSON",
  "unexpected bearings schema",
  "bearings too large for envelope",
  "invalid tool",
  "invalid arguments",
  "unknown tool",
  "invalid receipt_id",
  "unknown receipt",
  "receipt expired",
  "cannot read receipt",
  "cannot read status log",
  "no status log for id",
  "invalid task_ids",
  "invalid none",
  "invalid identity",
  "invalid distinguish_absent",
  "invalid release",
  "release unauthorized",
  "release refused",
  "unexpected snapshot schema",
  "snapshot was not JSON",
  "snapshot too large for PoC envelope",
  "poll output too large for PoC envelope",
  "tool crashed",
]);

function auditTarget(args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  for (const key of ["id", "target", "task_id", "origin_id", "request_id", "receipt_id", "grant_id", "grantee", "tool", "path", "log", "project"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function auditDecision(
  args: unknown,
  payload: Record<string, unknown>,
  isError: boolean,
): [string, string] {
  if (!isError) return ["allow", "ok"];
  const error = (payload as Record<string, unknown>)["error"];
  if (error === "approval required") {
    const approval =
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? ((args as Record<string, unknown>)["approval"] ?? (args as Record<string, unknown>)["grant"])
        : undefined;
    if (approval === undefined || approval === null) return ["refuse", "approval-required"];
    return ["refuse", "approval-invalid"];
  }
  if (typeof error === "string" && AUDIT_VALIDATION_ERRORS.has(error)) {
    return ["refuse", "validation-failed"];
  }
  return ["allow", "ok"];
}

function auditPath(ctx: ToolContext): string {
  return process.env.FM_AUDIT_LOG ?? path.join(ctx.stateDir, "mcp-audit.jsonl");
}

function auditAppend(
  ctx: ToolContext,
  tool: string,
  decision: string,
  reason: string,
  approval: unknown,
  target: string | null,
  durationMs: number | null = null,
  transport: TransportType = "stdio",
  actorOverride?: string,
  decisionDigest: string | null = null,
  grantRef?: string | null,
): void {
  try {
    const actor = actorOverride ?? process.env.FM_ACTOR ?? (transport === "http" ? "http-audit" : "local");
    appendAudit(
      auditPath(ctx),
      buildLine(actor, tool, decision, reason, {
        approval,
        grant_ref: grantRef,
        target,
        duration_ms: durationMs,
        transport,
        decision_digest: decisionDigest,
      }),
    );
  } catch {
    /* audit is best-effort; never break a tool call */
  }
}

/**
 * Effect core for audit appends: same line shape, typed error channel,
 * best-effort at the call site (failures are ignored, never break calls).
 */
export function auditAppendEffect(
  ctx: ToolContext,
  tool: string,
  decision: string,
  reason: string,
  approval: unknown,
  target: string | null,
  durationMs: number | null = null,
  transport: TransportType = "stdio",
  actorOverride?: string,
  decisionDigest: string | null = null,
  grantRef?: string | null,
): Effect.Effect<void, never, AuditService> {
  return Effect.gen(function* () {
    const audit = yield* AuditService;
    const actor = actorOverride ?? process.env.FM_ACTOR ?? (transport === "http" ? "http-audit" : "local");
    const line = buildLine(actor, tool, decision, reason, {
      approval,
      grant_ref: grantRef,
      target,
      duration_ms: durationMs,
      transport,
      decision_digest: decisionDigest,
    });
    yield* audit.append(auditPath(ctx), line).pipe(Effect.ignore);
  });
}

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
  try {
    ({ payload, isError } = await TOOLS[name].handler(args, ctx));
  } catch (exc) {
    payload = { error: "tool crashed", detail: String(exc) };
    isError = true;
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
    const outcome = yield* Effect.promise(() =>
      TOOLS[name].handler(args, ctx).then(
        (ok) => ({ ok: true as const, value: ok }),
        (exc) => ({ ok: false as const, error: exc }),
      ),
    );
    let payload: Record<string, unknown>;
    let isError: boolean;
    if (outcome.ok) {
      ({ payload, isError } = outcome.value);
    } else {
      payload = { error: "tool crashed", detail: String(outcome.error) };
      isError = true;
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
export function dispatchMessageEffect(
  msg: RpcMessage,
  ctx: ToolContext,
  send: (value: unknown) => void = writeLine,
  transport: TransportType = "stdio",
  actorOverride?: string,
): Effect.Effect<boolean, never, AuditService> {
  const method = msg?.method;
  const msgId = msg?.id;
  const params = (msg?.params as Record<string, unknown> | undefined) ?? {};
  if (method === "initialize") {
    return Effect.sync(() => {
      handleInitialize(msgId, params, send);
    }).pipe(Effect.as(true));
  } else if (method === "notifications/initialized") {
    return Effect.succeed(true);
  } else if (method === "tools/list") {
    return Effect.sync(() => {
      handleToolsList(msgId, send);
    }).pipe(Effect.as(true));
  } else if (method === "tools/call") {
    return handleToolsCallEffect(msgId, params, ctx, send, transport, actorOverride).pipe(Effect.as(true));
  } else if (method === "ping") {
    return Effect.sync(() => {
      send({ jsonrpc: "2.0", id: msgId ?? null, result: {} });
    }).pipe(Effect.as(true));
  } else if (typeof method === "string" && method.startsWith("notifications/")) {
    return Effect.succeed(true);
  } else if (msgId !== undefined && msgId !== null) {
    return Effect.sync(() => {
      send({
        jsonrpc: "2.0",
        id: msgId,
        error: { code: -32601, message: `method not found: ${method}` },
      });
    }).pipe(Effect.as(true));
  }
  return Effect.succeed(true);
}

/** Dispatch one parsed message. Returns false when the session should end. */
export async function dispatchMessage(
  msg: RpcMessage,
  ctx: ToolContext,
  send: (value: unknown) => void = writeLine,
  transport: TransportType = "stdio",
  actorOverride?: string,
): Promise<boolean> {
  const method = msg?.method;
  const msgId = msg?.id;
  const params = (msg?.params as Record<string, unknown> | undefined) ?? {};
  if (method === "initialize") {
    handleInitialize(msgId, params, send);
  } else if (method === "notifications/initialized") {
    /* ack, no response */
  } else if (method === "tools/list") {
    handleToolsList(msgId, send);
  } else if (method === "tools/call") {
    await handleToolsCall(msgId, params, ctx, send, transport, actorOverride);
  } else if (method === "ping") {
    send({ jsonrpc: "2.0", id: msgId ?? null, result: {} });
  } else if (typeof method === "string" && method.startsWith("notifications/")) {
    /* ack, no response */
  } else if (msgId !== undefined && msgId !== null) {
    send({
      jsonrpc: "2.0",
      id: msgId,
      error: { code: -32601, message: `method not found: ${method}` },
    });
  }
  return true;
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let isHttp = false;
  let isHttpOnly = false;
  let httpPort: number | undefined;
  let httpHost: string | undefined;
  let authToken: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--http") {
      isHttp = true;
    } else if (arg === "--http-only") {
      isHttp = true;
      isHttpOnly = true;
    } else if (arg === "--port" && i + 1 < args.length) {
      httpPort = parseInt(args[++i], 10);
    } else if (arg.startsWith("--port=")) {
      httpPort = parseInt(arg.slice(7), 10);
    } else if (arg === "--host" && i + 1 < args.length) {
      httpHost = args[++i];
    } else if (arg.startsWith("--host=")) {
      httpHost = arg.slice(7);
    } else if (arg === "--auth-token" && i + 1 < args.length) {
      authToken = args[++i];
    } else if (arg.startsWith("--auth-token=")) {
      authToken = arg.slice(13);
    }
  }

  if (process.env.FM_MCP_HTTP === "1" || process.env.FM_MCP_HTTP_ENABLED === "1") {
    isHttp = true;
  }
  if (process.env.FM_MCP_HTTP_ONLY === "1") {
    isHttp = true;
    isHttpOnly = true;
  }

  const ctx = liveContext();

  let httpHandle: HttpServerHandle | undefined;
  if (isHttp) {
    const { startHttpServer } = await import("./http.js");
    httpHandle = await startHttpServer({
      host: httpHost,
      port: httpPort,
      authToken,
      toolContext: ctx,
    });
    process.stderr.write(
      `fm-mcp-http: listening on http://${httpHandle.host}:${httpHandle.port}/mcp auth=bearer\n`,
    );
  }

  if (isHttpOnly) {
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => resolve());
      process.on("SIGTERM", () => resolve());
    });
    if (httpHandle) await httpHandle.close();
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      replyError(null, -32700, "parse error");
      continue;
    }
    await dispatchMessage(msg, ctx);
  }

  if (httpHandle) {
    await httpHandle.close();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith("/server.js") ||
    import.meta.url.endsWith("/server.ts"));

if (isEntryPoint) {
  void main();
}

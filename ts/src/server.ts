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
import { AuditService, appendAudit, buildLine, TIER_FORBIDDEN, tierOf, type TransportType } from "./auth.js";
import { checkAuthorization } from "./grants.js";
import { FollowOnService, FollowOnLive } from "./followon.js";
import { TOOLS, liveContext, missingContractScript, type ToolContext } from "./tools.js";
import { readResource, resourceList } from "./resources.js";
import { MainLive } from "./layers.js";
import type { HttpServerHandle } from "./http.js";

export { MainLive };

// JSON-RPC framing + list/read handlers live in ./server/rpc.ts (slice 21, task-8pqjb).
import {
  writeLine,
  handleResourcesRead,
  RpcMessage,
  reply,
  replyError,
  handleInitialize,
  handleResourcesList,
  handleToolsList,
} from "./server/rpc.js";
export {
  RpcMessage,
  reply,
  replyError,
  handleInitialize,
  handleResourcesList,
  handleToolsList,
};
// audit targeting/append/decision + approval gate live in ./server/audit.ts (slice 21, task-8pqjb).
import {
  auditAppendEffect,
} from "./server/audit.js";
export {
  auditAppendEffect,
};
// tools/call dispatch (promise + Effect) live in ./server/dispatch.ts (slice 21, task-8pqjb).
import {
  handleToolsCall,
  handleToolsCallEffect,
} from "./server/dispatch.js";
export {
  handleToolsCall,
  handleToolsCallEffect,
};
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
  } else if (method === "resources/list") {
    return Effect.sync(() => {
      handleResourcesList(msgId, send);
    }).pipe(Effect.as(true));
  } else if (method === "resources/read") {
    return Effect.promise(() => handleResourcesRead(msgId, params, ctx, send)).pipe(Effect.as(true));
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
  } else if (method === "resources/list") {
    handleResourcesList(msgId, send);
  } else if (method === "resources/read") {
    await handleResourcesRead(msgId, params, ctx, send);
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

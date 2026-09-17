#!/usr/bin/env node
/**
 * First Mate MCP smarts-only server (TypeScript sibling).
 *
 * stdio parity with fm_mcp_server.py: newline-delimited JSON-RPC on stdin,
 * responses on stdout, logs on stderr. No dependencies — Node built-ins only.
 * No SSE / streamable HTTP (out of scope, same as the Python path).
 */
import readline from "node:readline";
import {
  SERVER_NAME,
  SERVER_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./constants.js";
import { TOOLS, liveContext, type ToolContext } from "./tools.js";

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

export async function handleToolsCall(
  msgId: string | number | null | undefined,
  params: Record<string, unknown>,
  ctx: ToolContext,
  send: (value: unknown) => void = writeLine,
): Promise<void> {
  const name = params?.["name"] as string | undefined;
  const args = (params?.["arguments"] as Record<string, unknown> | undefined) ?? {};
  if (typeof name !== "string" || !(name in TOOLS)) {
    send({
      jsonrpc: "2.0",
      id: msgId ?? null,
      error: { code: -32602, message: `unknown tool: ${name}` },
    });
    return;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
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
  const result: Record<string, unknown> = {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
  if (isError) result["isError"] = true;
  send({ jsonrpc: "2.0", id: msgId ?? null, result });
}

/** Dispatch one parsed message. Returns false when the session should end. */
export async function dispatchMessage(
  msg: RpcMessage,
  ctx: ToolContext,
  send: (value: unknown) => void = writeLine,
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
    await handleToolsCall(msgId, params, ctx, send);
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
  const ctx = liveContext();
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
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith("/server.js") ||
    import.meta.url.endsWith("/server.ts"));

if (isEntryPoint) {
  void main();
}

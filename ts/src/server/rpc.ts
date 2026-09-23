/**
 * JSON-RPC framing + initialize/list/read handlers. (slice 21 of the server.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/server.ts. Exported there, re-exported via server.ts so the `./server.js` surface is unchanged.
 */
import {
  SERVER_NAME,
  SERVER_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "../constants.js";
import { TIER_FORBIDDEN, tierOf } from "../auth.js";
import { TOOLS } from "../tools.js";
import { readResource, resourceList } from "../resources.js";
import type { ToolContext } from "../tools.js";

export interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export function writeLine(value: unknown): void {
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
      capabilities: { tools: {}, resources: { listChanged: false, subscribe: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    },
  });
}

export function handleResourcesList(
  msgId: string | number | null | undefined,
  send: (value: unknown) => void = writeLine,
): void {
  send({ jsonrpc: "2.0", id: msgId ?? null, result: { resources: resourceList() } });
}

export async function handleResourcesRead(
  msgId: string | number | null | undefined,
  params: Record<string, unknown>,
  ctx: ToolContext,
  send: (value: unknown) => void = writeLine,
): Promise<void> {
  const uri = params?.["uri"];
  const result = await readResource(uri, ctx);
  if (result === null) {
    send({
      jsonrpc: "2.0",
      id: msgId ?? null,
      error: { code: -32602, message: `unknown resource: ${String(uri)}` },
    });
    return;
  }
  if ("error" in result) {
    send({ jsonrpc: "2.0", id: msgId ?? null, error: { code: -32602, message: result.error } });
    return;
  }
  send({
    jsonrpc: "2.0",
    id: msgId ?? null,
    result: { contents: [{ uri, mimeType: result.mimeType, text: result.text }] },
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
      // Code-forbidden tools are not advertised. They are registered (so the
      // dispatcher can refuse them by name with `forbidden`), but a client that
      // builds a tool picker from this list should never be offered a lever the
      // server will always refuse: 27 of the 128 registered surfaces could only
      // ever answer `forbidden`. The dispatcher still refuses them either way.
      tools: Object.entries(TOOLS)
        .filter(([name]) => tierOf(name) !== TIER_FORBIDDEN)
        .map(([name, def]) => ({
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


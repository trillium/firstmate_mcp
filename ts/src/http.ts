/**
 * Streamable HTTP Transport for First Mate MCP as an AUDIT control plane.
 *
 * Purpose:
 * External audit systems reach in to inspect fleet state, crew states,
 * audit trails, guard checks, bearings, and receipts over HTTP with SSE /
 * JSON-RPC streaming.
 *
 * Security & Transport Controls:
 * 1. Localhost-first binding (127.0.0.1 default).
 * 2. Origin validation (DNS-rebinding defense): rejects foreign origins with 403 Forbidden.
 * 3. Host header validation: rejects unapproved Host headers with 403 Forbidden.
 * 4. Authentication: Bearer token (RFC 6750) via Authorization header, validated
 *    using timingSafeEqual string comparison to prevent timing side-channels.
 * 5. MCP Spec Session handling: Mcp-Session-Id header lifecycle, session store with
 *    TTL expiry, and DELETE termination.
 * 6. Audit Trail Distinction: records transport="http" in the audit log for
 *    complete traceability without changing the line schema or approval hashing.
 * 7. Write Surface Protection: preserves all auth tiers; Tier 3 writes still require
 *    explicit "I authorize" approval tokens.
 */
import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { Context, Effect, Layer } from "effect";
import { AuditService, TransportType } from "./auth.js";
import { dispatchMessageEffect, RpcMessage } from "./server.js";
import { liveContext, ToolContext } from "./tools.js";
import { MainLive } from "./layers.js";
import { MAX_OUTPUT_BYTES } from "./constants.js";

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 3000;
export const DEFAULT_SESSION_TTL_MS = 3600000; // 1 hour
export const DEFAULT_ENDPOINT_PATH = "/mcp";

export interface HttpServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly authToken?: string;
  readonly allowedOrigins?: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly sessionTtlMs?: number;
  readonly endpointPath?: string;
  readonly toolContext?: ToolContext;
}

export interface SessionData {
  readonly id: string;
  readonly createdAt: number;
  lastActivityAt: number;
  initialized: boolean;
  protocolVersion?: string;
  clientInfo?: { name: string; version: string };
  sseRes?: http.ServerResponse;
}

/** Constant-time string comparison using SHA-256 digests. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const hashA = crypto.createHash("sha256").update(a, "utf8").digest();
  const hashB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(hashA, hashB) && a === b;
}

/** Check whether an origin is allowed (localhost / 127.0.0.1 / [::1] or explicitly listed). */
export function validateOrigin(
  originHeader: string | undefined,
  allowedOrigins?: readonly string[],
): boolean {
  if (!originHeader) return true; // Non-browser clients (curl, python, sdk) omit Origin
  try {
    const parsed = new URL(originHeader);
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
      return true;
    }
    if (allowedOrigins && allowedOrigins.includes(parsed.origin.toLowerCase())) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Check whether Host header is valid (localhost / 127.0.0.1 / [::1] or explicitly listed). */
export function validateHost(
  hostHeader: string | undefined,
  allowedHosts?: readonly string[],
): boolean {
  if (!hostHeader) return false;
  const hostWithoutPort = hostHeader.replace(/:\d+$/, "").toLowerCase();
  if (
    hostWithoutPort === "localhost" ||
    hostWithoutPort === "127.0.0.1" ||
    hostWithoutPort === "[::1]" ||
    hostWithoutPort === "::1"
  ) {
    return true;
  }
  if (allowedHosts && allowedHosts.map((h) => h.toLowerCase()).includes(hostWithoutPort)) {
    return true;
  }
  return false;
}

/** Validate Bearer token authentication against the expected secret token. */
export function validateAuth(
  authHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (!authHeader) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const presented = match[1].trim();
  if (!presented) return false;
  return timingSafeEqualStr(presented, expectedToken);
}

/** In-memory MCP session manager. */
export class SessionStore {
  private readonly sessions = new Map<string, SessionData>();

  createSession(protocolVersion?: string, idOverride?: string): SessionData {
    const id = idOverride ?? crypto.randomUUID();
    const session: SessionData = {
      id,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      initialized: false,
      protocolVersion,
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): SessionData | undefined {
    return this.sessions.get(id);
  }

  touchSession(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.lastActivityAt = Date.now();
  }

  deleteSession(id: string): boolean {
    const s = this.sessions.get(id);
    if (s) {
      if (s.sseRes && !s.sseRes.writableEnded) {
        try {
          s.sseRes.end();
        } catch {
          /* ignore */
        }
      }
      return this.sessions.delete(id);
    }
    return false;
  }

  cleanupExpired(ttlMs: number): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, s] of this.sessions.entries()) {
      if (now - s.lastActivityAt > ttlMs) {
        if (s.sseRes && !s.sseRes.writableEnded) {
          try {
            s.sseRes.end();
          } catch {
            /* ignore */
          }
        }
        this.sessions.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  count(): number {
    return this.sessions.size;
  }

  closeAll(): void {
    for (const s of this.sessions.values()) {
      if (s.sseRes && !s.sseRes.writableEnded) {
        try {
          s.sseRes.end();
        } catch {
          /* ignore */
        }
      }
    }
    this.sessions.clear();
  }
}

export interface HttpServerHandle {
  readonly server: http.Server;
  readonly host: string;
  readonly port: number;
  readonly authToken: string;
  readonly sessionStore: SessionStore;
  readonly close: () => Promise<void>;
}

/** Create and configure the Node HTTP Server. */
export function createHttpServer(
  options: HttpServerOptions = {},
  sessionStore: SessionStore = new SessionStore(),
): { server: http.Server; authToken: string } {
  const authToken =
    options.authToken ??
    process.env.FM_MCP_AUTH_TOKEN ??
    crypto.randomBytes(32).toString("hex");

  const allowedOrigins = options.allowedOrigins ??
    (process.env.FM_MCP_ALLOWED_ORIGINS
      ? process.env.FM_MCP_ALLOWED_ORIGINS.split(",").map((s) => s.trim())
      : undefined);

  const allowedHosts = options.allowedHosts ??
    (process.env.FM_MCP_ALLOWED_HOSTS
      ? process.env.FM_MCP_ALLOWED_HOSTS.split(",").map((s) => s.trim())
      : undefined);

  const endpointPath = options.endpointPath ?? DEFAULT_ENDPOINT_PATH;
  const toolContext = options.toolContext ?? liveContext();
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;

  const server = http.createServer(async (req, res) => {
    // 1. Host Validation (DNS rebinding defense)
    if (!validateHost(req.headers.host, allowedHosts)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden: invalid Host header" }));
      return;
    }

    // 2. Origin Validation (DNS rebinding & CSRF defense)
    const originHeader = req.headers.origin as string | undefined;
    if (!validateOrigin(originHeader, allowedOrigins)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden: invalid Origin" }));
      return;
    }

    const setCorsHeaders = () => {
      if (originHeader) {
        res.setHeader("Access-Control-Allow-Origin", originHeader);
      }
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Mcp-Session-Id, X-FirstMate-Actor, Accept",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      res.setHeader("Access-Control-Max-Age", "86400");
    };

    setCorsHeaders();

    // 3. CORS Preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // 4. Authentication Verification (RFC 6750 Bearer token)
    if (!validateAuth(req.headers.authorization, authToken)) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="firstmate-mcp"',
      });
      res.end(
        JSON.stringify({
          error: "Unauthorized: valid Bearer token required in Authorization header",
        }),
      );
      return;
    }

    // Parse URL path
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = reqUrl.pathname;

    const isMcpPath =
      pathname === endpointPath ||
      pathname === "/" ||
      pathname === "/sse" ||
      pathname === `${endpointPath}/sse`;

    if (!isMcpPath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Not Found: ${pathname}` }));
      return;
    }

    // Sweep expired sessions periodically
    sessionStore.cleanupExpired(sessionTtlMs);

    const reqSessionId =
      (req.headers["mcp-session-id"] as string | undefined) ??
      reqUrl.searchParams.get("sessionId") ??
      undefined;

    const actor =
      (req.headers["x-firstmate-actor"] as string | undefined) ??
      process.env.FM_ACTOR ??
      "http-audit";

    // 5. GET Handler (SSE / Streamable Event Stream)
    if (req.method === "GET") {
      const isSse =
        req.headers.accept?.includes("text/event-stream") ||
        pathname === "/sse" ||
        pathname === `${endpointPath}/sse`;

      let session: SessionData;
      if (reqSessionId) {
        const existing = sessionStore.getSession(reqSessionId);
        if (!existing) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found or expired" }));
          return;
        }
        session = existing;
        sessionStore.touchSession(session.id);
      } else {
        session = sessionStore.createSession();
      }

      if (isSse) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Mcp-Session-Id": session.id,
        });

        session.sseRes = res;
        res.write(`event: endpoint\ndata: ${endpointPath}?sessionId=${session.id}\n\n`);

        req.on("close", () => {
          if (session.sseRes === res) {
            session.sseRes = undefined;
          }
        });
        return;
      }

      // Plain GET returns session status / endpoint info
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Mcp-Session-Id": session.id,
      });
      res.end(
        JSON.stringify({
          status: "ready",
          transport: "http",
          sessionId: session.id,
          initialized: session.initialized,
          endpoint: endpointPath,
        }),
      );
      return;
    }

    // 6. DELETE Handler (Session Termination)
    if (req.method === "DELETE") {
      if (!reqSessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Mcp-Session-Id header or parameter required" }));
        return;
      }
      const deleted = sessionStore.deleteSession(reqSessionId);
      if (!deleted) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // 7. POST Handler (JSON-RPC Messages & Tool Execution)
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_OUTPUT_BYTES) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload Too Large" }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", async () => {
        const bodyStr = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(bodyStr);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            }),
          );
          return;
        }

        const isBatch = Array.isArray(parsed);
        const messages: RpcMessage[] = isBatch
          ? (parsed as RpcMessage[])
          : [parsed as RpcMessage];

        if (messages.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32600, message: "Invalid Request: empty batch" },
            }),
          );
          return;
        }

        // Determine session
        let session: SessionData | undefined;
        const isInit = messages.some((m) => m?.method === "initialize");

        if (isInit) {
          session = sessionStore.createSession(undefined, reqSessionId);
        } else if (reqSessionId) {
          session = sessionStore.getSession(reqSessionId);
          if (session) {
            sessionStore.touchSession(session.id);
          }
        }

        if (!session && !isInit) {
          // If not initialized and no valid session, reject with Session error
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: messages[0]?.id ?? null,
              error: { code: -32001, message: "Session not found or expired. Call initialize first." },
            }),
          );
          return;
        }

        const sessionId = session?.id ?? "";

        // Process each message via Effect runtime
        const responses: unknown[] = [];

        for (const msg of messages) {
          const sendResponse = (val: unknown) => {
            responses.push(val);
          };

          const dispatchProgram = dispatchMessageEffect(
            msg,
            toolContext,
            sendResponse,
            "http",
            actor,
          ).pipe(
            Effect.provide(MainLive),
            Effect.catchAll(() => Effect.succeed(true)),
          );

          await Effect.runPromise(dispatchProgram);

          if (msg?.method === "initialize" && session) {
            session.initialized = true;
          }
        }

        // Send HTTP response
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (sessionId) {
          headers["Mcp-Session-Id"] = sessionId;
        }

        const statusCode = !isBatch && responses.length === 0 ? 202 : 200;
        res.writeHead(statusCode, headers);
        if (isBatch) {
          res.end(JSON.stringify(responses));
        } else if (responses.length === 0) {
          res.end();
        } else {
          res.end(JSON.stringify(responses[0]));
        }
      });
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Method Not Allowed: ${req.method}` }));
  });

  return { server, authToken };
}

/** Start the HTTP server on specified host and port. */
export async function startHttpServer(
  options: HttpServerOptions = {},
): Promise<HttpServerHandle> {
  const host = options.host ?? process.env.FM_MCP_HTTP_HOST ?? DEFAULT_HTTP_HOST;
  const port = options.port ?? (process.env.FM_MCP_HTTP_PORT ? parseInt(process.env.FM_MCP_HTTP_PORT, 10) : DEFAULT_HTTP_PORT);
  const sessionStore = new SessionStore();
  const { server, authToken } = createHttpServer(options, sessionStore);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const boundAddr = server.address();
  const boundPort = typeof boundAddr === "object" && boundAddr !== null ? boundAddr.port : port;

  return {
    server,
    host,
    port: boundPort,
    authToken,
    sessionStore,
    close: async () => {
      sessionStore.closeAll();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// --- Effect Service & Layer ---

export interface HttpServerApi {
  readonly start: (options?: HttpServerOptions) => Effect.Effect<HttpServerHandle, Error>;
}

export class HttpServerService extends Context.Tag("HttpServerService")<
  HttpServerService,
  HttpServerApi
>() {}

export const HttpServerLive: Layer.Layer<HttpServerService> = Layer.succeed(
  HttpServerService,
  HttpServerService.of({
    start: (options) =>
      Effect.tryPromise({
        try: () => startHttpServer(options),
        catch: (exc) => new Error(`Failed to start HTTP server: ${String(exc)}`),
      }),
  }),
);

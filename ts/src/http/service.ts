/**
 * Server start + Effect service/layers. (slice 22 of the http.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/http.ts. Exported there, re-exported via
 * http.ts so the `./http.js` public surface is unchanged.
 */
import { Context, Effect, Layer } from "effect";
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, createHttpServer } from "../http.js";
import { SessionStore } from "./session-store.js";
import type { HttpServerHandle } from "./session-store.js";
import type { HttpServerOptions } from "../http.js";

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

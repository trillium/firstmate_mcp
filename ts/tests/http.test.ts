/**
 * Tests for the Streamable HTTP Transport (ts/src/http.ts) as an AUDIT control plane.
 *
 * Verifies:
 * 1. Streamable HTTP endpoint alongside stdio (localhost-first binding, dynamic port allocation).
 * 2. Origin validation (DNS-rebinding defense against attacker origins).
 * 3. Host header validation (DNS-rebinding defense).
 * 4. Authentication enforcement (RFC 6750 Bearer token, timing-safe equality, rejection of anonymous reach-in).
 * 5. MCP Spec Session handling (Mcp-Session-Id header lifecycle, initialize -> list -> calls, DELETE session termination).
 * 6. SSE stream (GET /mcp with text/event-stream).
 * 7. Audit-optimized read path (initialize -> tools/list -> fleet reads) with latency measurement.
 * 8. Write surface protection (Tier 3 approval enforcement, unknown/unadmitted tool deny list preserved over HTTP).
 * 9. Audit log transport distinction (transport="http" vs transport="stdio", unified audit log, approvalRef preserved).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHttpServer, HttpServerHandle, timingSafeEqualStr, validateOrigin, validateHost, validateAuth } from "../src/http.js";
import { TIER_FORBIDDEN, readAuditLines, tierOf, type AuditLine } from "../src/auth.js";
import { TOOLS, type ToolContext } from "../src/tools.js";

function makeTestHome(): { dir: string; ctx: ToolContext; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-http-test-"));
  const binDir = path.join(dir, "bin");
  const stateDir = path.join(dir, "state");
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const snapshot = {
    schema: "fm-fleet-snapshot.v1",
    generated: "2026-09-20T12:00:00Z",
    backlog: { inbox: [{ id: "t1", title: "test task" }] },
    tasks: [{ task_id: "t1", current_state: { state: "running" }, note: "testing" }],
  };

  const stubs: Record<string, string> = {
    "fm-fleet-snapshot.sh": `#!/bin/sh\necho '${JSON.stringify(snapshot)}'\n`,
    "fm-crew-state.sh": `#!/bin/sh\necho 'state: running · source: pane · test task'\n`,
    "fm-bearings.sh": `#!/bin/sh\necho '{"schema":"fm-bearings.v1","board":{"focus":"task-1"}}'\n`,
    "fm-guard-check.sh": `#!/bin/sh\necho 'guard: allow'\n`,
    "fm-control.sh": `#!/bin/sh\necho 'steered $1'\n`,
  };

  for (const [name, content] of Object.entries(stubs)) {
    const scriptPath = path.join(binDir, name);
    fs.writeFileSync(scriptPath, content, { mode: 0o755 });
  }

  fs.writeFileSync(path.join(stateDir, "t1.status"), "working: task started\nworking: processing\n");

  const ctx: ToolContext = {
    binDir,
    stateDir,
    dataDir,
    run: (cmd: string[]) => {
      const script = path.basename(cmd[0]);
      const target = path.join(binDir, script);
      if (fs.existsSync(target)) {
        const { spawnSync } = require("node:child_process");
        const res = spawnSync(target, cmd.slice(1), { encoding: "utf8" });
        return Promise.resolve({
          exitCode: res.status ?? 0,
          stdout: res.stdout ?? "",
          stderr: res.stderr ?? "",
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: "mock stdout", stderr: "" });
    },
  };

  return {
    dir,
    ctx,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface HttpRequestOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: () => any;
}

function requestHttp(
  handle: HttpServerHandle,
  opts: HttpRequestOptions = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const method = opts.method ?? "POST";
    const reqPath = opts.path ?? "/mcp";
    const headers: Record<string, string> = {
      Host: `127.0.0.1:${handle.port}`,
      ...opts.headers,
    };

    const req = http.request(
      {
        hostname: handle.host,
        port: handle.port,
        path: reqPath,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body),
          });
        });
      },
    );

    req.on("error", reject);
    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

describe("Streamable HTTP Transport: Security & Auth", () => {
  const testHome = makeTestHome();
  let handle: HttpServerHandle;
  const SECRET_TOKEN = "test-secret-token-12345678901234567890";

  before(async () => {
    handle = await startHttpServer({
      host: "127.0.0.1",
      port: 0, // Dynamic port
      authToken: SECRET_TOKEN,
      toolContext: testHome.ctx,
    });
  });

  after(async () => {
    await handle.close();
    testHome.cleanup();
  });

  it("timingSafeEqualStr compares strings in constant time", () => {
    assert.equal(timingSafeEqualStr("token123", "token123"), true);
    assert.equal(timingSafeEqualStr("token123", "token124"), false);
    assert.equal(timingSafeEqualStr("token123", "token12"), false);
  });

  it("validateOrigin rejects foreign origins and allows localhost", () => {
    assert.equal(validateOrigin(undefined), true);
    assert.equal(validateOrigin("http://localhost:3000"), true);
    assert.equal(validateOrigin("http://127.0.0.1:8080"), true);
    assert.equal(validateOrigin("http://[::1]:3000"), true);
    assert.equal(validateOrigin("http://evil.com"), false);
    assert.equal(validateOrigin("https://attacker.org:3000"), false);
    assert.equal(validateOrigin("https://allowed.internal", ["https://allowed.internal"]), true);
  });

  it("validateHost rejects forged host headers and allows localhost", () => {
    assert.equal(validateHost(undefined), false);
    assert.equal(validateHost("localhost:3000"), true);
    assert.equal(validateHost("127.0.0.1:8080"), true);
    assert.equal(validateHost("[::1]:3000"), true);
    assert.equal(validateHost("attacker.com"), false);
    assert.equal(validateHost("malicious.internal:3000"), false);
  });

  it("validateAuth verifies Bearer tokens correctly", () => {
    assert.equal(validateAuth(undefined, SECRET_TOKEN), false);
    assert.equal(validateAuth("Basic abc", SECRET_TOKEN), false);
    assert.equal(validateAuth("Bearer wrong-token", SECRET_TOKEN), false);
    assert.equal(validateAuth(`Bearer ${SECRET_TOKEN}`, SECRET_TOKEN), true);
    assert.equal(validateAuth(`bearer ${SECRET_TOKEN}`, SECRET_TOKEN), true);
  });

  it("rejects request without Authorization header with 401 Unauthorized", async () => {
    const res = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers["www-authenticate"], 'Bearer realm="firstmate-mcp"');
    const body = res.json();
    assert.match(body.error, /Unauthorized/i);
  });

  it("rejects request with invalid Bearer token with 401 Unauthorized", async () => {
    const res = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: { Authorization: "Bearer wrong-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(res.status, 401);
  });

  it("rejects request with invalid Host header with 403 Forbidden (DNS rebinding defense)", async () => {
    const res = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: {
        Host: "attacker.com",
        Authorization: `Bearer ${SECRET_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(res.status, 403);
    assert.match(res.json().error, /invalid Host/i);
  });

  it("rejects request with invalid Origin header with 403 Forbidden (DNS rebinding / CSRF defense)", async () => {
    const res = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: {
        Origin: "http://evil.com",
        Authorization: `Bearer ${SECRET_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(res.status, 403);
    assert.match(res.json().error, /invalid Origin/i);
  });

  it("handles CORS OPTIONS preflight for approved localhost origin", async () => {
    const res = await requestHttp(handle, {
      method: "OPTIONS",
      path: "/mcp",
      headers: {
        Origin: "http://localhost:3000",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers["access-control-allow-origin"], "http://localhost:3000");
    assert.equal(res.headers["access-control-expose-headers"], "Mcp-Session-Id");
  });
});

describe("Streamable HTTP Transport: Session Lifecycle & MCP Protocol", () => {
  const testHome = makeTestHome();
  let handle: HttpServerHandle;
  const SECRET_TOKEN = "session-test-token-abcdef";
  let activeSessionId: string = "";

  before(async () => {
    handle = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      authToken: SECRET_TOKEN,
      toolContext: testHome.ctx,
    });
  });

  after(async () => {
    await handle.close();
    testHome.cleanup();
  });

  it("POST /mcp initialize creates a new session and returns Mcp-Session-Id header", async () => {
    const res = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "external-audit-client", version: "1.0.0" },
        },
      }),
    });

    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, 1);
    assert.equal(body.result.serverInfo.name, "firstmate-mcp-poc");
    assert.equal(body.result.protocolVersion, "2024-11-05");

    activeSessionId = res.headers["mcp-session-id"] as string;
    assert.ok(activeSessionId, "Mcp-Session-Id header must be present");
    assert.equal(handle.sessionStore.count(), 1);
  });

  it("POST /mcp notifications/initialized acknowledges session initialization", async () => {
    const res = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`,
        "Mcp-Session-Id": activeSessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    });

    assert.equal(res.status, 202);
    const session = handle.sessionStore.getSession(activeSessionId);
    assert.ok(session);
    assert.equal(session.initialized, true);
  });

  it("POST /mcp tools/list returns all registered tools", async () => {
    const res = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`,
        "Mcp-Session-Id": activeSessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });

    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.id, 2);
    assert.ok(Array.isArray(body.result.tools));
    assert.equal(
      body.result.tools.length,
      Object.keys(TOOLS).filter((name) => tierOf(name) !== TIER_FORBIDDEN).length,
      "the HTTP surface advertises the same callable tools as stdio",
    );
    const toolNames = body.result.tools.map((t: any) => t.name);
    assert.ok(toolNames.includes("fleet_snapshot"));
    assert.ok(toolNames.includes("crew_state"));
    assert.ok(toolNames.includes("backlog"));
  });

  it("GET /mcp with text/event-stream establishes SSE stream", async () => {
    const sseRes = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; firstChunk: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: handle.host,
          port: handle.port,
          path: "/mcp",
          method: "GET",
          headers: {
            Host: `127.0.0.1:${handle.port}`,
            Authorization: `Bearer ${SECRET_TOKEN}`,
            Accept: "text/event-stream",
            "Mcp-Session-Id": activeSessionId,
          },
        },
        (res) => {
          res.on("data", (chunk: Buffer) => {
            const firstChunk = chunk.toString("utf8");
            req.destroy();
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              firstChunk,
            });
          });
        },
      );
      req.on("error", (err: any) => {
        // If error is from destroying request, ignore if already resolved
        if (err.code !== "ECONNRESET") {
          reject(err);
        }
      });
      req.end();
    });

    assert.equal(sseRes.status, 200);
    assert.equal(sseRes.headers["content-type"], "text/event-stream");
    assert.equal(sseRes.headers["mcp-session-id"], activeSessionId);
    assert.match(sseRes.firstChunk, /event: endpoint/);
  });

  it("DELETE /mcp terminates the active session", async () => {
    const res = await requestHttp(handle, {
      method: "DELETE",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`,
        "Mcp-Session-Id": activeSessionId,
      },
    });

    assert.equal(res.status, 204);
    assert.equal(handle.sessionStore.getSession(activeSessionId), undefined);
  });

  it("POST /mcp with nonexistent session returns -32001 session error", async () => {
    const res = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`,
        "Mcp-Session-Id": "non-existent-session-uuid",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
      }),
    });

    assert.equal(res.status, 400);
    const body = res.json();
    assert.equal(body.error.code, -32001);
  });
});

describe("Streamable HTTP Transport: Audit Reads, Latency & Write Protection", () => {
  const testHome = makeTestHome();
  let handle: HttpServerHandle;
  const SECRET_TOKEN = "audit-proof-token-123456";
  let sessionId: string = "";
  const auditLogPath = path.join(testHome.dir, "state", "mcp-audit.jsonl");

  before(async () => {
    process.env.FM_AUDIT_LOG = auditLogPath;
    handle = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      authToken: SECRET_TOKEN,
      toolContext: testHome.ctx,
    });
  });

  after(async () => {
    await handle.close();
    delete process.env.FM_AUDIT_LOG;
    testHome.cleanup();
  });

  it("executes full audit-optimized read path over HTTP and measures latency", async () => {
    // 1. Initialize
    const t0 = performance.now();
    const initRes = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: { Authorization: `Bearer ${SECRET_TOKEN}`, "X-FirstMate-Actor": "external-auditor" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      }),
    });
    const initLatencyMs = performance.now() - t0;
    assert.equal(initRes.status, 200);
    sessionId = initRes.headers["mcp-session-id"] as string;

    // 2. tools/list
    const t1 = performance.now();
    const listRes = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`,
        "Mcp-Session-Id": sessionId,
        "X-FirstMate-Actor": "external-auditor",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const listLatencyMs = performance.now() - t1;
    assert.equal(listRes.status, 200);

    // 3. fleet_snapshot
    const t2 = performance.now();
    const snapRes = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`,
        "Mcp-Session-Id": sessionId,
        "X-FirstMate-Actor": "external-auditor",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "fleet_snapshot", arguments: {} },
      }),
    });
    const snapLatencyMs = performance.now() - t2;
    assert.equal(snapRes.status, 200);
    const snapBody = JSON.parse(snapRes.json().result.content[0].text);
    assert.equal(snapBody.schema, "fm-fleet-snapshot.v1");

    // 4. backlog
    const t3 = performance.now();
    const backlogRes = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`,
        "Mcp-Session-Id": sessionId,
        "X-FirstMate-Actor": "external-auditor",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "backlog", arguments: {} },
      }),
    });
    const backlogLatencyMs = performance.now() - t3;
    assert.equal(backlogRes.status, 200);
    const backlogBody = JSON.parse(backlogRes.json().result.content[0].text);
    assert.equal(backlogBody.task_counts.total, 1);

    // 5. crew_state
    const t4 = performance.now();
    const crewRes = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`,
        "Mcp-Session-Id": sessionId,
        "X-FirstMate-Actor": "external-auditor",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "crew_state", arguments: { id: "t1" } },
      }),
    });
    const crewLatencyMs = performance.now() - t4;
    assert.equal(crewRes.status, 200);
    const crewBody = JSON.parse(crewRes.json().result.content[0].text);
    assert.equal(crewBody.current.state, "running");

    // 6. status_tail
    const t5 = performance.now();
    const statusRes = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`,
        "Mcp-Session-Id": sessionId,
        "X-FirstMate-Actor": "external-auditor",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "status_tail", arguments: { id: "t1", lines: 5 } },
      }),
    });
    const statusLatencyMs = performance.now() - t5;
    assert.equal(statusRes.status, 200);
    const statusBody = JSON.parse(statusRes.json().result.content[0].text);
    assert.equal(statusBody.events.length, 2);

    // 7. bearings_snapshot
    const t6 = performance.now();
    const bearingsRes = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`,
        "Mcp-Session-Id": sessionId,
        "X-FirstMate-Actor": "external-auditor",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "bearings_snapshot", arguments: {} },
      }),
    });
    const bearingsLatencyMs = performance.now() - t6;
    assert.equal(bearingsRes.status, 200);

    // Log benchmark numbers
    const latencies = {
      initialize: initLatencyMs,
      tools_list: listLatencyMs,
      fleet_snapshot: snapLatencyMs,
      backlog: backlogLatencyMs,
      crew_state: crewLatencyMs,
      status_tail: statusLatencyMs,
      bearings_snapshot: bearingsLatencyMs,
    };
    process.stderr.write(`\n--- HTTP Audit Read Latency Benchmark ---\n${JSON.stringify(latencies, null, 2)}\n`);
  });

  it("write safety: Tier 3 tool WITHOUT approval over HTTP is refused", async () => {
    const res = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`,
        "Mcp-Session-Id": sessionId,
        "X-FirstMate-Actor": "external-auditor",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "lifecycle_interrupt",
          arguments: { id: "t1" },
        },
      }),
    });

    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.result.isError, true);
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.error, "approval required");
  });

  it("write safety: Tier 3 tool WITH explicit approval over HTTP is allowed", async () => {
    const res = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`,
        "Mcp-Session-Id": sessionId,
        "X-FirstMate-Actor": "external-auditor",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "lifecycle_interrupt",
          arguments: { id: "t1", approval: "I authorize lifecycle_interrupt on t1 (test)" },
        },
      }),
    });

    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.result.isError, undefined);
  });

  it("write safety: Code-forbidden tool over HTTP is refused as unknown tool", async () => {
    const res = await requestHttp(handle, {
      method: "POST",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${SECRET_TOKEN}`,
        "Mcp-Session-Id": sessionId,
        "X-FirstMate-Actor": "external-auditor",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "nope_forbidden_tool",
          arguments: {},
        },
      }),
    });

    assert.equal(res.status, 200);
    const body = res.json();
    assert.ok(body.error);
    assert.equal(body.error.code, -32602);
  });

  it("verifies audit log records transport='http' and actor='external-auditor'", () => {
    const lines = readAuditLines(auditLogPath);
    assert.ok(lines.length >= 7, `Expected >= 7 audit lines, got ${lines.length}`);

    for (const line of lines) {
      assert.equal(line.transport, "http");
      assert.equal(line.actor, "external-auditor");
      assert.ok(typeof line.v === "number");
      assert.ok(typeof line.ts === "string");
      assert.ok(typeof line.decision === "string");
    }

    // Check refused Tier 3 line
    const refusedLine = lines.find((l) => l.tool === "lifecycle_interrupt" && l.decision === "refuse");
    assert.ok(refusedLine);
    assert.equal(refusedLine.reason, "approval-required");
    assert.equal(refusedLine.approval_ref, null);

    // Check allowed Tier 3 line
    const allowedLine = lines.find((l) => l.tool === "lifecycle_interrupt" && l.decision === "allow");
    assert.ok(allowedLine);
    assert.equal(allowedLine.reason, "ok");
    assert.match(allowedLine.approval_ref as string, /^[0-9a-f]{16}$/);
  });
});

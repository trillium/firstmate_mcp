/**
 * Audit targeting/append/decision + approval gate. (slice 21 of the server.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/server.ts. Exported there.
 */
import path from "node:path";
import { Effect } from "effect";
import {
  appendAudit,
  AuditService,
  buildLine,
  type TransportType,
} from "../auth.js";
import { checkAuthorization } from "../grants.js";
import { missingContractScript } from "../tools.js";
import type { ToolContext } from "../tools.js";

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

export function auditTarget(args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  for (const key of ["id", "target", "task_id", "origin_id", "request_id", "receipt_id", "grant_id", "grantee", "tool", "path", "log", "project"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/**
 * Central authorization gate for tools/call.
 *
 * Approval used to be enforced only inside the handlers that remembered to ask
 * (`requireAuth`), so 19 of the 50 live Tier-3 tools — repo_edit, repo_commit,
 * repo_push, repo_merge, merge_pr, promote_scout, teardown_crew and pr_open
 * among them — ran with no approval string at all. Proven 2026-09-22 by
 * calling pr_open through the mcpjungle group endpoint with no approval: the
 * handler executed and tried to spawn gh. The gate lives here now, so a new
 * tool cannot ship unguarded by omission, and the per-handler requireAuth calls
 * stay for the detached receipt/follow-on paths that bypass this dispatcher.
 * checkAuthorization is pure (it only records _grant_ref), so a handler asking
 * a second time consumes nothing.
 */
export async function authorizeOrRefuse(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<Record<string, unknown> | null> {
  // A declared contract with no implementation on this home is refused before
  // authorization: the call cannot work whoever asks, and naming the missing
  // script beats letting the handler report a raw ENOENT (18 of 55 contracts on
  // the served fork line). doctor lists the whole set.
  const missingScript = missingContractScript(name, ctx.binDir);
  if (missingScript !== null) {
    return {
      error: "unavailable on this home",
      tool: name,
      script: missingScript,
      expect: `bin/${missingScript} in the served home`,
      hint: "declared contract with no implementation on this served line; doctor lists every one",
    };
  }
  const auth = await checkAuthorization(name, args, ctx);
  if (auth.ok) return null;
  return (
    auth.payload ?? {
      error: "approval required",
      expect: "explicit approval string starting with 'I authorize'",
    }
  );
}

export function auditDecision(
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

export function auditPath(ctx: ToolContext): string {
  return process.env.FM_AUDIT_LOG ?? path.join(ctx.stateDir, "mcp-audit.jsonl");
}

export function auditAppend(
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


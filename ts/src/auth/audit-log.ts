/**
 * JSON-lines audit log: build/format/append/read. (slice 23 of the auth.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/auth.ts. Exported there, re-exported via
 * auth.ts so the `./auth.js` public surface is unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { approvalRef, tierOf } from "./tier-check.js";
import type { Tier } from "./tiers.js";

export const AUDIT_VERSION = 1;

export const AUDIT_KEYS = [
  "v",
  "ts",
  "actor",
  "tool",
  "tier",
  "decision",
  "reason",
  "approval_ref",
  "target",
  "duration_ms",
  "transport",
  "decision_digest",
] as const;

export type TransportType = "stdio" | "http";

export interface AuditLine {
  v: number;
  ts: string;
  actor: string;
  tool: string;
  tier: Tier | null;
  decision: string;
  reason: string;
  approval_ref: string | null;
  target: string | null;
  duration_ms: number | null;
  transport: TransportType;
  decision_digest: string | null;
}

function utcStamp(date: Date = new Date()): string {
  // 2026-09-13T18:00:00Z — no millis, matching the Python strftime format.
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildLine(
  actor: string,
  tool: string,
  decision: string,
  reason: string,
  opts: {
    approval?: unknown;
    grant_ref?: string | null;
    target?: string | null;
    ts?: string;
    duration_ms?: number | null;
    transport?: TransportType;
    decision_digest?: string | null;
  } = {},
): AuditLine {
  return {
    v: AUDIT_VERSION,
    ts: opts.ts ?? utcStamp(),
    actor,
    tool,
    tier: tierOf(tool),
    decision,
    reason,
    approval_ref: opts.grant_ref ?? approvalRef(opts.approval),
    target: opts.target ?? null,
    duration_ms:
      typeof opts.duration_ms === "number"
        ? Math.max(0, Math.round(opts.duration_ms))
        : (opts.duration_ms ?? null),
    transport: opts.transport ?? "stdio",
    decision_digest: opts.decision_digest ?? null,
  };
}

/** Single JSON line with sorted keys; the approval token never appears. */
export function formatLine(line: AuditLine): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(line).sort()) {
    sorted[key] = (line as unknown as Record<string, unknown>)[key];
  }
  return JSON.stringify(sorted);
}

export function appendAudit(filePath: string, line: AuditLine): string {
  const dest = path.resolve(filePath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.appendFileSync(dest, formatLine(line) + "\n", "utf8");
  return dest;
}

export function readAuditLines(filePath: string): AuditLine[] {
  const out: AuditLine[] = [];
  const raw = fs.readFileSync(filePath, "utf8");
  for (const row of raw.split("\n")) {
    const trimmed = row.trim();
    if (trimmed) out.push(JSON.parse(trimmed) as AuditLine);
  }
  return out;
}

// --- Effect composition: Audit Service + typed approval checks ---


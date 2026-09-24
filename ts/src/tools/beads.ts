/**
 * Beads durability reads: mirror + write queue (s00r port, task-8pqjb pattern).
 *
 * Both read plain home-state files owned by bin/fm-beads-resilience-lib.sh —
 * no TS reimplementation of queue semantics, no script dispatch. Mirror
 * freshness uses the lib's 900s default max age. Absent/unreadable files
 * return typed degraded state ({present: false} / {pending: 0}), never an
 * error. Pending-write argv never surfaces (mutations shown, never executed).
 */
import fs from "node:fs";
import path from "node:path";
import { ownedCall } from "../runner.js";
import { validMirrorView, validStaleDays } from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

const MIRROR_MAX_AGE_S = 900;
const QUEUE_FILENAME = ".beads-write-queue";

function ageS(writtenAt: number): number {
  return Math.max(0, Math.floor(Date.now() / 1000) - writtenAt);
}

export async function toolBeadsMirror(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const view = args["view"];
  if (!validMirrorView(view)) {
    return {
      payload: {
        error: "invalid view",
        expect: "non-empty [a-z0-9_-], max 64 chars",
      },
      isError: true,
    };
  }
  const file = path.join(ctx.stateDir, `.beads-mirror-${view}.json`);
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return { payload: { view, present: false }, isError: false };
  }
  const written = doc["written_at"];
  const output = doc["output"];
  if (typeof written !== "number" || !Number.isFinite(written) || typeof output !== "string") {
    return { payload: { view, present: false }, isError: false };
  }
  const age = ageS(written);
  return {
    payload: {
      view,
      present: true,
      output,
      written_at: written,
      age_s: age,
      stale: age > MIRROR_MAX_AGE_S,
    },
    isError: false,
  };
}

export async function toolBeadsQueue(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const file = path.join(ctx.stateDir, QUEUE_FILENAME);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { payload: { present: false, pending: 0 }, isError: false };
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { payload: { present: true, pending: 0 }, isError: false };
  }
  let oldest: Record<string, unknown> = {};
  try {
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    if (first && typeof first === "object") oldest = first;
  } catch {
    oldest = { malformed: true };
  }
  const queuedAt = typeof oldest["queued_at"] === "number" ? oldest["queued_at"] : null;
  const payload: Record<string, unknown> = {
    present: true,
    pending: lines.length,
    oldest: {
      task_id: typeof oldest["task_id"] === "string" ? oldest["task_id"] : null,
      description: typeof oldest["description"] === "string" ? oldest["description"] : null,
      queued_at: queuedAt,
      age_s: queuedAt === null ? null : ageS(queuedAt),
    },
  };
  if (oldest["malformed"] === true) payload["oldest"] = { malformed: true };
  return { payload, isError: false };
}

export async function toolLedgerList(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  if (args["close"] !== undefined || args["close_all"] !== undefined) {
    return {
      payload: {
        error: "close verbs are not exposed",
        expect: "ledger_list is read-only; closing beads stays outside the doorway",
      },
      isError: true,
    };
  }
  const staleDays = args["stale_days"] ?? 2;
  if (!validStaleDays(staleDays)) {
    return {
      payload: {
        error: "invalid stale_days",
        expect: "integer 1..30 (doorway-bounded sweep window)",
      },
      isError: true,
    };
  }
  const cmd = [
    path.join(ctx.binDir, "fm-ledger.sh"),
    "--json",
    "--stale-days",
    String(staleDays),
  ];
  return ownedCall(cmd, "ledger list failed", ctx.run);
}

export async function toolBeadsBackup(_args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const cmd = [path.join(ctx.binDir, "fm-beads-remote-backup.sh"), "--verify"];
  const { payload, isError } = await ownedCall(cmd, "beads backup verify failed", ctx.run);
  if (isError) return { payload, isError: true };
  return { payload: { ...payload }, isError: false };
}

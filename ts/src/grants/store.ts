/**
 * Grant store: filenames, hashes, reads, writes, lookups. (slice 18 of the grants.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/grants.ts. Exported there, re-exported via
 * grants.ts so the `./grants.js` public surface is unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { GRANT_DIRNAME } from "../constants.js";
import { validId } from "../validators.js";
import type { StandingGrant } from "../grants.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

export function grantDir(ctx: ToolContext): string {
  return path.join(ctx.stateDir, GRANT_DIRNAME);
}

export function utcStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export function computeGrantRef(tokenOrHash: string): string {
  const hash = tokenOrHash.length === 64 ? tokenOrHash : hashToken(tokenOrHash);
  return hash.slice(0, 16);
}

/** Confined write of one grant record; returns true on success. */
export function writeGrant(ctx: ToolContext, grant: StandingGrant): boolean {
  const dir = grantDir(ctx);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.resolve(dir, `${grant.grant_id}.json`);
  if (path.dirname(file) !== path.resolve(dir)) return false;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(grant, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

/** Confined read of one grant record by grant_id. */
export function readGrant(ctx: ToolContext, grantId: unknown): StandingGrant | null {
  if (!validId(grantId)) return null;
  const dir = path.resolve(grantDir(ctx));
  const file = path.resolve(dir, `${grantId}.json`);
  if (path.dirname(file) !== dir) return null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as StandingGrant;
    if (parsed && typeof parsed === "object" && parsed.grant_id === grantId) {
      return parsed;
    }
  } catch {
    /* missing or corrupt */
  }
  return null;
}

/** Find grant record by token hash or grant id or grant_ref across the home's grant store. */
export function findGrantByTokenHash(ctx: ToolContext, tokenHash: string): StandingGrant | null {
  const dir = path.resolve(grantDir(ctx));
  try {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, entry), "utf8");
        const parsed = JSON.parse(raw) as StandingGrant;
        if (parsed && parsed.token_hash === tokenHash) {
          return parsed;
        }
      } catch {
        /* skip corrupt */
      }
    }
  } catch {
    /* dir read failed */
  }
  return null;
}

export function findGrantByIdOrRef(ctx: ToolContext, idOrRef: string): StandingGrant | null {
  const byId = readGrant(ctx, idOrRef);
  if (byId) return byId;
  const dir = path.resolve(grantDir(ctx));
  try {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, entry), "utf8");
        const parsed = JSON.parse(raw) as StandingGrant;
        if (parsed && (parsed.grant_id === idOrRef || parsed.grant_ref === idOrRef)) {
          return parsed;
        }
      } catch {
        /* skip corrupt */
      }
    }
  } catch {
    /* dir read failed */
  }
  return null;
}

export function listGrants(ctx: ToolContext, granteeFilter?: string | null): StandingGrant[] {
  const dir = path.resolve(grantDir(ctx));
  const out: StandingGrant[] = [];
  try {
    if (!fs.existsSync(dir)) return out;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, entry), "utf8");
        const parsed = JSON.parse(raw) as StandingGrant;
        if (parsed && typeof parsed.grant_id === "string") {
          if (granteeFilter && parsed.grantee !== granteeFilter) continue;
          out.push(parsed);
        }
      } catch {
        /* skip corrupt */
      }
    }
  } catch {
    /* dir read failed */
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

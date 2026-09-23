/**
 * Temp-file + digest helpers (slice 17 of the tools.ts folder split, task-8pqjb).
 *
 * Moved verbatim from src/tools.ts. Shared by relay, digests-write and
 * decisions slices; tools.ts no longer defines them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

let tmpCounter = 0;
export function writeTempFile(content: string): string {
  tmpCounter += 1;
  const tmp = path.join(
    os.tmpdir(),
    `fm-mcp-ts-${process.pid}-${Date.now()}-${tmpCounter}.md`,
  );
  fs.writeFileSync(tmp, content, "utf8");
  return tmp;
}

export function removeTempFile(tmp: string): void {
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* best effort */
  }
}

/** Compute SHA-256 hex digest for decision text. */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

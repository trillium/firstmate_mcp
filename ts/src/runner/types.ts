/**
 * Run result/error types + byte/truncate helpers. (slice 25 of the runner.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/runner.ts. Exported there, re-exported via
 * runner.ts so the `./runner.js` public surface is unchanged.
 */
import { TAIL_CAP_BYTES } from "../constants.js";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface RunError {
  error: string;
  [key: string]: unknown;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Bound a script output tail; returns [text, wasTruncated]. */
export function truncate(text: string, cap: number = TAIL_CAP_BYTES): [string, boolean] {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return [text, false];
  return [buf.subarray(0, cap).toString("utf8") + "\n…[truncated]", true];
}


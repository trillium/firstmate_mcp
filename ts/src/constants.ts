/**
 * Shared server constants.
 *
 * Mirrors the contract-relevant constants in fm_mcp_server.py (the Python
 * path). The shared behavioral contract and tests are the referee between
 * the two implementations — this file is independently written against that
 * contract, not translated line-by-line from the Python source.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

export const SERVER_NAME = "firstmate-mcp-poc";
export const SERVER_VERSION = "0.3.0";

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
] as const;

export const SNAPSHOT_SCHEMA = "fm-fleet-snapshot.v1";
export const BEARINGS_SCHEMA = "fm-bearings.v1";

/** Repo root: the TS tree lives one folder below it (ts/ -> root). */
export const CHECKOUT_ROOT: string = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function resolveBinDir(): string {
  const checkoutBin = path.join(CHECKOUT_ROOT, "bin");
  try {
    if (fs.statSync(checkoutBin).isDirectory()) return checkoutBin;
  } catch {
    /* fall through to FM_HOME/bin */
  }
  return path.join(homeDir(), "bin");
}

export function homeDir(): string {
  return process.env.FM_HOME ?? CHECKOUT_ROOT;
}

export function binDir(): string {
  return resolveBinDir();
}

export function stateDir(): string {
  return process.env.FM_STATE_OVERRIDE ?? path.join(homeDir(), "state");
}

/**
 * Fail-closed call budget: no tool call ever blocks an external caller
 * past this. A script that cannot finish in time is killed as a whole
 * process group and answered with a typed timeout error; callers that need
 * longer work submit it via receipt_submit and poll receipt_status instead.
 */
export const SUBPROCESS_TIMEOUT_S = 30;
/** Background budget for receipt runs: the detached continuation of a
 * receipt_submit may run this long while the caller stays unblocked. */
export const RECEIPT_TIMEOUT_S = 180;
/**
 * Receipt lifetime: completed receipt records stay retrievable this long,
 * then expire. Receipts live under the serving home's state dir, so they
 * never leak across homes.
 */
export const RECEIPT_TTL_S = 3600;
export const RECEIPT_DIRNAME = "mcp-receipts";
export const MAX_OUTPUT_BYTES = 1048576;
export const TAIL_CAP_BYTES = 8192;
export const PROCESS_GROUP_GRACE_S = 5;

export const SEND_TEXT_MAX_CHARS = 500;
export const APPROVAL_PREFIX = "I authorize";

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
export const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/;

export const MODES = ["no-mistakes", "direct-PR", "local-only"] as const;
export type Mode = (typeof MODES)[number];

export const BRIEF_MODES = [
  "no-mistakes",
  "direct-PR",
  "local-only",
  "scout",
] as const;
export type BriefMode = (typeof BRIEF_MODES)[number];

export const VERDICTS = ["approve", "decline", "comment"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const YOLO = ["on", "off"] as const;

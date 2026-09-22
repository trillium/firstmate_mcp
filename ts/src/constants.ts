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
export const HOME_SUMMARY_SCHEMA = "fm-secondmate-home-summary.v1";

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

/**
 * Resolve the `gh` binary the way bin/ scripts resolve FM_HOME/bin.
 *
 * The served process is spawned by mcpjungle from a launchd context whose PATH
 * is /usr/bin:/bin:/usr/sbin:/sbin, so a bare "gh" is not found even though it
 * resolves fine by hand — measured 2026-09-22: pr_open through the doorway
 * returned "Executable not found in $PATH: gh". Order: FM_GH_BIN, then the
 * usual install locations, then a last-resort PATH lookup so an unusual install
 * can still be pointed at explicitly.
 */
export function resolveGhBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FM_GH_BIN?.trim();
  if (override) return override;
  for (const candidate of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* try the next location */
    }
  }
  return "gh";
}

export function stateDir(): string {
  return process.env.FM_STATE_OVERRIDE ?? path.join(homeDir(), "state");
}

export function dataDir(): string {
  return process.env.FM_DATA_OVERRIDE ?? path.join(homeDir(), "data");
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
export const SNAPSHOT_DIRNAME = "mcp-snapshots";
export const SNAPSHOT_TTL_S = 3600;
// Cached whole-home reads (fleet_view, bearings_snapshot): same TTL as snapshots.
export const ARTIFACT_DIRNAME = "mcp-artifacts";
export const ARTIFACT_TTL_S = 3600;
export const SNAPSHOT_DEFAULT_LIMIT = 50;
export const SNAPSHOT_MIN_LIMIT = 1;
export const SNAPSHOT_MAX_LIMIT = 200;
export const CURSOR_RE = /^([A-Za-z0-9][A-Za-z0-9_.:-]{0,63}):(\d+)$/;
export const GRANT_DIRNAME = "mcp-grants";
export const GRANT_DEFAULT_TTL_S = 3600;
export const GRANT_MAX_TTL_S = 2592000;
export const GRANT_TOKEN_PREFIX = "sg_";
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

export const REL_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,255}$/;
export const SHA256_RE = /^[0-9a-fA-F]{64}$/;
export const CORR_RE = /^(?:corr=)?[0-9a-fA-F]{16}$/;

export const REMOTE_CONTROL_VERBS = ["state", "route", "observe", "send"] as const;
export type RemoteControlVerb = (typeof REMOTE_CONTROL_VERBS)[number];

export const VENDOR_AUTH_PROBES = ["grok"] as const;
export type VendorAuthProbe = (typeof VENDOR_AUTH_PROBES)[number];

export const VOICE_SCOPES = ["counts", "full"] as const;
export type VoiceScope = (typeof VOICE_SCOPES)[number];

export const STARTUP_MEMORY_MODES = ["read", "report"] as const;
export type StartupMemoryMode = (typeof STARTUP_MEMORY_MODES)[number];

export const TEST_ISOLATION_LIST_MODES = ["candidates", "exclusions"] as const;
export type TestIsolationListMode = (typeof TEST_ISOLATION_LIST_MODES)[number];

export const TEST_RUN_LIST_MODES = ["families", "lanes", "concurrent_safe", "coverage"] as const;
export type TestRunListMode = (typeof TEST_RUN_LIST_MODES)[number];

export const ISOLATION_POOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const SUPERVISION_INSTRUCTIONS_HARNESSES = [
  "claude", "codex", "opencode", "pi", "pi-signed", "grok", "cursor", "omp",
] as const;
export type SupervisionInstructionsHarness = (typeof SUPERVISION_INSTRUCTIONS_HARNESSES)[number];

export const SUPERVISION_AFK_MODES = ["away", "quiet"] as const;
export type SupervisionAfkMode = (typeof SUPERVISION_AFK_MODES)[number];

/** Longest shell command the arm/cd policy classifiers accept (bounded argv). */
export const POLICY_COMMAND_MAX_CHARS = 4000;

/** Longest harness tool name the subagent policy classifier accepts. */
export const SUBAGENT_TOOL_MAX_CHARS = 128;

/** Longest quota-axi snapshot (JSON or TOON) quota_choose accepts on stdin. */
export const QUOTA_SNAPSHOT_MAX_CHARS = 65536;

/** Most ordered dispatch candidates quota_choose evaluates. */
export const QUOTA_CANDIDATES_MAX = 16;

/** Candidate token shape owned by bin/fm-quota-choose.sh (never a leading colon). */
export const QUOTA_CANDIDATE_RE = /^[A-Za-z0-9._/:\-]+$/;

export const MAIL_TO_MAX_CHARS = 200;
export const MAIL_SUBJECT_MAX_CHARS = 200;
export const MAIL_BODY_MAX_CHARS = 5000;
export const VOICE_QUEUE_MAX_CHARS = 500;

export const PR_TITLE_MAX_CHARS = 200;
export const PR_BODY_MAX_BYTES = 65536;
export const DEFAULT_PR_BASE = "main";

export const PR_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,37}[A-Za-z0-9])\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]*)$/;

export const REMOTE_FILE_BYTES_MIN = 1;
export const REMOTE_FILE_BYTES_MAX = 262144;
export const REMOTE_FILE_DEFAULT_MAX_BYTES = 8192;
export const DELTA_WAIT_MIN = 0;
export const DELTA_WAIT_MAX = 10;
export const HANDOFF_LINES_MIN = 1;
export const HANDOFF_LINES_MAX = 20;
export const HANDOFF_DEFAULT_LINES = 10;
export const RESTART_IDS_MAX = 8;
export const HANDOFF_KEYS_MAX = 20;

export const HARNESS_MODES = [
  "own",
  "crew",
  "secondmate",
  "secondmate-model",
  "secondmate-effort",
] as const;
export type HarnessMode = (typeof HARNESS_MODES)[number];

/**
 * Fail-closed subprocess runner.
 *
 * Contract: every tool script runs with SUBPROCESS_TIMEOUT_S=180 and a
 * MAX_OUTPUT_BYTES=1MB envelope. Children start at the head of their own
 * process group (detached) so a timeout can reclaim the whole descendant
 * tree — a bare child-kill would leave fm-*.sh per-task grandchildren
 * running as orphans. On timeout the group gets SIGTERM, a short grace
 * period, then SIGKILL.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  CHECKOUT_ROOT,
  MAX_OUTPUT_BYTES,
  PROCESS_GROUP_GRACE_S,
  SUBPROCESS_TIMEOUT_S,
  TAIL_CAP_BYTES,
} from "./constants.js";

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

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessGroup(child: ChildProcess, graceS: number = PROCESS_GROUP_GRACE_S): Promise<void> {
  return (async () => {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
      // Negative pid targets the whole group (child was spawned detached).
      process.kill(-child.pid, "SIGTERM");
    } catch {
      return;
    }
    const deadline = Date.now() + graceS * 1000;
    while (child.exitCode === null && Date.now() < deadline) {
      await sleepMs(50);
    }
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  })();
}

export interface RunnerOptions {
  timeoutS?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run argv to completion. Resolves with the result, or with a typed
 * RunError when the executable is missing or the timeout fires.
 */
export function runScript(argv: string[], opts: RunnerOptions = {}): Promise<RunResult | RunError> {
  const timeoutS = opts.timeoutS ?? SUBPROCESS_TIMEOUT_S;
  const cwd = opts.cwd ?? CHECKOUT_ROOT;
  const env = opts.env ?? process.env;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        detached: true,
        windowsHide: true,
      });
    } catch (exc) {
      resolve({ error: "executable not found", detail: String(exc) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: RunResult | RunError) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      void killProcessGroup(child).then(() => {
        finish({ error: "timed out", timeout_s: timeoutS });
      });
    }, timeoutS * 1000);
    // Don't let the kill-grace timer keep the event loop alive on its own.
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (exc: Error & { code?: string }) => {
      if (exc?.code === "ENOENT") {
        finish({ error: "executable not found", detail: String(exc) });
      } else {
        finish({ error: "executable not found", detail: String(exc) });
      }
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, exitCode: code });
    });
  });
}

export interface OwnedOk {
  ok: true;
  stdout: string;
  stdout_truncated: boolean;
  stderr: string;
  stderr_truncated: boolean;
}

export type OwnedResult = OwnedOk | (RunError & { ok?: never });

/** Shared fail-closed wrapper: nonzero exit stays a typed error. */
export async function ownedCall(
  argv: string[],
  label: string,
  run: typeof runScript = runScript,
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  const res = await run(argv);
  if (!isRunResult(res)) {
    return { payload: res, isError: true };
  }
  const [out, outTrunc] = truncate(res.stdout ?? "");
  const [errOut, errTrunc] = truncate(res.stderr ?? "");
  if (res.exitCode !== 0) {
    return {
      payload: { error: label, exit: res.exitCode, stdout: out, stderr: errOut },
      isError: true,
    };
  }
  return {
    payload: {
      ok: true,
      stdout: out,
      stdout_truncated: outTrunc,
      stderr: errOut,
      stderr_truncated: errTrunc,
    },
    isError: false,
  };
}

export function isRunResult(value: RunResult | RunError): value is RunResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "exitCode" in value &&
    !("error" in value)
  );
}

export function outputTooLarge(text: string, cap: number = MAX_OUTPUT_BYTES): boolean {
  return byteLength(text) > cap;
}

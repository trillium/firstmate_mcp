/**
 * Git/gh archaeology reads: history, blame-range, run history (2od.4 port).
 *
 * Tier-1 reads dispatching raw git/gh (precedent: pr_open shells gh, test_run
 * shells runners). git uses -C (no cwd plumbing needed); gh runs with
 * cwd=repo. Output bounded by ownedCall truncation. Repo confinement: absolute
 * or FM_HOME-relative paths resolving under $HOME with a .git present.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isRunResult, ownedCall, truncate } from "../runner.js";
import { argv } from "../tools.js";
import { resolveGhBin } from "../constants.js";
import {
  validNonnegInt,
  validPageLimit,
  validReadBranch,
} from "../validators.js";
import type { ToolArgs, ToolContext, ToolResult } from "../tools.js";

const LOG_LIMIT_MAX = 50;

function confineRepo(repo: unknown, ctx: ToolContext): string | null {
  const fallback = process.env.FM_HOME ?? "";
  const raw = repo === undefined || repo === null || repo === "" ? fallback : repo;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  if (raw.includes("\0")) return null;
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.join(ctx.stateDir, "..", raw);
  // Confined to the user's home tree plus os.tmpdir() (scratch clones live
  // there, including every test stub home). Operations are strictly read-only
  // git/gh, so the wider root cannot mutate anything it can see.
  const roots = [os.homedir(), os.tmpdir()];
  const inside = roots.some((r) => abs === r || abs.startsWith(r + path.sep));
  if (!inside) return null;
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;
  try {
    if (!fs.statSync(path.join(abs, ".git")).isDirectory()) return null;
  } catch {
    return null;
  }
  return abs;
}

function repoError(): ToolResult {
  return {
    payload: {
      error: "invalid repo",
      expect: "absolute or home-relative repo path under $HOME containing .git (default: FM_HOME)",
    },
    isError: true,
  };
}

export async function toolGitHistory(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const repo = confineRepo(args["repo"], ctx);
  if (repo === null) return repoError();
  const limit = validPageLimit(args["limit"] ?? 20, 20);
  if (limit === null || limit < 1 || limit > LOG_LIMIT_MAX) {
    return {
      payload: { error: "invalid limit", expect: "integer 1..50" },
      isError: true,
    };
  }
  const paths = args["paths"];
  let pathArgs: string[] = [];
  if (paths !== undefined) {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 20) {
      return {
        payload: { error: "invalid paths", expect: "1..20 home-relative paths, no traversal" },
        isError: true,
      };
    }
    for (const p of paths) {
      if (typeof p !== "string" || p.length === 0 || p.length > 256) {
        return {
          payload: { error: "invalid paths", expect: "1..20 home-relative paths, no traversal" },
          isError: true,
        };
      }
      const resolved = path.normalize(path.join(repo, p));
      if (resolved !== repo && !resolved.startsWith(repo + path.sep)) {
        return {
          payload: { error: "invalid paths", expect: "paths must stay inside the repo" },
          isError: true,
        };
      }
      pathArgs.push(p);
    }
  }
  const cmd = ["git", "-C", repo, "log", "--oneline", "--max-count", String(limit)];
  if (pathArgs.length > 0) cmd.push("--", ...pathArgs);
  const { payload, isError } = await ownedCall(cmd, "git history failed", ctx.run);
  if (isError) return { payload, isError: true };
  return { payload: { ...payload, repo, limit }, isError: false };
}

export async function toolGitBlame(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const repo = confineRepo(args["repo"], ctx);
  if (repo === null) return repoError();
  const file = args["file"];
  if (typeof file !== "string" || file.length === 0 || file.length > 256) {
    return {
      payload: { error: "invalid file", expect: "repo-relative file path, no traversal" },
      isError: true,
    };
  }
  const resolved = path.normalize(path.join(repo, file));
  if (resolved !== repo && !resolved.startsWith(repo + path.sep)) {
    return {
      payload: { error: "invalid file", expect: "file must stay inside the repo" },
      isError: true,
    };
  }
  const start = validNonnegInt(args["start"]);
  const end = validNonnegInt(args["end"]);
  if (start === null || end === null || start < 1 || end < start || end - start > 200) {
    return {
      payload: { error: "invalid range", expect: "1 <= start <= end, at most 200 lines" },
      isError: true,
    };
  }
  const cmd = [
    "git", "-C", repo, "blame", "-L", `${start},${end}`, "--line-porcelain", "--", file,
  ];
  const { payload, isError } = await ownedCall(cmd, "git blame failed", ctx.run);
  if (isError) return { payload, isError: true };
  return { payload: { ...payload, repo, file, start, end }, isError: false };
}

export async function toolCiHistory(args: ToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const repo = confineRepo(args["repo"], ctx);
  if (repo === null) return repoError();
  const branch = args["branch"];
  if (!validReadBranch(branch)) {
    return {
      payload: { error: "invalid branch", expect: "branch name, no traversal" },
      isError: true,
    };
  }
  const limit = validPageLimit(args["limit"] ?? 20, 20);
  if (limit === null || limit < 1 || limit > LOG_LIMIT_MAX) {
    return {
      payload: { error: "invalid limit", expect: "integer 1..50" },
      isError: true,
    };
  }
  const cmd = [
    resolveGhBin(), "run", "list", "--branch", branch as string,
    "--limit", String(limit), "--json",
    "conclusion,headBranch,name,createdAt,url",
  ];
  const res = await ctx.run(cmd, { cwd: repo });
  if (!isRunResult(res)) {
    return { payload: res as Record<string, unknown>, isError: true };
  }
  if (res.exitCode !== 0) {
    const [errOut] = truncate(res.stderr ?? "");
    return {
      payload: { error: "gh run list failed", exit: res.exitCode, stderr: errOut },
      isError: true,
    };
  }
  let runs: unknown;
  try {
    runs = JSON.parse(res.stdout || "[]");
  } catch {
    return { payload: { error: "gh returned non-JSON", expect: "gh run list --json output" }, isError: true };
  }
  if (!Array.isArray(runs)) {
    return { payload: { error: "gh returned non-JSON", expect: "JSON array of runs" }, isError: true };
  }
  return {
    payload: { repo, branch, limit, runs: runs.slice(0, limit) },
    isError: false,
  };
}

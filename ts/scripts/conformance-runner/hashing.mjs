/**
 * Input hashing + cache-key computation. (slice 28 of the conformance-runner.mjs folder split, task-8pqjb).
 *
 * Moved verbatim from scripts/conformance-runner.mjs. Imported by
 * conformance-runner.mjs; CLI surface (`--runtime/--shard/--no-cache`) unchanged.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { CACHE_DIR, REPO_ROOT, TS_ROOT } from "./config.mjs";

export function hashFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath);
      return crypto.createHash("sha256").update(content).digest("hex");
    }
  } catch {
    /* ignore read errors */
  }
  return "missing";
}

export function hashDirectoryFiles(dirPath, extFilter = null) {
  const hashes = {};
  try {
    if (fs.existsSync(dirPath)) {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          if (!extFilter || extFilter.some((ext) => entry.name.endsWith(ext))) {
            const fullPath = path.join(dirPath, entry.name);
            hashes[entry.name] = hashFile(fullPath);
          }
        }
      }
    }
  } catch {
    /* ignore read errors */
  }
  return hashes;
}

export function getSubmodulePin() {
  try {
    const rev = execFileSync("git", ["rev-parse", "HEAD:sources/firstmate"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (rev && /^[0-9a-f]{40}$/.test(rev)) return rev;
  } catch {
    /* fallback below */
  }

  try {
    const baselinePath = path.join(REPO_ROOT, "drift", "baseline.json");
    if (fs.existsSync(baselinePath)) {
      const data = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
      if (data.firstmate_revision) return data.firstmate_revision;
    }
  } catch {
    /* ignore */
  }
  return "unknown-submodule-pin";
}

export function getRuntimeVersion(targetRuntime) {
  if (targetRuntime === "bun") {
    try {
      return execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
    } catch {
      return "bun-unknown";
    }
  } else {
    try {
      return execFileSync("node", ["--version"], { encoding: "utf8" }).trim();
    } catch {
      return process.version;
    }
  }
}

export function computeConformanceKey(targetRuntime, targetShard) {
  const submodulePin = getSubmodulePin();
  const contractsHashes = hashDirectoryFiles(path.join(REPO_ROOT, "schema"));
  const manifestHashes = hashDirectoryFiles(path.join(REPO_ROOT, "manifest"));
  const tsSrcHashes = hashDirectoryFiles(path.join(TS_ROOT, "src"), [".ts", ".js"]);

  const testFilesToHash = [path.join(TS_ROOT, "tests", "conformance-helpers.ts")];
  if (targetShard === "all" || targetShard === "read") {
    testFilesToHash.push(path.join(TS_ROOT, "tests", "conformance-read.test.ts"));
  }
  if (targetShard === "all" || targetShard === "remote") {
    testFilesToHash.push(path.join(TS_ROOT, "tests", "conformance-remote.test.ts"));
  }
  if (targetShard === "all" || targetShard === "system") {
    testFilesToHash.push(path.join(TS_ROOT, "tests", "conformance-system.test.ts"));
  }

  const tsTestHashes = {};
  for (const tf of testFilesToHash) {
    tsTestHashes[path.basename(tf)] = hashFile(tf);
  }

  const configsHashes = {
    "package.json": hashFile(path.join(TS_ROOT, "package.json")),
    "pnpm-lock.yaml": hashFile(path.join(TS_ROOT, "pnpm-lock.yaml")),
    "tsconfig.json": hashFile(path.join(TS_ROOT, "tsconfig.json")),
    "tsconfig.tests.json": hashFile(path.join(TS_ROOT, "tsconfig.tests.json")),
  };

  const runtimeVersion = getRuntimeVersion(targetRuntime);

  const manifest = {
    runtime: targetRuntime,
    runtimeVersion,
    shard: targetShard,
    submodulePin,
    contracts: contractsHashes,
    manifest: manifestHashes,
    tsSrc: tsSrcHashes,
    tsTests: tsTestHashes,
    configs: configsHashes,
  };

  const key = crypto
    .createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");

  return { key, manifest };
}

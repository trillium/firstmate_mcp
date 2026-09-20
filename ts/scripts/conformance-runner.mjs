#!/usr/bin/env node
/**
 * Conformance test runner with per-runtime input-hash caching and sharding.
 *
 * Implements the council-decided test optimization:
 * - Shards conformance across independent files (read, remote, system).
 * - Computes a deterministic cache key over:
 *     1. Submodule pin (sources/firstmate commit SHA)
 *     2. Contracts (schema/contracts.yaml and schema/*.schema.json)
 *     3. Manifest (manifest/FEATURES.yaml, manifest/COVERAGE.md)
 *     4. Lockfile & configs (pnpm-lock.yaml, package.json, tsconfigs)
 *     5. TS source files (ts/src/*.ts)
 *     6. Conformance test files (conformance-helpers.ts + shard tests)
 *     7. Runtime version (Bun or Node version string)
 * - Hash-skips when byte-identical inputs match a previously verified run.
 * - Supports --no-cache / NO_CACHE=1 to bypass caching.
 *
 * NOTE: Timing/envelope/kill/receipt/live-fleet proofs are NEVER cached.
 *
 * Usage:
 *   node scripts/conformance-runner.mjs [--runtime=node|bun] [--shard=read|remote|system|all] [--no-cache]
 *   bun scripts/conformance-runner.mjs [--runtime=bun] [--shard=read]
 */
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TS_ROOT, "..");
const CACHE_DIR = path.join(TS_ROOT, ".cache", "conformance");

const args = process.argv.slice(2);

function getArgValue(prefix) {
  for (const arg of args) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return null;
}

const requestedRuntime =
  getArgValue("--runtime=") ||
  (args.includes("--bun") ? "bun" : args.includes("--node") ? "node" : null);

const isRunningUnderBun = typeof process.versions.bun === "string";
const runtime = requestedRuntime || (isRunningUnderBun ? "bun" : "node");

const shard = getArgValue("--shard=") || "all";
const noCache =
  args.includes("--no-cache") ||
  Boolean(process.env.NO_CACHE) ||
  Boolean(process.env.CI_FORCE_RUN) ||
  Boolean(process.env.NIGHTLY_FULL_RUN);

const SHARDS = {
  read: ["testbuild/tests/conformance-read.test.js"],
  remote: ["testbuild/tests/conformance-remote.test.js"],
  system: ["testbuild/tests/conformance-system.test.js"],
  all: [
    "testbuild/tests/conformance-read.test.js",
    "testbuild/tests/conformance-remote.test.js",
    "testbuild/tests/conformance-system.test.js",
  ],
};

if (!SHARDS[shard]) {
  console.error(`Unknown shard '${shard}'. Valid shards: ${Object.keys(SHARDS).join(", ")}`);
  process.exit(1);
}

function hashFile(filePath) {
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

function hashDirectoryFiles(dirPath, extFilter = null) {
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

function getSubmodulePin() {
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

function getRuntimeVersion(targetRuntime) {
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

function computeConformanceKey(targetRuntime, targetShard) {
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

async function runTests(targetRuntime, testFiles) {
  return new Promise((resolve) => {
    let cmd;
    let cmdArgs;

    if (targetRuntime === "bun") {
      cmd = "bun";
      cmdArgs = ["test", "--timeout", "120000", ...testFiles];
    } else {
      cmd = "node";
      cmdArgs = ["--test", ...testFiles];
    }

    const proc = spawn(cmd, cmdArgs, {
      cwd: TS_ROOT,
      stdio: "inherit",
      env: process.env,
    });

    proc.on("close", (code) => {
      resolve(code === 0);
    });
  });
}

async function main() {
  const targetFiles = SHARDS[shard];

  for (const f of targetFiles) {
    const full = path.join(TS_ROOT, f);
    if (!fs.existsSync(full)) {
      console.error(`Test file not built: ${f}. Please run build:tests first.`);
      process.exit(1);
    }
  }

  const { key, manifest } = computeConformanceKey(runtime, shard);
  const cacheFile = path.join(CACHE_DIR, `${runtime}-${shard}-${key}.json`);

  if (!noCache && fs.existsSync(cacheFile)) {
    try {
      const cachedData = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (cachedData.status === "passed" && cachedData.key === key) {
        console.log(
          `[conformance-cache] HASH-SKIP: byte-identical inputs for ${runtime}/${shard} (key: ${key.slice(0, 16)}). Skipping test replay.`,
        );
        process.exit(0);
      }
    } catch {
      /* ignore cache read error, proceed to run */
    }
  }

  console.log(
    `[conformance-runner] Running conformance (${runtime}, shard: ${shard}, files: ${targetFiles.length})...`,
  );

  const passed = await runTests(runtime, targetFiles);

  if (passed) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(
        cacheFile,
        JSON.stringify(
          {
            key,
            runtime,
            runtimeVersion: manifest.runtimeVersion,
            shard,
            timestamp: new Date().toISOString(),
            status: "passed",
            submodulePin: manifest.submodulePin,
            files: targetFiles,
          },
          null,
          2,
        ),
        "utf8",
      );
      console.log(
        `\n[conformance-runner] ✅ Conformance passed for ${runtime}/${shard} (cached key: ${key.slice(0, 16)})`,
      );
    } catch (err) {
      console.warn(`[conformance-runner] Warning: failed to write cache:`, err);
    }
    process.exit(0);
  } else {
    console.error(`\n[conformance-runner] ❌ Conformance failed for ${runtime}/${shard}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Conformance runner with input hashing + cache skipping.
 *
 * Entry point only (slice 28, task-8pqjb): implementation lives in
 * ./conformance-runner/{config,hashing,execute}.mjs. CLI surface unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import {
  CACHE_DIR,
  REPO_ROOT,
  SHARDS,
  TS_ROOT,
  getArgValue,
  isRunningUnderBun,
  noCache,
  requestedRuntime,
  runtime,
  shard,
} from "./conformance-runner/config.mjs";
import {
  computeConformanceKey,
  getRuntimeVersion,
  getSubmodulePin,
  hashDirectoryFiles,
  hashFile,
} from "./conformance-runner/hashing.mjs";
import { runTests } from "./conformance-runner/execute.mjs";

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


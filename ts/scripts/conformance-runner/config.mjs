/**
 * Paths, CLI flags, shard table. (slice 28 of the conformance-runner.mjs folder split, task-8pqjb).
 *
 * Moved verbatim from scripts/conformance-runner.mjs. Imported by
 * conformance-runner.mjs; CLI surface (`--runtime/--shard/--no-cache`) unchanged.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TS_ROOT = path.resolve(HERE, "..", ".."); // scripts/conformance-runner/ -> ts/ (was scripts/ -> ts/ pre-split, slice 28)
export const REPO_ROOT = path.resolve(TS_ROOT, "..");
export const CACHE_DIR = path.join(TS_ROOT, ".cache", "conformance");

export const args = process.argv.slice(2);

export function getArgValue(prefix) {
  for (const arg of args) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return null;
}

export const requestedRuntime =
  getArgValue("--runtime=") ||
  (args.includes("--bun") ? "bun" : args.includes("--node") ? "node" : null);

export const isRunningUnderBun = typeof process.versions.bun === "string";
export const runtime = requestedRuntime || (isRunningUnderBun ? "bun" : "node");

export const shard = getArgValue("--shard=") || "all";
export const noCache =
  args.includes("--no-cache") ||
  Boolean(process.env.NO_CACHE) ||
  Boolean(process.env.CI_FORCE_RUN) ||
  Boolean(process.env.NIGHTLY_FULL_RUN);

export const SHARDS = {
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


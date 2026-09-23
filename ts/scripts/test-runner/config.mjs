/**
 * Paths, CLI flags, environment. (slice 27 of the test-runner.mjs folder split, task-8pqjb).
 *
 * Moved verbatim from scripts/test-runner.mjs. Imported by test-runner.mjs;
 * CLI surface (`--bun/--node/--all/--no-cache/--failed-only`) is unchanged.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TS_ROOT = path.resolve(HERE, "..", ".."); // scripts/test-runner/ -> ts/ (was scripts/ -> ts/ pre-split, slice 27)
export const CACHE_FILE = path.join(TS_ROOT, ".test-failures.json");
export const TEST_DIR = path.join(TS_ROOT, "testbuild", "tests");
export const CONTRACTS_FILE = path.join(TS_ROOT, "proof-cache", "contracts.json");
export const MANIFEST_FILE = path.join(TS_ROOT, "proof-cache", "manifest.json");

export const isCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS || process.env.CONTINUOUS_INTEGRATION);
export const args = process.argv.slice(2);
export const useBun = args.includes("--bun") || (process.versions.bun !== undefined && !args.includes("--node"));
export const forceAll = args.includes("--all");
export const noCache = args.includes("--no-cache") || args.includes("--no-proof-cache");
export const failedOnly = args.includes("--failed-only");

export const startTime = performance.now();

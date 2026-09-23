/**
 * Test-file enumeration + failure persistence. (slice 27 of the test-runner.mjs folder split, task-8pqjb).
 *
 * Moved verbatim from scripts/test-runner.mjs. Imported by test-runner.mjs;
 * CLI surface (`--bun/--node/--all/--no-cache/--failed-only`) is unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_FILE, TEST_DIR } from "./config.mjs";

export function getAllTestFiles() {
  if (!fs.existsSync(TEST_DIR)) return [];
  return fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join("testbuild", "tests", f))
    .sort();
}

export function loadFailedFiles() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (Array.isArray(data.failedFiles)) {
        return data.failedFiles.filter((f) => fs.existsSync(path.join(TS_ROOT, f)));
      }
    }
  } catch {
    /* ignore read error */
  }
  return [];
}

export function saveFailedFiles(failedFiles) {
  try {
    if (failedFiles.length === 0) {
      if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    } else {
      fs.writeFileSync(
        CACHE_FILE,
        JSON.stringify({ failedFiles, timestamp: new Date().toISOString() }, null, 2),
        "utf8",
      );
    }
  } catch {
    /* ignore write error */
  }
}

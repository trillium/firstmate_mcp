/**
 * Unit tests for test_run — the execution counterpart that test_run_list
 * deliberately excludes ("suite runs stay out").
 *
 * The tool wraps bin/fm-test-run.sh, so what matters is that it builds exactly
 * the argv the runner documents for one selection, refuses a malformed
 * selection instead of passing it through, and warns that a suite run can
 * exceed the 30s envelope before the caller discovers it as a bare timeout.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { TIER_AUTHORITY, TOOL_TIERS } from "../src/auth.js";
import { TOOLS, toolTestRun, type ToolContext } from "../src/tools.js";
import type { RunResult } from "../src/runner.js";
import { makeStubHome } from "./helpers.js";

type Seen = { argv: string[] };

function ctxRecording(seen: Seen): ToolContext {
  const home = makeStubHome();
  return {
    binDir: path.join(home, "bin"),
    stateDir: path.join(home, "state"),
    dataDir: path.join(home, "data"),
    run: async (argv): Promise<RunResult> => {
      seen.argv = argv;
      return { stdout: "suite output", stderr: "", exitCode: 0 };
    },
  };
}

const runner = (home: string): string => path.join(home, "bin", "fm-test-run.sh");

async function run(args: Record<string, unknown>): Promise<{ seen: Seen; res: Awaited<ReturnType<typeof toolTestRun>> }> {
  const seen: Seen = { argv: [] };
  const res = await toolTestRun(args, ctxRecording(seen));
  return { seen, res };
}

describe("test_run: selection argv", () => {
  it("is a tier 3 authority action, unlike its read-only siblings", () => {
    assert.equal(TOOL_TIERS["test_run"], TIER_AUTHORITY);
    assert.notEqual(TOOLS["test_run"], undefined);
  });

  it("builds --all", async () => {
    const { seen, res } = await run({ mode: "all" });
    assert.equal(res.isError, false);
    assert.deepEqual(seen.argv.slice(1), ["--all"]);
    assert.equal(seen.argv[0].endsWith("fm-test-run.sh"), true);
  });

  it("builds --family with its name", async () => {
    const { seen } = await run({ mode: "family", family: "mcp-adapter" });
    assert.deepEqual(seen.argv.slice(1), ["--family", "mcp-adapter"]);
  });

  it("builds --changed with and without --base", async () => {
    const bare = await run({ mode: "changed" });
    assert.deepEqual(bare.seen.argv.slice(1), ["--changed"]);
    const based = await run({ mode: "changed", base: "origin/main" });
    assert.deepEqual(based.seen.argv.slice(1), ["--changed", "--base", "origin/main"]);
  });

  it("builds --lane and --proven-isolated", async () => {
    const lane = await run({ mode: "lane", lane: "portable-serial-2of3" });
    assert.deepEqual(lane.seen.argv.slice(1), ["--lane", "portable-serial-2of3"]);
    const iso = await run({ mode: "proven-isolated" });
    assert.deepEqual(iso.seen.argv.slice(1), ["--proven-isolated"]);
  });

  it("builds explicit script paths", async () => {
    const { seen } = await run({ mode: "scripts", scripts: ["tests/a.test.sh", "tests/b.test.sh"] });
    assert.deepEqual(seen.argv.slice(1), ["tests/a.test.sh", "tests/b.test.sh"]);
  });

  it("composes --list with a selection and never executes the suite", async () => {
    const { seen, res } = await run({ mode: "all", list: true });
    assert.deepEqual(seen.argv.slice(1), ["--list", "--all"]);
    assert.equal(res.payload["list_only"], true);
    assert.equal(res.payload["long_running"], undefined, "inspection is not a long run");
  });

  it("supports the standalone coverage guard", async () => {
    const { seen, res } = await run({ mode: "all", check_coverage: true });
    assert.deepEqual(seen.argv.slice(1), ["--all", "--check-coverage"]);
    assert.equal(res.payload["long_running"], undefined);
  });

  it("warns that a suite run can exceed the envelope", async () => {
    const { res } = await run({ mode: "all" });
    assert.equal(res.payload["long_running"], true);
    assert.match(String(res.payload["hint"]), /receipt_submit/);
    assert.equal(res.payload["selection"], "--all");
  });
});

describe("test_run: refusals", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["an unknown mode", { mode: "everything" }, "invalid mode"],
    ["a family name with a slash", { mode: "family", family: "../etc" }, "invalid family"],
    ["a family mode with no family", { mode: "family" }, "invalid family"],
    ["an unknown lane", { mode: "lane", lane: "portable-parallel-9" }, "invalid lane"],
    ["a lane mode with no lane", { mode: "lane" }, "invalid lane"],
    ["a traversal base ref", { mode: "changed", base: "main..evil" }, "invalid base"],
    ["an absolute script path", { mode: "scripts", scripts: ["/etc/passwd"] }, "invalid scripts"],
    ["an empty script list", { mode: "scripts", scripts: [] }, "invalid scripts"],
    ["a non-boolean list flag", { mode: "all", list: "yes" }, "invalid list"],
  ];
  for (const [label, args, expected] of cases) {
    it(`refuses ${label} without running anything`, async () => {
      const { seen, res } = await run(args);
      assert.equal(res.isError, true, JSON.stringify(res.payload));
      assert.equal(res.payload["error"], expected);
      assert.deepEqual(seen.argv, [], "a refused selection must execute nothing");
    });
  }
});

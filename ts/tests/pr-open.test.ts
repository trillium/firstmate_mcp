/**
 * Unit tests for pr_open — the missing middle of the delivery chain.
 *
 * repo_commit and repo_push could publish a branch, but nothing could open the
 * pull request, so an agent had to shell out to gh outside the doorway. These
 * tests pin the shape that makes it safe to expose: a non-default source
 * branch, a non-empty single-line title, a body (never a bodyless PR), a
 * validated base, and no path to merging.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import {
  DEFAULT_PR_BASE,
  PR_BODY_MAX_BYTES,
  PR_TITLE_MAX_CHARS,
  resolveGhBin,
} from "../src/constants.js";
import { TOOL_TIERS, TIER_AUTHORITY } from "../src/auth.js";
import { TOOLS, toolPrOpen, type ToolContext } from "../src/tools.js";
import type { RunResult } from "../src/runner.js";
import { makeStubHome, removeHome } from "./helpers.js";

type Seen = { argv: string[] };

function ctxRecording(seen: Seen, result?: Partial<RunResult>): ToolContext {
  const home = makeStubHome();
  return {
    binDir: path.join(home, "bin"),
    stateDir: path.join(home, "state"),
    dataDir: path.join(home, "data"),
    run: async (argv) => {
      seen.argv = argv;
      return { stdout: "https://github.com/trillium/firstmate_mcp/pull/99", stderr: "", exitCode: 0, ...result };
    },
  };
}

const VALID = {
  title: "feat(orient): make orientation O(1)",
  body: "Why: orientation walked every task. What: read the published ledger.",
  head: "fm/orientation",
};

describe("pr_open: input guards", () => {
  it("is a tier 3 authority write", () => {
    assert.equal(TOOL_TIERS["pr_open"], TIER_AUTHORITY);
    assert.equal(TOOLS["pr_open"] !== undefined, true);
  });

  it("refuses a multi-line title", async () => {
    const res = await toolPrOpen(
      { ...VALID, title: "one line\nand another" },
      ctxRecording({ argv: [] }),
    );
    assert.equal(res.isError, true);
    assert.equal(res.payload["error"], "invalid title");
    assert.match(String(res.payload["expect"]), /single line/);
  });

  it("refuses an oversized or empty title", async () => {
    for (const title of ["", "x".repeat(PR_TITLE_MAX_CHARS + 1)]) {
      const res = await toolPrOpen({ ...VALID, title }, ctxRecording({ argv: [] }));
      assert.equal(res.isError, true, `title ${title.length} chars must be refused`);
      assert.equal(res.payload["error"], "invalid title");
    }
  });

  it("refuses a bodyless PR", async () => {
    const res = await toolPrOpen({ ...VALID, body: "" }, ctxRecording({ argv: [] }));
    assert.equal(res.isError, true);
    assert.equal(res.payload["error"], "invalid body");
  });

  it("refuses an oversized body", async () => {
    const res = await toolPrOpen(
      { ...VALID, body: "x".repeat(PR_BODY_MAX_BYTES + 1) },
      ctxRecording({ argv: [] }),
    );
    assert.equal(res.isError, true);
    assert.equal(res.payload["error"], "invalid body");
  });

  it("refuses the default branch as the source", async () => {
    for (const head of ["main", "master"]) {
      const res = await toolPrOpen({ ...VALID, head }, ctxRecording({ argv: [] }));
      assert.equal(res.isError, true, `head ${head} must be refused`);
      assert.equal(res.payload["error"], "invalid head");
    }
  });

  it("refuses a traversal-shaped head or base", async () => {
    const badHead = await toolPrOpen({ ...VALID, head: "../evil" }, ctxRecording({ argv: [] }));
    assert.equal(badHead.payload["error"], "invalid head");
    const badBase = await toolPrOpen({ ...VALID, base: "/etc" }, ctxRecording({ argv: [] }));
    assert.equal(badBase.payload["error"], "invalid base");
  });

  it("refuses a non-boolean draft", async () => {
    const res = await toolPrOpen({ ...VALID, draft: "yes" }, ctxRecording({ argv: [] }));
    assert.equal(res.isError, true);
    assert.equal(res.payload["error"], "invalid draft");
  });
});

describe("gh resolution", () => {
  it("honours an explicit FM_GH_BIN override", () => {
    assert.equal(resolveGhBin({ FM_GH_BIN: "/custom/gh" }), "/custom/gh");
    assert.equal(resolveGhBin({ FM_GH_BIN: "  /spaced/gh  " }), "/spaced/gh");
  });

  it("returns a real executable, never a bare name when one exists", () => {
    const resolved = resolveGhBin({});
    if (resolved !== "gh") {
      assert.equal(fs.existsSync(resolved), true, `${resolved} must exist`);
      assert.doesNotThrow(() => fs.accessSync(resolved, fs.constants.X_OK));
    }
  });

  it("resolves gh on this machine, where the served PATH would not", () => {
    // The whole point: the serving process has /usr/bin:/bin:/usr/sbin:/sbin.
    assert.notEqual(resolveGhBin({}), "gh", "expected a resolved path on this host");
  });
});

describe("pr_open: invocation", () => {
  it("builds gh pr create with the default base and returns the PR url", async () => {
    const seen: Seen = { argv: [] };
    const res = await toolPrOpen(VALID, ctxRecording(seen));
    assert.equal(res.isError, false, JSON.stringify(res.payload));
    assert.deepEqual(seen.argv, [
      resolveGhBin(),
      "pr",
      "create",
      "--title",
      VALID.title,
      "--body",
      VALID.body,
      "--head",
      VALID.head,
      "--base",
      DEFAULT_PR_BASE,
    ]);
    assert.match(String(res.payload["stdout"]), /pull\/99/);
  });

  it("honours an explicit base and a draft request", async () => {
    const seen: Seen = { argv: [] };
    const res = await toolPrOpen({ ...VALID, base: "release/1.x", draft: true }, ctxRecording(seen));
    assert.equal(res.isError, false);
    const baseAt = seen.argv.indexOf("--base");
    assert.equal(seen.argv[baseAt + 1], "release/1.x");
    assert.equal(seen.argv.includes("--draft"), true);
  });

  it("surfaces a gh failure instead of claiming success", async () => {
    const res = await toolPrOpen(
      VALID,
      ctxRecording({ argv: [] }, { stdout: "", stderr: "gh: not authenticated", exitCode: 1 }),
    );
    assert.equal(res.isError, true);
    assert.equal(res.payload["error"], "pr_open");
    assert.match(String(res.payload["stderr"]), /not authenticated/);
  });

  it("never passes a merge or force flag", async () => {
    const seen: Seen = { argv: [] };
    await toolPrOpen(VALID, ctxRecording(seen));
    for (const forbidden of ["merge", "--force", "-f", "--auto"]) {
      assert.equal(seen.argv.includes(forbidden), false, `argv must not carry ${forbidden}`);
    }
  });
});

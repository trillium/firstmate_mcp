/**
 * Tests for MCP resources.
 *
 * The doorway was tools-only; resources are the right shape for what a client
 * wants to watch rather than invoke. Two invariants matter more than the shapes:
 * every resource must be backed by an open read (MCP resource reads carry no
 * approval channel, so a gated surface must never appear here), and an unknown URI
 * must be refused rather than silently answered.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { TIER_OPEN, TIER_STEER, tierOf } from "../src/auth.js";
import { RESOURCES, readResource, resourceList, resourceBackingIsOpen } from "../src/resources.js";
import { TOOLS, type ToolContext } from "../src/tools.js";
import { makeStubHome, removeHome } from "./helpers.js";

let home: string;
let ctx: ToolContext;

before(() => {
  home = makeStubHome();
  ctx = {
    binDir: path.join(home, "bin"),
    stateDir: path.join(home, "state"),
    dataDir: path.join(home, "data"),
    run: async () => ({ stdout: "stub", stderr: "", exitCode: 0 }),
  };
});

after(() => {
  removeHome(home);
});

describe("resource catalogue", () => {
  it("lists every resource with uri, name, description and mime type", () => {
    const listed = resourceList();
    assert.equal(listed.length, RESOURCES.length);
    for (const item of listed) {
      assert.match(item.uri, /^firstmate:\/\//);
      assert.ok(item.name.length > 0, item.uri);
      assert.ok(item.description.length > 0, item.uri);
      assert.match(item.mimeType, /^(application\/json|text\/plain)$/);
    }
    const uris = listed.map((r) => r.uri);
    assert.equal(new Set(uris).size, uris.length, "resource uris must be unique");
  });

  it("only exposes ungated reads", () => {
    for (const def of RESOURCES) {
      assert.equal(
        resourceBackingIsOpen(def),
        true,
        `${def.uri} is backed by ${def.tool} (tier ${tierOf(def.tool)}); resources have no approval channel`,
      );
      const tier = tierOf(def.tool);
      assert.ok(tier === TIER_OPEN || tier === TIER_STEER, def.uri);
    }
  });

  it("backs every resource with a registered tool", () => {
    for (const def of RESOURCES) {
      assert.notEqual(TOOLS[def.tool], undefined, `${def.uri} -> ${def.tool} must exist`);
    }
  });
});

describe("resource reads", () => {
  it("reads the self-check report as JSON", async () => {
    const result = await readResource("firstmate://doctor", ctx);
    assert.ok(result !== null && "text" in result);
    if (result === null || !("text" in result)) return;
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    assert.equal(result.mimeType, "application/json");
    assert.ok(typeof parsed["status"] === "string");
  });

  it("reads the fleet view as text, not a JSON envelope", async () => {
    const result = await readResource("firstmate://fleet/view", ctx);
    assert.ok(result !== null && "text" in result);
    if (result === null || !("text" in result)) return;
    assert.equal(result.mimeType, "text/plain");
    assert.equal(result.text, "stub");
  });

  it("reads the ledger and the caches, reporting the reason when one is absent", async () => {
    for (const uri of ["firstmate://home-summary", "firstmate://fleet/snapshot", "firstmate://backlog", "firstmate://fleet/bearings"]) {
      const result = await readResource(uri, ctx);
      assert.ok(result !== null && "text" in result, uri);
      if (result === null || !("text" in result)) continue;
      // An unpublished ledger or an empty cache is content worth returning, not a
      // protocol error: the client needs to see the reason.
      assert.ok(result.text.length > 0, uri);
      JSON.parse(result.text);
    }
  });

  it("refuses an unknown uri and a non-string uri", async () => {
    assert.equal(await readResource("firstmate://nope", ctx), null);
    assert.equal(await readResource(42, ctx), null);
  });
});

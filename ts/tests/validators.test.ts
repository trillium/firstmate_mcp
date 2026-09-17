/**
 * Unit tests for src/validators.ts — pure input checks.
 * Contract referee: adapter/validators.py via tests/mcp-adapter.test.py.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  confineStatePath,
  validApproval,
  validId,
  validNote,
  validPeekLines,
  validProject,
  validSingleLine,
  validStatusLines,
  validSteerText,
} from "../src/validators.js";

const APPROVAL = "I authorize adapter test use";

describe("validId", () => {
  it("accepts short slugs", () => {
    assert.equal(validId("abc"), true);
    assert.equal(validId("task-1a2b.3:x_y-z"), true);
  });
  it("rejects traversal, slashes, empties, overlong", () => {
    assert.equal(validId("../escape"), false);
    assert.equal(validId("a/b"), false);
    assert.equal(validId(""), false);
    assert.equal(validId(null), false);
    assert.equal(validId("x".repeat(70)), false);
  });
  it("accepts the 64-char boundary", () => {
    assert.equal(validId("x".repeat(64)), true);
    assert.equal(validId("x".repeat(65)), false);
  });
});

describe("validProject", () => {
  it("accepts bare and projects/ names", () => {
    assert.equal(validProject("myproj"), true);
    assert.equal(validProject("projects/myproj"), true);
  });
  it("rejects absolute paths, traversal, empties", () => {
    assert.equal(validProject("/abs/path"), false);
    assert.equal(validProject("../up"), false);
    assert.equal(validProject("a..b"), false);
    assert.equal(validProject(""), false);
  });
});

describe("notes and approval", () => {
  it("accepts single-line notes within cap", () => {
    assert.equal(validNote("one line"), true);
    assert.equal(validNote("z".repeat(200), 200), true);
  });
  it("rejects multiline, empty, overlong", () => {
    assert.equal(validNote("two\nlines"), false);
    assert.equal(validNote(""), false);
    assert.equal(validNote("z".repeat(501)), false);
    assert.equal(validNote("z".repeat(201), 200), false);
  });
  it("validates the approval prefix", () => {
    assert.equal(validApproval(APPROVAL), true);
    assert.equal(validApproval("please do it"), false);
    assert.equal(validApproval(null), false);
  });
  it("validSingleLine enforces caps and no CR/LF", () => {
    assert.equal(validSingleLine("ok", 10), true);
    assert.equal(validSingleLine("a\r\nb", 10), false);
    assert.equal(validSingleLine("", 10), false);
  });
});

describe("validSteerText", () => {
  it("accepts plain prose", () => {
    assert.equal(validSteerText("hello crew"), true);
  });
  it("refuses slash commands, multiline, overlong, empty", () => {
    assert.equal(validSteerText("/merge now"), false);
    assert.equal(validSteerText("  /slash with pad"), false);
    assert.equal(validSteerText("one\ntwo"), false);
    assert.equal(validSteerText("z".repeat(501)), false);
    assert.equal(validSteerText(""), false);
  });
});

describe("validStatusLines", () => {
  it("passes integers through the 1..50 window", () => {
    assert.equal(validStatusLines(10), 10);
    assert.equal(validStatusLines(999), 50);
    assert.equal(validStatusLines(0), 1);
  });
  it("returns null for non-integers", () => {
    assert.equal(validStatusLines("many"), null);
    assert.equal(validStatusLines(null), null);
    assert.equal(validStatusLines(undefined), null);
  });
});

describe("validPeekLines", () => {
  it("passes integers through the 1..100 window", () => {
    assert.equal(validPeekLines(40), 40);
    assert.equal(validPeekLines(999), 100);
    assert.equal(validPeekLines(0), 1);
  });
  it("returns null for non-integers", () => {
    assert.equal(validPeekLines("many"), null);
    assert.equal(validPeekLines(null), null);
    assert.equal(validPeekLines(undefined), null);
  });
});

describe("confineStatePath", () => {
  it("confines ids under the state dir", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-ts-valid-"));
    const state = path.join(home, "state");
    fs.mkdirSync(state);
    const okPath = confineStatePath(state, "task-1");
    assert.equal(okPath, path.resolve(state, "task-1.status"));
    assert.equal(confineStatePath(state, "../escape"), null);
    assert.equal(confineStatePath(state, "a/b"), null);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

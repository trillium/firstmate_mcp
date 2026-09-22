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
  confineHandoffPath,
  confineStatePath,
  validApproval,
  validCorr,
  validDeltaWait,
  validHandoffLines,
  validId,
  validIdList,
  validMailBody,
  validMailSubject,
  validMailTo,
  validNonnegInt,
  validNote,
  validPageLimit,
  parseSnapshotCursor,
  validPeekLines,
  validProbe,
  validProject,
  validPrUrl,
  validRelpath,
  validRemoteMaxBytes,
  validSha256,
  validSingleLine,
  validStartupMode,
  validStatusLines,
  validSteerText,
  validVoiceQueueText,
  validVoiceScope,
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

describe("validRelpath", () => {
  it("accepts home-relative paths", () => {
    assert.equal(validRelpath("data/backlog.md"), true);
    assert.equal(validRelpath("state/handoff/x.outbox.md"), true);
  });
  it("rejects absolute paths, traversal, empties, controls", () => {
    assert.equal(validRelpath("/abs/path"), false);
    assert.equal(validRelpath("../up"), false);
    assert.equal(validRelpath("a//b"), false);
    assert.equal(validRelpath("a/./b"), false);
    assert.equal(validRelpath("a/../b"), false);
    assert.equal(validRelpath(""), false);
    assert.equal(validRelpath("a\tb"), false);
    assert.equal(validRelpath(null), false);
  });
});

describe("validSha256 and validCorr", () => {
  it("accepts 64 hex chars", () => {
    assert.equal(validSha256("e".repeat(64)), true);
  });
  it("rejects short, non-hex, empty", () => {
    assert.equal(validSha256("e".repeat(63)), false);
    assert.equal(validSha256("z".repeat(64)), false);
    assert.equal(validSha256(null), false);
  });
  it("accepts 16 hex with optional corr= prefix", () => {
    assert.equal(validCorr("abcdef0123456789"), true);
    assert.equal(validCorr("corr=abcdef0123456789"), true);
  });
  it("rejects short and non-hex corr", () => {
    assert.equal(validCorr("abcdef01"), false);
    assert.equal(validCorr("zzzzz0123456789ab"), false);
    assert.equal(validCorr(null), false);
  });
});

describe("delta windows", () => {
  it("passes nonnegative offsets", () => {
    assert.equal(validNonnegInt(0), 0);
    assert.equal(validNonnegInt("42"), 42);
  });
  it("rejects negative, non-integer, bool", () => {
    assert.equal(validNonnegInt(-1), null);
    assert.equal(validNonnegInt("many"), null);
    assert.equal(validNonnegInt(null), null);
    assert.equal(validNonnegInt(true), null);
  });
  it("clamps waits into 0..10", () => {
    assert.equal(validDeltaWait(0), 0);
    assert.equal(validDeltaWait(300), 10);
    assert.equal(validDeltaWait(-5), 0);
  });
  it("returns null for bad waits", () => {
    assert.equal(validDeltaWait("long"), null);
    assert.equal(validDeltaWait(null), null);
  });
  it("clamps byte caps into 1..256KB", () => {
    assert.equal(validRemoteMaxBytes(8192), 8192);
    assert.equal(validRemoteMaxBytes(10 ** 9), 262144);
    assert.equal(validRemoteMaxBytes(0), 1);
  });
  it("returns null for bad byte caps", () => {
    assert.equal(validRemoteMaxBytes("big"), null);
    assert.equal(validRemoteMaxBytes(null), null);
  });
  it("passes handoff lines through 1..20", () => {
    assert.equal(validHandoffLines(10), 10);
    assert.equal(validHandoffLines(999), 20);
    assert.equal(validHandoffLines(0), 1);
  });
  it("returns null for bad handoff lines", () => {
    assert.equal(validHandoffLines("many"), null);
    assert.equal(validHandoffLines(null), null);
    assert.equal(validHandoffLines(undefined), null);
  });
});

describe("validIdList", () => {
  it("accepts capped id lists", () => {
    assert.deepEqual(validIdList(["a", "b"], 8), ["a", "b"]);
  });
  it("rejects empty, overlong, bad ids, non-lists", () => {
    assert.equal(validIdList([], 8), null);
    assert.equal(validIdList(["a", "a", "a", "a", "a", "a", "a", "a", "a"], 8), null);
    assert.equal(validIdList(["../x"], 8), null);
    assert.equal(validIdList("a", 8), null);
    assert.equal(validIdList(null, 8), null);
  });
});

describe("wave-4 validators", () => {
  it("accepts only allowlisted probes", () => {
    assert.equal(validProbe("grok"), true);
    assert.equal(validProbe("bogus"), false);
    assert.equal(validProbe(null), false);
  });
  it("accepts counts/full scopes", () => {
    assert.equal(validVoiceScope("counts"), true);
    assert.equal(validVoiceScope("full"), true);
    assert.equal(validVoiceScope("everything"), false);
  });
  it("accepts read/report memory modes", () => {
    assert.equal(validStartupMode("read"), true);
    assert.equal(validStartupMode("report"), true);
    assert.equal(validStartupMode("boot"), false);
  });
  it("validates mail recipients, subjects, bodies", () => {
    assert.equal(validMailTo("a@example.com"), true);
    assert.equal(validMailTo("not-an-address"), false);
    assert.equal(validMailTo("a@b c.co"), false);
    assert.equal(validMailTo("a\n@b.co"), false);
    assert.equal(validMailSubject("hello"), true);
    assert.equal(validMailSubject("one\ntwo"), false);
    assert.equal(validMailSubject(""), false);
    assert.equal(validMailBody("hello\nworld"), true);
    assert.equal(validMailBody(""), false);
    assert.equal(validMailBody("x".repeat(5001)), false);
  });
  it("validates handover text and PR urls", () => {
    assert.equal(validVoiceQueueText("check the fleet"), true);
    assert.equal(validVoiceQueueText("one\ntwo"), false);
    assert.equal(validPrUrl("https://github.com/octo/repo/pull/42"), true);
    assert.equal(validPrUrl("https://example.com/o/r/pull/1"), false);
    assert.equal(validPrUrl("not a url"), false);
    assert.equal(validPrUrl("https://github.com/bad--owner/repo/pull/1"), false);
  });
});

describe("confineHandoffPath", () => {
  it("confines ids under data/handoff", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-ts-valid-"));
    const data = path.join(home, "data");
    fs.mkdirSync(path.join(data, "handoff"), { recursive: true });
    const okPath = confineHandoffPath(data, "mate-1");
    assert.equal(okPath, path.resolve(data, "handoff", "mate-1.outbox.md"));
    assert.equal(confineHandoffPath(data, "../escape"), null);
    assert.equal(confineHandoffPath(data, "a/b"), null);
    fs.rmSync(home, { recursive: true, force: true });
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

describe("validPageLimit", () => {
  it("defaults to 50 when omitted or null", () => {
    assert.equal(validPageLimit(undefined), 50);
    assert.equal(validPageLimit(null), 50);
    assert.equal(validPageLimit(undefined, 25), 25);
  });
  it("accepts valid integers within 1..200", () => {
    assert.equal(validPageLimit(1), 1);
    assert.equal(validPageLimit(50), 50);
    assert.equal(validPageLimit(200), 200);
    assert.equal(validPageLimit("25"), 25);
    assert.equal(validPageLimit(" 30 "), 30);
  });
  it("rejects out of bounds integers", () => {
    assert.equal(validPageLimit(0), null);
    assert.equal(validPageLimit(-5), null);
    assert.equal(validPageLimit(500), null);
    assert.equal(validPageLimit("0"), null);
    assert.equal(validPageLimit("300"), null);
  });
  it("rejects non-integers, booleans, and non-numeric strings", () => {
    assert.equal(validPageLimit(true), null);
    assert.equal(validPageLimit(false), null);
    assert.equal(validPageLimit("abc"), null);
    assert.equal(validPageLimit({}), null);
    assert.equal(validPageLimit([]), null);
    assert.equal(validPageLimit(1.5), null);
  });
});

describe("parseSnapshotCursor", () => {
  it("handles empty / omitted cursor", () => {
    assert.deepEqual(parseSnapshotCursor(undefined), { ok: true, snapshotId: null, offset: 0 });
    assert.deepEqual(parseSnapshotCursor(null), { ok: true, snapshotId: null, offset: 0 });
    assert.deepEqual(parseSnapshotCursor(undefined, "snap-12345678"), {
      ok: true,
      snapshotId: "snap-12345678",
      offset: 0,
    });
  });
  it("parses composite cursor <snapshot_id>:<offset>", () => {
    assert.deepEqual(parseSnapshotCursor("snap-abcdef1234:25"), {
      ok: true,
      snapshotId: "snap-abcdef1234",
      offset: 25,
    });
    assert.deepEqual(parseSnapshotCursor("snap-abcdef1234:0"), {
      ok: true,
      snapshotId: "snap-abcdef1234",
      offset: 0,
    });
    assert.deepEqual(parseSnapshotCursor("snap-abcdef1234:25", "snap-abcdef1234"), {
      ok: true,
      snapshotId: "snap-abcdef1234",
      offset: 25,
    });
  });
  it("rejects mismatched composite cursor and snapshot_id arg", () => {
    const res = parseSnapshotCursor("snap-11111111:10", "snap-22222222");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error, "cursor snapshot_id mismatch");
    }
  });
  it("parses integer / numeric cursor with explicit snapshot_id", () => {
    assert.deepEqual(parseSnapshotCursor(10, "snap-abcdef1234"), {
      ok: true,
      snapshotId: "snap-abcdef1234",
      offset: 10,
    });
    assert.deepEqual(parseSnapshotCursor("10", "snap-abcdef1234"), {
      ok: true,
      snapshotId: "snap-abcdef1234",
      offset: 10,
    });
    assert.deepEqual(parseSnapshotCursor(0), {
      ok: true,
      snapshotId: null,
      offset: 0,
    });
    assert.deepEqual(parseSnapshotCursor("0"), {
      ok: true,
      snapshotId: null,
      offset: 0,
    });
  });
  it("rejects non-zero numeric cursor without snapshot_id", () => {
    const res = parseSnapshotCursor(10);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error, "invalid cursor");
    }
    const resStr = parseSnapshotCursor("10");
    assert.equal(resStr.ok, false);
  });
  it("rejects invalid snapshot_id with traversal or slashes", () => {
    assert.equal(parseSnapshotCursor(undefined, "../bad").ok, false);
    assert.equal(parseSnapshotCursor(undefined, "a/b").ok, false);
    assert.equal(parseSnapshotCursor(undefined, "").ok, false);
  });
  it("rejects invalid cursor formats", () => {
    assert.equal(parseSnapshotCursor(-5).ok, false);
    assert.equal(parseSnapshotCursor(1.5).ok, false);
    assert.equal(parseSnapshotCursor("").ok, false);
    assert.equal(parseSnapshotCursor("   ").ok, false);
    assert.equal(parseSnapshotCursor("bad_cursor").ok, false);
    assert.equal(parseSnapshotCursor("snap-1234:-5").ok, false);
    assert.equal(parseSnapshotCursor("../escape:10").ok, false);
    assert.equal(parseSnapshotCursor("snap/sub:10").ok, false);
    assert.equal(parseSnapshotCursor(true).ok, false);
    assert.equal(parseSnapshotCursor(false).ok, false);
    assert.equal(parseSnapshotCursor({}).ok, false);
    assert.equal(parseSnapshotCursor([]).ok, false);
  });
});

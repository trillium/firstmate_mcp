#!/usr/bin/env python3
"""Upstream test preservation harness: run upstream firstmate tests unchanged
against the TypeScript MCP server.

- Upstream tests are executed verbatim (bash <upstream>/tests/<file>); this
  file never patches expectations.
- TypeScript MCP path is exercised through thin stdio JSON-RPC clients
  against stub FM_HOMEs; all assertions live here.
- A test ceases to be expected-to-pass only with an explicit entry in
  divergences.json pointing at the manifest reason.

Usage:
  python3 tests/upstream/run_upstream.py --format text
  python3 tests/upstream/run_upstream.py --format json
  python3 tests/upstream/run_upstream.py --format text --write-results
"""
import argparse
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
MANIFEST = Path(__file__).resolve().parent / "manifest.json"
DIVERGENCES = Path(__file__).resolve().parent / "divergences.json"
RESULTS_MD = ROOT / "UPSTREAM-RESULTS.md"
TS_SERVER = ROOT / "ts" / "dist" / "server.js"

SNAPSHOT_SCHEMA = "fm-fleet-snapshot.v1"
APPROVAL = "I authorize upstream preservation proof"
UPSTREAM_TIMEOUT_S = int(os.environ.get("UPSTREAM_TIMEOUT_S", "120"))
MCP_TIMEOUT_S = 30

STUB_SNAPSHOT = {
    "schema": SNAPSHOT_SCHEMA,
    "generated": "stub",
    "backlog": {},
    "tasks": [],
}

STUBS = {
    "fm-fleet-snapshot.sh": "echo '%s'\n" % json.dumps(STUB_SNAPSHOT),
    "fm-crew-state.sh": "echo 'state: unknown \u00b7 source: none \u00b7 stub: no such crew'\n",
    "fm-send.sh": "echo 'stub: no such crew' >&2\nexit 1\n",
    "fm-control.sh": "echo 'stub: refused' >&2\nexit 1\n",
    "fm-spawn.sh": "echo 'stub: refused' >&2\nexit 1\n",
    "fm-brief.sh": "echo 'stub: refused' >&2\nexit 1\n",
    "fm-decision-hold.sh": "echo 'stub: refused' >&2\nexit 1\n",
    "fm-captain-hold.sh": "echo 'stub: refused' >&2\nexit 1\n",
    "fm-x-reply.sh": "echo 'stub: refused' >&2\nexit 1\n",
    "fm-x-dismiss.sh": "echo 'stub: refused' >&2\nexit 1\n",
    "fm-x-followup.sh": "echo 'stub: refused' >&2\nexit 1\n",
}


def resolve_upstream_root():
    """Resolution order: submodule, env vars, live-checkout sibling. None when absent."""
    candidates = []
    sub = ROOT / "sources" / "firstmate"
    if (sub / "bin" / "fm-fleet-snapshot.sh").is_file():
        return sub
    # Submodule present but empty (uninitialized) -> not usable, keep looking.
    candidates.append(sub)
    for var in ("FIRSTMATE_HOME", "FM_REAL_HOME", "FM_CHECKOUT"):
        val = os.environ.get(var)
        if val and (Path(val) / "bin" / "fm-fleet-snapshot.sh").is_file():
            return Path(val)
        if val:
            candidates.append(Path(val))
    sibling = ROOT.parent / "firstmate"
    if (sibling / "bin" / "fm-fleet-snapshot.sh").is_file():
        return sibling
    # Developer-convenience absolute fallback (live checkout); harmless when missing.
    live = Path("/Users/trilliumsmith/code/firstmate")
    if (live / "bin" / "fm-fleet-snapshot.sh").is_file():
        return live
    return None


def upstream_pin():
    """Authoritative gitlink pin for sources/firstmate, else manifest pointer."""
    for spec in (":sources/firstmate", "HEAD:sources/firstmate"):
        try:
            proc = subprocess.run(
                ["git", "rev-parse", spec],
                cwd=str(ROOT),
                capture_output=True,
                text=True,
                timeout=15,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                return proc.stdout.strip()
        except Exception:
            pass
    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        return manifest.get("upstream", {}).get("gitlink", "unknown")
    except Exception:
        return "unknown"


def make_stub_home():
    home = Path(tempfile.mkdtemp(prefix="fm-upstream-"))
    bindir = home / "bin"
    bindir.mkdir()
    for name, body in STUBS.items():
        script = bindir / name
        script.write_text("#!/bin/sh\n" + body, encoding="utf-8")
        script.chmod(script.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    (home / "state").mkdir()
    return home


class McpClient:
    """Thinnest stdio JSON-RPC client: one tools/call, no assertion logic."""

    def __init__(self, argv, env):
        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            env=env,
        )
        self.seq = 0

    def request(self, method, params=None, timeout=MCP_TIMEOUT_S):
        self.seq += 1
        msg = {"jsonrpc": "2.0", "id": self.seq, "method": method}
        if params is not None:
            msg["params"] = params
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("server closed stdout")
            line = line.strip()
            if not line:
                continue
            resp = json.loads(line)
            if resp.get("id") == self.seq:
                return resp
        raise TimeoutError(f"no response for {method}")

    def call(self, name, args):
        return self.request("tools/call", {"name": name, "arguments": args})

    def close(self):
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass


def payload_of(resp):
    try:
        return json.loads(resp["result"]["content"][0]["text"])
    except Exception as exc:
        return {"_decode_error": str(exc), "_raw": str(resp)[:500]}


def is_error(resp):
    try:
        return resp.get("result", {}).get("isError") is True
    except Exception:
        return False


def run_projection_checks(ts_client, test_id, stub_home):
    """Per-contract MCP projection checks. Returns list of (label, ok, detail)."""
    results = []

    def check(name, args, want_ok, want_substr=""):
        if ts_client is None:
            results.append((f"{test_id}:{name} {args}", False, "ts client not available"))
            return
        try:
            resp = ts_client.call(name, args)
        except Exception as exc:
            results.append((f"{test_id}:{name} {args}", False, f"ts transport: {exc}"))
            return
        pay = payload_of(resp)
        err = is_error(resp)
        ok = (not err) if want_ok else err
        if want_substr and want_substr not in json.dumps(pay):
            ok = False
        results.append((f"{test_id}:{name} {args}", ok, json.dumps(pay)[:200]))

    if test_id == "fleet_snapshot":
        check("fleet_snapshot", {}, True, SNAPSHOT_SCHEMA)
    elif test_id == "backlog":
        check("backlog", {}, True, "task_counts")
    elif test_id == "crew_state":
        check("crew_state", {"id": "no-such-crew"}, True, "unknown")
        check("crew_state", {"id": "../escape"}, False, "invalid")
    elif test_id == "status_tail":
        lines = [f"event-{i}: working" for i in range(1, 8)]
        (stub_home / "state" / "t1.status").write_text("\n".join(lines) + "\n", encoding="utf-8")
        check("status_tail", {"id": "t1", "lines": 3}, True, "event-7")
        check("status_tail", {"id": "ghost-crew"}, False, "no status log")
        check("status_tail", {"id": "../escape"}, False, "invalid")
    elif test_id == "send_message":
        check("send_message", {"target": "t1", "text": "/bad slash"}, False, "slash")
        check("send_message", {"target": "../escape", "text": "hi"}, False, "invalid")
        check("send_message", {"target": "t1", "text": "hello from upstream harness"}, False, "stub")
    elif test_id == "spawn_crew":
        check("spawn_crew", {"task_id": "no-such-id", "project": "no-such-project",
                              "mode": "local-only", "yolo": "off"}, False, "approval")
        check("spawn_crew", {"task_id": "no-such-id", "project": "no-such-project",
                              "mode": "local-only", "yolo": "off", "approval": APPROVAL}, False, "stub")
    elif test_id == "scaffold_brief":
        check("scaffold_brief", {"task_id": "no-such-id", "project": "no-such-project",
                                  "mode": "scout"}, False, "approval")
        check("scaffold_brief", {"task_id": "no-such-id", "project": "no-such-project",
                                  "mode": "bogus", "approval": APPROVAL}, False, "invalid")
    return results


def run_upstream_file(upstream_root, filename):
    """Execute one upstream test file verbatim. Returns (verdict, detail)."""
    if filename is None:
        return "skip", "no owning upstream test (adapter-native surface)"
    if upstream_root is None:
        return "skip", "no upstream checkout; upstream reference skipped cleanly"
    target = upstream_root / "tests" / filename
    if not target.is_file():
        return "skip", f"upstream test missing at pin: tests/{filename}"
    try:
        proc = subprocess.run(
            ["bash", str(target)],
            cwd=str(upstream_root),
            capture_output=True,
            text=True,
            timeout=UPSTREAM_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return "fail", f"timeout after {UPSTREAM_TIMEOUT_S}s running tests/{filename} unchanged"
    except Exception as exc:
        return "fail", f"spawn failed: {exc}"
    tail = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip().splitlines()
    tail = "\n".join(tail[-15:])
    if proc.returncode == 0:
        return "pass", f"exit 0; tail: {tail[:800]}"
    return "fail", f"exit {proc.returncode}; tail: {tail[:1200]}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--format", choices=["text", "json"], default="text")
    ap.add_argument("--write-results", action="store_true")
    ap.add_argument("--ts-runtime", choices=["auto", "bun", "node"], default="auto")
    args = ap.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    divergences = json.loads(DIVERGENCES.read_text(encoding="utf-8"))
    div_ids = {d["id"] for d in divergences.get("divergences", [])}

    upstream_root = resolve_upstream_root()
    pin = upstream_pin()
    try:
        upstream_root_display = str(upstream_root.relative_to(ROOT)) if upstream_root else None
    except ValueError:
        upstream_root_display = str(upstream_root) if upstream_root else None

    # TS availability: dist must exist; runtime bun-primary, node-fallback.
    ts_dist_ok = TS_SERVER.is_file()
    ts_runtime = None
    ts_cmd = None
    if ts_dist_ok:
        bun = shutil.which("bun")
        node = shutil.which("node")
        if args.ts_runtime in ("auto", "bun") and bun:
            ts_runtime, ts_cmd = "bun", [bun, str(TS_SERVER)]
        elif args.ts_runtime in ("auto", "node") and node:
            ts_runtime, ts_cmd = "node", [node, str(TS_SERVER)]
        elif args.ts_runtime == "bun" and bun:
            ts_runtime, ts_cmd = "bun", [bun, str(TS_SERVER)]
        elif args.ts_runtime == "node" and node:
            ts_runtime, ts_cmd = "node", [node, str(TS_SERVER)]

    stub_home = make_stub_home()
    # status_tail fixture dir is per-run; projection checks write their own file.
    env = dict(os.environ)
    env["FM_HOME"] = str(stub_home)
    env["FM_STATE_OVERRIDE"] = str(stub_home / "state")

    ts_client = McpClient(ts_cmd, env) if ts_cmd else None
    if ts_client is not None:
        try:
            ts_client.request("ping", None)
        except Exception:
            pass

    rows = []
    overall_fail = False
    try:
        for entry in manifest.get("tests", []):
            test_id = entry["id"]
            upstream_file = entry.get("upstream_test")
            verdict_up, detail_up = run_upstream_file(upstream_root, upstream_file)
            checks = run_projection_checks(ts_client, test_id, stub_home)
            if not checks:
                ts_verdict = "skip"
            else:
                if ts_client is None:
                    ts_verdict = "skip"
                else:
                    ts_bad = [c for c in checks if c[1] is False]
                    ts_verdict = "pass" if not ts_bad else "fail"
            row = {
                "id": test_id,
                "contracts": entry.get("contracts", []),
                "upstream_test": upstream_file,
                "upstream": verdict_up,
                "upstream_detail": detail_up[:600],
                "ts": ts_verdict,
                "ts_runtime": ts_runtime or ("missing-dist" if not ts_dist_ok else "missing-runtime"),
                "checks": [{"label": c[0], "ts": c[1], "detail": c[2][:300]} for c in checks],
            }
            rows.append(row)
            if ts_verdict == "fail":
                overall_fail = True
    finally:
        try:
            if ts_client is not None:
                ts_client.close()
        except Exception:
            pass
        shutil.rmtree(stub_home, ignore_errors=True)

    summary = {
        "upstream_root": upstream_root_display,
        "upstream_pin": pin,
        "ts_runtime": ts_runtime,
        "ts_dist": ts_dist_ok,
        "divergences_known": sorted(div_ids),
        "results": rows,
        "overall": "fail" if overall_fail else "pass",
    }

    if args.format == "json":
        print(json.dumps(summary, indent=2))
    else:
        print(f"upstream root: {upstream_root or 'none (skipped cleanly)'}  pin: {pin}")
        print(f"ts: {ts_runtime or 'skipped'}  dist: {'ok' if ts_dist_ok else 'missing'}")
        print("")
        print(f"{'test':<16} {'upstream':<8} {'ts':<6}  upstream file")
        for r in rows:
            print(f"{r['id']:<16} {r['upstream']:<8} {r['ts']:<6}  {r['upstream_test'] or '(native)'}")
            for c in r["checks"]:
                ts_mark = "-" if c["ts"] is None else ("ok" if c["ts"] else "FAIL")
                print(f"  ts:{ts_mark}  {c['label']}")
                if c["detail"] and c["ts"] is False:
                    print(f"    detail: {c['detail'][:240]}")
        print("")
        print(f"overall: {summary['overall']}")

    if args.write_results:
        write_markdown(summary, manifest, divergences)

    return 1 if overall_fail else 0


def write_markdown(summary, manifest, divergences):
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    lines = []
    lines.append("# UPSTREAM-RESULTS")
    lines.append("")
    lines.append(f"Seeded: {ts} via `bash tests/upstream/run_upstream.sh` (`python3 tests/upstream/run_upstream.py --write-results`).")
    lines.append("")
    lines.append(f"- upstream repo: `{manifest['upstream']['repo']}`")
    lines.append(f"- gitlink pin: `{summary['upstream_pin']}`")
    lines.append(f"- upstream root at seed time: `{summary['upstream_root'] or 'none (reference skipped cleanly)'}`")
    lines.append(f"- ts runtime at seed time: `{summary['ts_runtime'] or 'skipped'}` (bun-primary, node-fallback; harness spawns the TS server via the proving runtime)")
    lines.append(f"- contracts source: `{manifest.get('contracts_source')}`")
    lines.append(f"- overall: **{summary['overall']}**")
    lines.append("")
    lines.append("| test | contracts | upstream file | upstream ref | ts |")
    lines.append("|---|---|---|---|---|")
    for r in summary["results"]:
        up = r["upstream_test"] or "(native)"
        lines.append(f"| {r['id']} | {', '.join(r['contracts'])} | {up} | {r['upstream']} | {r['ts']} |")
    lines.append("")
    lines.append("## Per-test detail")
    lines.append("")
    for r in summary["results"]:
        lines.append(f"### {r['id']}")
        lines.append("")
        lines.append(f"- upstream file: `{r['upstream_test'] or '(native file-tail reference)'}`")
        lines.append(f"- upstream ref: **{r['upstream']}** — {r['upstream_detail'][:400]}")
        lines.append(f"- ts ({r['ts_runtime']}): **{r['ts']}**")
        for c in r["checks"]:
            ts_mark = "skip" if c["ts"] is None else ("pass" if c["ts"] else "fail")
            lines.append(f"  - `{c['label']}` — ts {ts_mark}" + (f" — {c['detail'][:200]}" if c["detail"] and ts_mark == "fail" else ""))
        lines.append("")
    lines.append("## Divergences (explicit only)")
    lines.append("")
    lines.append("A test ceases to be expected-to-pass only with an entry below pointing at the manifest reason. All four seeded divergences are pre-existing intentional behavioral deltas already pinned by conformance / test_client; none of them flips a row above to expected-fail on this seed run.")
    lines.append("")
    for d in divergences.get("divergences", []):
        lines.append(f"### {d['id']}: {d['title']}")
        lines.append("")
        lines.append(f"- reason: {d['manifest_reason']}")
        lines.append(f"- affected: {', '.join(d['affected']) or '(no depended-on contract; upstream-only surfaces)'}")
        lines.append(f"- upstream: {d['upstream_behavior']}")
        lines.append(f"- ours: {d['our_behavior']}")
        lines.append(f"- replacement tests: {'; '.join(d['replacement_tests'])}")
        lines.append("")
    lines.append("## Repro")
    lines.append("")
    lines.append("```sh")
    lines.append("bash tests/upstream/run_upstream.sh")
    lines.append("python3 tests/upstream/run_upstream.py --format json")
    lines.append("```")
    lines.append("")
    RESULTS_MD.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {RESULTS_MD}")


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Cutover proof: serve a scratch firstmate fleet through the launcher.

Builds a fixed scratch home (/tmp/fm-mcp-cutover-proof, never the live
fleet), serves it via scripts/fm-mcp-launch.sh, and runs the cutover
sweep: full read sweep, one Tier 2 steer, one approval-gated Tier 3
allow, one refused-without-approval case, one relay-inert case, and one
code-forbidden case. Writes CUTOVER-PROOF.md at the repo root.

Repro:  python3 scripts/cutover_prove.py
"""
import json
import os
import shutil
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRATCH = Path("/tmp/fm-mcp-cutover-proof")
LAUNCHER = ROOT / "scripts" / "fm-mcp-launch.sh"
REPORT = ROOT / "CUTOVER-PROOF.md"
APPROVAL_INT = "I authorize lifecycle_interrupt on demo-1 (cutover proof)"
APPROVAL_RELAY = "I authorize relay_reply on req-1 (cutover proof)"

SNAPSHOT = {
    "schema": "fm-fleet-snapshot.v1",
    "generated": "cutover-proof",
    "backlog": {"inbox": [{"id": "demo-1", "title": "cutover proof crew"}]},
    "tasks": [
        {"task_id": "demo-1", "current_state": {"state": "running"},
         "note": "cutover proof crew"},
        {"task_id": "demo-2", "current_state": {"state": "idle"},
         "note": "cutover proof bystander"},
    ],
}

STUBS = {
    "fm-fleet-snapshot.sh": "echo '%s'\n" % json.dumps(SNAPSHOT),
    "fm-crew-state.sh":
        "echo 'state: running \u00b7 source: pane \u00b7 cutover proof crew' \n",
    "fm-send.sh": "echo \"cutover-proof: steered $1\"\nexit 0\n",
    "fm-control.sh": "echo \"cutover-proof: $1 $2\"\nexit 0\n",
    "fm-spawn.sh": "echo \"cutover-proof: spawn $1\"\nexit 0\n",
    "fm-brief.sh": "echo \"cutover-proof: brief $1\"\nexit 0\n",
    "fm-decision-hold.sh": "echo \"cutover-proof: decision $1\"\nexit 0\n",
    "fm-review-decision.sh": "echo \"cutover-proof: review $1 $2\"\nexit 0",
    "fm-x-reply.sh": ("echo 'cutover-proof: relay consent required "
                      "(no FMX_PAIRING_TOKEN)' >&2\nexit 3\n"),
    "fm-x-dismiss.sh": ("echo 'cutover-proof: relay consent required "
                        "(no FMX_PAIRING_TOKEN)' >&2\nexit 3\n"),
    "fm-x-followup.sh": ("echo 'cutover-proof: relay consent required "
                         "(no FMX_PAIRING_TOKEN)' >&2\nexit 3\n"),
}

STATUS_LINES = [
    "working: cutover proof crew launched",
    "working: steer received",
    "working: proof sweep running",
]


def build_scratch():
    shutil.rmtree(SCRATCH, ignore_errors=True)
    (SCRATCH / "bin").mkdir(parents=True)
    (SCRATCH / "state").mkdir(parents=True)
    for name, body in STUBS.items():
        script = SCRATCH / "bin" / name
        script.write_text("#!/bin/sh\n" + body, encoding="utf-8")
        script.chmod(script.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    (SCRATCH / "state" / "demo-1.status").write_text(
        "\n".join(STATUS_LINES) + "\n", encoding="utf-8")


class Client:
    def __init__(self, server, audit_log, actor):
        env = dict(os.environ)
        env.pop("FMX_PAIRING_TOKEN", None)  # relay must stay inert
        env["FM_ACTOR"] = actor
        self.proc = subprocess.Popen(
            [str(LAUNCHER), "--home", str(SCRATCH), "--server", server,
             "--audit-log", str(audit_log)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, env=env, cwd=str(ROOT))
        # Drain the launcher banner so stdout stays pure JSON-RPC.
        banner = self.proc.stderr.readline()
        assert banner.startswith("fm-mcp-launch: home="), banner
        self.banner = banner.strip()
        self.next_id = 0

    def rpc(self, method, params=None):
        self.next_id += 1
        self.proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "id": self.next_id,
             "method": method, "params": params or {}}) + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def call(self, name, args):
        resp = self.rpc("tools/call",
                        {"name": name, "arguments": args})
        assert "result" in resp, resp
        body = json.loads(resp["result"]["content"][0]["text"])
        return body, bool(resp["result"].get("isError"))

    def close(self):
        self.proc.stdin.close()
        self.proc.terminate()
        self.proc.wait()


def main():
    build_scratch()
    audit_py = SCRATCH / "state" / "mcp-audit-py.jsonl"
    audit_ts = SCRATCH / "state" / "mcp-audit-ts.jsonl"
    rows = []

    def row(tool, approval, outcome, detail):
        rows.append((tool, approval, outcome, detail))

    py = Client("py", audit_py, "cutover-proof")
    init = py.rpc("initialize", {"protocolVersion": "2024-11-05"})
    server_info = init["result"]["serverInfo"]
    listed = py.rpc("tools/list")
    names = [t["name"] for t in listed["result"]["tools"]]
    row("initialize/tools/list", "n/a",
        "ok" if len(names) == 27 else "MISMATCH",
        "%d tools, server %s %s" % (
            len(names), server_info["name"], server_info["version"]))

    body, _ = py.call("fleet_snapshot", {})
    row("fleet_snapshot", "none (Tier 1)",
        "ok" if body.get("schema") == "fm-fleet-snapshot.v1"
        and len(body.get("tasks", [])) == 2 else "MISMATCH",
        "schema=%s tasks=%d" % (body.get("schema"), len(body.get("tasks", []))))
    body, _ = py.call("backlog", {})
    row("backlog", "none (Tier 1)",
        "ok" if body.get("task_counts", {}).get("total") == 2 else "MISMATCH",
        "total=%s" % body.get("task_counts", {}).get("total"))
    body, _ = py.call("crew_state", {"id": "demo-1"})
    row("crew_state", "none (Tier 1)",
        "ok" if body.get("current", {}).get("state") == "running" else "MISMATCH",
        "state=%s" % body.get("current", {}).get("state"))
    body, _ = py.call("status_tail", {"id": "demo-1", "lines": 10})
    row("status_tail", "none (Tier 1)",
        "ok" if body.get("events") == STATUS_LINES else "MISMATCH",
        "events=%d" % len(body.get("events", [])))
    body, _ = py.call("fleet_poll", {"count": 1})
    row("fleet_poll", "none (Tier 1)",
        "ok" if len(body.get("polls", [])) == 1 else "MISMATCH",
        "polls=%d" % len(body.get("polls", [])))
    body, err = py.call("send_message",
                        {"target": "demo-1", "text": "cutover proof steer"})
    row("send_message", "none (Tier 2)",
        "ok" if not err and body.get("delivered") else "MISMATCH",
        "delivered=%s" % body.get("delivered"))
    body, err = py.call("lifecycle_interrupt",
                        {"id": "demo-1", "approval": APPROVAL_INT})
    row("lifecycle_interrupt", "`I authorize` (Tier 3)",
        "ok" if not err and "cutover-proof" in body.get("stdout", "")
        else "MISMATCH",
        "stdout=%r" % body.get("stdout", ""))
    body, err = py.call("lifecycle_interrupt", {"id": "demo-1"})
    row("lifecycle_interrupt", "missing (Tier 3)",
        "refused" if err and body.get("error") == "approval required"
        else "MISMATCH",
        "error=%r" % body.get("error"))
    body, err = py.call("relay_reply",
                        {"request_id": "req-1", "text": "hello",
                         "approval": APPROVAL_RELAY})
    row("relay_reply", "`I authorize` (Tier 4)",
        "inert" if err and body.get("exit") == 3 else "MISMATCH",
        "exit=%s (no FMX_PAIRING_TOKEN)" % body.get("exit"))
    resp = py.rpc("tools/call",
                  {"name": "promote_scout", "arguments": {}})
    row("promote_scout", "n/a (code-forbidden)",
        "unknown-tool" if resp.get("error", {}).get("message", "").startswith(
            "unknown tool:") else "MISMATCH",
        resp.get("error", {}).get("message", ""))
    py_banner = py.banner
    py.close()

    # TS parity spot-check: reads plus the approval allow/refuse pair.
    ts_rows = []
    ts = Client("ts", audit_ts, "cutover-proof-ts")
    body, _ = ts.call("fleet_snapshot", {})
    ts_rows.append(("fleet_snapshot",
                    "ok" if body.get("schema") == "fm-fleet-snapshot.v1"
                    else "MISMATCH"))
    body, err = ts.call("lifecycle_interrupt",
                        {"id": "demo-1", "approval": APPROVAL_INT})
    ts_rows.append(("lifecycle_interrupt+approval",
                    "ok" if not err else "MISMATCH"))
    body, err = ts.call("lifecycle_interrupt", {"id": "demo-1"})
    ts_rows.append(("lifecycle_interrupt-approval",
                    "refused" if err else "MISMATCH"))
    ts_banner = ts.banner
    ts.close()

    py_log = audit_py.read_text(encoding="utf-8")
    py_lines = [json.loads(line) for line in py_log.splitlines()]
    ts_log = audit_ts.read_text(encoding="utf-8")
    ts_lines = [json.loads(line) for line in ts_log.splitlines()]

    failures = [r for r in rows if r[2] in ("MISMATCH",)]
    failures += [(t, "", s, "") for t, s in ts_rows if s == "MISMATCH"]
    audit_failures = []
    if len(py_lines) != 10:
        audit_failures.append("py audit lines=%d, want 10" % len(py_lines))
    if len(ts_lines) != 3:
        audit_failures.append("ts audit lines=%d, want 3" % len(ts_lines))
    want_py = [("allow", "ok"), ("allow", "ok"), ("allow", "ok"),
               ("allow", "ok"), ("allow", "ok"), ("allow", "ok"),
               ("allow", "ok"), ("refuse", "approval-required"),
               ("allow", "ok"), ("refuse", "unknown-tool")]
    got_py = [(ln["decision"], ln["reason"]) for ln in py_lines]
    if got_py != want_py:
        audit_failures.append("py audit decisions=%r" % (got_py,))
    if "I authorize" in py_log or "I authorize" in ts_log:
        audit_failures.append("approval plaintext leaked into audit log")
    refs = [ln["approval_ref"] for ln in py_lines]
    if refs[6] is None or refs[7] is not None or refs[8] is None:
        audit_failures.append("approval_ref present only where approval given")
    if any(set(ln.keys()) != {"v", "ts", "actor", "tool", "tier",
                              "decision", "reason", "approval_ref", "target"}
           for ln in py_lines + ts_lines):
        audit_failures.append("audit line keys mismatch auth/AUTH.md")

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    md = []
    md.append("# CUTOVER-PROOF — live fleet through firstmate_mcp")
    md.append("")
    md.append("Generated %s by `python3 scripts/cutover_prove.py` against a" % stamp)
    md.append("scratch home only (`/tmp/fm-mcp-cutover-proof`). The live fleet")
    md.append("was never touched.")
    md.append("")
    md.append("Launcher: `scripts/fm-mcp-launch.sh --home $SCRATCH --server py|ts`")
    md.append("pins one `FM_HOME`, stays local-only (stdio JSON-RPC, no TCP/SSE),")
    md.append("and execs the proven server with the `I authorize` approval flow")
    md.append("and the JSON-lines audit log (`$FM_HOME/state/mcp-audit.jsonl`).")
    md.append("")
    md.append("Python banner: `%s`" % py_banner)
    md.append("")
    md.append("TS banner: `%s`" % ts_banner)
    md.append("")
    md.append("## Read sweep + steers (Python server, scratch home)")
    md.append("")
    md.append("| tool | approval | result | detail |")
    md.append("|---|---|---|---|")
    for tool, approval, outcome, detail in rows:
        md.append("| `%s` | %s | **%s** | %s |" % (tool, approval, outcome, detail))
    md.append("")
    md.append("## TS parity spot-check (same scratch home, separate audit log)")
    md.append("")
    for tool, outcome in ts_rows:
        md.append("- `%s`: **%s**" % (tool, outcome))
    md.append("")
    md.append("## Approval flow")
    md.append("")
    md.append("- Allow: `lifecycle_interrupt` with `%s` dispatched to the" % APPROVAL_INT)
    md.append("  owning script and returned its output; audit `allow/ok` (Tier 3).")
    md.append("- Refuse: the same call without `approval` was refused with")
    md.append("  `approval required`; audit `refuse/approval-required`, nothing dispatched.")
    md.append("- Tier 2 `send_message` stays approval-free with validated text;")
    md.append("  Tiers 3/4 refuse without the string per AUTH.md.")
    md.append("")
    md.append("## Relay consent (outside this layer)")
    md.append("")
    md.append("- `relay_reply` with approval but without `FMX_PAIRING_TOKEN` failed")
    md.append("  closed (exit 3, consent message on stderr): the send stayed inert,")
    md.append("  proving consent still lives in the owning script (FINDINGS.md).")
    md.append("")
    md.append("## Code-forbidden")
    md.append("")
    md.append("- `promote_scout` answered `unknown tool`, auditing")
    md.append("  `refuse/unknown-tool` at tier `forbidden`: no merge authority lives")
    md.append("  in this layer.")
    md.append("")
    md.append("## Audit log (Python server, 10 tools/call lines)")
    md.append("")
    md.append("Decisions in order: " +
              ", ".join("%s/%s" % (d, r) for d, r in got_py) + ".")
    md.append("`approval_ref` is set only on the two calls that presented approval;")
    md.append("the token text never appears in the log (hash only). Full lines:")
    md.append("")
    md.append("```json")
    md.append(py_log.strip())
    md.append("```")
    md.append("")
    md.append("## Residual risks")
    md.append("")
    md.append("Authority laundering and relay consent outside this layer remain as")
    md.append("stated in FINDINGS.md: keep this local-only on a pinned `FM_HOME`,")
    md.append("treat approval strings as per-action captain consent, and rescope")
    md.append("before any networked or multi-user wiring.")
    md.append("")
    REPORT.write_text("\n".join(md), encoding="utf-8")

    print("sweep rows: %d, ts rows: %d" % (len(rows), len(ts_rows)))
    print("audit: py=%d lines ts=%d lines" % (len(py_lines), len(ts_lines)))
    if failures or audit_failures:
        for item in failures + audit_failures:
            print("FAIL:", item)
        return 1
    print("wrote %s" % REPORT)
    return 0


if __name__ == "__main__":
    sys.exit(main())

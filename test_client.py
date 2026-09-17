#!/usr/bin/env python3
"""External MCP client proof for the First Mate smarts-only server (stdlib only).

Self-contained: every check runs against a stub firstmate home (stub bin/
scripts plus an empty state dir) built in a temp dir and pinned via FM_HOME,
so this repo stays standalone with no firstmate checkout required. The stubs
emulate the owning-script CLI contracts (snapshot schema, crew-state line,
fail-closed non-zero exits); the server validation under test is unchanged.
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SERVER = Path(__file__).resolve().parent / "fm_mcp_server.py"
CHECKS = []
APPROVAL = "I authorize smarts-only PoC use"

SNAPSHOT = {
    "schema": "fm-fleet-snapshot.v1",
    "generated": "stub",
    "backlog": {},
    "tasks": [],
}

BEARINGS = {
    "schema": "fm-bearings.v1",
    "generated": "stub",
    "in_flight": [],
    "decisions_open": [],
    "landed": [],
    "omitted": [],
}

STUBS = {
    "fm-fleet-snapshot.sh": "echo '%s'\n" % json.dumps(SNAPSHOT),
    "fm-crew-state.sh": "echo 'state: unknown \\u00b7 source: none \\u00b7 stub: no such crew'\n",
    "fm-send.sh": "echo 'stub: no such crew' >&2\nexit 1\n",
    "fm-control.sh": "echo 'stub: refused' >&2\nexit 1\n",
    "fm-spawn.sh": "echo 'stub: refused' >&2\nexit 1\n",
    "fm-brief.sh": "echo 'stub: refused' >&2\nexit 1\n",
    "fm-decision-hold.sh": "echo 'stub: refused' >&2\nexit 1\n",
    "fm-review-decision.sh": "echo 'stub: refused' >&2\nexit 1\n",
    "fm-x-reply.sh": "echo 'stub: refused' >&2\nexit 1\n",
    "fm-x-dismiss.sh": "echo 'stub: refused' >&2\nexit 1\n",
    "fm-x-followup.sh": "echo 'stub: refused' >&2\nexit 1\n",
    "fm-peek.sh": "echo \"peek-stub:$1 lines=$2\"\n",
    "fm-fleet-view.sh": "echo '# Fleet View stub'\n",
    "fm-review-diff.sh": "echo \"diff-stub:$1 stat=$2\"\n",
    "fm-bearings-snapshot.sh": "echo '%s'\n" % json.dumps(BEARINGS),
    "fm-wake-drain.sh": "echo 'wake-drain stub: empty'\n",
    "fm-guard.sh": "exit 0\n",
}


def make_stub_home():
    home = Path(tempfile.mkdtemp(prefix="fm-mcp-stub-"))
    bindir = home / "bin"
    bindir.mkdir()
    for name, body in STUBS.items():
        script = bindir / name
        script.write_text("#!/bin/sh\n" + body, encoding="utf-8")
        script.chmod(script.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    (home / "state").mkdir()
    return str(home)


# Emulates the real fleet-snapshot envelope: the first call takes >30s (past the
# fail-closed server budget) and every call emits >128KB (past the old output
# ceiling) of valid snapshot JSON. A marker file short-circuits the sleep after
# the first call so the suite proves the fail-closed timeout without paying 30s
# per tool call. Uses /bin/sleep absolutely: bare `sleep` may be a guard shim.
SLOW_LARGE_SNAPSHOT = '''if [ ! -e "$FM_HOME/.envelope-slow-shown" ]; then
  : > "$FM_HOME/.envelope-slow-shown"
  /bin/sleep 32
fi
python3 - <<'PY'
import json
tasks = []
for i in range(800):
    tasks.append({
        "task_id": "task-%04d" % i,
        "current_state": {"state": "running"},
        "note": "envelope-fixture-" + ("x" * 380),
    })
print(json.dumps({
    "schema": "fm-fleet-snapshot.v1",
    "generated": "envelope-slow-large",
    "backlog": {},
    "tasks": tasks,
}))
PY
'''


def make_stub_home_with_snapshot(prefix, snapshot_body):
    home = Path(tempfile.mkdtemp(prefix=prefix))
    bindir = home / "bin"
    bindir.mkdir()
    for name, body in STUBS.items():
        script = bindir / name
        script.write_text("#!/bin/sh\n" + body, encoding="utf-8")
        script.chmod(script.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    snapshot = bindir / "fm-fleet-snapshot.sh"
    snapshot.write_text("#!/bin/sh\n" + snapshot_body, encoding="utf-8")
    snapshot.chmod(snapshot.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    (home / "state").mkdir()
    return str(home)


def make_envelope_stub_home():
    return make_stub_home_with_snapshot("fm-mcp-envelope-", SLOW_LARGE_SNAPSHOT)


# Slow snapshot that also spawns a grandchild outliving the 30s budget: if the
# server kills only the shell instead of the whole process group, the orphan
# touches the marker after the timeout and the kill proof fails.
ORPHAN_LARGE_SNAPSHOT = '''rm -f "$FM_HOME/orphan-marker"
( /bin/sleep 34; touch "$FM_HOME/orphan-marker" ) >/dev/null 2>&1 &
''' + SLOW_LARGE_SNAPSHOT


def make_orphan_stub_home():
    return make_stub_home_with_snapshot("fm-mcp-orphan-", ORPHAN_LARGE_SNAPSHOT)


def make_receipt_stub_home():
    return make_stub_home_with_snapshot("fm-mcp-receipt-", SLOW_LARGE_SNAPSHOT)


def check(name, cond, detail=""):
    CHECKS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f" :: {detail}" if detail and not cond else ""))


class Client:
    def __init__(self, env=None):
        merged = dict(os.environ)
        if env:
            merged.update(env)
        self.proc = subprocess.Popen(
            [sys.executable, str(SERVER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            env=merged,
        )
        self.seq = 0

    def request(self, method, params=None):
        self.seq += 1
        msg = {"jsonrpc": "2.0", "id": self.seq, "method": method}
        if params is not None:
            msg["params"] = params
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def notify(self, method):
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method}) + "\n")
        self.proc.stdin.flush()

    def call(self, name, args):
        return self.request("tools/call", {"name": name, "arguments": args})

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=10)


def payload(resp):
    return json.loads(resp["result"]["content"][0]["text"])


def is_error(resp):
    return resp["result"].get("isError") is True


def main():
    client = Client(env={"FM_HOME": make_stub_home()})
    try:
        resp = client.request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "poc-test-client", "version": "0.1.0"},
        })
        check("handshake negotiates version", resp["result"]["protocolVersion"] == "2024-11-05")
        check("server identifies itself", resp["result"]["serverInfo"]["name"] == "firstmate-mcp-poc")
        client.notify("notifications/initialized")

        resp = client.request("tools/list")
        names = {t["name"] for t in resp["result"]["tools"]}
        check("tools list keeps the 5 PoC tools", {
            "fleet_snapshot", "backlog", "crew_state", "status_tail", "send_message",
        } <= names, sorted(names))
        check("tools carry input schemas", all("inputSchema" in t for t in resp["result"]["tools"]))

        resp = client.call("fleet_snapshot", {})
        snap = payload(resp)
        check("fleet_snapshot returns canonical schema", snap.get("schema") == "fm-fleet-snapshot.v1", str(snap)[:200])
        check("fleet_snapshot has backlog plus tasks", "backlog" in snap and "tasks" in snap)

        resp = client.call("backlog", {})
        back = payload(resp)
        check("backlog returns records plus counts", "backlog" in back and "task_counts" in back)

        resp = client.call("crew_state", {"id": "no-such-id"})
        state = payload(resp)
        check("crew_state answers unknown for missing id", state["current"]["state"] == "unknown", str(state)[:200])

        resp = client.call("crew_state", {"id": "../escape"})
        check("crew_state rejects traversal", resp["result"].get("isError") is True)

        resp = client.call("status_tail", {"id": "no-such-id", "lines": 5})
        check("status_tail missing id is structured error", resp["result"].get("isError") is True)
        resp = client.call("status_tail", {"id": "x/../../y"})
        check("status_tail rejects traversal", resp["result"].get("isError") is True)

        resp = client.call("send_message", {"target": "no-such-id", "text": "hello"})
        check("send_message fail-closed stays structured", resp["result"].get("isError") is True)
        resp = client.call("send_message", {"target": "x", "text": "/merge now"})
        check("send_message refuses slash", "slash" in payload(resp).get("error", ""))
        resp = client.call("send_message", {"target": "x", "text": "one\ntwo"})
        check("send_message refuses multiline", resp["result"].get("isError") is True)
        resp = client.call("send_message", {"target": "x", "text": "z" * 501})
        check("send_message enforces length cap", resp["result"].get("isError") is True)

        resp = client.call("nope", {})
        check("unknown tool is JSON-RPC error", "error" in resp and resp["error"]["code"] == -32602)

        resp = client.request("ping")
        check("ping answers", resp["result"] == {})
    finally:
        client.close()

    sandbox = make_stub_home()
    boxed = Client(env={"FM_HOME": sandbox})
    try:
        boxed.notify("notifications/initialized")
        resp = boxed.request("tools/list")
        names = {t["name"] for t in resp["result"]["tools"]}
        check("smarts server lists 27 tools", len(names) == 27, sorted(names))
        for required in ("lifecycle_interrupt", "lifecycle_exit", "lifecycle_relaunch",
                         "lifecycle_suspend", "lifecycle_resume", "spawn_crew", "scaffold_brief",
                         "decision_hold", "decision_resolve", "review_decision", "relay_reply",
                         "relay_dismiss", "relay_followup", "fleet_poll",
                         "peek", "fleet_view", "review_diff",
                         "bearings_snapshot", "wake_drain", "guard_check",
                         "receipt_submit", "receipt_status"):
            check(f"tool present: {required}", required in names)
        for forbidden in ("promote_scout", "teardown_crew", "arm_pr_check",
                          "merge_pr", "merge_local"):
            check(f"code-forbidden absent: {forbidden}", forbidden not in names)
        for forbidden in ("promote_scout", "teardown_crew", "arm_pr_check",
                          "merge_pr", "merge_local"):
            fresp = boxed.call(forbidden, {})
            check(f"code-forbidden refused: {forbidden}",
                  "error" in fresp and fresp["error"]["code"] == -32602, str(fresp)[:200])
        check("every authority tool schema requires approval", all(
            "approval" in (t.get("inputSchema", {}).get("required", []) or [])
            for t in resp["result"]["tools"]
            if t["name"] not in ("fleet_snapshot", "backlog", "crew_state", "status_tail", "send_message", "fleet_poll",
                                "peek", "fleet_view", "review_diff", "bearings_snapshot", "wake_drain", "guard_check",
                                "receipt_submit", "receipt_status")
        ))

        resp = boxed.call("lifecycle_interrupt", {"id": "no-such-id"})
        check("interrupt refuses without approval", is_error(resp) and "approval" in payload(resp).get("error", ""))
        resp = boxed.call("lifecycle_interrupt", {"id": "../escape", "approval": APPROVAL})
        check("interrupt rejects traversal", is_error(resp))
        resp = boxed.call("lifecycle_interrupt", {"id": "no-such-id", "approval": APPROVAL})
        check("interrupt unknown id stays structured", is_error(resp))

        resp = boxed.call("lifecycle_exit", {"id": "no-such-id"})
        check("exit refuses without approval", is_error(resp) and "approval" in payload(resp).get("error", ""))
        resp = boxed.call("lifecycle_exit", {"id": "no-such-id", "approval": APPROVAL})
        check("exit unknown id stays structured", is_error(resp))

        resp = boxed.call("lifecycle_relaunch", {"id": "no-such-id", "note": "retry", "approval": APPROVAL})
        check("relaunch unknown id stays structured", is_error(resp))
        resp = boxed.call("lifecycle_relaunch", {"id": "no-such-id", "approval": APPROVAL})
        check("relaunch requires note", is_error(resp))

        resp = boxed.call("lifecycle_suspend", {"id": "no-such-id", "note": "park", "approval": APPROVAL})
        check("suspend unknown id stays structured", is_error(resp))
        resp = boxed.call("lifecycle_resume", {"id": "no-such-id", "note": "back", "approval": APPROVAL})
        check("resume unknown id stays structured", is_error(resp))

        resp = boxed.call("spawn_crew", {"task_id": "no-such-id", "project": "no-such-project",
                                         "mode": "local-only", "yolo": "off"})
        check("spawn refuses without approval", is_error(resp) and "approval" in payload(resp).get("error", ""))
        resp = boxed.call("spawn_crew", {"task_id": "../x", "project": "p",
                                         "mode": "local-only", "yolo": "off", "approval": APPROVAL})
        check("spawn rejects traversal id", is_error(resp))
        resp = boxed.call("spawn_crew", {"task_id": "no-such-id", "project": "/abs/path",
                                         "mode": "local-only", "yolo": "off", "approval": APPROVAL})
        check("spawn rejects absolute project", is_error(resp))
        resp = boxed.call("spawn_crew", {"task_id": "no-such-id", "project": "no-such-project",
                                         "mode": "local-only", "yolo": "off", "approval": APPROVAL})
        check("spawn unknown target stays structured", is_error(resp))

        resp = boxed.call("scaffold_brief", {"task_id": "no-such-id", "project": "no-such-project", "mode": "scout"})
        check("brief refuses without approval", is_error(resp) and "approval" in payload(resp).get("error", ""))
        resp = boxed.call("scaffold_brief", {"task_id": "no-such-id", "project": "no-such-project",
                                             "mode": "bogus", "approval": APPROVAL})
        check("brief rejects bad mode", is_error(resp))

        resp = boxed.call("decision_hold", {"origin_id": "no-such-id", "decision_key": "k1",
                                            "title": "t", "reason": "r"})
        check("decision hold refuses without approval", is_error(resp) and "approval" in payload(resp).get("error", ""))
        resp = boxed.call("decision_resolve", {"origin_id": "x", "decision_key": "k",
                                               "routed_to": "y", "decision_text": "d"})
        check("decision resolve refuses without approval", is_error(resp) and "approval" in payload(resp).get("error", ""))

        resp = boxed.call("review_decision", {"id": "no-such-id", "verdict": "approve"})
        check("review refuses without approval", is_error(resp) and "approval" in payload(resp).get("error", ""))
        resp = boxed.call("review_decision", {"id": "no-such-id", "verdict": "bogus", "approval": APPROVAL})
        check("review rejects bad verdict", is_error(resp))

        resp = boxed.call("relay_reply", {"request_id": "no-such-id", "text": "hello"})
        check("relay reply refuses without approval", is_error(resp) and "approval" in payload(resp).get("error", ""))
        resp = boxed.call("relay_reply", {"request_id": "../x", "text": "hello", "approval": APPROVAL})
        check("relay reply rejects traversal", is_error(resp))
        resp = boxed.call("relay_dismiss", {"request_id": "no-such-id"})
        check("relay dismiss refuses without approval", is_error(resp) and "approval" in payload(resp).get("error", ""))
        resp = boxed.call("relay_followup", {"task_id": "no-such-id", "text": "done"})
        check("relay followup refuses without approval", is_error(resp) and "approval" in payload(resp).get("error", ""))

        resp = boxed.call("fleet_poll", {"count": 2, "interval_s": 0})
        polled = payload(resp)
        check("fleet_poll returns poll summaries", not is_error(resp) and len(polled.get("polls", [])) == 2)

        resp = boxed.call("peek", {"target": "no-such-id"})
        peeked = payload(resp)
        check("peek returns bounded tail with target echoed",
              not is_error(resp) and peeked.get("target") == "no-such-id" and "stdout" in peeked)
        resp = boxed.call("peek", {"target": "../escape"})
        check("peek rejects traversal", is_error(resp))
        resp = boxed.call("peek", {"target": "x", "lines": "many"})
        check("peek rejects bad lines", is_error(resp))

        resp = boxed.call("fleet_view", {})
        check("fleet_view returns human render", not is_error(resp) and "stdout" in payload(resp))

        resp = boxed.call("review_diff", {"id": "no-such-id"})
        diffed = payload(resp)
        check("review_diff returns diff with id echoed",
              not is_error(resp) and diffed.get("id") == "no-such-id")
        resp = boxed.call("review_diff", {"id": "../escape"})
        check("review_diff rejects traversal", is_error(resp))
        resp = boxed.call("review_diff", {"id": "x", "stat": "yes"})
        check("review_diff rejects non-bool stat", is_error(resp))

        resp = boxed.call("bearings_snapshot", {})
        bearings = payload(resp)
        check("bearings_snapshot returns fm-bearings.v1",
              not is_error(resp) and bearings.get("schema") == "fm-bearings.v1")

        resp = boxed.call("wake_drain", {})
        check("wake_drain drains to structured text", not is_error(resp) and "stdout" in payload(resp))

        resp = boxed.call("guard_check", {})
        check("guard_check returns verdict text", not is_error(resp) and "stdout" in payload(resp))
    finally:
        boxed.close()

    # Fail-closed budget: a >30s snapshot never blocks past 30s, the whole
    # process group dies, and the timeout is audited as an allowed execution
    # whose downstream run failed (failure stays in the payload).
    envelope = make_envelope_stub_home()
    ebox = Client(env={"FM_HOME": envelope})
    try:
        started = time.time()
        resp = ebox.call("fleet_snapshot", {})
        elapsed = time.time() - started
        snap = payload(resp)
        check("slow snapshot fails closed within the 30s budget",
              is_error(resp) and snap.get("error") == "timed out"
              and snap.get("timeout_s") == 30, str(resp)[:200])
        check("no call blocks an external caller past 30s",
              30 <= elapsed < 45, f"{elapsed:.1f}s")
        audit_lines = [json.loads(line) for line in
                       Path(envelope, "state", "mcp-audit.jsonl").read_text().splitlines()]
        timed_out = [line for line in audit_lines
                     if line.get("tool") == "fleet_snapshot" and line.get("decision") == "allow"]
        check("timed-out call is audited as allow with the failure in the payload",
              len(timed_out) >= 1, str(audit_lines[-1:])[:200])

        resp = ebox.call("backlog", {})
        back = payload(resp)
        check("backlog derives counts from a >128KB snapshot",
              not is_error(resp) and back.get("task_counts", {}).get("total") == 800, str(resp)[:200])

        resp = ebox.call("fleet_poll", {"count": 1, "interval_s": 0})
        polled = payload(resp)
        check("fleet_poll bounds output from a >128KB snapshot",
              not is_error(resp) and len(polled.get("polls", [])) == 1
              and len(json.dumps(polled).encode("utf-8")) <= 8192, str(resp)[:200])
    finally:
        ebox.close()

    # Timeout kill proof: the orphan grandchild must never touch its marker.
    orphan_home = make_orphan_stub_home()
    obox = Client(env={"FM_HOME": orphan_home})
    try:
        started = time.time()
        resp = obox.call("fleet_snapshot", {})
        check("orphan-home slow snapshot also fails closed",
              is_error(resp) and payload(resp).get("error") == "timed out", str(resp)[:200])
        while time.time() - started < 40:
            time.sleep(1)
        check("timed-out group leaves no orphan compute",
              not Path(orphan_home, "orphan-marker").exists())
    finally:
        obox.close()

    # Receipt lifecycle: submit detaches immediately, status goes
    # running -> done with the full result, failures attach too.
    receipt_home = make_receipt_stub_home()
    rbox = Client(env={"FM_HOME": receipt_home})
    try:
        started = time.time()
        resp = rbox.call("receipt_submit", {"tool": "fleet_snapshot", "arguments": {}})
        submit_elapsed = time.time() - started
        sub = payload(resp)
        check("receipt_submit detaches immediately with a pending receipt",
              not is_error(resp) and sub.get("status") == "pending"
              and sub.get("receipt_id", "").startswith("rcpt-")
              and sub.get("ttl_s") == 3600, str(resp)[:300])
        check("submit returns far inside the 30s budget",
              submit_elapsed < 10, f"{submit_elapsed:.1f}s")
        check("pending receipt carries its check signature",
              sub.get("check") == {"tool": "receipt_status",
                                  "arguments": {"receipt_id": sub.get("receipt_id")}}, str(resp)[:300])
        rid = sub["receipt_id"]
        done = None
        deadline = time.time() + 120
        while time.time() < deadline:
            resp = rbox.call("receipt_status", {"receipt_id": rid})
            state = payload(resp)
            if state.get("status") != "running":
                done = state
                break
            time.sleep(2)
        check("receipt reaches done with the >128KB result attached",
              done is not None and done.get("status") == "done"
              and done.get("result", {}).get("generated") == "envelope-slow-large"
              and len(done.get("result", {}).get("tasks", [])) == 800,
              str(done)[:200])

        resp = rbox.call("receipt_submit", {"tool": "status_tail",
                                              "arguments": {"id": "../escape"}})
        fail_rid = payload(resp)["receipt_id"]
        failed = None
        deadline = time.time() + 30
        while time.time() < deadline:
            resp = rbox.call("receipt_status", {"receipt_id": fail_rid})
            state = payload(resp)
            if state.get("status") != "running":
                failed = state
                break
            time.sleep(0.5)
        check("failed receipt attaches its error record",
              failed is not None and failed.get("status") == "failed"
              and "invalid id" in str(failed.get("error_record", {})), str(failed)[:200])

        resp = rbox.call("receipt_submit", {"tool": "nope", "arguments": {}})
        check("submit refuses unknown tools", is_error(resp))
        resp = rbox.call("receipt_submit", {"tool": "lifecycle_interrupt",
                                              "arguments": {"id": "x"}})
        check("submit still needs nested approval for authority targets",
              is_error(resp) and "approval" in payload(resp).get("error", ""))
        resp = rbox.call("receipt_status", {"receipt_id": "../escape"})
        check("status rejects traversal receipt ids", is_error(resp))

        # Cross-home isolation: this home's receipts are unknown elsewhere.
        other = Client(env={"FM_HOME": envelope})
        try:
            resp = other.call("receipt_status", {"receipt_id": rid})
            check("receipts never leak across homes",
                  is_error(resp) and payload(resp).get("error") == "unknown receipt",
                  str(resp)[:200])
        finally:
            other.close()

        # Expiry: a record older than its TTL reads expired and is removed.
        expired_id = "rcpt-expired-proof"
        Path(receipt_home, "state", "mcp-receipts").mkdir(exist_ok=True)
        Path(receipt_home, "state", "mcp-receipts", expired_id + ".json").write_text(json.dumps({
            "receipt_id": expired_id, "tool": "fleet_snapshot", "status": "done",
            "created": "stub", "created_epoch": time.time() - 7200,
            "ttl_s": 3600, "result": {},
        }))
        resp = rbox.call("receipt_status", {"receipt_id": expired_id})
        check("expired receipts report expired with their TTL",
              is_error(resp) and payload(resp).get("error") == "receipt expired"
              and payload(resp).get("ttl_s") == 3600, str(resp)[:200])
        check("expired receipt record is removed",
              not Path(receipt_home, "state", "mcp-receipts", expired_id + ".json").exists())
    finally:
        rbox.close()
    failed = [n for n, ok, _ in CHECKS if not ok]
    print(f"{len(CHECKS) - len(failed)}/{len(CHECKS)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Generate manifest/COVERAGE.md: the support-coverage view over upstream firstmate.

Every upstream firstmate command area is shown with its mirror status:
mirrored (tool name + py/ts status from the manifest), denied-by-design
(with reason), or unmirrored gap. Captain area order; nothing hand-counted.

Sources (all live-probed; only the area grouping below is curated):
  - Upstream command set: sources/firstmate/bin/fm-*.sh top-level commands
    (excluding *-lib.sh helpers) plus backends/ entries. When the submodule
    is not checked out, drift/baseline.json's top-level surfaces stand in.
  - Mirror status: manifest/FEATURES.yaml upstream-mirror entries (tool name
    + py/ts status) cross-checked against adapter/dispatch.py TOOLS.
  - Denied-by-design: adapter/dispatch.py DENY_LIST with the reason recorded
    beside each owning command (policy-only refusals with no owning script
    get an explicit policy row so they are classified too).

Usage:
  python3 scripts/gen_coverage.py                 # write manifest/COVERAGE.md
  python3 scripts/gen_coverage.py --check         # verify COVERAGE.md is current,
                                                  # every manifest entry appears,
                                                  # every upstream top-level command
                                                  # is classified (no silent
                                                  # omissions), and every DENY_LIST
                                                  # name is referenced.
  python3 scripts/gen_coverage.py --upstream-root <dir>  # override the upstream
                                                  # bin dir (tests)
  python3 scripts/gen_coverage.py --output <path>        # override output (tests)

Regen: python3 scripts/gen_coverage.py, then commit manifest/COVERAGE.md.
The README summary table is rendered from summary_rows() below by
scripts/gen_readme_lists.py; keep the two in agreement via their gates.
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

UPSTREAM_BIN = os.path.join(ROOT, "sources", "firstmate", "bin")
UPSTREAM_BACKENDS = os.path.join(UPSTREAM_BIN, "backends")
BASELINE_PATH = os.path.join(ROOT, "drift", "baseline.json")
MANIFEST_PATH = os.path.join(ROOT, "manifest", "FEATURES.yaml")
COVERAGE_PATH = os.path.join(ROOT, "manifest", "COVERAGE.md")

TICK = "\u2714"  # ✔
CROSS = "\u2718"  # ✘

# Captain area order: (key, title, one-line blurb).
AREAS = [
    ("fleet-runs", "Fleet runs",
     "Whole-fleet reads and fleet hygiene: snapshot, views, and reconciliation."),
    ("supervision", "Supervision",
     "Control and data planes for live crews: daemon, lifecycle verbs, steer, wakes, guards."),
    ("sessions", "Sessions",
     "Launching and owning agent sessions: start, harness, backends, spawn, briefs."),
    ("backlog-decisions", "Backlog / decisions",
     "Queue mechanics and durable captain decisions: backlog moves, holds, verdicts."),
    ("secondmates-remotes", "Secondmates / remotes",
     "Persistent secondmates and remote homes: launch, control, reconcile, inherit."),
    ("pr-pipeline", "PR pipeline",
     "Check arming, polls, reviews, and landing: the code-adjacent surface that stays out."),
    ("relay", "Relay",
     "Public X surface: replies, dismissals, followups, polls, and links."),
    ("voice-mail", "Voice / mail",
     "Out-of-band planes: mail reads/sends; voice helpers are non-command modules."),
    ("digests", "Digests",
     "Composed captain views: bearings, inbox, home summary, contributions."),
    ("installs", "Installs",
     "Setup and hygiene: installers, seeds, linters, tests, probes, registry checks."),
]

# Upstream command -> (area key, curator note). Status (mirrored/denied/gap)
# is NOT curated here: it is derived live from the manifest + adapter
# registry and cross-checked below, so a stale annotation fails the gate
# instead of blessing a stale view. Commands absent from the live tree
# (removed upstream since the baseline pin) keep their classification with
# a "removed" tag so history is explicit, never silent.
#
# Special rows: "derived: fleet_snapshot (backlog)" and the status-tail file
# surface are manifest entries with no owning script; backends/* are listed
# under sessions with a "backends/" prefix.
COMMAND_AREAS = {
    # ---- fleet runs ----
    "fm-fleet-snapshot.sh": ("fleet-runs", "canonical read; backlog counts derive from it"),
    "fm-fleet-view.sh": ("fleet-runs", "human render of the snapshot"),
    "fm-fleet-sync.sh": ("fleet-runs", "project sync across the fleet"),
    "fm-agent-axi.sh": ("fleet-runs", "read-only reap-triage; removed upstream since pin"),
    "fm-peek.sh": ("fleet-runs", "bounded endpoint tail for cheap diagnosis"),
    "fm-inactive-reconcile.sh": ("fleet-runs", "bounded reconciliation of inactive outcomes"),
    "fm-pool-reclaim.sh": ("fleet-runs", "treehouse pool-slot reclaim; removed upstream since pin"),
    "fm-mini1-healthcheck.sh": ("fleet-runs", "mini1 dev-space health read; removed upstream since pin"),
    # ---- supervision ----
    "fm-supervise-daemon.sh": ("supervision", "the shared daemon binary"),
    "fm-supervision-instructions.sh": ("supervision", "supervisor prompt surface"),
    "fm-attended-start.sh": ("supervision", "attended triage daemon; removed upstream since pin"),
    "fm-afk-start.sh": ("supervision", "away-mode daemon foreground"),
    "fm-afk-launch.sh": ("supervision", "non-visible terminal launch for the daemon"),
    "fm-afk-return.sh": ("supervision", "away-mode return catch-up gate"),
    "fm-afk-contract.sh": ("supervision", "away-posture record owner"),
    "fm-control.sh": ("supervision", "lifecycle verbs behind approval"),
    "fm-send.sh": ("supervision", "data plane: prose steer for one crew"),
    "file: state/<id>.status": ("supervision", "wake-event history file; history only"),
    "fm-crew-state.sh": ("supervision", "deterministic current-state read"),
    "fm-teardown.sh": ("supervision", "endpoint + worktree teardown"),
    "fm-watch.sh": ("supervision", "watcher control verbs"),
    "fm-watch-arm.sh": ("supervision", "watcher arm path"),
    "fm-watch-checkpoint.sh": ("supervision", "watcher checkpoint path; read-adjacent, unmirrored"),
    "fm-guard.sh": ("supervision", "watcher liveness / worktree-tangle guard"),
    "fm-wake-drain.sh": ("supervision", "durable wake-queue drain"),
    "fm-wake-grant.sh": ("supervision", "wake-grant mechanics"),
    "fm-wake-memo.sh": ("supervision", "wake memo record/consult/prune; removed upstream since pin"),
    "fm-lease.sh": ("supervision", "per-task supervision leases"),
    "fm-busy-event.sh": ("supervision", "sole writer of the busy-state contract"),
    "fm-lock.sh": ("supervision", "per-home session lock"),
    "fm-procevent.sh": ("supervision", "process-to-event runner"),
    "fm-procevent-lavish.sh": ("supervision", "rich event rendering"),
    "fm-procevent-quota.sh": ("supervision", "event-path quota accounting"),
    "fm-procevent-when.sh": ("supervision", "condition->action adapter"),
    "fm-procevent-remote-reply.sh": ("supervision", "remote reply intake on the event path"),
    "fm-no-mistakes-liveness.sh": ("supervision", "shared-daemon liveness match; removed upstream since pin"),
    "fm-nm-run-is-live.sh": ("supervision", "single-run liveness probe; removed upstream since pin"),
    "fm-operational-input.sh": ("supervision", "cross-language operational-input protocol"),
    "fm-quota-choose.sh": ("supervision", "quota-eligible candidate choice for dispatch"),
    "fm-kimi-turnend-hook.sh": ("supervision", "kimi turn-end hook"),
    "fm-turnend-guard.sh": ("supervision", "turn-end guard"),
    "fm-turnend-guard-grok.sh": ("supervision", "grok turn-end guard"),
    "fm-turnend-guard-cursor.sh": ("supervision", "cursor turn-end guard"),
    "fm-arm-pretool-check.sh": ("supervision", "PreToolUse command-policy hook"),
    "fm-cd-pretool-check.sh": ("supervision", "cwd-change policy hook"),
    "fm-subagent-pretool-check.sh": ("supervision", "subagent policy hook"),
    "fm-branch-outcome.sh": ("supervision", "supervision-branch outcome store"),
    "fm-branch-prompt.sh": ("supervision", "supervision-branch system prompt emitter"),
    # ---- sessions ----
    "fm-session-start.sh": ("sessions", "session bootstrap"),
    "fm-sessionstart-nudge.sh": ("sessions", "session-start nudge"),
    "fm-sessionstart-run.sh": ("sessions", "session-start runner"),
    "fm-sessionstart-cursor.sh": ("sessions", "cursor session-start path"),
    "fm-harness.sh": ("sessions", "harness detection for the process tree"),
    "fm-backend.sh": ("sessions", "session-provider selection and dispatch"),
    "fm-herdr-lab.sh": ("sessions", "isolated Herdr lab sessions"),
    "fm-herdr-ci-cleanup.sh": ("sessions", "CI session cleanup"),
    "fm-herdr-session-cleanup.sh": ("sessions", "session cleanup"),
    "fm-herdr-spur.sh": ("sessions", "agent watch spur; removed upstream since pin"),
    "fm-isolated-launch.sh": ("sessions", "isolated CLI launch; removed upstream since pin"),
    "fm-spawn.sh": ("sessions", "spawn one direct report under contract"),
    "fm-brief.sh": ("sessions", "scaffold one crewmate brief; launches nothing"),
    "fm-dispatch-resolve.sh": ("sessions", "resolve one concrete dispatch"),
    "fm-project-mode.sh": ("sessions", "registered delivery posture (mode + yolo)"),
    "fm-claude-trust.sh": ("sessions", "workspace-trust preregistration for spawns"),
    "fm-agy-trust.sh": ("sessions", "Antigravity workspace-trust preregistration"),
    "fm-claude-stop-autoarm.sh": ("sessions", "disable auto-arm in claude sessions"),
    "backends/herdr.sh": ("sessions", "Herdr session backend"),
    "backends/tmux.sh": ("sessions", "tmux session backend"),
    "backends/cmux.sh": ("sessions", "cmux session backend"),
    "backends/orca.sh": ("sessions", "Orca session backend"),
    "backends/zellij.sh": ("sessions", "zellij session backend"),
    "backends/herdr-eventwait.py": ("sessions", "Herdr event-wait helper"),
    "backends/herdr-workspace-move.py": ("sessions", "Herdr workspace-move helper"),
    # ---- backlog / decisions ----
    "fm-backlog-handoff.sh": ("backlog-decisions", "secondmate handoff moves"),
    "file: data/handoff/<id>.outbox.md": ("backlog-decisions", "staged handoff outbox file; staged moves only"),
    "fm-backlog-receive.sh": ("backlog-decisions", "remote outbox receipt"),
    "fm-backlog-import-beads.sh": ("backlog-decisions", "one-time backlog.md importer; removed upstream since pin"),
    "fm-decision-hold.sh": ("backlog-decisions", "durable captain holds behind approval"),
    "fm-captain-hold.sh": ("backlog-decisions", "unified held-for-captain mechanics; supersedes review-decision upstream"),
    "fm-review-decision.sh": ("backlog-decisions", "removed upstream since pin; review_decision now ports onto fm-captain-hold.sh answer"),
    "fm-groom.sh": ("backlog-decisions", "idea->brief->dispatch generator; removed upstream since pin"),
    "fm-groom-json-field.sh": ("backlog-decisions", "groom field helper; removed upstream since pin"),
    "fm-ledger.sh": ("backlog-decisions", "landed-but-open bead surface; removed upstream since pin"),
    "fm-staleness-file.sh": ("backlog-decisions", "staleness-file writer; removed upstream since pin"),
    "fm-bead-stamp.sh": ("backlog-decisions", "bead stamp helper; removed upstream since pin"),
    "fm-tasks-axi.sh": ("backlog-decisions", "backlog backend CLI for this home"),
    # ---- secondmates / remotes ----
    "fm-on.sh": ("secondmates-remotes", "run one tracked command in a remote home"),
    "fm-extension.sh": ("secondmates-remotes", "tracked entrypoint for fm-on extension bindings"),
    "fm-remote-entrypoint.sh": ("secondmates-remotes", "remote-end launch entrypoint"),
    "fm-remote-secondmate-control.sh": ("secondmates-remotes", "remote secondmate lifecycle"),
    "fm-remote-doctor.sh": ("secondmates-remotes", "remote home diagnostics"),
    "fm-remote-delta-read.sh": ("secondmates-remotes", "bounded remote delta reads"),
    "fm-remote-file.sh": ("secondmates-remotes", "remote file reads"),
    "fm-remote-home-provision.sh": ("secondmates-remotes", "remote home provisioning"),
    "fm-remote-home-seed.sh": ("secondmates-remotes", "remote home seeding"),
    "fm-remote-inherit.sh": ("secondmates-remotes", "remote config inherit"),
    "fm-remote-inherit-push.sh": ("secondmates-remotes", "push inherited local material out"),
    "fm-remote-job-worker.sh": ("secondmates-remotes", "remote job worker"),
    "fm-remote-job-reap-orphans.sh": ("secondmates-remotes", "reap orphaned remote jobs"),
    "fm-remote-herdr-guard.sh": ("secondmates-remotes", "fm-remote Herdr server login-session guard"),
    "fm-remote-launch.sh": ("secondmates-remotes", "remote mini launch/reclaim; removed upstream since pin"),
    "fm-secondmate-report.sh": ("secondmates-remotes", "secondmate report read"),
    "fm-secondmate-reconcile.sh": ("secondmates-remotes", "ask a secondmate to reconcile its books"),
    "fm-secondmate-restart.sh": ("secondmates-remotes", "restart secondmates onto current wiring"),
    "fm-config-push.sh": ("secondmates-remotes", "push inherited local material to live homes"),
    "fm-beads-remote-backup.sh": ("secondmates-remotes", "off-box Dolt backup verify/repair; removed upstream since pin"),
    # ---- PR pipeline ----
    "fm-pr-check.sh": ("pr-pipeline", "record PR-ready task + arm merge poll"),
    "fm-pr-merge.sh": ("pr-pipeline", "landing merge; merge authority owns this, never MCP"),
    "fm-merge-local.sh": ("pr-pipeline", "local landing merge; same refusal as merge_pr"),
    "fm-promote.sh": ("pr-pipeline", "promote scout to ship; code-writing path stays out"),
    "fm-pr-poll.sh": ("pr-pipeline", "merge-poll check source; unmirrored read"),
    "fm-pr-state.sh": ("pr-pipeline", "PR state read; unmirrored"),
    "fm-pr-reviewers.sh": ("pr-pipeline", "reviewer assignment; unmirrored"),
    "fm-pr-check-migrate.sh": ("pr-pipeline", "PR check migration; removed upstream since pin"),
    "fm-coderabbit-review-state.sh": ("pr-pipeline", "CodeRabbit review state; removed upstream since pin"),
    "fm-review-diff.sh": ("pr-pipeline", "branch-vs-base review diff; unmirrored read"),
    "policy: repo-mutation": ("pr-pipeline", ""),
    # ---- relay ----
    "fm-x-reply.sh": ("relay", "one public reply; inert without relay consent"),
    "fm-x-dismiss.sh": ("relay", "dismiss one public item; same consent gate"),
    "fm-x-followup.sh": ("relay", "one public followup; same consent gate"),
    "fm-x-link.sh": ("relay", "link a task to the mention that triggered it"),
    "fm-x-poll.sh": ("relay", "short-poll the relay connector; inert unless configured"),
    "fm-public-followup.sh": ("relay", "public followup surface"),
    "fm-public-followup-emit.sh": ("relay", "emit staged public followups"),
    "fm-public-followup-collect.sh": ("relay", "retire terminal events staged for an owning home"),
    # ---- voice / mail ----
    "fm-mail.sh": ("voice-mail", "IMAP read / SMTP send plane"),
    "fm-mail-check.sh": ("voice-mail", "inbound mail check"),
    "bin/fm_voice_records.py": ("voice-mail", "voice status/queue helper (non-command module; mic client and Bedrock relay stay out)"),
    # ---- digests ----
    "file: state/home-summary.json": ("digests", "published home-summary ledger read; refresh stays firstmate-owned"),
    "fm-bearings-snapshot.sh": ("digests", "compact bearings projection over the snapshot"),
    "fm-bearings-board.sh": ("digests", "bearings board render"),
    "fm-inbox.sh": ("digests", "captain's out-of-band capture surface"),
    "fm-home-summary-refresh.sh": ("digests", "published home-summary refresh"),
    "fm-contributions.sh": ("digests", "published contributions observer"),
    # ---- installs ----
    "fm-install-herdr.sh": ("installs", "Herdr installer"),
    "fm-install-shellcheck.sh": ("installs", "shellcheck installer"),
    "fm-install-treehouse.sh": ("installs", "treehouse installer"),
    "fm-install-actionlint.sh": ("installs", "actionlint installer"),
    "fm-bootstrap.sh": ("installs", "home bootstrap"),
    "fm-home-seed.sh": ("installs", "home seeding"),
    "fm-update.sh": ("installs", "firstmate update"),
    "fm-tool-update-check.sh": ("installs", "tool update check"),
    "fm-stow-cascade.sh": ("installs", "stow cascade"),
    "fm-ensure-agents-md.sh": ("installs", "agent-memory file bootstrap"),
    "fm-startup-network.sh": ("installs", "startup network probe"),
    "fm-startup-memory-budget.sh": ("installs", "startup memory budget"),
    "fm-lint.sh": ("installs", "repo lint (required-version probe mirrored; runs stay out)"),
    "fm-lint-workflows.sh": ("installs", "workflow lint run (probe served via lint_versions; run stays out)"),
    "fm-test-run.sh": ("installs", "test runner"),
    "fm-test-isolation-proof.sh": ("installs", "isolation proof"),
    "fm-test-affected.sh": ("installs", "test-impact selector; removed upstream since pin"),
    "fm-vendor-auth-probe.sh": ("installs", "vendor auth probe"),
    "fm-doc-audience-check.sh": ("installs", "docs audience + link check"),
    "fm-fork-origin-check.sh": ("installs", "fork-origin advisory scan; removed upstream since pin"),
    "fm-fix-no-mistakes-fork-mapping.sh": ("installs", "fork-mapping fix helper; removed upstream since pin"),
    "fm-check-register.sh": ("installs", "custom check registration"),
    "fm-check-unregister.sh": ("installs", "custom check removal"),
}

# DENY_LIST name -> (upstream command or "policy: ..." row, reason).
# Every adapter DENY_LIST entry must appear here; the gate enforces it.
DENY_REASONS = {
    "promote_scout": ("fm-promote.sh", "code-writing path: scouts report, ships launch separately"),
    "teardown_crew": ("fm-teardown.sh", "discards endpoint, worktree, and uncommitted work"),
    "arm_pr_check": ("fm-pr-check.sh", "arming a merge poll mutates CI/landing state"),
    "merge_pr": ("fm-pr-merge.sh", "landing merges belong to the configured merge authority"),
    "merge_local": ("fm-merge-local.sh", "local landing merges belong to the merge authority"),
    "daemon_start": ("fm-supervise-daemon.sh", "shared daemon serves every lane; only firstmate manages it"),
    "daemon_stop": ("fm-supervise-daemon.sh", "shared daemon serves every lane; only firstmate manages it"),
    "daemon_restart": ("fm-supervise-daemon.sh", "shared daemon serves every lane; only firstmate manages it"),
    "watch_start": ("fm-watch.sh", "watcher control would fork shared supervision state"),
    "watch_stop": ("fm-watch.sh", "watcher control would fork shared supervision state"),
    "repo_edit": ("policy: repo-mutation", "project changes belong to workers behind merge authority"),
    "repo_commit": ("policy: repo-mutation", "project changes belong to workers behind merge authority"),
    "repo_push": ("policy: repo-mutation", "project changes belong to workers behind merge authority"),
    "repo_merge": ("policy: repo-mutation", "project changes belong to workers behind merge authority"),
    "public_followup_emit": ("fm-public-followup-emit.sh", "emitting staged terminal events advances public commitments toward delivery; only supervisor/crew workflow owns terminal event staging"),
    "relay_link": ("fm-x-link.sh", "linking tasks to public relay mentions binds public reply budgets; only fmx-respond skill owns relay linking"),
    "fleet_sync": ("fm-fleet-sync.sh", "refreshing project clones mutates local checkouts and branch tracking; only session start and teardown own fleet sync"),
    "inactive_reconcile": ("fm-inactive-reconcile.sh", "reconciling inactive terminal outcomes mutates terminal outcome records and publishes parent channel/wake updates; only watcher poll and session start own inactive outcome reconciliation"),
    "backlog_receive": ("fm-backlog-receive.sh", "receiving remote outboxes moves backlog items between homes; only secondmate receipt loops own backlog receipt"),
}

DENY_LIST = frozenset(DENY_REASONS.keys())


# Extra commands refused under an existing DENY_LIST name (same policy, more
# than one owning script). Reasons are shared with DENY_REASONS.
DENY_ALSO = {
    "fm-watch-arm.sh": ("watch_start", "watch_stop"),
}


def load_manifest():
    import yaml

    data = yaml.safe_load(open(MANIFEST_PATH, encoding="utf-8"))
    mirror_tools = {}  # script -> [(tool_id, py, ts)]
    special_rows = []  # (command, tool_id, py, ts, summary)
    for entry in data.get("features", []):
        if entry.get("kind") != "upstream-mirror":
            continue
        tool = entry["id"]
        py = entry["py"]["status"]
        ts = entry["ts"]["status"]
        cmd = entry.get("upstream_command", "")
        m = re.match(r"^bin/(fm-[\w.-]+\.sh)$", cmd)
        if m:
            mirror_tools.setdefault(m.group(1), []).append((tool, py, ts))
        else:
            # derived:/file: provenance (backlog, status_tail) — explicit rows.
            special_rows.append((cmd, tool, py, ts, entry.get("summary", "")))
    return mirror_tools, special_rows


def upstream_commands(upstream_root):
    """Top-level upstream commands: fm-*.sh minus *-lib.sh, plus backends/."""
    bindir = upstream_root if os.path.basename(upstream_root) == "bin" else os.path.join(upstream_root, "bin")
    if os.path.isdir(bindir):
        cmds = sorted(
            f for f in os.listdir(bindir)
            if f.startswith("fm-") and f.endswith(".sh") and not f.endswith("-lib.sh")
        )
        backends = os.path.join(bindir, "backends")
        if os.path.isdir(backends):
            cmds += sorted("backends/" + f for f in os.listdir(backends)
                           if not f.endswith("-lib.sh"))
        return cmds, "sources/firstmate"
    # Submodule absent: the baseline pin stands in (documented fallback).
    data = json.load(open(BASELINE_PATH, encoding="utf-8"))
    cmds = sorted(
        s["name"] for s in data["surfaces"]
        if s["name"].endswith(".sh") and not s["name"].endswith("-lib.sh")
    )
    return cmds, "drift/baseline.json"


def read_pins():
    import yaml

    manifest = yaml.safe_load(open(MANIFEST_PATH, encoding="utf-8"))
    gitlink = (manifest.get("upstream") or {}).get("gitlink_at_seed", "?")
    baseline = json.load(open(BASELINE_PATH, encoding="utf-8"))
    return gitlink, baseline.get("firstmate_revision", "?"), len(baseline.get("surfaces", []))


def classify(upstream_root=UPSTREAM_BIN):
    """Return (rows, errors). rows: list of dicts in area order."""
    mirror_tools, special_rows = load_manifest()
    cmds, source = upstream_commands(upstream_root)
    cmdset = set(cmds)
    errors = []

    if set(DENY_REASONS) != set(DENY_LIST):
        errors.append(
            "DENY wiring drift: DENY_REASONS=%s adapter DENY_LIST=%s"
            % (sorted(DENY_REASONS), sorted(DENY_LIST))
        )

    deny_cmd = {}  # command -> [(deny_name, reason)]
    for name, (cmd, reason) in DENY_REASONS.items():
        deny_cmd.setdefault(cmd, []).append((name, reason))
    for cmd, names in DENY_ALSO.items():
        for name in names:
            deny_cmd.setdefault(cmd, []).append((name, DENY_REASONS[name][1]))

    # Every curated command must exist in the area map exactly once (it does
    # by construction); every live upstream command must be curated.
    for cmd in cmds:
        if cmd not in COMMAND_AREAS and not cmd.startswith("backends/"):
            errors.append("unclassified upstream command: %s" % cmd)
        if cmd.startswith("backends/") and cmd not in COMMAND_AREAS:
            errors.append("unclassified upstream backend: %s" % cmd)
    for cmd in COMMAND_AREAS:
        # file:/derived:/policy: rows are manifest-only by design; bin/
        # voice helpers are non-command modules, noted but not enumerated
        # in the upstream .sh set, and rendered via the special-rows path.
        if cmd.startswith(("file:", "derived:", "policy:", "bin/")) or cmd.startswith("backends/"):
            continue
        if cmd not in cmdset and "removed upstream since pin" not in COMMAND_AREAS[cmd][1]:
            errors.append(
                "curated command not in upstream set and not marked removed: %s" % cmd
            )

    rows = []
    for cmd in cmds:
        area, note = COMMAND_AREAS.get(cmd, (None, ""))
        if area is None:
            area, note = ("UNCLASSIFIED", "no area mapping — fix COMMAND_AREAS")
            errors.append("unclassified upstream command: %s" % cmd)
        tools = mirror_tools.pop(cmd, [])
        denies = deny_cmd.get(cmd, [])
        if tools and denies:
            errors.append("command both mirrored and denied: %s" % cmd)
        if tools:
            status = "mirrored"
        elif denies:
            status = "denied"
        else:
            status = "gap"
        rows.append({"command": cmd, "area": area, "status": status,
                     "tools": tools, "denies": denies, "note": note,
                     "removed": False})
    # Curated-but-removed commands: explicit history rows, never silent.
    for cmd in sorted(set(COMMAND_AREAS) - cmdset):
        if cmd.startswith(("file:", "derived:", "policy:", "bin/")) or cmd.startswith("backends/"):
            continue
        area, note = COMMAND_AREAS[cmd]
        tools = mirror_tools.pop(cmd, [])
        denies = deny_cmd.get(cmd, [])
        status = "mirrored-stale" if tools else ("denied" if denies else "gap")
        rows.append({"command": cmd, "area": area, "status": status,
                     "tools": tools, "denies": denies, "note": note,
                     "removed": True})
    # Special manifest rows (derived backlog, status-tail file).
    for cmd, tool, py, ts, summary in special_rows:
        if cmd.startswith("derived:"):
            continue  # folded into the owning snapshot row below
        if cmd not in COMMAND_AREAS:
            errors.append("special manifest provenance without an area: %s" % cmd)
            continue
        area, _ = COMMAND_AREAS[cmd]
        rows.append({"command": cmd, "area": area, "status": "mirrored",
                     "tools": [(tool, py, ts)], "denies": [],
                     "note": summary, "removed": False})
    # Policy-only denied rows (no owning script).
    for cmd in sorted(set(COMMAND_AREAS) & set(deny_cmd) - cmdset - {r["command"] for r in rows}):
        area, note = COMMAND_AREAS[cmd]
        rows.append({"command": cmd, "area": area, "status": "denied",
                     "tools": [], "denies": deny_cmd.get(cmd, []),
                     "note": note, "removed": False})
    # Leftovers: manifest mirrors pointing at nothing curated — fail, never drop.
    for cmd, tools in sorted(mirror_tools.items()):
        errors.append(
            "manifest mirrors '%s' (%s) with no coverage row" % (cmd, ",".join(t for t, _, _ in tools))
        )
    order = {key: i for i, (key, _, _) in enumerate(AREAS)}
    rows.sort(key=lambda r: (order.get(r["area"], 99), r["command"]))
    return rows, errors, source


def fmt_tools(tools, note=""):
    bits = []
    for tool, py, ts in tools:
        mark = lambda s: TICK if s == "implemented" else CROSS  # noqa: E731
        extra = " (derived)" if tool == "backlog" else ""
        if py == "retired":
            bits.append("`%s`%s (ts%s)" % (tool, extra, mark(ts)))
        else:
            bits.append("`%s`%s (py%s ts%s)" % (tool, extra, mark(py), mark(ts)))
    # backlog derives from the snapshot read: name it on the owning row so
    # the manifest entry visibly appears in the view.
    if any(t == "fleet_snapshot" for t, _, _ in tools):
        has_retired = any(t == "fleet_snapshot" and py == "retired" for t, py, _ in tools)
        if has_retired:
            bits.append("`backlog` (derived, ts\u2714)")
        else:
            bits.append("`backlog` (derived, py\u2714 ts\u2714)")
    s = ", ".join(bits)
    if note and tools:
        s += " — " + note
    return s or note


def generate(upstream_root=UPSTREAM_BIN):
    rows, errors, source = classify(upstream_root)
    gitlink, rev, n_surfaces = read_pins()
    counts = {}
    for key, _, _ in AREAS:
        counts[key] = {"mirrored": 0, "denied": 0, "gap": 0}
    for r in rows:
        if r["area"] not in counts:
            continue
        if r["status"].startswith("mirrored"):
            counts[r["area"]]["mirrored"] += 1
        elif r["status"] == "denied":
            counts[r["area"]]["denied"] += 1
        else:
            counts[r["area"]]["gap"] += 1

    L = []
    A = L.append
    A("# Support-coverage view")
    A("")
    A("<!-- GENERATED by scripts/gen_coverage.py — do not hand-edit. -->")
    A("")
    A("Every upstream firstmate command area with its mirror status: **mirrored**")
    A("(tool name + py/ts status from `manifest/FEATURES.yaml`), **denied-by-design**")
    A("(with reason), or **unmirrored gap**. Captain area order.")
    A("")
    A("Source: `%s` at the pinned submodule `%s` (baseline `%s`, rev `%s`, %d surfaces)." % (
        "bin/fm-*.sh top-level + backends/" if source == "sources/firstmate" else source,
        gitlink[:7], "drift/baseline.json", rev, n_surfaces))
    A("Backends ship per-harness session adapters; voice helpers outside `fm-*.sh`")
    A("are noted, not enumerated. `-lib.sh` helpers are owned by their commands.")
    A("")
    A("## Summary")
    A("")
    A("| Area | Mirrored | Denied | Gap |")
    A("| --- | --- | --- | --- |")
    for key, title, _ in AREAS:
        c = counts[key]
        A("| [%s](#%s) | %d | %d | %d |" % (title, key, c["mirrored"], c["denied"], c["gap"]))
    tot_m = sum(c["mirrored"] for c in counts.values())
    tot_d = sum(c["denied"] for c in counts.values())
    tot_g = sum(c["gap"] for c in counts.values())
    A("| **Total** | **%d** | **%d** | **%d** |" % (tot_m, tot_d, tot_g))
    A("")
    for key, title, blurb in AREAS:
        A("## %s" % title)
        A("")
        A("%s" % blurb)
        A("")
        A("| Command | Mirror status | Notes |")
        A("| --- | --- | --- |")
        for r in [x for x in rows if x["area"] == key]:
            cmd = "`%s`" % r["command"]
            if r["removed"]:
                cmd += " (removed upstream)"
            if r["status"].startswith("mirrored"):
                stale = "stale: " if r["status"] == "mirrored-stale" else ""
                status = "mirrored — %s%s" % (stale, fmt_tools(r["tools"]))
                notes = r["note"]
            elif r["status"] == "denied":
                status = "denied-by-design — " + ", ".join("`%s`" % n for n, _ in r["denies"])
                reasons = "; ".join(sorted(set(reason for _, reason in r["denies"])))
                notes = ((r["note"] + ". " if r["note"] else "") + reasons).strip()
            else:
                status = "gap"
                notes = r["note"]
            A("| %s | %s | %s |" % (cmd, status, notes))
        A("")
    A("## Definitions")
    A("")
    A("- **mirrored**: an MCP tool dispatches the owning script (or derives from it);")
    A("  py/ts marks come from `manifest/FEATURES.yaml`. `stale` means upstream removed")
    A("  the owning script after the pin — the tool still dispatches the old name.")
    A("- **denied-by-design**: `adapter/dispatch.py` DENY_LIST refuses the surface with")
    A("  `forbidden`; the reason names the smarts-only line that keeps it out.")
    A("- **gap**: reachable upstream surface with no tool and no refusal entry —")
    A("  explicitly unmirrored, not silently omitted. Gaps are the port backlog.")
    A("")
    return "\n".join(L), errors


def summary_rows(upstream_root=UPSTREAM_BIN):
    """Per-area (title, mirrored, denied, gap) for the README summary table."""
    rows, errors, _ = classify(upstream_root)
    out = []
    for key, title, _ in AREAS:
        rs = [r for r in rows if r["area"] == key]
        m = sum(1 for r in rs if r["status"].startswith("mirrored"))
        d = sum(1 for r in rs if r["status"] == "denied")
        g = sum(1 for r in rs if r["status"] == "gap")
        out.append((title, m, d, g))
    return out, errors


def main():
    args = sys.argv[1:]
    upstream_root = UPSTREAM_BIN
    output = COVERAGE_PATH
    if "--upstream-root" in args:
        upstream_root = args[args.index("--upstream-root") + 1]
    if "--output" in args:
        output = args[args.index("--output") + 1]
    doc, errors = generate(upstream_root)
    if "--check" in args:
        problems = list(errors)
        if not os.path.isfile(output):
            problems.append("missing %s" % output)
        elif open(output, encoding="utf-8").read().strip() != doc.strip():
            problems.append("%s is stale; regen with python3 scripts/gen_coverage.py" % output)
        # Every manifest mirror id appears; every DENY_LIST name is referenced.
        import yaml

        manifest = yaml.safe_load(open(MANIFEST_PATH, encoding="utf-8"))
        for entry in manifest.get("features", []):
            if entry.get("kind") == "upstream-mirror" and entry["id"] not in doc:
                problems.append("manifest entry '%s' missing from coverage" % entry["id"])
        for name in DENY_LIST:
            if name not in doc:
                problems.append("DENY_LIST name '%s' missing from coverage" % name)
        if problems:
            for p in problems:
                print("coverage check: %s" % p, file=sys.stderr)
            return 1
        n_rows = doc.count("\n| `") + doc.count("\n| file:") + doc.count("\n| policy:") + doc.count("\n| backends/")
        print("coverage check: COVERAGE.md current, manifest + upstream fully classified (%d rows)" % n_rows)
        return 0
    with open(output, "w", encoding="utf-8") as fh:
        fh.write(doc)
    if errors:
        for e in errors:
            print("coverage: %s" % e, file=sys.stderr)
        return 1
    print("wrote %s" % output)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Validate schema/contracts.yaml against schema/contracts.schema.json.

Commodity validator: JSON Schema draft 2020-12 via the `jsonschema` package,
plus semantic checks the schema cannot express: the owning command must
exist for bin/ paths, the version pin must match the current pin table,
and the dual provenance pins (upstream radar + fork working-copy) must be
present and agree with manifest/FEATURES.yaml.
Usage: python3 schema/validate.py [contracts.yaml]
Exit 0 Valid. Exit 2 Schema violation. Exit 3 Stale pin, unknown command,
or missing/mismatched provenance pins.
"""
import json
import os
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("validate: missing dependency: pyyaml (pip install pyyaml)", file=sys.stderr)
    sys.exit(2)

try:
    from jsonschema import Draft202012Validator
except ImportError:
    print("validate: missing dependency: jsonschema (pip install jsonschema)", file=sys.stderr)
    sys.exit(2)

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "schema" / "contracts.schema.json"
FEATURES_PATH = ROOT / "manifest" / "FEATURES.yaml"

CURRENT_PINS = {
    "fleet_snapshot": "fm-fleet-snapshot.v1",
    "backlog": "fm-fleet-snapshot.v1",
    "crew_state": "fm-crew-state.v1",
    "status_tail": "status-log.v1",
    "send_message": "fm-send.plain-text.v1",
    "spawn_crew": "fm-spawn.safe-subset.v1",
    "scaffold_brief": "fm-brief.safe-subset.v1",
    "receipt_submit": "mcp-receipt.v1",
    "receipt_status": "mcp-receipt.v1",
    "peek": "fm-peek.v1",
    "fleet_view": "fm-fleet-view.v1",
    "review_diff": "fm-review-diff.v1",
    "bearings_snapshot": "fm-bearings.v1",
    "wake_drain": "fm-wake-drain.v1",
    "guard_check": "fm-guard.v1",
    "remote_doctor": "fm-remote-doctor.v1",
    "remote_file": "fm-remote-file.get.v1",
    "remote_delta": "fm-remote-delta-read.v1",
    "handoff_status": "handoff-outbox.v1",
    "secondmate_nudge": "fm-reconcile.notify.v1",
    "secondmate_restart": "fm-secondmate-restart.v1",
    "secondmate_report": "fm-secondmate-report.v1",
    "remote_control": "fm-remote-control.safe-subset.v1",
    "handoff_move": "fm-handoff.safe-subset.v1",
    "harness_detect": "fm-harness.v1",
    "project_mode": "fm-project-mode.v1",
    "lock_status": "fm-lock.status.v1",
    "lease_check": "fm-lease.check.v1",
    "bearings_board_path": "fm-bearings-board.path.v1",
    "inbox_status": "fm-inbox.status.v1",
    "inbox_list": "fm-inbox.list.v1",
    "home_summary": "fm-secondmate-home-summary.v1",
    "home_summary_refresh": "fm-home-summary-refresh.v1",
    "contributions_snapshot": "fm-contributions.snapshot.v1",
    "contributions_pending": "fm-contributions.pending.v1",
    "mail_status": "fm-mail.status.v1",
    "mail_read": "fm-mail.read.v1",
    "mail_check": "fm-mail-check.v1",
    "mail_send": "fm-mail.safe-subset.v1",
    "voice_status": "fm-voice-records.status.v1",
    "voice_queue": "fm-voice-records.queue.v1",
    "lint_versions": "fm-lint.versions.v1",
    "tool_update_check": "fm-tool-update.check.v1",
    "vendor_auth_probe": "fm-vendor-auth-probe.v1",
    "startup_memory": "fm-startup-memory-budget.v1",
    "pr_state": "fm-pr-state.v1",
    "relay_poll": "fm-x-poll.v1",
    "grant_mint": "mcp-grant.v1",
    "grant_revoke": "mcp-grant.v1",
    "grant_status": "mcp-grant.v1",
    "public_followup_pending": "fm-public-followup.pending.v1",
    "public_followup_collect": "fm-public-followup-collect.drain.v1",
    "tasks_list": "fm-tasks-axi.list.v1",
    "tasks_show": "fm-tasks-axi.show.v1",
    "tasks_ready": "fm-tasks-axi.ready.v1",
}


def fail(code, message):
    print(f"validate: {message}", file=sys.stderr)
    sys.exit(code)


def owning_command_exists(command):
    """A bin/ command resolves beside a firstmate checkout or under $FM_HOME/bin.

    This repo ships the MCP layer only, so on a clean root the owning scripts
    come from the firstmate checkout the server itself resolves (see README).
    """
    rel = Path(command)
    if (ROOT / rel).exists():
        return True
    fm_home = os.environ.get("FM_HOME")
    if fm_home and (Path(fm_home) / rel).exists():
        return True
    sub = ROOT / "sources" / "firstmate"
    if (sub / rel).exists():
        return True
    return False


def main():
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "schema" / "contracts.yaml"
    try:
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    except OSError as exc:
        fail(2, f"cannot read schema {SCHEMA_PATH}: {exc}")
    try:
        data = yaml.safe_load(target.read_text(encoding="utf-8"))
    except OSError as exc:
        fail(2, f"cannot read contracts {target}: {exc}")
    except yaml.YAMLError as exc:
        fail(2, f"contracts {target} is not valid YAML: {exc}")

    validator = Draft202012Validator(schema)
    # YAML parses an unquoted date into a date object; normalize to ISO so a
    # well-formed pin validates as the string the schema requires.
    import datetime
    try:
        fork_date = data["provenance"]["fork"]["proven_date"]
        if isinstance(fork_date, (datetime.date, datetime.datetime)):
            data["provenance"]["fork"]["proven_date"] = fork_date.isoformat()
    except (KeyError, TypeError):
        pass
    errors = sorted(validator.iter_errors(data), key=lambda e: list(e.path))
    if errors:
        for err in errors[:5]:
            where = ".".join(str(p) for p in err.absolute_path) or "(root)"
            fail(2, f"contract invalid at '{where}': {err.message}")
        fail(2, f"{len(errors)} schema violation(s) in {target}")

    for entry in data.get("contracts", []):
        name = entry.get("name", "?")
        command = entry.get("command", "")
        if command.startswith("bin/") and not owning_command_exists(command):
            fail(3, f"contract '{name}' is stale: command '{command}' does not exist "
                    f"(see {entry.get('evidence', {}).get('header', '?')})")
        current = CURRENT_PINS.get(name)
        if current is not None and entry.get("pinned") != current:
            fail(3, f"contract '{name}' is stale: pinned '{entry.get('pinned')}' "
                    f"does not match current '{current}' "
                    f"(see {entry.get('evidence', {}).get('header', '?')})")

    # Dual provenance: the upstream (radar) and fork (working-copy) pins must
    # both be present and must agree with manifest/FEATURES.yaml. Shape is
    # enforced by the JSON schema above; here the pins must match the manifest
    # so the two files can never bless different commits. Fail loudly.
    prov = data.get("provenance")
    if not isinstance(prov, dict):
        fail(3, f"{target} carries no provenance block: record both pins "
                "(upstream radar + fork working-copy), never ship one silently")
    try:
        features = yaml.safe_load(FEATURES_PATH.read_text(encoding="utf-8"))
    except OSError as exc:
        fail(3, f"cannot read manifest pins {FEATURES_PATH}: {exc}")
    except yaml.YAMLError as exc:
        fail(3, f"manifest pins {FEATURES_PATH} are not valid YAML: {exc}")
    fup, ffork = features.get("upstream") or {}, features.get("fork") or {}
    cup, cfork = prov.get("upstream") or {}, prov.get("fork") or {}
    def norm(value):
        return value.isoformat() if isinstance(value, (datetime.date, datetime.datetime)) else value
    pairs = [
        (norm(cup.get("gitlink")), norm(fup.get("gitlink_at_seed")), "upstream gitlink"),
        (norm(cup.get("baseline_rev")), norm(fup.get("baseline_rev_at_seed")), "upstream baseline_rev"),
        (norm(cup.get("baseline_surfaces")), norm(fup.get("baseline_surfaces_at_seed")), "upstream baseline_surfaces"),
        (norm(cfork.get("proven_commit")), norm(ffork.get("proven_commit")), "fork proven_commit"),
        (norm(cfork.get("proven_date")), norm(ffork.get("proven_date")), "fork proven_date"),
    ]
    for got, want, label in pairs:
        if got in (None, "") or want in (None, "") or got != want:
            fail(3, f"provenance {label} is missing or stale: contracts {got!r} vs "
                    f"manifest {want!r} — re-seed both pins together")

    print(f"validate: ok: {len(data.get('contracts', []))} contract(s) from {target}; "
          f"provenance pins agree (upstream radar + fork working-copy)")


if __name__ == "__main__":
    main()

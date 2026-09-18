#!/usr/bin/env python3
"""Validate schema/contracts.yaml against schema/contracts.schema.json.

Commodity validator: JSON Schema draft 2020-12 via the `jsonschema` package,
plus two semantic checks the schema cannot express: the owning command must
exist for bin/ paths, and the version pin must match the current pin table.
Usage: python3 schema/validate.py [contracts.yaml]
Exit 0 Valid. Exit 2 Schema violation. Exit 3 Stale pin or unknown command.
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
    return bool(fm_home) and (Path(fm_home) / rel).exists()


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

    print(f"validate: ok: {len(data.get('contracts', []))} contract(s) from {target}")


if __name__ == "__main__":
    main()

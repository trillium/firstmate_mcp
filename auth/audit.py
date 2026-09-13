import json
from datetime import datetime, timezone
from pathlib import Path

from auth.tiers import approval_ref, tier_of

AUDIT_VERSION = 1

AUDIT_KEYS = (
    "v",
    "ts",
    "actor",
    "tool",
    "tier",
    "decision",
    "reason",
    "approval_ref",
    "target",
)


def build_line(actor, tool, decision, reason, approval=None, target=None, ts=None):
    stamp = ts or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "v": AUDIT_VERSION,
        "ts": stamp,
        "actor": actor,
        "tool": tool,
        "tier": tier_of(tool),
        "decision": decision,
        "reason": reason,
        "approval_ref": approval_ref(approval),
        "target": target,
    }


def format_line(line):
    return json.dumps(line, sort_keys=True)


def append(path, line):
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("a", encoding="utf-8") as handle:
        handle.write(format_line(line) + "\n")
    return dest


def read_lines(path):
    out = []
    with Path(path).open(encoding="utf-8") as handle:
        for raw in handle:
            raw = raw.strip()
            if raw:
                out.append(json.loads(raw))
    return out

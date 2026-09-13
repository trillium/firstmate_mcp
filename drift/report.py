#!/usr/bin/env python3
"""Report emitters for drift reports (stdlib only).

Three shapes from one report dict:
- to_dict: the machine-readable JSON-serializable report itself.
- to_json: that dict serialized with indent 2.
- to_markdown / to_text: human-readable views with the same sections
  (summary, added, removed, changed with per-surface feature/behavior tags).
"""
import json


def to_dict(report):
    return report


def to_json(report):
    return json.dumps(report, indent=2) + "\n"


def _badge(entry):
    tags = []
    if entry.get("feature_drift"):
        tags.append("feature-drift")
    if entry.get("behavior_drift"):
        tags.append("behavior-drift")
    return " + ".join(tags) if tags else "unchanged"


def _change_line(change):
    field, klass = change["field"], change["class"]
    old, new = change.get("baseline"), change.get("observed")
    if field == "flags":
        old_set, new_set = set(old or []), set(new or [])
        gained = sorted(new_set - old_set)
        lost = sorted(old_set - new_set)
        detail = []
        if gained:
            detail.append("gained " + ", ".join(gained))
        if lost:
            detail.append("lost " + ", ".join(lost))
        return f"    - {field} [{klass}]: {'; '.join(detail) or 'reordered'}"
    if isinstance(old, str) and isinstance(new, str) and (len(old) + len(new) > 160):
        return f"    - {field} [{klass}]: changed ({len(old)} -> {len(new)} chars)"
    return f"    - {field} [{klass}]: {old!r} -> {new!r}"


def to_markdown(report):
    summary = report["summary"]
    lines = ["# Drift report", ""]
    base = report.get("baseline", {})
    obs = report.get("observed", {})
    lines.append(
        f"Baseline rev `{base.get('firstmate_revision', '?')}` "
        f"({base.get('generated', '?')}) vs observed rev "
        f"`{obs.get('firstmate_revision', '?')}` ({obs.get('generated', '?')})."
    )
    lines.append("")
    lines.append(
        f"Summary: {summary['added']} added, {summary['removed']} removed, "
        f"{summary['changed']} changed "
        f"({summary['feature_drift']} feature-drift, {summary['behavior_drift']} behavior-drift)."
    )
    lines.append("")
    if report["added"]:
        lines.append("## Added (feature drift)")
        lines.extend(f"- `{name}`" for name in report["added"])
        lines.append("")
    if report["removed"]:
        lines.append("## Removed (feature drift)")
        lines.extend(f"- `{name}`" for name in report["removed"])
        lines.append("")
    if report["changed"]:
        lines.append("## Changed")
        for entry in report["changed"]:
            lines.append(f"- `{entry['name']}` ({_badge(entry)})")
            lines.extend(_change_line(change) for change in entry["changes"])
        lines.append("")
    if summary["clean"]:
        lines.append("No drift: observed inventory matches the baseline.")
        lines.append("")
    return "\n".join(lines)


def to_text(report):
    summary = report["summary"]
    lines = [
        f"drift: {summary['added']} added, {summary['removed']} removed, "
        f"{summary['changed']} changed "
        f"({summary['feature_drift']} feature, {summary['behavior_drift']} behavior)"
    ]
    for name in report["added"]:
        lines.append(f"added [feature]: {name}")
    for name in report["removed"]:
        lines.append(f"removed [feature]: {name}")
    for entry in report["changed"]:
        lines.append(f"changed [{_badge(entry)}]: {entry['name']}")
        lines.extend(_change_line(change) for change in entry["changes"])
    if summary["clean"]:
        lines.append("clean: no drift")
    return "\n".join(lines) + "\n"

#!/usr/bin/env python3
"""Diff engine for two observed-inventory snapshots (stdlib only).

Change classes:
- added / removed: a surface appears or disappears. Always feature drift:
  the depended-on command set itself changed.
- changed: a surface exists on both sides but differs. Each differing field
  is classified per the design report vocabulary:
  - feature drift: the contract surface moved (command path, kind, flag
    set, schema id hint, header output contract). A depended-on pin may
    need updating.
  - behavior drift: the same contract behaves or documents differently
    (help text, file bytes, size/mtime, help exit code). Worth a look,
    but no contract pin necessarily changes.

A surface can carry both classes at once (e.g. new flags plus new help).
"""

FEATURE_FIELDS = ("command", "kind", "flags", "schema_hint", "header_contract")
BEHAVIOR_FIELDS = ("help_excerpt", "help_hash", "file_hash", "size", "mtime", "help_exit")


def _field_change(field, old, new):
    return {
        "field": field,
        "baseline": old,
        "observed": new,
        "class": "feature" if field in FEATURE_FIELDS else "behavior",
    }


def _diff_surface(old, new):
    changes = []
    for field in FEATURE_FIELDS + BEHAVIOR_FIELDS:
        old_value = old.get(field)
        new_value = new.get(field)
        if old_value != new_value:
            changes.append(_field_change(field, old_value, new_value))
    if not changes:
        return None
    classes = {change["class"] for change in changes}
    return {
        "name": new.get("name", old.get("name", "?")),
        "feature_drift": "feature" in classes,
        "behavior_drift": "behavior" in classes,
        "changes": changes,
    }


def diff_snapshots(baseline, observed):
    """Compare two snapshot dicts; return the machine-readable drift report."""
    old_surfaces = {s["name"]: s for s in baseline.get("surfaces", [])}
    new_surfaces = {s["name"]: s for s in observed.get("surfaces", [])}
    added = sorted(name for name in new_surfaces if name not in old_surfaces)
    removed = sorted(name for name in old_surfaces if name not in new_surfaces)
    changed = []
    for name in sorted(set(old_surfaces) & set(new_surfaces)):
        entry = _diff_surface(old_surfaces[name], new_surfaces[name])
        if entry is not None:
            changed.append(entry)
    feature_count = len(added) + len(removed) + sum(
        1 for entry in changed if entry["feature_drift"]
    )
    behavior_count = sum(1 for entry in changed if entry["behavior_drift"])
    meta = lambda snap: {
        "generated": snap.get("generated", ""),
        "firstmate_revision": snap.get("firstmate_revision", ""),
        "surfaces": len(snap.get("surfaces", [])),
    }
    return {
        "version": 1,
        "baseline": meta(baseline),
        "observed": meta(observed),
        "summary": {
            "added": len(added),
            "removed": len(removed),
            "changed": len(changed),
            "feature_drift": feature_count,
            "behavior_drift": behavior_count,
            "clean": not (added or removed or changed),
        },
        "added": added,
        "removed": removed,
        "changed": changed,
    }

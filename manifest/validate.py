#!/usr/bin/env python3
"""Validate manifest/FEATURES.yaml: the durable feature manifest (task-8d0ah).

Checks, in order:
  1. Structural: parses, version pin, unique well-formed ids, required fields,
     kind enum, status enums.
  2. Contract coverage: every schema/contracts.yaml contract name has a
     manifest entry pointing at it (schema/contracts.yaml#<name>).
  3. Honesty: every `implemented` evidence pointer names a file that exists
     under the repo root and (when a substring is given) that substring
     occurs in the file — a status must never claim an implementation that
     does not exist. `missing` must carry no evidence; `partial` must carry
     a note explaining what is partial.
  4. Divergence: intentional requires a reason, none/not-applicable require
     an empty reason, and local entries must be not-applicable.
  5. Provenance: both pins present and well-formed — the upstream (Kun)
     fingerprint block and the fork (trillium/firstmate) working-copy block —
     cross-checked against the tree (submodule gitlink, drift/baseline.json)
     and against schema/contracts.yaml's provenance block. Missing, malformed,
     or drifted pins fail loudly, never silently.

Usage: python3 manifest/validate.py [FEATURES.yaml]
Exit 0 Valid. Exit 2 Structural violation (including missing/malformed pins).
Exit 3 Coverage, honesty, divergence, or stale-pin violation.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("validate: missing dependency: pyyaml (pip install pyyaml)", file=sys.stderr)
    sys.exit(2)

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TARGET = ROOT / "manifest" / "FEATURES.yaml"
CONTRACTS_PATH = ROOT / "schema" / "contracts.yaml"

ID_RE = re.compile(r"^[a-z0-9_]+$")
SHA40_RE = re.compile(r"^[0-9a-f]{40}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
KINDS = ("upstream-mirror", "local", "fork")
STATUSES = ("implemented", "partial", "missing", "retired")
DIVERGENCE = ("none", "intentional", "not-applicable")
REQUIRED = ("summary", "contract", "upstream_test", "py", "ts", "divergence")


def fail(code, message):
    print(f"validate: {message}", file=sys.stderr)
    sys.exit(code)


def load_yaml(path):
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except OSError as exc:
        fail(2, f"cannot read {path}: {exc}")
    except yaml.YAMLError as exc:
        fail(2, f"{path} is not valid YAML: {exc}")


def check_evidence(entry_id, side, impl):
    """Spot-check one implementation claim against the tree. Returns errors."""
    errors = []
    status = impl.get("status")
    if status not in STATUSES:
        return [f"feature '{entry_id}' {side}.status '{status}' not in {list(STATUSES)}"]
    evidence = impl.get("evidence") or []
    note = impl.get("note") or ""
    if status in ("missing", "retired"):
        if evidence:
            errors.append(
                f"feature '{entry_id}' {side} is '{status}' but carries evidence; "
                f"a {status} status must not point at an implementation"
            )
    elif status == "partial" and not note:
        errors.append(
            f"feature '{entry_id}' {side} is 'partial' but carries no note; "
            "say what is partial"
        )
    if status == "implemented" and not evidence:
        errors.append(
            f"feature '{entry_id}' {side} is 'implemented' with no evidence pointers"
        )
    for item in evidence:
        path_text, _, substr = item.partition(":")
        target = ROOT / path_text
        if not target.is_file():
            errors.append(
                f"feature '{entry_id}' {side} evidence '{item}': file not in tree"
            )
            continue
        if substr and substr not in target.read_text(encoding="utf-8"):
            errors.append(
                f"feature '{entry_id}' {side} evidence '{item}': "
                "symbol not found — status claims an implementation that does not exist"
            )
    return errors


def live_gitlink():
    """The submodule gitlink recorded in the index or at HEAD (works even
    when the submodule itself is not checked out in this worktree)."""
    for args in (
        ("git", "-C", str(ROOT), "ls-files", "--stage", "sources/firstmate"),
        ("git", "-C", str(ROOT), "ls-tree", "HEAD", "sources/firstmate"),
    ):
        try:
            proc = subprocess.run(
                list(args),
                capture_output=True, text=True, timeout=30,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            continue
        if proc.returncode != 0:
            continue
        m = re.search(r"\b[0-9a-f]{40}\b", proc.stdout)
        if m:
            return m.group(0), ""
    return None, "no gitlink found"


def check_provenance(data):
    """Both pins present, well-formed, and agreeing with the tree.
    Returns (structural_errors, stale_errors)."""
    structural, stale = [], []
    up = data.get("upstream")
    fork = data.get("fork")
    if not isinstance(up, dict):
        structural.append("missing 'upstream' provenance block (Kun fingerprint pin)")
    if not isinstance(fork, dict):
        structural.append("missing 'fork' provenance block (working-copy pin)")
    if structural:
        return structural, stale
    for field in ("repo", "submodule", "gitlink_at_seed", "baseline",
                  "baseline_rev_at_seed", "baseline_surfaces_at_seed", "role"):
        if up.get(field) in (None, ""):
            structural.append(f"upstream provenance is missing '{field}'")
    for field in ("repo", "proven_commit", "proven_date", "served_commit", "served_date", "basis", "role"):
        if fork.get(field) in (None, ""):
            structural.append(f"fork provenance is missing '{field}'")
    if structural:
        return structural, stale
    # YAML parses an unquoted date into a date object; accept it loudly by
    # normalizing to ISO rather than failing a well-formed pin.
    import datetime
    if isinstance(fork.get("proven_date"), (datetime.date, datetime.datetime)):
        fork["proven_date"] = fork["proven_date"].isoformat()
    if isinstance(fork.get("served_date"), (datetime.date, datetime.datetime)):
        fork["served_date"] = fork["served_date"].isoformat()
    if not SHA40_RE.match(up["gitlink_at_seed"]):
        structural.append("upstream gitlink_at_seed must be a 40-char hex commit")
    if up.get("role") != "radar":
        structural.append("upstream provenance role must be 'radar' (early-warning only)")
    if not SHA40_RE.match(fork["proven_commit"]):
        structural.append("fork proven_commit must be a 40-char hex commit")
    if not SHA40_RE.match(fork["served_commit"]):
        structural.append("fork served_commit must be a 40-char hex commit")
    if not DATE_RE.match(fork["proven_date"]):
        structural.append("fork proven_date must be YYYY-MM-DD")
    if not DATE_RE.match(fork["served_date"]):
        structural.append("fork served_date must be YYYY-MM-DD")
    if fork.get("role") != "working-copy":
        structural.append("fork provenance role must be 'working-copy'")
    if structural:
        return structural, stale


    # Stale checks against the live tree — fail loudly, never silently.
    gitlink, err = live_gitlink()
    if gitlink is None:
        stale.append(f"cannot verify upstream gitlink against HEAD: {err}")
    elif gitlink != up["gitlink_at_seed"]:
        stale.append(
            f"upstream gitlink_at_seed {up['gitlink_at_seed'][:9]} is stale: "
            f"HEAD records {gitlink[:9]} — re-seed the pin, never ignore the drift"
        )
    baseline_path = ROOT / "drift" / "baseline.json"
    try:
        baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    except OSError as exc:
        stale.append(f"cannot read {baseline_path}: {exc}")
        baseline = {}
    # The fork block carries two revs on purpose: `proven_commit` is the proof
    # basis (history, moves only when the adapter is re-proven) and `served_commit`
    # is the line the fleet runs. They are different revs, which a single pin made
    # ambiguous — the owner asked "what are we pinned at" on 2026-09-22 and the
    # manifest could not answer cleanly. `served_commit` must match the observed
    # inventory of that same checkout in drift/baseline.json, so a moved fleet home
    # cannot leave this file quietly wrong.
    baseline_served = baseline.get("firstmate_revision", "") if isinstance(baseline, dict) else ""
    if baseline_served and not baseline_served.startswith(fork["served_commit"][:8]):
        stale.append(
            f"fork served_commit {fork['served_commit'][:9]} is stale: "
            f"drift/baseline.json records {baseline_served!r} — re-seed served_commit "
            "to the line the fleet actually runs"
        )
    if isinstance(baseline, dict):
        rev = baseline.get("firstmate_revision", "")
        if rev and not rev.startswith(up["baseline_rev_at_seed"]):
            stale.append(
                f"upstream baseline_rev_at_seed {up['baseline_rev_at_seed']!r} is stale: "
                f"drift/baseline.json records {rev!r} — re-seed the pin"
            )
        surfaces = baseline.get("surfaces", [])
        if isinstance(surfaces, list) and len(surfaces) != up["baseline_surfaces_at_seed"]:
            stale.append(
                f"upstream baseline_surfaces_at_seed {up['baseline_surfaces_at_seed']} is stale: "
                f"drift/baseline.json carries {len(surfaces)} surfaces — re-seed the pin"
            )
    contracts = load_yaml(CONTRACTS_PATH)
    prov = contracts.get("provenance") if isinstance(contracts, dict) else None
    if not isinstance(prov, dict):
        stale.append(f"{CONTRACTS_PATH} carries no provenance block to match the manifest pins")
    else:
        cup = prov.get("upstream") or {}
        cfork = prov.get("fork") or {}
        pairs = [
            (cup.get("gitlink"), up["gitlink_at_seed"], "upstream gitlink"),
            (cup.get("baseline_rev"), up["baseline_rev_at_seed"], "upstream baseline_rev"),
            (cup.get("baseline_surfaces"), up["baseline_surfaces_at_seed"], "upstream baseline_surfaces"),
            (cfork.get("proven_commit"), fork["proven_commit"], "fork proven_commit"),
            (cfork.get("proven_date"), fork["proven_date"], "fork proven_date"),
        ]
        for got, want, label in pairs:
            if got != want:
                stale.append(
                    f"{CONTRACTS_PATH} provenance {label} {got!r} does not match "
                    f"manifest/FEATURES.yaml {want!r} — pins must agree, re-seed both"
                )
    return structural, stale


def main():
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_TARGET
    data = load_yaml(target)
    if not isinstance(data, dict):
        fail(2, f"{target} root must be a mapping")
    if data.get("version") != "v1":
        fail(2, f"{target} version must be 'v1'")
    if "fork" in data:
        fork_info = data["fork"]
        if not isinstance(fork_info, dict):
            fail(2, f"{target} 'fork' must be a mapping")
        if not fork_info.get("repo") or not fork_info.get("proven_commit"):
            fail(2, f"{target} 'fork' mapping must include 'repo' and 'proven_commit'")
    features = data.get("features")
    if not isinstance(features, list) or not features:
        fail(2, f"{target} must carry a non-empty 'features' list")

    seen = set()
    for i, entry in enumerate(features):
        where = f"features[{i}]"
        if not isinstance(entry, dict):
            fail(2, f"{where} must be a mapping")
        fid = entry.get("id")
        if not isinstance(fid, str) or not ID_RE.match(fid):
            fail(2, f"{where} has no stable snake_case 'id'")
        if fid in seen:
            fail(2, f"duplicate feature id '{fid}'")
        seen.add(fid)
        if entry.get("kind") not in KINDS:
            fail(2, f"feature '{fid}' kind must be one of {list(KINDS)}")
        # Fork/local extensions must point at their bead: the brain store is the basis
        # of that data (owner directive 2026-09-22), so one here without a bead id only
        # exists in markdown — exactly what is being retired.
        if entry.get("kind") in ("fork", "local") and not entry.get("bead"):
            fail(
                2,
                f"feature '{fid}' is kind '{entry['kind']}' with no 'bead' id "
                "(the brain store is the basis for these)",
            )
        for field in REQUIRED:
            if entry.get(field) in (None, ""):
                fail(2, f"feature '{fid}' is missing required field '{field}'")
        if entry["kind"] == "upstream-mirror" and not entry.get("upstream_command"):
            fail(2, f"mirror feature '{fid}' must name 'upstream_command' provenance")
        if entry["kind"] == "local" and not entry.get("local_path"):
            fail(2, f"local feature '{fid}' must name 'local_path' provenance")
        if entry["kind"] == "fork":
            if not entry.get("fork_rev"):
                fail(2, f"fork feature '{fid}' must name 'fork_rev' commit provenance")
            if not (entry.get("fork_command") or entry.get("fork_path")):
                fail(2, f"fork feature '{fid}' must name 'fork_command' or 'fork_path' provenance")
        for side in ("py", "ts"):
            impl = entry[side]
            if not isinstance(impl, dict) or "status" not in impl:
                fail(2, f"feature '{fid}' {side} must be a mapping with 'status'")
        div = entry["divergence"]
        if not isinstance(div, dict) or div.get("status") not in DIVERGENCE:
            fail(2, f"feature '{fid}' divergence.status must be one of {list(DIVERGENCE)}")
        reason = div.get("reason") or ""
        if entry["kind"] == "local":
            if div["status"] != "not-applicable":
                fail(3, f"local feature '{fid}' divergence must be 'not-applicable' (nothing upstream to diverge from)")
            if reason:
                fail(3, f"local feature '{fid}' divergence carries a reason but is not-applicable")
        elif entry["kind"] == "fork":
            if div["status"] != "intentional":
                fail(3, f"fork feature '{fid}' divergence must be 'intentional' (tracking delta against upstream)")
            if not reason:
                fail(3, f"fork feature '{fid}' is an intentional divergence with no reason; record why upstream behavior differs")
        elif div["status"] == "intentional" and not reason:
            fail(3, f"feature '{fid}' is an intentional divergence with no reason; record why upstream behavior is no longer authoritative")
        elif div["status"] in ("none", "not-applicable") and reason:
            fail(3, f"feature '{fid}' divergence '{div['status']}' must carry an empty reason")

    structural, stale = check_provenance(data)
    if structural:
        for err in structural[:10]:
            print(f"validate: provenance {err}", file=sys.stderr)
        fail(2, f"{len(structural)} provenance pin(s) missing or malformed in {target}")
    if stale:
        for err in stale[:10]:
            print(f"validate: provenance {err}", file=sys.stderr)
        fail(3, f"{len(stale)} stale provenance pin(s) in {target}")

    # Contract coverage: every schema contract name has a manifest entry.
    contracts = load_yaml(CONTRACTS_PATH)
    try:
        names = [c["name"] for c in contracts["contracts"]]
    except (KeyError, TypeError):
        fail(2, f"{CONTRACTS_PATH} has no contracts list")
    pointed = set()
    for entry in features:
        contract = entry.get("contract") or ""
        m = re.match(r"^schema/contracts\.yaml#(\S+)$", contract)
        if m:
            pointed.add(m.group(1))
    missing = [n for n in names if n not in pointed]
    if missing:
        fail(3, f"schema contracts without a manifest entry: {', '.join(missing)}")

    # Honesty spot-checks against the tree.
    honesty = []
    for entry in features:
        honesty += check_evidence(entry["id"], "py", entry["py"])
        honesty += check_evidence(entry["id"], "ts", entry["ts"])
    if honesty:
        for err in honesty[:10]:
            print(f"validate: {err}", file=sys.stderr)
        fail(3, f"{len(honesty)} honesty violation(s) in {target}")

    n_mirror = sum(1 for e in features if e["kind"] == "upstream-mirror")
    n_local = sum(1 for e in features if e["kind"] == "local")
    n_fork = sum(1 for e in features if e["kind"] == "fork")
    n_div = sum(1 for e in features if e["divergence"]["status"] == "intentional")
    print(
        f"manifest ok: {len(features)} features "
        f"({n_mirror} mirrored, {n_local} local, {n_fork} fork deltas, {n_div} intentional divergences), "
        f"{len(names)} schema contracts covered, evidence spot-checked, "
        f"provenance pins verified "
        f"(upstream {data['upstream']['gitlink_at_seed'][:9]} radar + "
        f"fork {data['fork']['proven_commit'][:9]} working-copy)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

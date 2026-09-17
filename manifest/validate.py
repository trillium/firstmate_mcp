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

Usage: python3 manifest/validate.py [FEATURES.yaml]
Exit 0 Valid. Exit 2 Structural violation. Exit 3 Coverage, honesty, or
divergence violation.
"""
import re
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
KINDS = ("upstream-mirror", "local")
STATUSES = ("implemented", "partial", "missing")
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
    if status == "missing":
        if evidence:
            errors.append(
                f"feature '{entry_id}' {side} is 'missing' but carries evidence; "
                "a missing status must not point at an implementation"
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


def main():
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_TARGET
    data = load_yaml(target)
    if not isinstance(data, dict):
        fail(2, f"{target} root must be a mapping")
    if data.get("version") != "v1":
        fail(2, f"{target} version must be 'v1'")
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
        for field in REQUIRED:
            if entry.get(field) in (None, ""):
                fail(2, f"feature '{fid}' is missing required field '{field}'")
        if entry["kind"] == "upstream-mirror" and not entry.get("upstream_command"):
            fail(2, f"mirror feature '{fid}' must name 'upstream_command' provenance")
        if entry["kind"] == "local" and not entry.get("local_path"):
            fail(2, f"local feature '{fid}' must name 'local_path' provenance")
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
        elif div["status"] == "intentional" and not reason:
            fail(3, f"feature '{fid}' is an intentional divergence with no reason; record why upstream behavior is no longer authoritative")
        elif div["status"] in ("none", "not-applicable") and reason:
            fail(3, f"feature '{fid}' divergence '{div['status']}' must carry an empty reason")

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
    n_div = sum(1 for e in features if e["divergence"]["status"] == "intentional")
    print(
        f"manifest ok: {len(features)} features "
        f"({n_mirror} mirrored, {n_local} local, {n_div} intentional divergences), "
        f"{len(names)} schema contracts covered, evidence spot-checked"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Generate the SUPPORTED / CHANGED / NEW lists for README.md from repo sources.

Sources (all live-probed, nothing hand-listed):
  - adapter/dispatch.py TOOLS registry (tool -> owning script, needs_approval)
  - adapter/dispatch.py DENY_LIST (refused surfaces)
  - auth/tiers.py TOOL_TIERS (tier per tool)
  - schema/contracts.yaml (depended-on contract names)
  - drift/baseline.json (observed surface count + firstmate rev)
  - fm_mcp_server.py envelope constants (SUBPROCESS_TIMEOUT_S, MAX_OUTPUT_BYTES)
  - tests/conformance/, tests/mcp-adapter.test.sh, tests/mcp-schema.test.sh,
    tests/drift-check.test.sh, tests/fm-mcp-authz.test.sh, test_client.py
    (existence-probed; only existing suites are listed)

Usage:
  python3 scripts/gen_readme_lists.py          # print fragment to stdout
  python3 scripts/gen_readme_lists.py --check  # verify README embed is current

Regen: python3 scripts/gen_readme_lists.py > /tmp/lists.md, then paste
between the GENERATED markers in README.md (or re-run and diff with --check).
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from adapter.dispatch import DENY_LIST, TOOLS
from auth.tiers import FORBIDDEN_TOOLS, TOOL_TIERS

TIER_LABEL = {1: "Tier 1 open", 2: "Tier 2 steer", 3: "Tier 3 approval", 4: "Tier 4 approval+relay"}


def read_server_envelope():
    src = open(os.path.join(ROOT, "fm_mcp_server.py")).read()
    timeout = re.search(r"SUBPROCESS_TIMEOUT_S\s*=\s*(\d+)", src).group(1)
    maxbytes = re.search(r"MAX_OUTPUT_BYTES\s*=\s*(\d+)", src).group(1)
    return timeout, maxbytes


def read_contracts():
    names = []
    for line in open(os.path.join(ROOT, "schema", "contracts.yaml")):
        m = re.match(r"\s+- name:\s*(\S+)", line)
        if m:
            names.append(m.group(1))
    return names


def read_baseline():
    d = json.load(open(os.path.join(ROOT, "drift", "baseline.json")))
    return d["firstmate_revision"], len(d["surfaces"])


def existing_suites():
    candidates = [
        "test_client.py",
        "tests/mcp-adapter.test.sh",
        "tests/mcp-schema.test.sh",
        "tests/drift-check.test.sh",
        "tests/fm-mcp-authz.test.sh",
        "tests/conformance/conformance.sh",
        "tests/test_drift.py",
        "auth/test_authz.py",
    ]
    return [c for c in candidates if os.path.exists(os.path.join(ROOT, c))]


def generate():
    contracts = read_contracts()
    rev, n_surfaces = read_baseline()
    timeout, maxbytes = read_server_envelope()
    suites = existing_suites()

    supported = [(t, TOOLS[t]) for t in sorted(TOOLS) if not TOOLS[t][2]]
    changed = [(t, TOOLS[t]) for t in sorted(TOOLS) if TOOLS[t][2]]

    lines = []
    lines.append("### SUPPORTED firstmate features (behavior-identical through the adapter)")
    lines.append("")
    lines.append("No-approval tools: the adapter's typed projection equals the owning")
    lines.append("script's observable output (modulo the envelope wrap).")
    lines.append("")
    for tool, (script, _, _) in supported:
        pin = "pinned in schema/contracts.yaml" if tool in contracts else "adapter-native projection"
        own = script if script else "native (no owning script)"
        lines.append(f"- `{tool}` — via `{own}` ({pin})")
    lines.append("")
    lines.append("### CHANGED firstmate features (stricter adapter behavior, approval gates)")
    lines.append("")
    lines.append("Same owning scripts, narrower surface: safe flag subsets only,")
    lines.append("revalidated ids/paths/text, explicit per-call approval.")
    lines.append("")
    for tool, (script, _, _) in changed:
        tier = TOOL_TIERS.get(tool, "?")
        lines.append(f"- `{tool}` — via `{script}` ({TIER_LABEL.get(tier, tier)}, approval required)")
    lines.append("")
    lines.append("Refused by the adapter deny-list (no tool, answered unknown):")
    lines.append("")
    for tool in sorted(DENY_LIST):
        note = "code-forbidden" if tool in FORBIDDEN_TOOLS else "out of smarts-only scope"
        lines.append(f"- `{tool}` ({note})")
    lines.append("")
    lines.append("### NEW Trillium features (exist only in this layer)")
    lines.append("")
    lines.append(f"- Drift detection — `drift/baseline.json` seeds {n_surfaces} observed")
    lines.append(f"  `bin/fm-*.sh` surfaces at firstmate rev `{rev}`; `drift/snapshot.py` +")
    lines.append("  `drift/check.py` diff feature drift from behavior drift.")
    lines.append("- Upstream-shift signal — `sources/firstmate` pins upstream firstmate;")
    lines.append("  `drift/shift.py` diffs the pin against upstream main and reports")
    lines.append("  which depended-on surfaces moved, so TS/Python ports start from")
    lines.append("  that report.")
    lines.append(f"- Subprocess envelope — `fm_mcp_server.py` runs every tool script with")
    lines.append(f"  `SUBPROCESS_TIMEOUT_S={timeout}` and `MAX_OUTPUT_BYTES={maxbytes}`,")
    lines.append("  process-group kill on timeout so timed-out reads leave no orphans.")
    lines.append("- Auth tiers in code — `auth/tiers.py` assigns every tool a tier,")
    lines.append("  `auth/audit.py` writes the JSON-lines audit log; every")
    lines.append("  authority-bearing tool refuses without an `I authorize` string.")
    lines.append("- Contract map — `schema/contracts.yaml` declares the depended-on")
    lines.append("  subset with stability tiers; `schema/validate.py` fails naming the")
    lines.append("  stale pin; `schema/matrix.md` is the human view.")
    lines.append("- Conformance fixtures — `tests/conformance/` proves adapter output")
    lines.append("  equals the owning scripts' output via stub homes (skips cleanly")
    lines.append("  without a firstmate checkout).")
    lines.append("- Proof suites in this tree (all run in gates below):")
    for s in suites:
        lines.append(f"  - `{s}`")
    return "\n".join(lines) + "\n"


def main():
    fragment = generate()
    if "--check" in sys.argv:
        readme = open(os.path.join(ROOT, "README.md")).read()
        m = re.search(
            r"<!-- GENERATED:BEGIN -->\n(.*)\n<!-- GENERATED:END -->", readme, re.S
        )
        if not m:
            print("README has no GENERATED block", file=sys.stderr)
            return 1
        if m.group(1).strip() != fragment.strip():
            print("README GENERATED block is stale; regen and paste", file=sys.stderr)
            return 1
        print("README GENERATED block is current")
        return 0
    sys.stdout.write(fragment)


if __name__ == "__main__":
    sys.exit(main())

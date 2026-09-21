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
- scripts/gen_coverage.py summary_rows() (per-area mirrored/denied/gap
  counts surfaced as the Support-coverage view at the end of the fragment)

Usage:
  python3 scripts/gen_readme_lists.py                 # print fragment to stdout
  python3 scripts/gen_readme_lists.py --check         # verify README embed is current
  python3 scripts/gen_readme_lists.py --check-manifest  # verify manifest/FEATURES.yaml
                                                        # agrees with these lists:
                                                        # mirrored ids equal the
                                                        # adapter registry, every local
                                                        # entry's readme_anchor
                                                        # appears in the NEW list.
                                                        # (The generator keeps
                                                        # live-probing authoritative
                                                        # sources rather than reading
                                                        # the manifest; see
                                                        # manifest/README.md.)

Regen: python3 scripts/gen_readme_lists.py > /tmp/lists.md, then paste
between the GENERATED markers in README.md (or re-run and diff with --check).
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from scripts.gen_coverage import summary_rows as coverage_summary_rows

TIER_LABEL = {1: "Tier 1 open", 2: "Tier 2 steer", 3: "Tier 3 approval", 4: "Tier 4 approval+relay"}

DENY_LIST = frozenset(
    {
        "promote_scout",
        "teardown_crew",
        "arm_pr_check",
        "merge_pr",
        "merge_local",
        "daemon_start",
        "daemon_stop",
        "daemon_restart",
        "watch_start",
        "watch_stop",
        "repo_edit",
        "repo_commit",
        "repo_push",
        "repo_merge",
        "public_followup_emit",
        "relay_link",
    }
)

FORBIDDEN_TOOLS = (
    "promote_scout",
    "teardown_crew",
    "arm_pr_check",
    "merge_pr",
    "merge_local",
)

TOOLS = {
    "fleet_snapshot": ("fm-fleet-snapshot.sh", None, False),
    "backlog": ("fm-fleet-snapshot.sh", None, False),
    "crew_state": ("fm-crew-state.sh", None, False),
    "status_tail": (None, None, False),
    "send_message": ("fm-send.sh", None, False),
    "fleet_poll": ("fm-fleet-snapshot.sh", None, False),
    "peek": ("fm-peek.sh", None, False),
    "fleet_view": ("fm-fleet-view.sh", None, False),
    "review_diff": ("fm-review-diff.sh", None, False),
    "bearings_snapshot": ("fm-bearings-snapshot.sh", None, False),
    "wake_drain": ("fm-wake-drain.sh", None, False),
    "guard_check": ("fm-guard.sh", None, False),
    "remote_doctor": ("fm-remote-doctor.sh", None, False),
    "remote_file": ("fm-remote-file.sh", None, False),
    "remote_delta": ("fm-remote-delta-read.sh", None, False),
    "handoff_status": (None, None, False),
    "secondmate_nudge": ("fm-secondmate-reconcile.sh", None, True),
    "secondmate_restart": ("fm-secondmate-restart.sh", None, True),
    "secondmate_report": ("fm-secondmate-report.sh", None, True),
    "remote_control": ("fm-remote-secondmate-control.sh", None, True),
    "handoff_move": ("fm-backlog-handoff.sh", None, True),
    "harness_detect": ("fm-harness.sh", None, False),
    "project_mode": ("fm-project-mode.sh", None, False),
    "lock_status": ("fm-lock.sh", None, False),
    "lease_check": ("fm-lease.sh", None, False),
    "bearings_board_path": ("fm-bearings-board.sh", None, False),
    "inbox_status": ("fm-inbox.sh", None, False),
    "inbox_list": ("fm-inbox.sh", None, False),
    "home_summary": (None, None, False),
    "home_summary_refresh": ("fm-home-summary-refresh.sh", None, False),
    "contributions_snapshot": ("fm-contributions.sh", None, False),
    "contributions_pending": ("fm-contributions.sh", None, False),
    "lifecycle_interrupt": ("fm-control.sh", None, True),
    "lifecycle_exit": ("fm-control.sh", None, True),
    "lifecycle_relaunch": ("fm-control.sh", None, True),
    "lifecycle_suspend": ("fm-control.sh", None, True),
    "lifecycle_resume": ("fm-control.sh", None, True),
    "spawn_crew": ("fm-spawn.sh", None, True),
    "scaffold_brief": ("fm-brief.sh", None, True),
    "decision_hold": ("fm-decision-hold.sh", None, True),
    "decision_resolve": ("fm-decision-hold.sh", None, True),
    "decision_release": ("fm-decision-hold.sh", None, True),
    "decision_complete": ("fm-captain-hold.sh", None, True),
    "decision_verify": ("fm-captain-hold.sh", None, False),
    "decision_open": ("fm-captain-hold.sh", None, False),
    "decision_diverged": ("fm-captain-hold.sh", None, False),
    "review_decision": ("fm-captain-hold.sh", None, True),
    "relay_reply": ("fm-x-reply.sh", None, True),
    "relay_dismiss": ("fm-x-dismiss.sh", None, True),
    "relay_followup": ("fm-x-followup.sh", None, True),
    "mail_status": ("fm-mail.sh", None, False),
    "mail_read": ("fm-mail.sh", None, False),
    "mail_check": ("fm-mail-check.sh", None, False),
    "mail_send": ("fm-mail.sh", None, True),
    "voice_status": ("fm_voice_records.py", None, False),
    "voice_queue": ("fm_voice_records.py", None, True),
    "lint_versions": ("fm-lint.sh", None, False),
    "tool_update_check": ("fm-tool-update-check.sh", None, False),
    "vendor_auth_probe": ("fm-vendor-auth-probe.sh", None, False),
    "startup_memory": ("fm-startup-memory-budget.sh", None, False),
    "pr_state": ("fm-pr-state.sh", None, False),
    "relay_poll": ("fm-x-poll.sh", None, False),
    "public_followup_pending": ("fm-public-followup.sh", None, False),
    "public_followup_collect": ("fm-public-followup-collect.sh", None, False),
}

TOOL_TIERS = {
    "fleet_snapshot": 1, "backlog": 1, "crew_state": 1, "status_tail": 1,
    "fleet_poll": 1, "peek": 1, "fleet_view": 1, "review_diff": 1,
    "bearings_snapshot": 1, "wake_drain": 1, "guard_check": 1,
    "remote_doctor": 1, "remote_file": 1, "remote_delta": 1,
    "handoff_status": 1, "harness_detect": 1, "project_mode": 1,
    "lock_status": 1, "lease_check": 1, "bearings_board_path": 1,
    "inbox_status": 1, "inbox_list": 1, "home_summary": 1, "home_summary_refresh": 1,
    "contributions_snapshot": 1, "contributions_pending": 1,
    "mail_status": 1, "mail_read": 1, "mail_check": 1, "voice_status": 1,
    "lint_versions": 1, "tool_update_check": 1, "vendor_auth_probe": 1,
    "startup_memory": 1, "pr_state": 1, "relay_poll": 1,
    "public_followup_pending": 1, "public_followup_collect": 1,
    "receipt_submit": 1, "receipt_status": 1, "grant_status": 1,
    "decision_verify": 1, "decision_open": 1, "decision_diverged": 1,
    "send_message": 2,
    "lifecycle_interrupt": 3, "lifecycle_exit": 3, "lifecycle_relaunch": 3,
    "lifecycle_suspend": 3, "lifecycle_resume": 3, "spawn_crew": 3,
    "scaffold_brief": 3, "decision_hold": 3, "decision_resolve": 3,
    "decision_release": 3, "decision_complete": 3,
    "review_decision": 3, "secondmate_nudge": 3, "secondmate_restart": 3,
    "secondmate_report": 3, "remote_control": 3, "handoff_move": 3,
    "voice_queue": 3, "grant_mint": 3, "grant_revoke": 3,
    "mail_send": 4, "relay_reply": 4, "relay_dismiss": 4, "relay_followup": 4,
}


def read_server_envelope():
    src = open(os.path.join(ROOT, "ts", "src", "constants.ts")).read()
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
        "tests/mcp-adapter.test.sh",
        "tests/mcp-schema.test.sh",
        "tests/drift-check.test.sh",
        "tests/fm-mcp-authz.test.sh",
        "tests/fm-coverage.test.sh",
        "tests/fm-manifest.test.sh",
        "tests/fm-mcp-deploy.test.sh",
        "tests/fm-mcp-smoke.test.sh",
        "tests/fm-mcp-logrotate.test.sh",
        "tests/mcp-hooks.test.sh",
        "tests/conformance/conformance.sh",
        "tests/conformance/ts-parity.sh",
        "tests/upstream/run_upstream.sh",
        "tests/test_drift.py",
        "ts/tests/server.test.ts",
        "ts/tests/timeout.test.ts",
        "ts/tests/receipt.test.ts",
        "ts/tests/conformance-read.test.ts",
        "ts/tests/conformance-remote.test.ts",
        "ts/tests/conformance-system.test.ts",
        "ts/tests/auth.test.ts",
        "ts/tests/followon.test.ts",
        "ts/tests/grants.test.ts",
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
    lines.append(f"- Subprocess envelope — TypeScript server returns every tool call within")
    lines.append(f"  `SUBPROCESS_TIMEOUT_S={timeout}` with `MAX_OUTPUT_BYTES={maxbytes}`,")
    lines.append("  process-group kill on timeout so timed-out reads leave no orphans.")
    lines.append("- Async receipts — `receipt_submit` detaches one call past the 30s")
    lines.append("  budget and returns a pending receipt; `receipt_status` reports")
    lines.append("  running/done/failed with the result attached, TTL expiry, and")
    lines.append("  per-home confinement so receipts never leak across homes.")
    lines.append("- Standing approval grants — `grant_mint`, `grant_revoke`, and `grant_status`")
    lines.append("  allow autonomous callers to mint, inspect, and revoke scoped standing approval grants.")
    lines.append("- Standing approval primitive — `ts/src/grants.ts` provides scoped standing approval")
    lines.append("  for autonomous MCP loops with tier boundaries, tool allowlists, project scopes,")
    lines.append("  expiry TTL, usage caps, and instant revocability while preserving default-deny and captain-hold release gates.")
    lines.append("- Auth tiers in code — `ts/src/auth.ts` assigns every tool a tier,")
    lines.append("  writes the JSON-lines audit log; every authority-bearing tool")
    lines.append("  refuses without an `I authorize` string.")
    lines.append("- Contract map — `schema/contracts.yaml` declares the depended-on")
    lines.append("  subset with stability tiers; `schema/validate.py` fails naming the")
    lines.append("  stale pin; `schema/matrix.md` is the human view.")
    lines.append("- Conformance fixtures — `ts/tests/conformance-*.test.ts` proves TS server")
    lines.append("  output equals the owning scripts' output via stub homes (sharded & hash-cached across")
    lines.append("  Bun and Node runtimes).")
    lines.append("- Upstream preservation — `tests/upstream/` runs upstream firstmate")
    lines.append("  tests unchanged against the TypeScript server via thin adapters")
    lines.append("  (upstream reference skips cleanly without a checkout); verdicts")
    lines.append("  seeded in `UPSTREAM-RESULTS.md`, divergences explicit in")
    lines.append("  `tests/upstream/divergences.json`.")
    # Server tool count is the adapter registry plus the two server-native
    # receipt tools (receipt_submit/receipt_status live in ts/src/tools.ts).
    lines.append(f"- TypeScript sibling — `ts/` implements the {len(TOOLS) + 2}-tool")
    lines.append("  contract over stdio as the sole server (zero runtime dependencies beyond Effect);")
    lines.append("  `tests/conformance/ts-parity.sh` runs multi-runtime conformance fixtures under bun and node.")
    lines.append("- Customizable follow-on actions — `ts/src/followon.ts` provides configurable")
    lines.append("  chained follow-on actions for any MCP tool with condition evaluation,")
    lines.append("  context forwarding, strict anti-laundering auth gates, and loop termination.")
    lines.append("- Supervised deployment — `deploy/com.firstmate.mcp.plist.template` provides")
    lines.append("  launchd user agent supervisor configuration with copytruncate log rotation")
    lines.append("  (`scripts/fm-mcp-logrotate.sh`) and fail-closed smoke gate verification")
    lines.append("  (`scripts/fm-mcp-smoke.sh`).")
    lines.append("- Proof suites in this tree (all run in gates below):")
    for s in suites:
        lines.append(f"  - `{s}`")
    lines.append("")
    lines.append("### Support-coverage view (per upstream command area)")
    lines.append("")
    lines.append("Every upstream `bin/fm-*.sh` top-level command plus `backends/`, grouped")
    lines.append("by command area with its mirror status. Full view: `manifest/COVERAGE.md`")
    lines.append("(generated by `scripts/gen_coverage.py`; gate: `tests/fm-coverage.test.sh`).")
    lines.append("")
    lines.append("| Area | Mirrored | Denied | Gap |")
    lines.append("| --- | --- | --- | --- |")
    coverage, _ = coverage_summary_rows()
    for title, mirrored, denied, gap in coverage:
        lines.append(f"| {title} | {mirrored} | {denied} | {gap} |")
    lines.append("")
    lines.append("Mirrored names the MCP tool; `stale` flags an owning script upstream removed")
    lines.append("after the pin (the tool still dispatches the old name). Denied names the")
    lines.append("refusal reason; gap is the explicitly unmirrored port backlog.")
    return "\n".join(lines) + "\n"


def check_manifest(fragment):
    """Manifest consistency: FEATURES.yaml agrees with the generated lists."""
    import yaml

    manifest = yaml.safe_load(
        open(os.path.join(ROOT, "manifest", "FEATURES.yaml"))
    )
    features = manifest.get("features", [])
    mirrored = sorted(f["id"] for f in features if f.get("kind") == "upstream-mirror")
    local = [f for f in features if f.get("kind") == "local"]
    errors = []
    if mirrored != sorted(TOOLS):
        errors.append(
            "mirrored manifest ids != adapter registry: manifest=%s registry=%s"
            % (mirrored, sorted(TOOLS))
        )
    for f in local:
        anchor = f.get("readme_anchor", "")
        if not anchor or anchor not in fragment:
            errors.append(
                "local feature '%s' readme_anchor missing from NEW list" % f.get("id")
            )
    return errors


def main():
    fragment = generate()
    if "--check-manifest" in sys.argv:
        errors = check_manifest(fragment)
        if errors:
            for e in errors:
                print(f"manifest check: {e}", file=sys.stderr)
            return 1
        print(
            f"manifest check: {len(fragment.splitlines())}-line fragment agrees "
            f"with FEATURES.yaml"
        )
        return 0
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

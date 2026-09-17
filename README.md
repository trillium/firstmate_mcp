# Firstmate MCP — an MCP-built adaption of firstmate, shaped to Trillium's desire of how firstmate works

firstmate_mcp is an MCP-built adaption of firstmate: every tool shells out to
firstmate's own `bin/fm-*.sh` scripts (pinned as a git submodule at
`sources/firstmate`) and never reimplements firstmate behavior. Trillium's
shape of how firstmate works is the smarts-only line: launch ability yes,
development ability no — observe the fleet, steer workers, launch crews, but
no code-writing, landing, or repo-mutation surface.

The three lists below are generated, not hand-written, so they cannot drift
from the tree. Regen with:

```sh
python3 scripts/gen_readme_lists.py --check   # verify the embed is current
```

<!-- GENERATED:BEGIN -->
### SUPPORTED firstmate features (behavior-identical through the adapter)

No-approval tools: the adapter's typed projection equals the owning
script's observable output (modulo the envelope wrap).

- `backlog` — via `fm-fleet-snapshot.sh` (pinned in schema/contracts.yaml)
- `crew_state` — via `fm-crew-state.sh` (pinned in schema/contracts.yaml)
- `fleet_poll` — via `fm-fleet-snapshot.sh` (adapter-native projection)
- `fleet_snapshot` — via `fm-fleet-snapshot.sh` (pinned in schema/contracts.yaml)
- `send_message` — via `fm-send.sh` (pinned in schema/contracts.yaml)
- `status_tail` — via `native (no owning script)` (pinned in schema/contracts.yaml)

### CHANGED firstmate features (stricter adapter behavior, approval gates)

Same owning scripts, narrower surface: safe flag subsets only,
revalidated ids/paths/text, explicit per-call approval.

- `decision_hold` — via `fm-decision-hold.sh` (Tier 3 approval, approval required)
- `decision_resolve` — via `fm-decision-hold.sh` (Tier 3 approval, approval required)
- `lifecycle_exit` — via `fm-control.sh` (Tier 3 approval, approval required)
- `lifecycle_interrupt` — via `fm-control.sh` (Tier 3 approval, approval required)
- `lifecycle_relaunch` — via `fm-control.sh` (Tier 3 approval, approval required)
- `lifecycle_resume` — via `fm-control.sh` (Tier 3 approval, approval required)
- `lifecycle_suspend` — via `fm-control.sh` (Tier 3 approval, approval required)
- `relay_dismiss` — via `fm-x-dismiss.sh` (Tier 4 approval+relay, approval required)
- `relay_followup` — via `fm-x-followup.sh` (Tier 4 approval+relay, approval required)
- `relay_reply` — via `fm-x-reply.sh` (Tier 4 approval+relay, approval required)
- `review_decision` — via `fm-review-decision.sh` (Tier 3 approval, approval required)
- `scaffold_brief` — via `fm-brief.sh` (Tier 3 approval, approval required)
- `spawn_crew` — via `fm-spawn.sh` (Tier 3 approval, approval required)

Refused by the adapter deny-list (no tool, answered unknown):

- `arm_pr_check` (code-forbidden)
- `daemon_restart` (out of smarts-only scope)
- `daemon_start` (out of smarts-only scope)
- `daemon_stop` (out of smarts-only scope)
- `merge_local` (code-forbidden)
- `merge_pr` (code-forbidden)
- `promote_scout` (code-forbidden)
- `repo_commit` (out of smarts-only scope)
- `repo_edit` (out of smarts-only scope)
- `repo_merge` (out of smarts-only scope)
- `repo_push` (out of smarts-only scope)
- `teardown_crew` (code-forbidden)
- `watch_start` (out of smarts-only scope)
- `watch_stop` (out of smarts-only scope)

### NEW Trillium features (exist only in this layer)

- Drift detection — `drift/baseline.json` seeds 163 observed
  `bin/fm-*.sh` surfaces at firstmate rev `aaf67489`; `drift/snapshot.py` +
  `drift/check.py` diff feature drift from behavior drift.
- Upstream-shift signal — `sources/firstmate` pins upstream firstmate;
  `drift/shift.py` diffs the pin against upstream main and reports
  which depended-on surfaces moved, so TS/Python ports start from
  that report.
- Subprocess envelope — `fm_mcp_server.py` returns every tool call within
  `SUBPROCESS_TIMEOUT_S=30` with `MAX_OUTPUT_BYTES=1048576`,
  process-group kill on timeout so timed-out reads leave no orphans.
- Async receipts — `receipt_submit` detaches one call past the 30s
  budget and returns a pending receipt; `receipt_status` reports
  running/done/failed with the result attached, TTL expiry, and
  per-home confinement so receipts never leak across homes.
- Auth tiers in code — `auth/tiers.py` assigns every tool a tier,
  `auth/audit.py` writes the JSON-lines audit log; every
  authority-bearing tool refuses without an `I authorize` string.
- Contract map — `schema/contracts.yaml` declares the depended-on
  subset with stability tiers; `schema/validate.py` fails naming the
  stale pin; `schema/matrix.md` is the human view.
- Conformance fixtures — `tests/conformance/` proves adapter output
  equals the owning scripts' output via stub homes (skips cleanly
  without a firstmate checkout).
- TypeScript sibling — `ts/` independently implements the same 21-tool
  contract over stdio (no dependencies); `tests/conformance/ts-parity.sh`
  diffs py/ts payloads field-for-field plus the TS equivalence fixtures.
- Proof suites in this tree (all run in gates below):
  - `test_client.py`
  - `tests/mcp-adapter.test.sh`
  - `tests/mcp-schema.test.sh`
  - `tests/drift-check.test.sh`
  - `tests/fm-mcp-authz.test.sh`
  - `tests/fm-coverage.test.sh`
  - `tests/conformance/conformance.sh`
  - `tests/conformance/ts-parity.sh`
  - `tests/test_drift.py`
  - `auth/test_authz.py`
  - `ts/tests/server.test.ts`
  - `ts/tests/conformance.test.ts`
  - `ts/tests/auth.test.ts`

### Support-coverage view (per upstream command area)

Every upstream `bin/fm-*.sh` top-level command plus `backends/`, grouped
by command area with its mirror status. Full view: `manifest/COVERAGE.md`
(generated by `scripts/gen_coverage.py`; gate: `tests/fm-coverage.test.sh`).

| Area | Mirrored | Denied | Gap |
| --- | --- | --- | --- |
| Fleet runs | 1 | 0 | 7 |
| Supervision | 4 | 4 | 32 |
| Sessions | 2 | 0 | 23 |
| Backlog / decisions | 2 | 0 | 10 |
| Secondmates / remotes | 0 | 0 | 20 |
| PR pipeline | 0 | 5 | 6 |
| Relay | 3 | 0 | 5 |
| Voice / mail | 0 | 0 | 2 |
| Digests | 0 | 0 | 5 |
| Installs | 0 | 0 | 23 |

Mirrored names the MCP tool; `stale` flags an owning script upstream removed
after the pin (the tool still dispatches the old name). Denied names the
refusal reason; gap is the explicitly unmirrored port backlog.
<!-- GENERATED:END -->

## Contents

- [What this is](#what-this-is)
- [Quickstart](#quickstart)
- [Cutover](#cutover)
- [Tools](#tools)
- [Authorization tiers](#authorization-tiers)
- [Contract map](#contract-map)
- [Conformance](#conformance)
- [Drift detection](#drift-detection)
- [Design choices](#design-choices)
- [Layout](#layout)
- [History](#history)

## What this is

Typed [Model Context Protocol](https://modelcontextprotocol.io) tools over
firstmate. The server exposes reads, steering, and launch control as
JSON-Schema-typed tools that shell out to firstmate's own scripts — it never
reimplements firstmate behavior.

The smarts-only line: **launch ability yes, development ability no.** This
layer may observe the fleet, steer workers, and launch or control crews. It
has no code-writing surface: no edit, commit, merge, or PR tools, no direct
repo mutation, no teardown that discards work, no promote-to-ship paths.
Firstmate stays the implementation; this repo is only the typed doorway.

## Quickstart

Requirements: Python 3, stdlib only, no dependencies.

Run the server (newline-delimited JSON-RPC on stdio, logs on stderr):

```sh
python3 fm_mcp_server.py
```

Point it at a firstmate checkout to wire the live tools:

```sh
FM_HOME=/path/to/firstmate python3 fm_mcp_server.py
```

Without a firstmate checkout beside it, the server resolves its tool scripts
from `$FM_HOME/bin` and tool calls fail closed with `executable not found`.

Run the end-to-end proof (72 checks, self-contained — no checkout needed):

```sh
python3 test_client.py
```

The suite handshakes, lists tools, exercises every read, proves traversal and
validation refusals, proves approval gating on every authority-bearing tool,
and proves every removed code-writing surface answers unknown-tool.

## Cutover

Serve a live firstmate fleet through this layer, local-only:

```sh
scripts/fm-mcp-launch.sh --home /path/to/firstmate
```

The launcher pins one `FM_HOME` (required: flag or env, absolute, carrying
`bin/fm-fleet-snapshot.sh`), stays on stdio JSON-RPC (no TCP/SSE/network
listeners — network flags are refused), and execs the proven Python server
by default (`--server ts --runtime bun|node` selects the TypeScript sibling
where `tests/conformance/ts-parity.sh` proves parity). Every allow and every
refuse appends one JSON line to the audit log (default
`$FM_HOME/state/mcp-audit.jsonl`, override `FM_AUDIT_LOG`, actor via
`FM_ACTOR`); approval tokens are stored as hashes only. See `AUTH.md` for
the tiers and `CUTOVER-PROOF.md` for the live scratch-home proof (repro:
`python3 scripts/cutover_prove.py` — scratch homes only, never the live
fleet).

## Tools

Reads (open, no side effects): `fleet_snapshot`, `backlog`, `crew_state`,
`status_tail`.

Single safe write: `send_message` — one verified plain-text line to one crew
(500-char cap, single line, slash commands refused).

Launch-authorized writes (approval required): `lifecycle_interrupt`,
`lifecycle_exit`, `lifecycle_relaunch`, `lifecycle_suspend`,
`lifecycle_resume`, `spawn_crew`, `scaffold_brief`, `decision_hold`,
`decision_resolve`, `review_decision`.

External sends (approval required, inert without relay consent):
`relay_reply`, `relay_dismiss`, `relay_followup`.

Read-only poller: `fleet_poll`, a bounded convenience poll over
`fleet_snapshot`, which stays canonical.

Code-forbidden (no tool, refused as unknown): `promote_scout`,
`teardown_crew`, `arm_pr_check`, `merge_pr`, `merge_local`.

See `INVENTORY.md` for the full capability inventory and typed mapping.

## Authorization tiers

Every authority-bearing or externally visible tool takes an explicit
`approval` string starting with `I authorize` and refuses without it. Reads
stay open because they change nothing.

- Tier 1 — open reads, no approval.
- Tier 2 — reversible steers (`send_message`), no approval, validated text.
- Tier 3 — launch-authorized writes, approval required.
- Tier 4 — external sends, approval required plus relay consent in the owning
  script.

See `AUTH.md` for the tier list and the code-forbidden list. The
`auth/` module enforces the same model in code: per-tool tier assignments,
the explicit per-call approval check, and the JSON-lines audit format.
Trillium grants approval per call by writing that sentence for the exact
tool and target, such as `I authorize lifecycle_interrupt on fm-task1`.
See `auth/AUTH.md` for the mechanics and `auth/test_authz.py` for the
allow/refuse proof.

## Contract map

The superset depends on a declared subset of firstmate surfaces, and
`schema/` owns that declaration.
Observed means visible but never depended on: the superset may read it for
context and must not break when it changes.
Depended-on means load-bearing: the entry pins a command plus flags, an
output shape, exit behavior, a stability tier, and a tested version, and a
stale pin fails validation naming the contract and the current pin.
Stable means the output schema is frozen and breaking changes need a new pin.
Evolving means the safe flag subset is pinned while the owning script may
still grow outside it.
Experimental means observed-only with no pin and no dependence.
Validate with `python3 schema/validate.py`, read the matrix view in
`schema/matrix.md`, and run `bash tests/mcp-schema.test.sh` for the proof.

## Conformance

`tests/conformance/` proves the adapter behaves like firstmate: the same
read inputs through the adapter and through firstmate's real `bin/fm-*.sh`
scripts agree.

```sh
bash tests/conformance/conformance.sh
FIRSTMATE_HOME=/path/to/firstmate bash tests/conformance/conformance.sh
```

Equivalence means the adapter's typed projection equals the owning
script's observable output (modulo the envelope wrap and the `generated`
timestamp). The adapter may be stricter than the script — traversal ids
are refused before any process starts while the raw script answers a lax
`unknown` — and the suite pins that direction; the reverse fails.
Conformance is side-effect-free by construction: only read tools dispatch,
every subprocess runs under a scratch `FM_HOME`, and each invocation is
captured carrying that scratch home. Without a firstmate checkout the
suite skips cleanly; see `tests/conformance/README.md`.

## Drift detection

Firstmate changes underneath the depended-on contracts, so `drift/`
watches the command surface and tells contract drift apart from noise.
`drift/baseline.json` seeds the observed inventory (165 `bin/fm-*.sh`
surfaces at firstmate rev `9bf454f4`, captured read-only from `--help`
output plus script headers — firstmate itself is never modified).

Snapshot the live checkout, then compare against the baseline:

```sh
python3 drift/snapshot.py --fm-home /path/to/firstmate -o /tmp/observed.json
python3 drift/check.py drift/baseline.json /tmp/observed.json --format markdown
```

`drift check` exits 0 when clean, 1 when drift is found, 2 on usage or
read errors. `--format json` emits the machine-readable report (summary
counts plus added/removed/changed sections); `markdown` and `text` are
the human-readable views of the same report.

Each differing field is classified per the design report vocabulary:
**feature drift** means the contract surface moved (command path, kind,
flag set, schema id hint, output contract) and a depended-on pin may
need updating; **behavior drift** means the same contract behaves or
documents differently (help text, file bytes, version) and is worth a
look without necessarily changing a pin. Added and removed surfaces are
always feature drift. Proof lives in `tests/test_drift.py` (diff
classes plus report shapes) and `tests/drift-check.test.sh` (CLI
behavior on inline fixtures).

Upstream shift (submodule pin vs upstream main) is a separate signal:

```sh
python3 drift/shift.py --format markdown
```

Exit 0 means the `sources/firstmate` pin tracks upstream main; exit 1
names the depended-on surfaces that moved (the port starting point)
apart from unrelated script churn; exit 2 is a usage or read error.

## Design choices

**Why typed tools, not shell.** Raw shell passes strings to scripts; the MCP
schema narrows every call to the safe subset up front (typed ids, bounded
text, no `--key`/`--raw` flags, no repo-mutation options). The server then
revalidates ids, paths, and approval strings, and the owning firstmate script
still fails closed. Three layers — schema, server, owning script — instead of
one.

**Why approval tiers.** Reads are free; anything authority-bearing or
externally visible costs an explicit per-action `I authorize` string, so a
convenient launch tool never feels routine while its downstream work may be
destructive. External sends additionally inherit relay consent and budgets
from the owning scripts.

**Why firstmate stays the implementation.** Duplicating fleet logic in this
layer would rot on every firstmate update. Every tool shells to the owning
`bin/` script, so policy lives in exactly one place and this repo tracks the
contract, not the code. See `FINDINGS.md` for the residual risks
(authority laundering chief among them) and the recommended local-only,
pinned-`FM_HOME` posture.

### MCP compatibility adapter

The adapter (`adapter/`, see [docs/mcp-adapter.md](docs/mcp-adapter.md)) is the only layer allowed to know First Mate internals.
Every MCP tool calls the adapter, the adapter shells to the owning `bin/fm-*.sh` script (never reimplements), validates ids/paths/text limits, and returns a typed result/error envelope.
Code-writing, landing, daemon-control, and direct repo-mutation surfaces have no tool and are refused by an explicit deny-list.

**The smarts-only line.** The owner order of 2026-09-13 drew this boundary:
launch yes, code no. The full-coverage prototype bundled dev-adjacent tools
and was trimmed to the 19 smarts-only tools shipped here. Rationale and the
ready-vs-not-ready ledger live in the notes of epic `task-5x79b`.

## Layout

- `fm_mcp_server.py` — stdio MCP server, stdlib only.
- `test_client.py` — 72-check end-to-end proof with a stub-home harness.
- `scripts/fm-mcp-launch.sh` — cutover launcher: pins one FM_HOME, local-only
  stdio transport, execs the proven server (Python default, TS on request).
- `scripts/cutover_prove.py` — cutover proof driver against scratch homes
  only; writes `CUTOVER-PROOF.md`.
- `CUTOVER-PROOF.md` — live scratch-home proof: read sweep, approval
  allow/refuse, relay-inert, and the JSON-lines audit log.
- `INVENTORY.md` — capability inventory and typed mapping.
- `FINDINGS.md` — smarts-only results and residual risks.
- `AUTH.md` — authorization tiers and the code-forbidden list.
- `auth/` — enforced tier assignments, approval check, and audit log,
  with `auth/test_authz.py` covering every tier.
- `schema/` — depended-on contract map, matrix view, and validator.
- `adapter/` — compatibility boundary (dispatcher, validators, typed envelope, deny-list); spec in `docs/mcp-adapter.md`.
- `drift/` — firstmate drift detection (observed-inventory snapshots, diff engine, report emitters, `check` CLI, seeded baseline).
- `tests/` — contract-map and adapter behavior tests.
- `LICENSE` — MIT.

## History

This root was rebuilt clean: the repo's initial seeding held a full firstmate
checkout by mistake, and branch `fm/clean-root` replaced the tree with the
MCP project only. Adaptations on the way: server resolves tool scripts from
`$FM_HOME/bin` when no checkout sits beside it, and the test client builds
stub firstmate homes so the proof runs standalone.

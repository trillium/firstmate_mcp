# Firstmate MCP — smarts layer over firstmate

## Contents

- [What this is](#what-this-is)
- [Quickstart](#quickstart)
- [Tools](#tools)
- [Authorization tiers](#authorization-tiers)
- [Contract map](#contract-map)
- [Conformance](#conformance)
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

Run the end-to-end proof (67 checks, self-contained — no checkout needed):

```sh
python3 test_client.py
```

The suite handshakes, lists tools, exercises every read, proves traversal and
validation refusals, proves approval gating on every authority-bearing tool,
and proves every removed code-writing surface answers unknown-tool.

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
- `test_client.py` — 67-check end-to-end proof with a stub-home harness.
- `INVENTORY.md` — capability inventory and typed mapping.
- `FINDINGS.md` — smarts-only results and residual risks.
- `AUTH.md` — authorization tiers and the code-forbidden list.
- `auth/` — enforced tier assignments, approval check, and audit log,
  with `auth/test_authz.py` covering every tier.
- `schema/` — depended-on contract map, matrix view, and validator.
- `adapter/` — compatibility boundary (dispatcher, validators, typed envelope, deny-list); spec in `docs/mcp-adapter.md`.
- `tests/` — contract-map and adapter behavior tests.
- `LICENSE` — MIT.

## History

This root was rebuilt clean: the repo's initial seeding held a full firstmate
checkout by mistake, and branch `fm/clean-root` replaced the tree with the
MCP project only. Adaptations on the way: server resolves tool scripts from
`$FM_HOME/bin` when no checkout sits beside it, and the test client builds
stub firstmate homes so the proof runs standalone.

# UPSTREAM-RESULTS

Seeded: 2026-09-17T19:13:18Z via `bash tests/upstream/run_upstream.sh` (`python3 tests/upstream/run_upstream.py --write-results`).

- upstream repo: `https://github.com/kunchenguid/firstmate.git`
- gitlink pin: `3eb5b6334a80e06083e3837f0032a5cec39b8e52`
- upstream root at seed time: `/Users/trilliumsmith/code/firstmate`
- ts runtime at seed time: `bun` (bun-primary, node-fallback; harness spawns the TS server via the proving runtime)
- contracts source: `schema/contracts.yaml`
- overall: **pass**

| test | contracts | upstream file | upstream ref | py | ts |
|---|---|---|---|---|---|
| fleet_snapshot | fleet_snapshot | fm-fleet-snapshot-view.test.sh | pass | pass | pass |
| backlog | backlog | (adapter-native) | skip | pass | pass |
| crew_state | crew_state | fm-crew-state.test.sh | pass | pass | pass |
| status_tail | status_tail | (adapter-native) | skip | pass | pass |
| send_message | send_message | fm-send-strict.test.sh | pass | pass | pass |
| spawn_crew | spawn_crew | fm-spawn-beads.test.sh | pass | pass | pass |
| scaffold_brief | scaffold_brief | fm-brief.test.sh | pass | pass | pass |

## Per-test detail

### fleet_snapshot

- upstream file: `fm-fleet-snapshot-view.test.sh`
- upstream ref: **pass** — exit 0; tail: ok - snapshot event hints follow reconciled current state
ok - durable fold keeps an open decision past a later unrelated event
ok - a live secondmate endpoint preserves unrelated open decisions
ok - durable captain-held transfer closes the duplicate live status decision
ok - durable fold clears a decision only on a keyed resolution
ok - a completed scout's stale decision surfaces as
- py: **pass**, ts (bun): **pass**
  - `fleet_snapshot:fleet_snapshot {}` — py pass, ts pass

### backlog

- upstream file: `(adapter-native file-tail reference)`
- upstream ref: **skip** — no owning upstream test (adapter-native surface)
- py: **pass**, ts (bun): **pass**
  - `backlog:backlog {}` — py pass, ts pass

### crew_state

- upstream file: `fm-crew-state.test.sh`
- upstream ref: **pass** — exit 0; tail: ok - dead window ignores stale status log
ok - closed pane still reports a terminal run-step
ok - closed pane still reports an active run-step
ok - no timeout command uses perl bound
ok - scout skips the run lookup
ok - torn-down worktree is handled gracefully
ok - missing meta is handled gracefully
ok - crew_is_provably_working absorbs a validating crew found only via the runs-list 
- py: **pass**, ts (bun): **pass**
  - `crew_state:crew_state {'id': 'no-such-crew'}` — py pass, ts pass
  - `crew_state:crew_state {'id': '../escape'}` — py pass, ts pass

### status_tail

- upstream file: `(adapter-native file-tail reference)`
- upstream ref: **skip** — no owning upstream test (adapter-native surface)
- py: **pass**, ts (bun): **pass**
  - `status_tail:status_tail {'id': 't1', 'lines': 3}` — py pass, ts pass
  - `status_tail:status_tail {'id': 'ghost-crew'}` — py pass, ts pass
  - `status_tail:status_tail {'id': '../escape'}` — py pass, ts pass

### send_message

- upstream file: `fm-send-strict.test.sh`
- upstream ref: **pass** — exit 0; tail: ok - fm-send strict: exact task/lane ids resolve through home metadata
ok - fm-send --key: exit status follows delivery, and an undelivered key never reports success
ok - fm-send strict: unset FM_HOME fails before target resolution
ok - fm-send strict: unresolvable selectors do not fall back to tmux
ok - fm-send strict: prefixless herdr pane ids are rejected before tmux fallback
ok -
- py: **pass**, ts (bun): **pass**
  - `send_message:send_message {'target': 't1', 'text': '/bad slash'}` — py pass, ts pass
  - `send_message:send_message {'target': '../escape', 'text': 'hi'}` — py pass, ts pass
  - `send_message:send_message {'target': 't1', 'text': 'hello from upstream harness'}` — py pass, ts pass

### spawn_crew

- upstream file: `fm-spawn-beads.test.sh`
- upstream ref: **pass** — exit 0; tail: ok - a spawn with --beads <id> records beads_id= in meta and stamps the bead dispatch=sent/lifecycle=sent
ok - a spawn without --beads records no beads_id= and never invokes the bead stamp
ok - a spawn under config/backlog-backend=beads auto-links a bead (no --beads needed) and stamps dispatch=sent/lifecycle=sent
ok - an explicit --beads id wins over auto-resolution under the beads b
- py: **pass**, ts (bun): **pass**
  - `spawn_crew:spawn_crew {'task_id': 'no-such-id', 'project': 'no-such-project', 'mode': 'local-only', 'yolo': 'off'}` — py pass, ts pass
  - `spawn_crew:spawn_crew {'task_id': 'no-such-id', 'project': 'no-such-project', 'mode': 'local-only', 'yolo': 'off', 'approval': 'I authorize upstream preservation proof'}` — py pass, ts pass

### scaffold_brief

- upstream file: `fm-brief.test.sh`
- upstream ref: **pass** — exit 0; tail: ok - fm-brief.sh: --herdr-lab uses its quoted Firstmate-owned helper path
ok - fm-brief.sh: ship and scout scaffolds make omitted Herdr intent fail-visible
ok - fm-brief.sh: Herdr lab contract covers scouts and rejects secondmate misuse
ok - fm-brief.sh: --no-projects scaffolds a project-less charter and guards misuse
ok - fm-brief.sh: marked requests avoid generic acknowledgements a
- py: **pass**, ts (bun): **pass**
  - `scaffold_brief:scaffold_brief {'task_id': 'no-such-id', 'project': 'no-such-project', 'mode': 'scout'}` — py pass, ts pass
  - `scaffold_brief:scaffold_brief {'task_id': 'no-such-id', 'project': 'no-such-project', 'mode': 'bogus', 'approval': 'I authorize upstream preservation proof'}` — py pass, ts pass

## Divergences (explicit only)

A test ceases to be expected-to-pass only with an entry below pointing at the manifest reason. All four seeded divergences are pre-existing intentional behavioral deltas already pinned by conformance / test_client; none of them flips a row above to expected-fail on this seed run.

### div-stricter-id: Adapter stricter than script on traversal ids

- reason: Security hardening: id validation + path confinement before any process starts. Pinned as stricter-is-conformant in tests/conformance/README.md and tests/conformance/test_conformance.py CrewStateEquivalenceTest::test_adapter_stricter_than_script_on_traversal.
- affected: crew_state, status_tail
- upstream: Raw fm-crew-state.sh answers a lax `unknown` line for traversal ids such as ../escape.
- ours: MCP refuses with invalid-id / invalid-target and spawns no process.
- replacement tests: tests/conformance/test_conformance.py::CrewStateEquivalenceTest::test_adapter_stricter_than_script_on_traversal; tests/conformance/test_conformance.py::StatusTailEquivalenceTest::test_status_tail_rejects_traversal_without_read; tests/upstream py/ts projection checks for crew_state traversal refusal

### div-approval-gating: Tier 3/4 approval gate has no upstream counterpart

- reason: Authority-laundering mitigation per AUTH.md and FINDINGS.md: every authority-bearing or externally visible MCP tool requires an explicit per-call approval string starting with 'I authorize'. Upstream scripts rely on yolo posture / relay consent instead.
- affected: spawn_crew, scaffold_brief
- upstream: bin/fm-spawn.sh and bin/fm-brief.sh run without an MCP-style approval string.
- ours: MCP spawn_crew / scaffold_brief (plus lifecycle, decision, relay tools) refuse without approval (approval-required), then delegate to the owning script which still enforces its own guards.
- replacement tests: test_client.py launch-tool refusal paths (approval gating on every authority-bearing tool); tests/upstream py/ts projection checks for spawn_crew and scaffold_brief approval refusal

### div-deny-list: Smarts-only deny-list has no MCP tool

- reason: Smarts-only line per README.md (launch ability yes, development ability no): code-writing, landing, daemon, and direct repo-mutation surfaces are refused as unknown-tool. Firstmate remains the implementation; this repo is only the typed doorway.
- affected: (no depended-on contract; upstream-only surfaces)
- upstream: Upstream fm-promote.sh, fm-teardown.sh, fm-pr-check.sh, fm-pr-merge.sh, fm-merge-local.sh and daemon/watch/repo tools exist and are tested upstream.
- ours: MCP answers unknown-tool for promote_scout, teardown_crew, arm_pr_check, merge_pr, merge_local, daemon_*, watch_*, repo_*; no stub, no delegation.
- replacement tests: test_client.py unknown-tool proof for every removed surface

### div-envelope: Typed ok/err envelope vs raw script output

- reason: MCP contract per adapter/envelope.py and fm_mcp_server.py: every dispatch returns exactly one ok/err shape with stable error codes, schema-id validation, output caps (1MB server / 128KB adapter), and timeouts (180s server with process-group kill). Raw scripts print free text / raw JSON.
- affected: fleet_snapshot, backlog, crew_state, status_tail, send_message, spawn_crew, scaffold_brief
- upstream: Scripts print raw lines or raw snapshot JSON with a live generated timestamp.
- ours: MCP wraps projections in the typed envelope (modulo the generated timestamp, which moves every run) and fails closed on schema mismatch, cap, or timeout.
- replacement tests: tests/mcp-adapter.test.py envelope shape checks; test_client.py envelope-fixture proof (>30s, >128KB snapshot stays covered); tests/conformance/test_conformance.py snapshot/backlog equivalence (modulo generated)

## Repro

```sh
bash tests/upstream/run_upstream.sh
python3 tests/upstream/run_upstream.py --format json
```

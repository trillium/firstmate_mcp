# UPSTREAM-RESULTS

Seeded: 2026-09-20T23:35:28Z via `bash tests/upstream/run_upstream.sh` (`python3 tests/upstream/run_upstream.py --write-results`).

- upstream repo: `https://github.com/kunchenguid/firstmate.git`
- gitlink pin: `1b1b6e051dafc9dcabe3ef0a7d4a64bd40a45567`
- upstream root at seed time: `sources/firstmate`
- ts runtime at seed time: `bun` (bun-primary, node-fallback; harness spawns the TS server via the proving runtime)
- contracts source: `schema/contracts.yaml`
- overall: **pass**

| test | contracts | upstream file | upstream ref | ts |
|---|---|---|---|---|
| fleet_snapshot | fleet_snapshot | fm-fleet-snapshot-view.test.sh | pass | pass |
| backlog | backlog | (native) | skip | pass |
| crew_state | crew_state | fm-crew-state.test.sh | pass | pass |
| status_tail | status_tail | (native) | skip | pass |
| send_message | send_message | fm-send-strict.test.sh | pass | pass |
| spawn_crew | spawn_crew | fm-spawn-batch.test.sh | pass | pass |
| scaffold_brief | scaffold_brief | fm-brief.test.sh | pass | pass |

## Per-test detail

### fleet_snapshot

- upstream file: `fm-fleet-snapshot-view.test.sh`
- upstream ref: **pass** — exit 0; tail: ok - undated captain holds age after a configurable threshold, decided only from structured fields
ok - captain-hold buckets are total, mutually exclusive, and never decided by prose
ok - main_inventory discloses orphan/unstructured and clears when inventory is consistent
ok - backlog normalization preserves strict roles and resolves every blocker compatibly
ok - snapshot event hints
- ts (bun): **pass**
  - `fleet_snapshot:fleet_snapshot {}` — ts pass

### backlog

- upstream file: `(native file-tail reference)`
- upstream ref: **skip** — no owning upstream test (adapter-native surface)
- ts (bun): **pass**
  - `backlog:backlog {}` — ts pass

### crew_state

- upstream file: `fm-crew-state.test.sh`
- upstream ref: **pass** — exit 0; tail: ok - R3 historical inventory yields to the current busy pane
ok - R3 historical inventory yields to current worker status
ok - superseded cancelled run preserves the replacement review gate
ok - competing live runs report unknown with both run ids
ok - newer failed run remains failed beside an older live run
ok - missing run selection reports unknown with candidate ids
ok - wrong-id 
- ts (bun): **pass**
  - `crew_state:crew_state {'id': 'no-such-crew'}` — ts pass
  - `crew_state:crew_state {'id': '../escape'}` — ts pass

### status_tail

- upstream file: `(native file-tail reference)`
- upstream ref: **skip** — no owning upstream test (adapter-native surface)
- ts (bun): **pass**
  - `status_tail:status_tail {'id': 't1', 'lines': 3}` — ts pass
  - `status_tail:status_tail {'id': 'ghost-crew'}` — ts pass
  - `status_tail:status_tail {'id': '../escape'}` — ts pass

### send_message

- upstream file: `fm-send-strict.test.sh`
- upstream ref: **pass** — exit 0; tail: ok - fm-send strict: exact task/lane ids resolve through home metadata
ok - fm-send --key: exit status follows delivery, and an undelivered key never reports success
ok - fm-send strict: unset FM_HOME fails before target resolution
ok - fm-send strict: unresolvable selectors do not fall back to tmux
ok - fm-send strict: prefixless herdr pane ids are rejected before tmux fallback
ok -
- ts (bun): **pass**
  - `send_message:send_message {'target': 't1', 'text': '/bad slash'}` — ts pass
  - `send_message:send_message {'target': '../escape', 'text': 'hi'}` — ts pass
  - `send_message:send_message {'target': 't1', 'text': 'hello from upstream harness'}` — ts pass

### spawn_crew

- upstream file: `fm-spawn-batch.test.sh`
- upstream ref: **pass** — exit 0; tail: ok - batch dispatch re-execs and reports every id=repo pair
ok - batch detection: single pair batches, non-pair rejected, single-task and slash-id stay single
ok - batch dispatch requires the shared ship delivery contract before any pair runs
ok - scout batch refuses ship delivery flags instead of ignoring them
ok - projects/ paths are scoped through the firstmate home for single-tas
- ts (bun): **pass**
  - `spawn_crew:spawn_crew {'task_id': 'no-such-id', 'project': 'no-such-project', 'mode': 'local-only', 'yolo': 'off'}` — ts pass
  - `spawn_crew:spawn_crew {'task_id': 'no-such-id', 'project': 'no-such-project', 'mode': 'local-only', 'yolo': 'off', 'approval': 'I authorize upstream preservation proof'}` — ts pass

### scaffold_brief

- upstream file: `fm-brief.test.sh`
- upstream ref: **pass** — exit 0; tail: ok - fm-brief.sh: --herdr-lab emits the complete hard safety contract
ok - fm-brief.sh: --herdr-lab uses its quoted Firstmate-owned helper path
ok - fm-brief.sh: ship and scout scaffolds make omitted Herdr intent fail-visible
ok - fm-brief.sh: the documented {TASK} and {FIRSTMATE_SPEC} fills cannot corrupt the Herdr safety gate
ok - fm-brief.sh: Herdr lab contract covers scouts and r
- ts (bun): **pass**
  - `scaffold_brief:scaffold_brief {'task_id': 'no-such-id', 'project': 'no-such-project', 'mode': 'scout'}` — ts pass
  - `scaffold_brief:scaffold_brief {'task_id': 'no-such-id', 'project': 'no-such-project', 'mode': 'bogus', 'approval': 'I authorize upstream preservation proof'}` — ts pass

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

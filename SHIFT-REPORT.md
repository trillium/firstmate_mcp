# Upstream shift report (re-pin: 2026-09-19)

Re-pin of the Kun upstream radar (`sources/firstmate` submodule pin)
to `65a3bac6031286b4058360859a9522a50a09bb14` (14 upstream commits ahead of `3eb5b6334a80e06083e3837f0032a5cec39b8e52`),
mapped onto the depended-on contracts in `schema/contracts.yaml`.

- previous radar pin (gitlink `sources/firstmate`):
  `3eb5b6334a80e06083e3837f0032a5cec39b8e52`
- new radar pin (gitlink `sources/firstmate`):
  `65a3bac6031286b4058360859a9522a50a09bb14`
- upstream main (`https://github.com/kunchenguid/firstmate.git`):
  `65a3bac6031286b4058360859a9522a50a09bb14`
- working-copy fork (`https://github.com/trillium/firstmate.git`):
  `86c035336bf9e136dd44d76e7d46e16d260fac8f` (untouched; live fleet runs fork)
- verdict: **6 depended-on surfaces moved (PORT)**, **20 other changed scripts (IGNORE)**.
- port judgment: **trivial replay across all 6 moved surfaces** (no contract or schema changes required; all proofs green).

## PORT (depended-on surfaces that moved)

6 depended-on surfaces moved between `3eb5b633` and `65a3bac6`. All 6 are trivial replays requiring no contract or schema modifications:

| contract | owning script | stability | upstream change | port cost judgment |
|---|---|---|---|---|
| handoff_move | `bin/fm-backlog-handoff.sh` | evolving | Guarded `"${to_move[@]+"${to_move[@]}"}"` for bash 3.2 empty-array nounset safety (#4778) | **Trivial replay** |
| crew_state | `bin/fm-crew-state.sh` | stable | Enhanced `no-mistakes` run selection via `axi` overview with run IDs/order; appends `run: <id>` to detail (#4476, #4738) | **Trivial replay** |
| lint_versions | `bin/fm-lint.sh` | stable | Added `--partition <1of2\|2of2>` for CI sharding; refactored file weight calculations (#4800) | **Trivial replay** |
| lock_status | `bin/fm-lock.sh` | stable | Added `.lock-session` sidecar and model-loop anchor PID to preserve lock ownership across Claude helper recycling (#4894) | **Trivial replay** |
| send_message | `bin/fm-send.sh` | stable | Added lease check `fm_lease_forbid_branch` for `--resolve-key` when resolving decisions under away posture (#4889) | **Trivial replay** |
| spawn_crew | `bin/fm-spawn.sh` | evolving | Kimi 2.0.0 folder-trust dialog loop (#4799); `COMPACT_ADVISER_DISABLE=1` export (#4877); away posture spend caps (#4889) | **Trivial replay** |

## IGNORE (other changed scripts / noise)

20 other scripts changed upstream outside the depended-on contract set:
multiplexer/backend adapters (`cmux.sh`, `herdr.sh`, `tmux.sh`, `zellij.sh`, `fm-backend.sh`),
session lock and Claude hook lifecycle helpers (`fm-claude-stop-autoarm.sh`, `fm-session-lock-lib.sh`, `fm-session-start.sh`, `fm-startup-network.sh`),
away-posture orchestration (`fm-afk-return.sh`, `fm-lease-lib.sh`, `fm-branch-prompt.sh`),
captain-hold Beads due-date handling (`fm-captain-hold.sh`),
and watcher/test/merge plumbing (`fm-watch.sh`, `fm-turnend-guard.sh`, `fm-mail-check.sh`, `fm-nm-run-lib.sh`, `fm-test-run.sh`, `fm-merge-local.sh`, `fm-pr-merge.sh`).

## Proof & Verification Status

All proofs and test suites executed against the re-pinned radar pass 100% green:

- **Schema & Contracts:** `python3 schema/validate.py` (via `tests/mcp-schema.test.sh`) — **OK**
- **Manifest:** `python3 manifest/validate.py` (via `tests/fm-manifest.test.sh`) — **OK**
- **Coverage Check:** `scripts/gen_coverage.py --check` (via `tests/fm-coverage.test.sh`) — **OK** (158 rows classified)
- **Upstream Conformance:** `FIRSTMATE_HOME="$PWD/sources/firstmate" bash tests/conformance/conformance.sh` — **63/63 pass**
- **TS Parity & Conformance:** `bash tests/conformance/ts-parity.sh` — **333/333 pass** under bun and node
- **Standalone Server Client Proof:** `python3 test_client.py` — **209/209 pass**
- **TypeScript Test Suite:** `(cd ts && npm test)` — **333/333 pass**
- **Upstream Preservation Harness:** `bash tests/upstream/run_upstream.sh` — **all pass**, re-seeded `UPSTREAM-RESULTS.md`

## Repro

```sh
python3 drift/shift.py --format text
python3 drift/shift.py --format json
bash tests/conformance/conformance.sh
bash tests/conformance/ts-parity.sh
python3 test_client.py
```

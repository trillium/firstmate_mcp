# Upstream shift report (re-pin: 2026-09-19)

Re-pin of the Kun upstream radar (`sources/firstmate` submodule pin)
to `1b1b6e051dafc9dcabe3ef0a7d4a64bd40a45567` (3 upstream commits ahead of `65a3bac6031286b4058360859a9522a50a09bb14`),
mapped onto the depended-on contracts in `schema/contracts.yaml`.

- previous radar pin (gitlink `sources/firstmate`):
  `65a3bac6031286b4058360859a9522a50a09bb14`
- new radar pin (gitlink `sources/firstmate`):
  `1b1b6e051dafc9dcabe3ef0a7d4a64bd40a45567`
- upstream main (`https://github.com/kunchenguid/firstmate.git`):
  `1b1b6e051dafc9dcabe3ef0a7d4a64bd40a45567`
- working-copy fork (`https://github.com/trillium/firstmate.git`):
  `86c035336bf9e136dd44d76e7d46e16d260fac8f` (untouched; live fleet runs fork)
- verdict: **2 depended-on surfaces moved (PORT)**, **4 other changed scripts (IGNORE)**.
- port judgment: **trivial replay across both moved surfaces** (no contract or schema changes required; all proofs green).

## PORT (depended-on surfaces that moved)

2 depended-on surfaces moved between `65a3bac6` and `1b1b6e05`. Both are trivial replays requiring no contract or schema modifications:

| contract | owning script | stability | upstream change | port cost judgment |
|---|---|---|---|---|
| send_message | `bin/fm-send.sh` | stable | Batched multi-key decision closes (`fm_send_close_resolved_keys`) and updated self-announced status appends (#4895) | **Trivial replay** (plain-text steer interface unaffected) |
| spawn_crew | `bin/fm-spawn.sh` | evolving | Removed experimental label for Herdr backend; silent auto-detection (#4972) | **Trivial replay** (safe subset flags unaffected) |

## IGNORE (other changed scripts / noise)

4 other scripts changed upstream outside the depended-on contract set:
multiplexer/backend adapters (`bin/backends/herdr.sh`, `bin/fm-backend.sh`),
captain-held multi-key close batching (`bin/fm-captain-hold.sh`),
and internal wake-queue status dedup library (`bin/fm-wake-lib.sh`).
CI timeout standardization in upstream workflow (`ci.yml`, docs, tests) touched no bin scripts.

## Proof & Verification Status

All proofs and test suites executed against the re-pinned radar pass 100% green:

- **Schema & Contracts:** `python3 schema/validate.py` (via `tests/mcp-schema.test.sh`) — **OK**
- **Manifest:** `python3 manifest/validate.py` (via `tests/fm-manifest.test.sh`) — **OK**
- **Coverage Check:** `scripts/gen_coverage.py --check` (via `tests/fm-coverage.test.sh`) — **OK** (158 rows classified)
- **TS Parity & Conformance:** `bash tests/conformance/ts-parity.sh` — **335/335 pass** under bun and node
- **TypeScript Test Suite:** `(cd ts && npm test)` — **335/335 pass**
- **Upstream Preservation Harness:** `bash tests/upstream/run_upstream.sh` — **all pass**, re-seeded `UPSTREAM-RESULTS.md`
- **Shift Schedule & Atom Feed Tests:** `bash tests/mcp-shift-schedule.test.sh` + `bash tests/mcp-shift-atom.test.sh` — **OK**
- **Authz & Drift Tests:** `bash tests/fm-mcp-authz.test.sh` + `bash tests/drift-check.test.sh` — **OK**

## Repro

```sh
python3 drift/shift.py --format text
python3 drift/shift.py --format json
bash tests/conformance/ts-parity.sh
bash tests/upstream/run_upstream.sh
```

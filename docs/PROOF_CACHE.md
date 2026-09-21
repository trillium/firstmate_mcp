# AST-Based Unit-Test Proof Caching

## Overview

Content-addressed proof caching for explicitly bounded unit tests in `firstmate_mcp`.

When an autonomous agent or CI runs the test suite, a unit test that has already passed against an identical AST representation of its target code unit does not need to re-execute. This drastically reduces duplicate compute cycles between local development iterations and CI without relying on heavyweight build systems like Bazel.

## Core Invariants

1. **Fail-Closed Explicit Contracts**:
   Cacheability is an explicit per-test contract defined in `ts/proof-cache/contracts.json`. Ineligible tests (multi-unit, integration, server, timing, receipts, conformance) always execute normally.
2. **AST-Grep Primitive & Normalization**:
   Uses `ast-grep` (`@ast-grep/napi` / CLI) to parse TypeScript AST nodes for both the target unit (function/method/class) and test block (`describe`/`it`). Comments, trivia, trailing commas, semicolons, and whitespace are normalized so formatting changes do not invalidate proofs, while semantic changes immediately invalidate proofs.
3. **Committed Git-Backed Manifest**:
   Committed in `ts/proof-cache/manifest.json`. Records `status: "PASS"`, test AST fingerprint, target AST fingerprint, timestamp, runner, runtime, and git commit provenance.
4. **No Transitive Dependency Inference in v1**:
   Proofs bind this exact test against this exact AST node of the explicitly identified code unit.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      test-runner.mjs                        │
└──────────────┬───────────────────────────────┬──────────────┘
               │                               │
       [Evaluate Proofs]              [Execute Remainder]
               │                               │
               ▼                               ▼
    ts/src/proof/engine.ts               Bun Test / Node
               │                               │
      ast-grep AST Parser                      │
               │                               │
    ts/src/proof/fingerprint.ts                │
               │                               ▼
    (Compare with manifest.json)     (Record passing proofs)
```

## Contract Specification (`ts/proof-cache/contracts.json`)

```json
{
  "id": "validators.validId",
  "testFile": "tests/validators.test.ts",
  "testPattern": "validId",
  "testKind": "describe",
  "target": {
    "targetFile": "src/validators.ts",
    "targetKind": "function",
    "targetName": "validId"
  },
  "description": "Pure input validator for ID slugs",
  "bounded": true
}
```

## Manifest Specification (`ts/proof-cache/manifest.json`)

```json
{
  "version": 1,
  "generatedAt": "2026-09-20T22:35:37.166Z",
  "proofs": {
    "validators.validId": {
      "status": "PASS",
      "testFingerprint": "f9a8953ce9b978f228a71c735976818e273c4f86c661111be3d409f5b5b04ca7",
      "targetFingerprint": "96436b73b3d34a7c771376e4097de0484cad3ce029e28b97ddefdcb493114f92",
      "testFile": "tests/validators.test.ts",
      "testUnit": "describe:validId",
      "targetFile": "src/validators.ts",
      "targetUnit": "function:validId",
      "provenance": {
        "runner": "bun test",
        "runtime": "node v24.12.0 (bun compat)",
        "verifiedAt": "2026-09-20T22:35:37.166Z",
        "gitCommit": "9cb02d7d8b4ec62e5bebbd75fe3d98e688e07452",
        "astGrepVersion": "0.45.3"
      }
    }
  }
}
```

## CLI Commands

From `ts/`:

- `pnpm run proof:check` / `node scripts/proof-cache.mjs check`:
  Evaluates all proof contracts against current source code and prints an execution plan.
- `pnpm run proof:explain [filter]` / `node scripts/proof-cache.mjs explain <filter>`:
  Explains the AST fingerprints, normalized AST representation, and verification status for specific test contracts.
- `pnpm run proof:update` / `node scripts/proof-cache.mjs update`:
  Recomputes AST fingerprints for all passing tests and repins the manifest.
- `pnpm run proof:bench` / `node scripts/proof-cache.mjs bench`:
  Benchmarks compile vs proof-validation vs test-execution wall-clock timing.
- `node scripts/test-runner.mjs [--bun|--node] [--all] [--no-cache]`:
  Test runner with proof caching active by default; pass `--all` or `--no-cache` to force full execution.

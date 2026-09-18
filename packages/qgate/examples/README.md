# `packages/qgate/examples/`

## `valid/five-stage.json`

A **legal** five-stage configuration (`requirements → design → build → review →
verify`) that exercises every one of the seven check types and stays inside the
frozen `configSchemaVersion = "1.0"` field tables. It is deliberately
**portable**: every path in it is relative to the project root.

This file *is* the self-contained runnable example (there is no separate
"self-contained" variant any more): all of its paths resolve inside its own project
root, so copying it next to the artefacts in the table below yields a runnable gate
without touching the repository. A byte-identical duplicate,
`valid/self-contained-five-stage.json`, existed until t41 with **zero references**
from this package, the tests, the CI templates or the docs — an unmaintained fork that
only made `verification-t9/tools/schema-eval.mjs` validate the same content twice. It
was deleted; the surviving file keeps the semantics, and that tool's `positives` list
still contains `valid/five-stage.json` (its duplicate entry is the verifier's to drop).

To run it, materialise a project root that contains the artefacts it declares
(this is exactly what `test/config-and-run-result.test.mjs` does, so the example
cannot silently rot):

| declared path | used by |
|---|---|
| `REQUIREMENTS.md` | `req-doc-exists`, `req-ids-present` |
| `index.json` | `req-index-valid`, `trace-complete` |
| `openapi.yaml` | `interface-exists`, `contract-fields-present` |
| `package.json` | `no-dep` |
| `severity-mix.json` | `severity-mix` |
| `test/*.test.mjs` (≥ 2) | `unit-tests` |
| `invalid/*.json` (≥ 3) | `negative-fixtures` |
| `trace-matrix.json` | `trace-complete` |
| `TODO.md` (absent, advisory) | `no-loose-ends` |

```bash
# from the repository root, after copying the example next to its artefacts
node packages/qgate/bin/qgate.mjs check --config <project-root>/qgate.config.json --json
```

## `invalid/*.json`

Six counter-example configurations. Each one **must** make `qgate check` exit `2`
with `error.code="CONFIG_INVALID"` and a JSON Pointer, and must never start a run:

| file | violation | pointer |
|---|---|---|
| `unknown-check-type.json` | `check.type="file_exist"` | `/gates/0/checks/0/type` |
| `unknown-stage.json` | `gate.stage="planning"` | `/gates/0/stage` |
| `missing-version.json` | no `version` | `/version` |
| `duplicate-check-id.json` | repeated `check.id` | `/gates/0/checks/1/id` |
| `bad-provider-type.json` | `provider.type="neural-network"` | `/provider/type` |
| `empty-gates.json` | `gates: []` | `/gates` |

## `severity-mix.json`

Recorded severity/confidence gating evidence for `REQ-QUALITY-GATE-013`: only a
finding with `confidence >= threshold` **and** `severity ∈ {high, blocker}` may
become a blocker; everything else is downgraded with an explicit reason.

## `fixtures/provider-recordings.json`

Offline recordings for the `scripted` provider. Regenerate with
`node packages/qgate/scripts/record-fixtures.mjs`. A request without a matching
fingerprint is a deterministic failure — the engine never falls back to a network
call.

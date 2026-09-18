# `packages/qgate/scripts/`

Maintenance tooling that is part of the deliverable (not scratch code).
Everything here is offline, dependency-free and runnable from any cwd.

| script | purpose |
|---|---|
| `run-check.mjs` | Run one built-in check type against a directory or a throwaway temp tree: `node packages/qgate/scripts/run-check.mjs file_exists .` |
| `record-fixtures.mjs` | Regenerate `examples/fixtures/provider-recordings.json`, the offline recordings the `scripted` provider replays. |
| `reset-demo-evidence.mjs` | Reset the demo fixture's ledger state to its shipped baseline (no run ids, the frozen 16 test ids). Run before hands-off verification so the fixture starts clean. |
| `tree-sha256.mjs` | Read-only tree fingerprint (`files=N treeSha256=…`) for evidencing that a directory was not modified: `node packages/qgate/scripts/tree-sha256.mjs schemas docs`. |

## Root `package.json` scripts

All of these run offline with no `npm install`:

| script | what it does | footnote |
|---|---|---|
| `npm test` | the engine's own suites: `config-and-run-result`, `pipeline-and-checks`, `acceptance` | [1] |
| `npm run test:contract` | the schema-conformance suite (`schema-contract.test.mjs`, owner: architect) | [2] |
| `npm run test:all` | every suite in `packages/qgate/test/` in one run (glob; nothing hidden) | [1] |
| `npm run check` / `check:json` / `check:summary` | five-stage gate run over `demo/qgate.config.json` | |
| `npm run contract` | `qgate contract --check` self-check (`CONTRACT_DRIFT` ⇒ exit 3) | |
| `npm run trace` | prints the trace matrix of the demo configuration | |
| `npm run preview` | deterministic selection/grouping/rule preview of `demo/mini-service` | |
| `npm run report` | renders a Markdown report from the newest ledger | [3] |
| `npm run verify` | the full pipeline as JSON (the `verify` stage entry point) | |

**Footnotes**

[1] Some sandboxes deny the piped child-process stdio that per-file test isolation
needs, which makes plain `node --test <dir>` fail with `spawn EPERM`. Disabling
isolation runs the suites through the same `node:test` API in one process — same
assertions, same counts, same exit code. Note that
`--experimental-test-isolation=none` with a **directory** argument is not supported
by Node (it tries to import the directory as a module), so the scripts pass explicit
files (or a quoted glob that Node expands itself, which works from cmd.exe too).

[2] Owned by the architect: it checks `schemas/*.schema.json` against the §5 field
tables. **It currently fails** with
`config:humanGate: surplus [gateId]` because `schemas/config.schema.json`
(2026-09-18 02:35) declares `humanGate.gateId` while the suite's frozen list in
`schema-contract.test.mjs` (02:17) still reads
`'config:humanGate': ['role', 'approvalRecord', 'enforcement']`. The one-line fix
belongs to that file's owner; `npm test` (the engine's own suites) is unaffected.

[3] `report` reads the newest evidence ledger, so at least one `check` run must have
happened first. On a freshly reset fixture there is no ledger and the command exits
2 with `no ledger found under …; run "qgate check" first`. Run `npm run verify`
first (it performs a full run), then `npm run report`.

## Config-path semantics (relevant when comparing working directories)

`--config` is resolved against the **current working directory**, so the same
relative string is only usable from a directory where that path exists. Once the
file is found, the project root is inferred from the **config file's own location**,
so the resulting RunResult does not depend on the cwd.

```bash
# same RunResult (0 leaf differences after stripping the four runtime fields)
cd .                  && node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json
cd packages/qgate     && node packages/qgate/bin/qgate.mjs check --config ../../demo/qgate.config.json

# from a foreign cwd the repo-relative path cannot be resolved -> exit 2 CONFIG_NOT_FOUND
cd packages/qgate     && node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json
```

Use `--root <dir>` to pin the project root explicitly instead of inferring it.

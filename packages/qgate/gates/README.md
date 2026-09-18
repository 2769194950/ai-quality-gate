# Contract self-description record (docs/01-architecture.md §9.3)

`contract.json` is the **frozen** mapping that `qgate contract --check` compares the
built-in contract against:

- `stages` — the five stages in fixed order (`requirements → design → build → review → verify`);
- `humanGates` — exactly three handover gates with role and default `approvalRecord`;
- `checkTypes` — the seven `check.type` values;
- `exitCodes` — `0=passed`, `1=gate_failed`, `2=config_error`, `3=internal_error`;
- `commands` — the six CLI commands with their command-specific parameters.

Any mismatch makes `qgate contract --check` exit `3` with `error.code="CONTRACT_DRIFT"`.
The record is regenerated only through a deliberate contract change.

Regenerate (from the repository root):

```bash
node -e "import('./packages/qgate/src/contract.mjs').then(async (m) => { const fs = await import('node:fs'); const path = await import('node:path'); const { describeContract } = m; const { stringifyJson } = await import('./packages/qgate/src/util/fsx.mjs'); const d = describeContract(); fs.writeFileSync(path.join('packages','qgate','gates','contract.json'), stringifyJson(d)); })"
```

---

# The SAFE_001 / SAFE_003 scan surface (coverage boundary, stated explicitly)

`SAFE_001` (no key reads) and `SAFE_003` (no network call surface) inspect a
**narrowed** file set. This section records the narrowing, its reason, and its cost —
this is a **reduction of the inspected surface**, not merely noise removal.

## What the default surface contains

| category | default | reason |
|---|---|---|
| code / config (`.mjs`, `.js`, `.cjs`, `.ts`, `.json`, `.yaml`, `.yml`, `.toml`, `.sh`, `.ps1`, `.env`, …) | **scanned** | the implementation surface |
| prose (`.md`, `.txt`, `.rst`, `.adoc`) | excluded | a document can only *name* a construct (`process.env.X` written in markdown); it cannot read a key or open a socket. Scanning prose produced 61/58 hits on this repository's own contract text |
| test fixtures (`test/`, `tests/`, `__tests__/`, `fixtures/`, `*.test.*`, `*.spec.*`) | excluded | a suite that sets sentinel key variables *to prove the code does not use them* is not a key read |
| generated / evidence dirs (`.git`, `node_modules`, `.qgate`, `verification`, `verification-t9`, `coverage`, `dist`, `build`, `artifacts`, `.cache`) | skipped, and **not counted** | they echo this policy's own output; counting them would also make the metric depend on the previous run (REQ-010) |

Measured on this repository (2026-09-18): **135 candidate files → 96 scanned**;
excluded: 11 prose, 23 fixtures, 5 other extensions, 0 oversize, plus the generated /
evidence directories (named above, deliberately not counted). For comparison, in t26 —
before the generated directories were taken out of the count — the raw walk was
264 files and 96 were scanned.

Every run publishes this summary as a machine-readable
`metrics.scanSurface` field in the policy check's evidence, so "96 files scanned" is
visible in the output rather than only in a commit message:

```json
{"candidates":135,"scanned":96,"excluded":{"prose":11,"fixtures":23,"otherExtension":5,"oversize":0,
 "skippedDirectories":[".git","node_modules",".qgate","coverage","dist","build",".cache","verification","verification-t9","artifacts"]}}
```

## The cost of the narrowing (known blind spot)

**A real key hard-coded inside a `.md` file or inside a test fixture is NOT detected
by the default surface.** For `SAFE_001` this is defensible — the policy asserts the
absence of key *reads*, and prose cannot read — but it is a genuine coverage gap and
is stated here rather than left implicit. The same applies to a network call surface
that only appears in prose.

### Boundary 4 (t34): comment syntax inside scanned code is skipped

Matching runs on the file text with **comment syntax blanked** (`//` and `/* … */`,
the syntax of the scanned JS/TS/JSON/YAML surface). `#`-commented lines in the
shell/Python files that the extension list also admits are **not** blanked — they keep
being treated as code (fail-closed, no new false negative there). The blanking
preserves every byte offset and line break, so a violation still quotes the real source
line, and the scanner is quote-aware (a `//` inside a string is not a comment) and
regex-literal-aware (a pattern such as `/https?|net/` is not mistaken for a comment
start).

Why: comment syntax is the one *prose* form that survives the prose-file exclusion
above. A `.mjs` module documenting "never write `process.env.X_API_KEY`" was scanned as
code, so explaining the invariant itself tripped the invariant
(`adapters/opencodereview/src/ocr-runner.mjs` comments, measured `SAFE_001` 6 +
`SAFE_003` 5 violations, and the demo gate red for that reason only).

**This widens the false-negative surface and is stated plainly: a key read, vault
reference or network call spelled *inside a comment* is not reported by
`SAFE_001`/`SAFE_003`.** The same class of text in non-comment code is unchanged — in
particular a **string literal** that spells a read (`const s = "process.env.X_API_KEY"`)
and a code line with a trailing comment (`const k = process.env.SECRET_TOKEN; // doc`)
are still violations; both are locked by regression tests
(`packages/qgate/test/contract-hardening.test.mjs`). This boundary now stands alongside
the three counted above: prose files, test fixtures, other extensions.

Measured after the change on this repository: **SAFE_001 and SAFE_003 each scan 96
files with 0 violations**, and the demo's `no-key-reads` / `no-network-surface` gates
pass again (`check --config demo/qgate.config.json` → exit 0, 5 of 5 gates).

#### Boundary 4a (t46/R3-H2): only a *closed* block comment is blanked

The blanking rule itself had a fail-open branch: an **unterminated** `/*` used to blank
everything from it to end-of-file, so a harmless input disabled the assertion for the
whole rest of the file. Measured before the fix — the YAML scalar `path: /*/build`
followed by `const k = process.env.ANTHROPIC_API_KEY;` and by `const r = await
fetch(url);`:

```
unterminated /* then key read      -> NOT-DETECTED   (control without /*: DETECTED)
unterminated /* then network call  -> NOT-DETECTED   (control without /*: DETECTED)
unterminated /* then vault ref     -> NOT-DETECTED
```

Fixed by treating `/*` as **plain text** unless a closing `*/` actually exists later in
the file (fail closed: over-report rather than miss). After the fix all three are
DETECTED again, while the t34 boundary is unchanged — a closed `/* … */` example is
still not reported. Note the opener's own `*/` overlap (`/*/build` contains `*/` but not
*after* the opener) does not count as a closing token.

The same review found the matching same-line case: `//` inside a URL scheme is data in
the YAML/config files this surface also scans, and blanking the rest of the line after
`https://` hid a read written later on that same line. `://` is therefore now treated as
text as well (measured: `url: https://… const k = process.env.ANTHROPIC_API_KEY;` went
from NOT-DETECTED to DETECTED). Both branches keep offsets and line breaks intact, and
both are locked by `packages/qgate/test/contract-hardening.test.mjs` (R3-H2 case).

### Identity chain: a hard link to a sensitive file (t46/R3-H1)

`qgate`'s selection now carries the same identity check the adapter publishes as
`SAFETY-005-HARDLINK-ALIAS`: a candidate that is hard-linked (`nlink > 1`) to a built-in
sensitive path is excluded **although its own name is harmless** (`notes.txt` → `.env`).
The identities are collected from **every candidate that is sensitive by name** —
including the ones the name rules already exclude, because the alias needs the excluded
file's identity (the mistake t42 found on the adapter side).

* Signals: `ino:<dev>:<ino>` (same inode as a sensitive file — the primary signal, and
  the one that fires for real hard links here) and `sha:<size>:<sha256>` (byte-identical
  content — the fallback for platforms/filesystems where a hard link is not reported to
  share `st_dev`/`st_ino`, e.g. some Windows layouts; exact, not a shape heuristic,
  because a hard link is byte-identical by definition).
* Cost: identity collection only stats/hashes paths matching a sensitive name, and the
  alias test runs only for `nlink > 1` candidates.
* Contract surface: **no new reason and no new field.** The exclusion reuses the frozen
  reason `secret_path` and carries the machine-readable detail in the free-form `rule`
  string as `alias:<sensitiveRuleId>:<via>`, e.g.
  `alias:secret-env:same-inode-as-sensitive-path`. The adapter's equivalent vocabulary is
  `reason=hardlink_secret_alias:<via>` + `ruleId=SAFETY-005-HARDLINK-ALIAS`.
* Both engine paths are covered *by construction* (they share the selection pipeline):
  `preview`'s `selection.included/excluded` + `invariants.secretPathsSelected`, and
  `check`'s `SAFE_002` policy scan. Measured: 3 aliases (`notes.txt`→`.env`,
  `handbook.txt`→`credentials.json`, `guide.txt`→`secrets/db.txt`) are excluded in both
  paths — before the fix `preview` selected all three while `SAFE_002` still reported
  `passed=true` with `secretPathsExcluded=3`; after it both report `secretPathsExcluded=6`
  (3 by name + 3 aliases).
* Negative control kept consistent with the adapter's D09 case: a hard-linked pair of
  **neutral** files (`plain.txt` ↔ `copy.txt`) has no sensitive counterpart and stays
  selected in both paths.

### Path-name case-insensitivity: the per-item audit (t53/R3-B1)

The secret-path rules were **case-sensitive**, so a CI diff spelled `Credentials.json` /
`.ENV` / `Secrets/Db.Txt` / `CONFIG/TLS/SERVER.PEM` slipped through: `.ENV` and `.PEM`
were stopped only by the *extension* allowlist by accident (`reason=extension`, not
`secret_path`), while `Credentials.json` and `Secrets/Db.Txt` were **selected** and
`SAFE_002` still reported `passed=true` with `secretPathsExcluded=0`. Measured on two
isomorphic trees whose only difference is on-disk case (now: both clean,
`secretPathsExcluded=5`; before: the UPPER tree selected
`[CONFIG/TLS/SERVER.PEM, Credentials.json, NODE_MODULES/dep.mjs, Secrets/Db.Txt, notes.txt]`).

The same review asked for every other case-sensitive decision to be checked. The audit:

| decision | before | after | evidence |
|---|---|---|---|
| secret path rules (`SECRET_PATH_RULES` → selection step 2, the `preview` invariant, `SAFE_002`) | case-sensitive ⇒ UPPER tree selected 2 sensitive files, `secretPathsExcluded=0` | **case-insensitive** through one `sensitiveNameRule()` (single source of truth), reason `secret_path` with the rule id | UPPER/lower probe, `preview` + `check`; test `R3-B1` |
| hard-link identity chain (t46/R3-H1) | inherited the case gap: `notes.txt` → `Credentials.json` stayed **selected** | identity collection reuses the CI rule ⇒ alias excluded, `rule=alias:secret-credentials:same-inode-as-sensitive-path` | probe + test `R3-B1 + R3-H1 retest` |
| default-excluded directories (`DEFAULT_EXCLUDED_PATHS`, e.g. `node_modules`, `.git`, `dist`) | case-sensitive ⇒ `NODE_MODULES/dep.mjs` was **selected** | comparison lower-cases both sides ⇒ `default_excluded_path` | probe; this step only *adds* exclusions |
| binary extension list | already insensitive (`path.extname().toLowerCase()`), `.PNG` → `binary` | unchanged (verified) | unit probe |
| scan-surface extensions (`CODE_EXTENSIONS`, prose/fixture classification) | already insensitive (extension lower-cased) | unchanged | `scanCategory` |
| `selection.extensions` (the **user's** allowlist) | `.MJS` matches nothing (the file's extension is compared lower-cased) | **deliberately unchanged**: lower-casing entries would let files back into `selected`, which this task forbids. Documented asymmetry, fail-closed | probe: `extensions: ['.MJS']` ⇒ `included=[]`, `src/app.mjs` reason `extension` |
| user `include` / `exclude` globs, `rules[].match` | case-sensitive | unchanged (user-authored patterns keep their semantics) | — |
| `policy.expectedFiles` | explicit paths, resolved by the filesystem (no glob matching); an **unresolvable** path yields a "declared scan target not found" reference, never a silent pass — a case mismatch is unresolvable only on a case-sensitive filesystem (on case-insensitive NTFS it resolves and is scanned, and the evidence keeps the config spelling) | unchanged | `checks/policy.mjs` uses `absOf` + `fileExists`; measured (t57): `['SRC/app.mjs']` scanned on Windows vs "declared scan target not found" + empty scan set under case-sensitive semantics |
| `policy.scanRoots` | resolved by the filesystem, spelling included; a root that walks nothing (absent, or mis-cased **on a case-sensitive filesystem**) contributes no files, and the `empty scan set = violation` guard is **aggregate** — it fires only when *every* root walks nothing | unchanged (already fail-closed) | `scanCandidates`; t57 probe on both filesystem semantics |
| scan-surface `SKIP_DIRECTORIES` (`node_modules`, `.git`, …) | case-sensitive ⇒ `NODE_MODULES/` is *scanned* | **deliberately unchanged**: making it insensitive would *skip* vendor trees that are scanned today, i.e. reduce coverage | `scanCategory` |
| `SAFE_001` / `SAFE_003` token matching | case-insensitive since t34 | unchanged | matcher tests |

Nothing was relaxed: every change above only *adds* exclusions, and no file that was
excluded before can now be selected (the one candidate for that — the user extension
allowlist — was deliberately left alone).

### Boundary 6 (t57): `scanRoots` / `expectedFiles` resolution is the filesystem's, and the fail-closed guard is aggregate

Both fields are joined onto the root and read with `readdirSync`/`statSync` **without any case
folding**, so whether a mis-cased path resolves is decided by the platform, not by `qgate`:
`SRC` resolves to `src` on case-insensitive NTFS (measured `filesScanned=1`, `passed=true`,
exit 0) and walks nothing on a case-sensitive filesystem (measured `filesScanned=0`,
empty-scan-set violation, exit 1). This is **platform behaviour, not implementation
behaviour** — the code neither normalises nor validates the spelling.

The guard is **aggregate, not per-root**: `['NOPE','src']` scans the one resolvable file and
**passes** on both filesystem semantics, so a typo'd root is only fatal when nothing else
resolves. And a mis-cased path keeps the **config spelling** in the output (`scanRoots:['SRC']`
⇒ evidence `file:SRC/app.mjs`), so a ledger written on Windows from a mis-cased config records
a path that does not resolve on a case-sensitive filesystem.

**Basis of the case-sensitive figures, and what is *not* measured here (t59):** the
mis-cased/absent-root behaviour on a case-sensitive filesystem follows from the code path
(`readdirSync` ENOENT is swallowed by `walkFiles` and yields `[]`, which the
`empty scan set` guard turns into a violation) and from a **controlled shim** that intercepts
`readdirSync`/`statSync`/`readFileSync` and matches each path component strictly from the
filesystem root (the shim self-tests itself before it is trusted). The Windows figures are
native runs. **No Ubuntu/Linux run is claimed**: `wsl -l -v` returns `E_ACCESSDENIED` and
`fsutil file setCaseSensitiveInfo` returns `Access denied` in this environment, so the
platform split is argued from those two sources rather than measured on Linux.

### Boundary 7 (t63/R5): the freshness gate depends on the verifier's frozen tool, and fails closed

The root configuration registers one `command` check, `baseline-freshness`, in the `verify`
gate:

```
node verification-t9/tools/baseline-freshness.mjs --deep --quiet    (expectExitCode: 0)
```

Its exit-code contract (the tool's own, not re-implemented here — **no second copy of the
verifier's logic lives in `packages/qgate/**`**): `0` every non-superseded pointer is FRESH
and its counts reproduce; `1` a pointer is STALE or its counts drifted; `2` a pointer was
tampered with; `3` discovery found no pointer file at all. Measured behaviour
(throwaway copies, t63):

| state | exit | aggregate line |
|---|---|---|
| as shipped (product surface moved after the pointer was recorded) | **1** | `fresh=0 superseded=5 stale=1` |
| after the verifier re-records the pointer for the current revision | **0** | `fresh=1 superseded=5 stale=0` |
| baseline counts edited (`--deep`) | **1** | `count_drift=1` |
| tool missing | **1** (node `MODULE_NOT_FOUND`) | — |
| no pointer file present | **3** | — |

Two properties matter, and both are deliberate:

* **Fail-closed.** A missing tool, a missing pointer file or a moved revision all produce a
  non-zero exit, so the check can never be skipped silently (`expectExitCode: 0` plus the
  verification requirement that gate failures block the run).
* **Read-only, layered.** The check *calls* the verifier's tool and never writes into
  `verification-t9/**` (measured: the directory's entry count is unchanged after a run, with
  and without `--deep`). The consequence is that the root gate is **red whenever the product
  surface has moved since the last pointer recording** — including after any change under
  `packages/qgate/**`, `adapters/opencodereview/**`, `schemas/`, `docs/`, `.github/` or
  `demo/` — and it turns green again only when the verifier re-records. That is the intended
  workflow (staleness is everyone's red light, not a private observation), and it is why the
  final release sequence ends with a verifier re-record. `--deep` additionally re-runs each
  authoritative pointer's own record command (~8 s here); dropping it would make the check
  ~0.5 s but would leave count-drift uncovered.

### Boundary 8 (t63/F19): the selection surface excludes the audit/evidence trees

`DEFAULT_EXCLUDED_PATHS` (now the **single** authority — `config.mjs` imports it instead of
keeping a second copy, which is exactly how one path could exclude the evidence trees while
the other did not) excludes the whole `verification/**` and `verification-t9/**` trees plus
the run products `.qgate/evidence`, `.qgate/reports`, `.qgate/out`.

Why: `SAFE_002` runs the *widest* selection, and the root config has no `selection` of its
own, so the audit/evidence trees used to be part of it — `metrics.selected` followed the
verifier's writes (measured 659 → 660 → 661 as files were added) and the demo's own
`report-*.md` products, so **two runs of the same revision produced different RunResult
text** (REQ-010, "same input, same output"). After the change the same measurement is
stable: `selected` 659 → 143, two consecutive runs give an identical normalized RunResult
hash, and adding files under `verification-t9/**` changes nothing (measured; see the t63
report). Security is unchanged: `SAFE_002` still passes with the same
`secretPathsExcluded` count, and the name-based secret rules still run before every user
include.

### Matcher extensions (t34): case, aliases, computed access

* **`SAFE_001` is case-insensitive.** Windows environment-variable names are not
  case-sensitive, so `process.env.anthropic_api_key` reads the same secret as the
  upper-case spelling (review-round2 high-3). The reverse direction is unchanged:
  `process.env.PATH`, a definition (`const apiKey = 1`), an object-literal key and a
  bare string naming a key stay clean.
* **`SAFE_003` additionally reports** (all four review-round2 bypass spellings):
  loading a network module (`await import('node:https')`, `import * as h from
  'node:http'`, `require('https')`), calling through a recovered binding
  (`h.request(…)`, `const f = fetch; f(url)`, `import { request as r } …; r(…)`), a
  computed global access whose parts are string literals
  (`globalThis['fe' + 'tch'](url)`), and a call on an HTTP-client package name
  (`axios.get(url)`, `client.get(url)`).
* The last one is a **name-vocabulary heuristic** (`axios|got|superagent|needle|
  undici|ky|node-fetch|request|client|httpClient|apiClient|httpAgent` followed by an
  HTTP-ish member): a binding cannot always be recovered from text alone. It is
  deliberately fail-closed — a false positive costs a rename, a false negative costs a
  silent network call — and its measured impact on this repository is **0 hits**.
  Object/map access such as `cache.get(key)` or `headers.get('x')` is not matched.

### Boundary 5 (t43): provider fixture *addressability* is not *replay capability*

`provider.fixture` names the offline recording a run's evidence rests on. Since t43 an
**explicitly named** fixture must be addressable for every provider type
(`deterministic`, `scripted`, `llm`, `external`): a missing/unreadable file, unparseable
JSON, or a file whose `recordings` array is empty fails the run with **exit 3 /
`PROVIDER_FAILED`** (pointer `/provider/fixture`) before any gate executes. Before t43 a
missing fixture was silently ignored: the run exited 0 with
`provider={degraded:false, detail:"offline-fixture"}`, i.e. a configuration could claim a
basis it did not have.

Two bounds are deliberately **not** covered, and are recorded here rather than only in
code comments — they are part of this project's detection boundary:

* **Addressability ≠ replay.** The check asserts the named file exists, parses and
  carries at least one recording. It does **not** assert that the fixture can answer the
  engine's provider probe: only the `scripted` branch requires the probe recording (a
  scripted provider must be exercisable), while `deterministic` — which never replays a
  request — accepts any non-empty recording set. A fixture that exists but cannot answer
  is therefore still a possible state.
* **Naming no fixture is not an error.** Without a `fixture` key the offline promise is
  unchanged: `deterministic` runs as before, and `llm`/`external` still degrade to
  deterministic (measured: exit 0, `provider={type:"deterministic", degraded:true,
  detail:"llm provider is not available offline; degraded to deterministic"}`). The rule
  forbids *claiming* a basis that cannot be read; it does not remove the degradation path.

## Re-including anything is explicit and works

`policy.expectedFiles` **bypasses** the default filter entirely (it is used verbatim,
so it can widen as well as narrow). Measured: a temporary tree containing only a
prose file and a fixture, both reading a sentinel key, is scanned as
`violations=0, filesScanned=0` by default and as
**`violations=2, filesScanned=2`** with `expectedFiles: ["notes.md", "fixture.test.mjs"]`.

```json
{ "id": "no-key-reads", "type": "policy", "policyId": "SAFE_001",
  "expectedFiles": ["packages/qgate/**/*.mjs", "docs/security.md"] }
```

## An empty scan set is an error, not a pass

If the filtered surface resolves to zero files, `SAFE_001`/`SAFE_003` **fail** with
`no file was scanned: … (empty scan set)` and `SAFE_002` does the same for an empty
candidate set. "Nothing was inspected" must never be reported as "nothing was found".

## Evidence discipline: an "unchanged" claim must carry its baseline hash (t43, team-wide)

Any claim that a file or tree is **unchanged / identical / untouched** must quote the
**sha256 as it was before the change** next to the sha256 after it, e.g.

```
packages/qgate/src/provider.mjs:  8c9913e9b6293495… → fdf2352d5ecf60a5…
```

A lone current value, or an aggregate tree hash with nothing to compare against, cannot
be re-checked by an independent verifier — who can then only mark the claim **blocked**
(the t40 verification report did exactly that). The rule applies to every "no change"
statement:

* **one file** — before-digest → after-digest of that same file (and, when a temporary
  edit was used to measure the pre-fix behaviour, the digest proving it was restored
  byte-for-byte);
* **a tree** — the aggregate value of `node packages/qgate/scripts/tree-sha256.mjs <dir>…`
  **as measured before** and after, plus the observation window; because other agents
  write concurrently, a later measurement can only support the files *you* claim to have
  written, which is what `changedPaths` plus your own edit window is for;
* **a run outcome** — the verdict (and `run_id`) before and after, not just the current
  one.

Baseline tools: `node packages/qgate/scripts/tree-sha256.mjs <dir>…` (mtime-independent
aggregate) and per-file `sha256`. Positive evidence for what you *did* write is
`changedPaths` + your edit window; the baseline hash is the evidence for what you did
**not** touch.


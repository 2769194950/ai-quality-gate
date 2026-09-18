# schemas/ — frozen JSON Schema contracts

Owner: **architect**. These four files are the machine-readable form of the field-level
contract frozen in `docs/01-architecture.md` §5. Implementers must not rename, add or remove
baseline fields; a contract change goes through the captain, not through a schema edit.

| file | contract section | artefact it validates | version constant |
|---|---|---|---|
| `config.schema.json` | §5.1 | `qgate.config.json` | `version` = `"1.0"` |
| `run-result.schema.json` | §5.2 | `qgate check --json` stdout | `version` = `"1.0"` |
| `evidence-ledger.schema.json` | §5.3.1 + §5.3.2 | `verification/evidence/ledger-<run_id>.json` (variant 1) and `verification/evidence/ledger-index.json` (variant 2) | `schemaVersion` = `"1.0"` |
| `trace-matrix.schema.json` | §5.3.3 | `verification/trace-matrix.json` | `schemaVersion` = `"1.0"` |

All four are JSON Schema **draft 2020-12** (`$schema` = `https://json-schema.org/draft/2020-12/schema`),
each with a unique absolute `$id`.

## How "no added or removed baseline fields" is enforced

Every object level that has a frozen field table declares `additionalProperties: false`, so both a
missing required field and an unknown field are rejected. That is what makes the
REQ-QUALITY-GATE-004 key-set assertion directly schema-checkable for `RunResult`.

Two deliberate exceptions, each with a `$comment` in the file:

1. `config.schema.json` → `$defs.checkBase` uses `additionalProperties: true`. JSON Schema applies
   `additionalProperties` per subschema, so a `false` there would reject every per-type field
   (`file`, `files`, …) of whichever variant matched. The seven type variants each declare the
   complete field set (shared + per-type) with `additionalProperties: false`; those variants are
   what reject an undeclared check field name.
2. `evidence-ledger.schema.json` root does not declare `additionalProperties: false`. The root only
   routes to exactly one of two variants; the variants themselves are strict.

`testIds`/`testId` and `approvedBy`/`approvedAt` use `oneOf` with an explicit `null` branch instead of
`type: ["string","null"]`, because a nullable type union silently stops applying `pattern`/`maxLength`

**This is the ONLY accepted way to express a nullable string (t20, single convention).** A `"type": ["string", "null"]`
union is a defect, not a style choice: `pattern`, `maxLength` and `minLength` apply **only when the instance is a
string**, so a type union silently disables them instead of failing loudly. As of t20 the whole `schemas/` tree
contains **zero** `"type": [ ... ]` union types (verified by grep); every nullable leaf is written as
`oneOf: [{type:"string"}, {type:"null"}]`. When adding a nullable field, copy that form.
(those keywords only constrain strings). Pinned patterns: `requirementId` `^REQ-[A-Z0-9-]+-[0-9]{3}$`,
`testId`/`testIds` `^T-[A-Z0-9-]+-[0-9]{3}$`, `priority` `P0|P1|P2`.

## Verification

`packages/qgate/test/schema-contract.test.mjs` exercises all four schemas with a real evaluator
(`packages/qgate/test/helpers/json-schema.mjs`, dependency-free), including the required positive and
negative judgements:

- the canonical §5.1 configuration is **valid** (also checked in as `test/_canonical-config.json`);
- `check.type = "file_exist"` is **invalid** (`enum` + `oneOf`);
- a `RunResult` missing any baseline field, or carrying an extra field at any of the six object
  levels, is **invalid**;
- a ledger with a malformed `testId`, an uncovered requirement carrying evidence, a 4-digit
  `requirementId`, and an out-of-enum stage are all **invalid**.

Run it with `node --test packages/qgate/test/schema-contract.test.mjs` (in this sandbox the test
runner's child-process spawn is denied, so the same file can be run in-process; see the task report).

Two commands from the task contract, both run at the project root:

```text
node -e "for(const f of ['config','run-result','evidence-ledger','trace-matrix']){const s=require('./schemas/'+f+'.schema.json');if(!s['$id']||!s['$schema'])process.exit(1)};console.log('4 schemas OK')"
→ 4 schemas OK   (exit 0)

Select-String -Path schemas/*.schema.json -Pattern '2020-12' -AllMatches
→ 4 files, 8 hits ($schema line + $id line in each)
```

## Resolved drift: §5.1 field tables vs the engine validator (ruling 1)

**Status: RESOLVED by captain ruling — option (a), declare the fields in the contract.**

The engine's validator (`packages/qgate/src/config.mjs`) accepts field names that the original
frozen §5.1 field table did not declare. Removing them (option (b)) was rejected because the
capability is already implemented and already depended on by `demo/qgate.config.json`, so deletion
would have broken working, demo-covered behaviour. The fields are now declared in
`docs/01-architecture.md` §5.1 and in `config.schema.json`.

Declaration sites in the engine (`config.mjs`) and the field tables added to §5.1:

| newly declared field | where | engine declaration | documented type / default |
|---|---|---|---|
| `projectRoot` | top level | `topAllowed` (l. 313); validated l. 480–485 and resolved l. 601–610 | `string`; omitted; relative to the config file |
| `selection` | top level | `topAllowed` (l. 313); `selectionFieldTable` (l. 115–124) | `object`; `{}` |
| `grouping` | top level | `topAllowed` (l. 313); `groupingTable` (l. ~339) | `object`; `{}` |
| `provider.fixture` | `provider` | `providerFieldTable` (l. 104) | `string \| null`; `null` |
| `provider.confidenceThreshold` | `provider` | `providerFieldTable` (l. 105) | `number`; `0.7`; `[0,1]` |
| `policy.scanRoots` | `policy` | `policyFieldTable` (l. 112) | `array<string> \| null`; `null` |
| `policy.expectedFiles` | `check.type="policy"` | `checkFieldTables.policy` (l. 94) | `array<string> \| null`; `null` |
| `selection.*` (8 keys) | `selection` | `selectionFieldTable` (l. 115–124) | see §5.1 |
| `grouping.*` (3 keys) | `grouping` | `groupingTable` (l. ~339) | see §5.1 |

Two fields beyond the five originally reported had to be declared as well, because
`demo/qgate.config.json` uses them and the acceptance criterion is that the untouched demo config
validates: top-level `projectRoot` (demo line 7) and `policy.scanRoots` (demo line 12). Without
those two, "make the demo config valid without editing it" is unreachable. Both are genuinely
implemented: `projectRoot` drives config-path-relative root resolution (`config.mjs` l. 601–610) and
`policy.scanRoots` narrows the SAFE_001/SAFE_003 scan subtrees (`policy.mjs` l. 85–108, `core.mjs` l. 109).

Validation strength was **not** relaxed while doing this:

- `check.type = "file_exist"` is still invalid (`enum` + `oneOf matched 0`);
- every still-undeclared field name is still rejected by `additionalProperties: false` at the top
  level, in `provider`, in `policySettings`, in `selectionSettings`, in `groupingSettings`, in every
  check variant and in `humanGate`;
- the `checkBase` / ledger-root exceptions below are unchanged.

Any *future* undeclared field must go through the same route: report → captain ruling → declare in
§5.1 + schema, never "relax the schema to fit the code".

## Resolved drift: §5.2 vs §9.1 approval nullability (ruling 2)

**Status: RESOLVED — §5.2 wins; §9.1 was the stale text.**

§5.2 already declared `gates[].humanGate.approvedBy` and `approvedAt` as `string | null`, while §9.1
described `approval.json`'s two fields as non-null. §9.1 has been corrected to
`string | null`, with the rule stated explicitly: `decision = "approved"` requires both to be
non-empty strings; an unsigned or missing approval uses `null`.

That conditional is **not** expressed as a JSON Schema `type` constraint, and deliberately so: JSON
Schema cannot cleanly assert "if this enum field has value X then these two fields are non-empty"
across fields. It is enforced in code instead — `packages/qgate/src/human-gate.mjs` returns
`approvedBy: null, approvedAt: null` for any non-approved decision and rejects a
`decision="approved"` record whose `approvedBy`/`approvedAt` is not a non-empty string (l. 58–62),
surfacing `approvalState="missing"` and a `HUMAN_GATE_NOT_APPROVED` blocker. This schema keeps the
`oneOf: [{type:"string"}, {type:"null"}]` form rather than `type: ["string","null"]`, because the
latter silently stops applying `pattern`/`maxLength` (see the note above).

## Contract-change discipline (mandatory, added in t22)

These schemas and the §5 field tables in `docs/01-architecture.md` are **two expressions of one contract**, and their
**executable sentinel** is `packages/qgate/test/schema-contract.test.mjs` together with
`packages/qgate/test/_canonical-config.json`. That sentinel lives in **core-engineer's scope**, while the schemas and §5
are **architect-owned** — so a contract change makes someone else's suite go red, and the change author is not allowed to
edit it.

**Therefore: anyone modifying §5 field tables or `schemas/**` MUST, in the same change, ask core-engineer to update that
test's frozen field table and `_canonical-config.json`, and MUST re-run the engine suite to green:**

```bash
node --test --experimental-test-isolation=none packages/qgate/test/schema-contract.test.mjs
```

Rules:

1. Never leave the engine suite red and justify it with "the test is in someone else's scope".
2. The change author **initiates** the sync; do not wait for the other side to notice a red suite.
3. If the sync cannot happen in the same change, state explicitly in your report: "the engine suite will therefore go
   red; core-engineer must be dispatched", and give the **exact one-line edit** (file, line number, full new value).
4. Do **not** move this test into architect's scope and do **not** delete it (captain ruling): it is the sentinel for
   **contract ↔ schema ↔ engine** consistency, and it also carries valuable engine-side value checks. It stays where it is;
   the collaboration duty is what gets written down.

This discipline is recorded as **GAP-8** in `docs/01-architecture.md` §6.2.3 (worked example: t17 added the optional
`humanGate.gateId` to `config.schema.json`, which left the frozen table at `role, approvalRecord, enforcement` and
produced `config:humanGate: surplus [gateId]`).

## Validation boundary: uniqueness is engine-enforced, not schema-expressible

JSON Schema cannot express cross-item uniqueness. `uniqueItems` only asserts that the array elements are pairwise
distinct — never "distinct by a particular field" — so **`gate.id` global uniqueness and `check.id` uniqueness within a
gate are enforced by the engine (`packages/qgate/src/config.mjs`), not by these schemas.**

Consequences (documented deliberately; do NOT try to "fix" this by faking strength in the schema):

- a counter-example relying on uniqueness — e.g. `packages/qgate/examples/invalid/duplicate-check-id.json` — is
  **expected to be `valid: true` under the schema while the engine exits 2**, with `error.code = "CONFIG_INVALID"` and a
  message naming the duplicate id;
- therefore **"the schema accepts it" never implies "the engine accepts it"**. Acceptance is decided by the engine;
  these schemas are a field-level static check only.

## Fixture drift closed

`test/_canonical-config.json` is the checked-in §5.1 example and now carries the complete declared
field surface (top-level `projectRoot`/`policy`/`selection`/`grouping`, `provider.fixture`,
`provider.confidenceThreshold`, `policy.scanRoots`, `selection.*`, `grouping.*`,
`check.expectedFiles`). A test asserts it deep-equals the inline §5.1 example and validates, so the
reference config and the documented field table can no longer drift apart.

`packages/qgate/examples/valid/five-stage.json` intentionally stays minimal (it demonstrates the
five-stage shape, not the full field surface) and validates as well; it is not claimed to be the
complete §5.1 example — `test/_canonical-config.json` is that artefact.

`demo/qgate.config.json` was **not modified** (it belongs to core-engineer) and now validates
`true` against the extended schema — see the task report for the executed evidence.


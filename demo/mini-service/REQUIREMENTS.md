# mini-service — requirements (five-stage demo repository)

This fixture repository is the end-to-end demonstration target for `qgate`. It is a
**synthetic, offline** service contract: no source service is required, no network
access happens, and no API key is read at any point.

Requirement ids follow `REQ-DEMO-NNNN` and are unique across this document.

## REQ-DEMO-001 — Payment intent intake must accept an idempotent request

- The service contract must expose `POST /v1/payment-intents`.
- Every request must carry a client-generated `Idempotency-Key`; two identical
  requests with the same key must produce one effect.
- 可测验收标准: `openapi.yaml` declares the path and the header; the recorded
  evidence records the duplicate-suppression result.
- Verification: `interface-fields` regex check over `openapi.yaml`.

## REQ-DEMO-002 — Every response must carry a correlation identifier

- The frozen field names `requestId` and `traceId` must appear in both the request
  envelope and every error body.
- 可测验收标准: the `interface-fields` check finds both field names in
  `openapi.yaml`; the trace matrix links this requirement to its test ids.
- Verification: `.qgate/trace-matrix.json` coverage for `REQ-DEMO-002`.

## REQ-DEMO-003 — Amounts must be minor units with an explicit currency

- The contract must declare integer `amount` (minor units) and an ISO-4217
  `currency` field; floating point amounts are forbidden.
- 可测验收标准: `interface-fields` finds `amount` and `currency`;
  `.qgate/evidence/coverage.json` records the branch coverage of the conversion.
- Verification: `coverage-threshold` json assertion.

## REQ-DEMO-004 — The build must be reproducible without network access

- `package.json` must declare no runtime dependency and `"type": "module"`.
- 可测验收标准: `no-dep` asserts `/dependencies == {}` and `/type == "module"`;
  the offline smoke command `node --version` must exit 0.
- Verification: `no-dep` + `command-smoke`.

## REQ-DEMO-005 — Recorded findings must respect severity and confidence gating

- Findings below the confidence threshold (0.7) or below `high` severity must be
  recorded as findings and must **not** become blockers.
- 可测验收标准: `.qgate/evidence/ocr-findings.json` records one `high` finding at
  confidence 0.86, one `medium` and one `low` finding; only the `high` one is a
  candidate blocker.
- Verification: `severity-mix` json assertion + `POLICY_VIOLATION` semantics.

## REQ-DEMO-006 — Requirements must be traced to tests and evidence

- Every P0/P1 requirement must reference at least one `T-*` test id, and every test
  id present in the ledger index must be referenced by some requirement.
- 可测验收标准: `trace-complete` fails with `TRACE_GAP` when a requirement loses its
  test id and passes when coverage is restored.
- Verification: `trace-complete` trace_matrix check.

## Non-goals

1. No real service runtime, no database, no network client is implemented.
2. No credential, `.env` value or API key is required to run this demo.
3. Loose-ends trackers (`TODO.md`) are not part of the fixture.

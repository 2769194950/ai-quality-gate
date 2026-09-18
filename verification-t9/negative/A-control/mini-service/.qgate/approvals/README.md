# Demo approval records

These three files are the **fixture** human-gate approvals that make
`demo/qgate.config.json` pass end to end:

- `.qgate/approvals/req-spec/approval.json` — role `product`, gate `req-spec`
- `.qgate/approvals/interface-frozen/approval.json` — role `architect`, gate `interface-frozen`
- `.qgate/approvals/review-counterexample/approval.json` — role `reviewer`, gate `review-counterexample`

Each record follows the frozen approval schema of `docs/01-architecture.md` §9.1
(`schemaVersion`, `gateId`, `role`, `decision`, `approvedBy`, `approvedAt`, `claims`).

The negative test (`human-gate.test.mjs`) deliberately deletes these files in a
temporary copy of the demo repository to prove that a missing approval produces
`HUMAN_GATE_NOT_APPROVED` and exit code 1 — the committed demo keeps them so the
positive end-to-end path stays reproducible offline.

# Security Policy

## Scope

This project is a local CLI and evidence pipeline. It does not provide a
hosted service or store model credentials.

## Reporting a vulnerability

Please do not open a public issue for a suspected credential leak, sandbox
escape, evidence-integrity bypass, or sensitive-file inclusion bug. Contact the
repository maintainers privately through the GitHub Security Advisories flow
for the published repository.

When reporting, include a minimal reproduction, affected commit or tag, and
whether the issue affects `qgate`, the OCR adapter, or the CI template. Never
include a real API key or other live credential in the report.

## Credential handling

- API keys belong in the user's provider configuration or CI secret store.
- They must never be committed, written to evidence, or printed by a runner.
- Use the repository's staged-content scan before pushing a release.

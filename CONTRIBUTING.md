# Contributing

## Development

The project requires Node.js 18 or newer and has no runtime dependencies.

```text
npm test
node adapters/opencodereview/tools/run-tests.mjs
node packages/qgate/bin/qgate.mjs contract --check
node packages/qgate/bin/qgate.mjs check --config qgate.config.json --json
```

Keep the deterministic qgate core independent from API keys and network
clients. Live OpenCodeReview calls belong behind the adapter's external runner.

## Pull requests

Describe the affected stage, the deterministic checks that changed, and any
new capability boundary. Add a regression test for every bug fix. Do not add
real credentials, private repository paths, or model transcripts containing
sensitive source code.

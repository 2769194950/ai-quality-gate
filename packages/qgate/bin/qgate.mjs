#!/usr/bin/env node
// qgate CLI executable (§6). All paths are derived from `import.meta.url` and from
// the supplied arguments, so every command works from any cwd without
// `npm install` and without relying on PATH.
//
// The command logic lives in `src/cli.mjs`; this wrapper only wires the process
// streams and the exit code. Exit codes (§6.3):
//   0 passed | 1 gate failed | 2 config error | 3 internal error
import { runCli } from '../src/cli.mjs';

process.exitCode = await runCli(process.argv.slice(2));

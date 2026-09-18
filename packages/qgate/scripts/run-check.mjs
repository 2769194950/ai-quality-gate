#!/usr/bin/env node
// Fires a single built-in check against a throwaway / given project root.
//
//   node packages/qgate/scripts/run-check.mjs <checkType> [dir] [--json <checkJson>]
//
// Useful for reproducing one check verdict without authoring a configuration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { executeCheck } from '../src/checks/index.mjs';
import { resolveRepoRoot } from '../src/policy.mjs';

const [, , checkType = 'file_exists', dir = null, ...rest] = process.argv;
const inlineIndex = rest.indexOf('--json');
const inline = inlineIndex === -1 ? null : JSON.parse(rest[inlineIndex + 1]);

const root = dir ? path.resolve(dir) : fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-check-'));
const created = dir === null;

const config = validateConfig({ version: '1.0', provider: { type: 'deterministic' }, gates: [] });
void config;

const check = { id: 'probe-check', type: checkType, required: true, severity: 'high', ...(inline ?? {}) };
const outcome = executeCheck(
  {
    root,
    repoRoot: resolveRepoRoot(root),
    policyScanRoot: resolveRepoRoot(root),
    configPath: 'qgate.config.json',
    configAbsPath: path.join(root, 'qgate.config.json'),
  },
  check,
);

process.stdout.write(`${JSON.stringify({ root, check, passed: outcome.passed, message: outcome.message, evidence: outcome.evidence }, null, 2)}\n`);

if (created) fs.rmSync(root, { recursive: true, force: true });

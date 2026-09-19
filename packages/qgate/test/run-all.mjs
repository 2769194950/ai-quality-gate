#!/usr/bin/env node
// Run qgate test files one at a time. Several contract tests intentionally
// exercise the shipped demo evidence ledger, so file-level concurrency would
// make an otherwise deterministic suite depend on scheduling.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const files = fs
  .readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort((a, b) => a.localeCompare(b));

let failures = 0;
const totals = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 };
for (const file of files) {
  console.log(`\n=== qgate test file: ${file} ===`);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-test-'));
  const stdoutPath = path.join(tempDir, 'stdout.txt');
  const stderrPath = path.join(tempDir, 'stderr.txt');
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');
  let result;
  try {
    result = spawnSync(
      process.execPath,
      ['--test', '--test-concurrency=1', '--experimental-test-isolation=none', path.join(TEST_DIR, file)],
      { cwd: path.resolve(TEST_DIR, '..', '..', '..'), stdio: ['ignore', stdoutFd, stderrFd], env: process.env },
    );
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  const stdout = fs.readFileSync(stdoutPath, 'utf8');
  const stderr = fs.readFileSync(stderrPath, 'utf8');
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  fs.rmSync(tempDir, { recursive: true, force: true });

  for (const key of Object.keys(totals)) {
    const match = new RegExp(`(?:^|\\r?\\n)ℹ ${key} (\\d+)`).exec(stdout);
    if (match) totals[key] += Number(match[1]);
  }
  if (result.error) {
    console.error(`test runner failed for ${file}: ${result.error.message}`);
    failures += 1;
  } else if (result.status !== 0) {
    failures += 1;
  }
}

for (const [key, value] of Object.entries(totals)) console.log(`ℹ ${key} ${value}`);
process.exitCode = failures === 0 ? 0 : 1;

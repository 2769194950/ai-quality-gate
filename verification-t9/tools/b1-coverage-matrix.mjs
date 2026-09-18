#!/usr/bin/env node
// verification-t9/tools/b1-coverage-matrix.mjs — t45 B1: full 10 safety decisions x 3 invocations.
// Paths: P1 = `--diff` only (diff beside the repo), P2 = `--root` enumeration,
//        P3 = `--diff --root <repo>` (explicit anchor; the third path this verifier judges relevant).
// Every cell records the decision's expected outcome and the observed included/excluded sets.
// All trees are throwaway; the shipped repository is only READ.
// Usage: node verification-t9/tools/b1-coverage-matrix.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { runPreview } from '../../adapters/opencodereview/test/helpers.mjs';
import { tmpDir, writeJson, writeText, cleanup } from '../../packages/qgate/test/helpers.mjs';

const base = tmpDir('b1-matrix-');
const repo = path.join(base, 'repo');
const NEUTRAL = 'export const a = 1;\n';
writeText(path.join(repo, 'src', 'app.mjs'), NEUTRAL);
writeText(path.join(repo, '.env'), 'ANTHROPIC_API_KEY=sk-ant-shouldnotleak\n');
writeText(path.join(repo, 'Credentials.json'), '{"access_key":"AKIAIOSFODNN7EXAMPLE"}\n');
writeText(path.join(repo, 'Secrets', 'db.txt'), 'password=hunter2\n');
writeText(path.join(repo, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]));
writeText(path.join(repo, 'node_modules', 'pkg', 'index.mjs'), NEUTRAL);
writeText(path.join(repo, 'dist', 'bundle.mjs'), NEUTRAL);
writeText(path.join(repo, 'notes.lock'), 'lockfile content\n');
// item 7: alias of a sensitive path (identity chain)
fs.linkSync(path.join(repo, '.env'), path.join(repo, 'docs.txt'));
// item 8: hardlinked file whose content is secret-shaped, with no sensitive *path* in the set
writeText(path.join(repo, 'vault.example'), 'ANTHROPIC_API_KEY=sk-ant-shouldnotleak\n');
fs.linkSync(path.join(repo, 'vault.example'), path.join(repo, 'promo.txt'));
// item 9: hardlinked file with neutral content and no sensitive counterpart (must stay selected)
writeText(path.join(repo, 'shared.txt'), 'hello neutral content\n');
fs.linkSync(path.join(repo, 'shared.txt'), path.join(repo, 'copy.txt'));

const diffFiles = [
  'src/app.mjs', '.env', 'Credentials.json', 'Secrets/db.txt', 'assets/logo.png',
  'node_modules/pkg/index.mjs', 'dist/bundle.mjs', 'notes.lock',
  'docs.txt', 'vault.example', 'promo.txt', 'shared.txt', 'copy.txt',
];
const diffPath = path.join(base, 'diff.json');
writeJson(diffPath, { version: '1.0', files: diffFiles });
const rulePath = path.join(base, 'rule.json');
writeJson(rulePath, {
  version: '1.0',
  include: [{ id: 'all', pattern: '**/*', reason: 'B1 matrix' }],
  exclude: [],
  includeExtensions: ['.mjs', '.json', '.txt', '.env', '.png', '.lock', '.example', ''],
});

const DECISIONS = [
  { id: 'D01_sensitive_path', file: '.env', want: 'excluded' },
  { id: 'D02_case_variant_path', file: 'Credentials.json', want: 'excluded' },
  { id: 'D03_case_variant_dir', file: 'Secrets/db.txt', want: 'excluded' },
  { id: 'D04_binary_extension', file: 'assets/logo.png', want: 'excluded' },
  { id: 'D05_default_excluded_dir', file: 'node_modules/pkg/index.mjs', want: 'excluded' },
  { id: 'D06_unsupported_extension', file: 'notes.lock', want: 'excluded' },
  { id: 'D07_hardlink_alias_of_sensitive', file: 'docs.txt', want: 'excluded' },
  { id: 'D08_hardlink_secret_content', file: 'promo.txt', want: 'excluded' },
  { id: 'D09_hardlink_neutral_content', file: 'copy.txt', want: 'selected' },
  { id: 'D10_negative_ordinary_file', file: 'src/app.mjs', want: 'selected' },
];

const PATHS = [
  { id: 'P1_diff_only', args: ['--diff', diffPath] },
  { id: 'P2_root_only', args: ['--root', repo] },
  { id: 'P3_diff_with_root', args: ['--diff', diffPath, '--root', repo] },
];

const cells = [];
for (const p of PATHS) {
  const r = runPreview([...p.args, '--rule', rulePath, '--json']);
  const included = new Set(r.payload?.selection?.included ?? []);
  const excluded = new Map((r.payload?.excluded ?? []).map((e) => [e.path, e.reason]));
  for (const d of DECISIONS) {
    const observed = included.has(d.file) ? 'selected' : excluded.has(d.file) ? 'excluded' : 'absent';
    cells.push({
      path: p.id,
      decision: d.id,
      file: d.file,
      want: d.want,
      observed,
      reason: excluded.get(d.file) ?? null,
      ok: observed === d.want,
      exit: r.exitCode,
    });
  }
}
const failures = cells.filter((c) => !c.ok);
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ cwd: process.cwd(), repo, diffFiles, cells, failures, cellCount: cells.length, okCount: cells.length - failures.length }, null, 2)}\n`);
} else {
  const byPath = {};
  for (const c of cells) (byPath[c.path] ??= []).push(`${c.ok ? '✅' : '❌'} ${c.decision}:${c.observed}${c.reason ? ` (${c.reason})` : ''}`);
  for (const [p, rows] of Object.entries(byPath)) {
    console.log(`--- ${p} ---`);
    for (const row of rows) console.log('  ' + row);
  }
  console.log(`cells=${cells.length} ok=${cells.length - failures.length} failed=${failures.length}`);
}
cleanup(base);
process.exitCode = failures.length ? 1 : 0;

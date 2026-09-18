#!/usr/bin/env node
// verification-t9/tools/v1-comment-boundary.mjs — t49 V1 (R3-H2): independently reproduce the
// unterminated-`/*` and `://` blind spots through the **CLI `check` path** (policy checks SAFE_001 /
// SAFE_003 on throwaway trees). This is deliberately the CLI layer, not the single-file helper:
// architect reported the CLI layer could not reproduce the pre-fix hole, so the layer matters.
// Usage: node verification-t9/tools/v1-comment-boundary.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { runCliJson, tmpDir, writeJson, writeText, cleanup } from '../../packages/qgate/test/helpers.mjs';

const results = [];
const UNTERM = 'path: /*/build\n';

function cfg(base, policyId, extraPolicy = {}, extraCheck = {}) {
  const p = path.join(base, 'qgate.config.json');
  writeJson(p, {
    version: '1.0',
    provider: { type: 'deterministic' },
    projectRoot: 'repo',
    policy: { evidenceDir: '.qgate/evidence', reportDir: '.qgate/reports', ...extraPolicy },
    gates: [{ id: 'g1', stage: 'build', required: true, checks: [{ id: 'policy-check', type: 'policy', policyId, required: true, ...extraCheck }] }],
  });
  return p;
}

const CASES = [
  {
    id: 'V1-01_unterminated_block_then_env_read', policyId: 'SAFE_001', want: 'DETECTED',
    files: { 'src/a.mjs': `${UNTERM}const k = process.env.ANTHROPIC_API_KEY;\n` },
  },
  {
    id: 'V1-02_unterminated_block_then_fetch', policyId: 'SAFE_003', want: 'DETECTED',
    files: { 'src/b.mjs': `${UNTERM}const body = await fetch(url);\n` },
  },
  {
    id: 'V1-03_scheme_double_slash_same_line', policyId: 'SAFE_001', want: 'DETECTED',
    files: { 'src/c.mjs': 'const u = "https://example.invalid"; const k = process.env.ANTHROPIC_API_KEY;\n' },
  },
  {
    id: 'V1-04_closed_block_comment_example', policyId: 'SAFE_001', want: 'NOT-DETECTED',
    files: { 'src/d.mjs': '/* example: process.env.ANTHROPIC_API_KEY */\nconst ok = 1;\n' },
  },
  {
    id: 'V1-05_pure_line_comment', policyId: 'SAFE_001', want: 'NOT-DETECTED',
    files: { 'src/e.mjs': '// process.env.ANTHROPIC_API_KEY\nconst ok = 1;\n' },
  },
  {
    id: 'V1-06_line_comment_at_eof_no_newline', policyId: 'SAFE_001', want: 'NOT-DETECTED',
    files: { 'src/f.mjs': 'const ok = 1;\n// process.env.ANTHROPIC_API_KEY' },
  },
  {
    id: 'V1-07_crlf_unterminated_then_read', policyId: 'SAFE_001', want: 'DETECTED',
    files: { 'src/g.mjs': 'path: /*/build\r\nconst k = process.env.ANTHROPIC_API_KEY;\r\n' },
  },
  {
    id: 'V1-08_bom_adjacent_unterminated_then_read', policyId: 'SAFE_001', want: 'DETECTED',
    files: { 'src/h.mjs': `\uFEFF${UNTERM}const k = process.env.ANTHROPIC_API_KEY;\n` },
  },
  {
    id: 'V1-09_quotes_with_double_slash_then_read', policyId: 'SAFE_001', want: 'DETECTED',
    files: { 'src/i.mjs': 'const s = "a // b"; const k = process.env.ANTHROPIC_API_KEY;\n' },
  },
  {
    id: 'V1-10_regex_literal_with_block_comment', policyId: 'SAFE_001', want: 'DETECTED',
    files: { 'src/j.mjs': 'const re = /\\/\\*/; const k = process.env.ANTHROPIC_API_KEY;\n' },
  },
  {
    id: 'V1-11_vault_reference_under_unterminated', policyId: 'SAFE_001', want: 'DETECTED',
    files: { 'src/k.mjs': `${UNTERM}vault.API_KEY;\n` },
  },
  {
    id: 'V1-12_expectedFiles_markdown_unterminated', policyId: 'SAFE_001', want: 'DETECTED',
    files: { 'docs/notes.md': `${UNTERM}the reader uses process.env.MY_SECRET_TOKEN at runtime\n` },
    extraCheck: { expectedFiles: ['docs/notes.md'] },
  },
];

for (const c of CASES) {
  const base = tmpDir('v1-');
  const root = path.join(base, 'repo');
  for (const [rel, text] of Object.entries(c.files)) writeText(path.join(root, rel), text);
  const configPath = cfg(base, c.policyId, c.extraPolicy ?? {}, c.extraCheck ?? {});
  const r = await runCliJson(['check', '--config', configPath, '--json'], { strict: false });
  const blockers = (r.json?.gates ?? []).flatMap((g) => g.blockers ?? []);
  const detected = r.status === 1 && blockers.length > 0;
  results.push({
    id: c.id,
    layer: 'CLI `qgate check` with a policy check (SAFE_001/SAFE_003)',
    policyId: c.policyId,
    want: c.want,
    observed: detected ? 'DETECTED' : 'NOT-DETECTED',
    exit: r.status,
    blockerCount: blockers.length,
    blockerPrefixes: blockers.map((b) => String(b.message).split(':')[0]),
    ok: (c.want === 'DETECTED') === detected,
  });
  cleanup(base);
}

if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ cwd: process.cwd(), layer: 'CLI', cases: results, failures: results.filter((r) => !r.ok) }, null, 2)}\n`);
else {
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.id} want=${r.want} observed=${r.observed} exit=${r.exit}`);
  console.log(`cases=${results.length} ok=${results.filter((r) => r.ok).length}`);
}
process.exitCode = results.every((r) => r.ok) ? 0 : 1;

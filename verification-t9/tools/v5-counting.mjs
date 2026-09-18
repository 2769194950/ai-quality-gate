#!/usr/bin/env node
// verification-t9/tools/v5-counting.mjs — t49 V5: after t48, unmaterialised diff paths must no longer
// pollute coverage-derived counts, while staying queryable, and the token logic must be unchanged.
// Compares `--diff` against `--root` on the same tree (3 real + 6 unmaterialised).
// Usage: node verification-t9/tools/v5-counting.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { runPreview } from '../../adapters/opencodereview/test/helpers.mjs';
import { tmpDir, writeJson, writeText, cleanup } from '../../packages/qgate/test/helpers.mjs';

const base = tmpDir('v5-count-');
const repo = path.join(base, 'repo');
writeText(path.join(repo, 'src', 'app.mjs'), 'export const a = 1;\n'.repeat(40));
writeText(path.join(repo, 'src', 'util.mjs'), 'export const b = 2;\n'.repeat(20));
writeText(path.join(repo, 'docs', 'notes.md'), '# notes\n');
const real = ['src/app.mjs', 'src/util.mjs', 'docs/notes.md'];
const gone = ['gone/a.js', 'gone/b.js', 'gone/c.js', 'gone/d.js', 'gone/e.js', 'gone/f.js'];
const diffPath = path.join(base, 'diff.json');
writeJson(diffPath, { version: '1.0', files: [...real, ...gone] });
const rulePath = path.join(base, 'rule.json');
writeJson(rulePath, { version: '1.0', include: [{ id: 'all', pattern: '**/*', reason: 'V5' }], exclude: [], includeExtensions: ['.mjs', '.md', ''] });

const run = (args) => runPreview([...args, '--rule', rulePath, '--json']);
const diff = run(['--diff', diffPath]);
const rootOnly = run(['--root', repo]);
const dp = diff.payload ?? {};
const rp = rootOnly.payload ?? {};
const groupFiles = (p) => (p.groups ?? []).flatMap((g) => g.files ?? []);
const tokenSum = (p) => (p.selected ?? []).reduce((n, s) => n + (s.tokens ?? 0), 0);
const groupTokenSum = (p) => (p.groups ?? []).reduce((n, g) => n + (g.estimated_tokens ?? g.tokens ?? 0), 0);

const report = {
  cwd: process.cwd(),
  diffEntries: [...real, ...gone],
  diff: {
    exit: diff.exitCode,
    counts: dp.counts ?? null,
    includedCount: (dp.selection?.included ?? []).length,
    groupFilesCount: groupFiles(dp).length,
    unmaterializedField: dp.unmaterialized ?? null,
    selectedUnmaterialisedFlags: (dp.selected ?? []).filter((s) => gone.includes(s.path)).map((s) => `${s.path}:materialized=${s.materialized}:tokens=${s.tokens}`),
    tokenSum: tokenSum(dp),
    groupTokenSum: groupTokenSum(dp),
    groups: (dp.groups ?? []).map((g) => ({ id: g.id, n: (g.files ?? []).length, excluded_unmaterialized: g.excluded_unmaterialized ?? null })),
  },
  root: {
    exit: rootOnly.exitCode,
    counts: rp.counts ?? null,
    includedCount: (rp.selection?.included ?? []).length,
    groupFilesCount: groupFiles(rp).length,
    tokenSum: tokenSum(rp),
    groupTokenSum: groupTokenSum(rp),
    groups: (rp.groups ?? []).map((g) => ({ id: g.id, n: (g.files ?? []).length })),
  },
  gone,
};
report.verdict = {
  countsAligned: report.diff.counts?.selected_materialized === report.root.counts?.selected_materialized && report.diff.counts?.groups === report.root.counts?.groups,
  groupFileCountAligned: report.diff.groupFilesCount === report.root.groupFilesCount,
  unmaterialisedQueryable: Array.isArray(report.diff.unmaterializedField) && report.diff.unmaterializedField.length === gone.length,
  selectedFlagsPresent: report.diff.selectedUnmaterialisedFlags.length === gone.length && report.diff.selectedUnmaterialisedFlags.every((x) => x.includes('materialized=false')),
  tokenLogicUnchanged: report.diff.tokenSum === report.root.tokenSum && report.diff.groupTokenSum === report.root.groupTokenSum,
  contractSurfaceUnchanged: report.diff.includedCount === real.length + gone.length,
};
report.ok = Object.values(report.verdict).every(Boolean);

if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  console.log(`diff counts=${JSON.stringify(report.diff.counts)} groupFiles=${report.diff.groupFilesCount} tokenSum=${report.diff.tokenSum} groupTokenSum=${report.diff.groupTokenSum}`);
  console.log(`root counts=${JSON.stringify(report.root.counts)} groupFiles=${report.root.groupFilesCount} tokenSum=${report.root.tokenSum}`);
  console.log(`unmaterialized=${JSON.stringify(report.diff.unmaterializedField)}`);
  console.log(`selectedFlags=${JSON.stringify(report.diff.selectedUnmaterialisedFlags)}`);
  console.log(`verdict=${JSON.stringify(report.verdict)} ok=${report.ok}`);
}
cleanup(base);
process.exitCode = report.ok ? 0 : 1;

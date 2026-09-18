#!/usr/bin/env node
// verification-t9/tools/b4-unmaterialized.mjs — t45 B4: do diff entries that do not exist on disk
// pollute the audit/token surfaces (`selection.included`, `selected[]`, `groups[]`)?
// A `--root` enumeration of the same tree acts as the control (it can only see real files).
// Usage: node verification-t9/tools/b4-unmaterialized.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { runPreview } from '../../adapters/opencodereview/test/helpers.mjs';
import { tmpDir, writeJson, writeText, cleanup } from '../../packages/qgate/test/helpers.mjs';

const base = tmpDir('b4-unmat-');
const repo = path.join(base, 'repo');
writeText(path.join(repo, 'src', 'app.mjs'), 'export const a = 1;\n'.repeat(40));
writeText(path.join(repo, 'src', 'util.mjs'), 'export const b = 2;\n'.repeat(20));
writeText(path.join(repo, 'docs', 'notes.md'), '# notes\n');
const realFiles = ['src/app.mjs', 'src/util.mjs', 'docs/notes.md'];
const missingFiles = ['gone/one.js', 'gone/two.js', 'gone/three.js', 'gone/four.js', 'gone/five.js', 'gone/six.js'];
const diffPath = path.join(base, 'diff.json');
writeJson(diffPath, { version: '1.0', files: [...realFiles, ...missingFiles] });
const rulePath = path.join(base, 'rule.json');
writeJson(rulePath, { version: '1.0', include: [{ id: 'all', pattern: '**/*', reason: 'B4' }], exclude: [], includeExtensions: ['.mjs', '.md', ''] });

const exists = (rel) => fs.existsSync(path.join(repo, rel));
const modes = [
  { id: 'P1_diff_only', args: ['--diff', diffPath] },
  { id: 'P2_root_only', args: ['--root', repo] },
  { id: 'P3_diff_with_root', args: ['--diff', diffPath, '--root', repo] },
];

const out = [];
for (const m of modes) {
  const r = runPreview([...m.args, '--rule', rulePath, '--json']);
  const p = r.payload ?? {};
  const included = p.selection?.included ?? [];
  const selected = p.selected ?? [];
  const groups = p.groups ?? [];
  const includedMissing = included.filter((x) => !exists(x));
  const selectedMissing = selected.filter((s) => !exists(s.path));
  const groupFiles = groups.flatMap((g) => g.files ?? []);
  const groupMissing = groupFiles.filter((x) => !exists(x));
  const tokenSum = selected.reduce((n, s) => n + (s.tokens ?? 0), 0);
  const groupTokenSum = groups.reduce((n, g) => n + (g.estimated_tokens ?? g.tokens ?? 0), 0);
  const missingTokenSum = selectedMissing.reduce((n, s) => n + (s.tokens ?? 0), 0);
  out.push({
    id: m.id,
    exit: r.exitCode,
    diffEntries: diffFiles(),
    includedCount: included.length,
    includedMissing,
    selectedCount: selected.length,
    selectedMissing: selectedMissing.map((s) => `${s.path}(size=${s.size},tokens=${s.tokens})`),
    groupCount: groups.length,
    groupFilesCount: groupFiles.length,
    groupMissing,
    counts: p.counts ?? null,
    tokenSum,
    groupTokenSum,
    missingTokenSum,
    tokenInflationPct: tokenSum ? Math.round((missingTokenSum / tokenSum) * 1000) / 10 : null,
  });
}
function diffFiles() {
  return JSON.parse(fs.readFileSync(diffPath, 'utf8')).files.length;
}

const diffMode = out.find((x) => x.id === 'P1_diff_only');
const rootMode = out.find((x) => x.id === 'P2_root_only');
const report = {
  cwd: process.cwd(),
  missingFiles,
  realFiles,
  modes: out,
  conclusion: {
    includedCarriesMissingPaths: diffMode.includedMissing.length > 0,
    selectedCarriesMissingPaths: diffMode.selectedMissing.length > 0,
    groupsCarryMissingPaths: diffMode.groupMissing.length > 0,
    tokenSumInflatedBy: diffMode.missingTokenSum,
    tokenInflationPct: diffMode.tokenInflationPct,
    rootModeTokenSum: rootMode.tokenSum,
    rootModeIncludedMissing: rootMode.includedMissing,
  },
};
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  for (const m of out) {
    console.log(`${m.id} exit=${m.exit} included=${m.includedCount} (missing ${m.includedMissing.length}) selected=${m.selectedCount} (missing ${m.selectedMissing.length}) groups=${m.groupCount}/files=${m.groupFilesCount} (missing ${m.groupMissing.length}) tokenSum=${m.tokenSum} groupTokenSum=${m.groupTokenSum} missingTokens=${m.missingTokenSum}`);
  }
  console.log(`conclusion=${JSON.stringify(report.conclusion)}`);
}
cleanup(base);

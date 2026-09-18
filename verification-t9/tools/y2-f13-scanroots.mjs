#!/usr/bin/env node
// verification-t9/tools/y2-f13-scanroots.mjs — t60/Y2: independently reproduce the F13 phenomenon
// that t57 measured and that t59/t61 documented, from the ENTRY POINT the docs now describe.
//
// What is being re-tested (not restated):
//   * `policy.scanRoots` and `check.expectedFiles` are resolved with plain fs calls (`absOf` +
//     `fileExists`, `readdirSync`) and are NOT case-folded, so a mis-cased spelling is decided by the
//     filesystem, not by qgate.
//   * the "empty scan set = violation" guard is AGGREGATE (fires only when every root walks nothing).
//   * the evidence keeps the configuration spelling.
//
// Honest scope note: this machine is case-insensitive NTFS. The case-sensitive filesystem is NOT
// available here (no WSL, no `fsutil file setCaseSensitiveInfo`), so the case-sensitive column is
// produced by the *same code path* a mis-cased root takes on such a filesystem — an absent root
// (readdirSync/statSync fails ⇒ the root contributes no files) — and is labelled as such everywhere.
//
// Usage: node verification-t9/tools/y2-f13-scanroots.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, writeText, writeJson, cleanup, runCliJson } from '../../packages/qgate/test/helpers.mjs';

const CONFIG = (scanRoots, expectedFiles) => ({
  version: '1.0',
  provider: { type: 'deterministic' },
  policy: { scanRoots },
  gates: [
    {
      id: 'scan-probe',
      stage: 'build',
      required: true,
      checks: [
        { id: 'no-key-reads', type: 'policy', policyId: 'SAFE_001', required: true, ...(expectedFiles ? { expectedFiles } : {}) },
      ],
    },
  ],
});

async function probe(label, { onDisk, scanRoots = null, expectedFiles = null }) {
  const base = tmpDir('t60-y2-');
  const root = path.join(base, 'proj');
  for (const rel of onDisk) writeText(path.join(root, rel), 'export const value = 1;\n');
  writeJson(path.join(root, 'qgate.config.json'), CONFIG(scanRoots, expectedFiles));
  const r = await runCliJson(['check', '--config', path.join(root, 'qgate.config.json'), '--json'], { cwd: root, strict: false });
  cleanup(base);
  const gate = r.json?.gates?.[0];
  const check = gate?.checks?.[0];
  const evidenceItems = (check?.evidence || []).map((e) => ({ path: e.path ?? null, kind: e.kind ?? null, excerpt: e.excerpt ?? null }));
  const excerpts = evidenceItems.map((e) => e.excerpt).filter(Boolean);
  const paths = evidenceItems.map((e) => e.path).filter(Boolean);
  const metrics = excerpts.map((e) => /SAFE_001 metrics=(\{.*\})/.exec(e)).find(Boolean);
  const emptyScan = excerpts.find((e) => /empty scan set/.test(e)) || null;
  return {
    label,
    onDisk,
    scanRoots,
    expectedFiles,
    exit: r.status,
    overall_passed: r.json?.overall_passed ?? null,
    check_passed: check?.passed ?? null,
    filesScanned: metrics ? JSON.parse(metrics[1]).filesScanned : null,
    secretPathsExcluded: metrics ? JSON.parse(metrics[1]).secretPathsExcluded : null,
    declaredTargetNotFound: excerpts.filter((e) => /declared scan target not found/.test(e)),
    declaredTargetEvidence: excerpts.filter((e) => /declared scan target/.test(e) && !/not found/.test(e)),
    emptyScanViolation: emptyScan,
    evidencePaths: paths,
    keepsConfigSpelling: paths.some((p) => /SRC\/app\.mjs/.test(p)),
    excerpts,
  };
}

const cases = [
  await probe('N1 aggregate guard: one resolvable root among two', { onDisk: ['src/app.mjs'], scanRoots: ['NOPE', 'src'] }),
  await probe('absent-only root (same code path as a mis-cased root on a case-sensitive FS)', { onDisk: ['src/app.mjs'], scanRoots: ['NOPE'] }),
  await probe('mis-cased root on case-insensitive NTFS (SRC resolves to src)', { onDisk: ['src/app.mjs'], scanRoots: ['SRC'] }),
  await probe('mis-cased expectedFiles on case-insensitive NTFS', { onDisk: ['src/app.mjs'], expectedFiles: ['SRC/app.mjs'] }),
  await probe('unresolvable expectedFiles entry is recorded, never a silent pass', { onDisk: ['src/app.mjs'], expectedFiles: ['NOPE/app.mjs'] }),
  await probe('control: correctly spelled root', { onDisk: ['src/app.mjs'], scanRoots: ['src'] }),
];

const byLabel = Object.fromEntries(cases.map((c) => [c.label, c]));
const report = {
  cwd: process.cwd(),
  platform: { platform: process.platform, caseInsensitiveFs: process.platform === 'win32', caseSensitiveSimulation: 'absent root (same code path: the root contributes no files)' },
  cases,
  summary: {
    n1_aggregate_one_root_resolves: byLabel['N1 aggregate guard: one resolvable root among two'].filesScanned === 1 && byLabel['N1 aggregate guard: one resolvable root among two'].check_passed === true,
    absent_only_root_fails_closed: byLabel['absent-only root (same code path as a mis-cased root on a case-sensitive FS)'].check_passed === false && byLabel['absent-only root (same code path as a mis-cased root on a case-sensitive FS)'].filesScanned === 0,
    miscased_root_resolves_on_windows: byLabel['mis-cased root on case-insensitive NTFS (SRC resolves to src)'].filesScanned === 1,
    miscased_root_keeps_config_spelling: byLabel['mis-cased root on case-insensitive NTFS (SRC resolves to src)'].keepsConfigSpelling,
    miscased_expectedFiles_resolves_on_windows: byLabel['mis-cased expectedFiles on case-insensitive NTFS'].declaredTargetEvidence.length === 1,
    unresolvable_expectedFiles_recorded: byLabel['unresolvable expectedFiles entry is recorded, never a silent pass'].declaredTargetNotFound.length === 1,
  },
};
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  for (const c of cases) {
    console.log(`${c.exit === 0 ? 'exit0' : `exit${c.exit}`} | ${c.label}`);
    console.log(`   scanRoots=${JSON.stringify(c.scanRoots)} expectedFiles=${JSON.stringify(c.expectedFiles)} check_passed=${c.check_passed} filesScanned=${c.filesScanned} emptyScanViolation=${Boolean(c.emptyScanViolation)} declaredNotFound=${c.declaredTargetNotFound.length} spellingKept=${c.keepsConfigSpelling} evidencePaths=${JSON.stringify(c.evidencePaths)}`);
  }
  console.log(`summary=${JSON.stringify(report.summary)}`);
}
process.exitCode = Object.values(report.summary).every(Boolean) ? 0 : 1;

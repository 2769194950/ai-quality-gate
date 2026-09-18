#!/usr/bin/env node
// verification-t9/tools/w3-audit-rows.mjs — t55 W3: independently reproduce four rows of the
// t53 case-insensitivity audit table (packages/qgate/gates/README.md L163-L175) and, in particular,
// the two "deliberately unchanged" decisions and their stated rationales.
// Usage: node verification-t9/tools/w3-audit-rows.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { runCliJson, tmpDir, writeJson, writeText, cleanup } from '../../packages/qgate/test/helpers.mjs';
import { policySafe001 } from '../../packages/qgate/src/policy.mjs';

const rows = [];

// row "secret path rules" (L165) + "default-excluded directories" (L167) are covered by w12-engine-case.mjs.
// Here: user extension allowlist (L170), scan-surface SKIP_DIRECTORIES (L174), binary extension (L168),
// scanRoots empty-scan-set (L173).

// (1) selection.extensions — user allowlist is deliberately case-SENSITIVE (fail-closed)
{
  const base = tmpDir('t55-w3-ext-');
  const root = path.join(base, 'repo');
  writeText(path.join(root, 'src', 'app.mjs'), 'export const a = 1;\n');
  const mk = (name, extensions) => {
    const p = path.join(base, `${name}.json`);
    writeJson(p, { version: '1.0', provider: { type: 'deterministic' }, projectRoot: 'repo', selection: { extensions }, gates: [{ id: 'g1', stage: 'requirements', required: true, checks: [{ id: 'req-doc-exists', type: 'file_exists', file: 'src/app.mjs', required: true }] }] });
    return p;
  };
  const upper = await runCliJson(['preview', '--root', root, '--config', mk('upper', ['.MJS']), '--json'], { strict: false });
  const lower = await runCliJson(['preview', '--root', root, '--config', mk('lower', ['.mjs']), '--json'], { strict: false });
  const upperEx = (upper.json?.selection?.excluded ?? []).find((e) => e.path === 'src/app.mjs');
  rows.push({
    row: 'selection.extensions — user allowlist deliberately case-sensitive (README L170)',
    separateRuns: true,
    upperAllowlist: { extensions: ['.MJS'], included: upper.json?.selection?.included, appReason: upperEx?.reason ?? null },
    lowerAllowlist: { extensions: ['.mjs'], included: lower.json?.selection?.included },
    rationaleHolds: (upper.json?.selection?.included ?? []).length === 0 && upperEx?.reason === 'extension' && (lower.json?.selection?.included ?? []).includes('src/app.mjs'),
    note: 'caller must NOT reuse one preview result for both allowlists (different configs) — hence two separate runs',
  });
  cleanup(base);
}

// (2) scan-surface SKIP_DIRECTORIES — deliberately case-sensitive ⇒ UPPER vendor dir is still scanned
{
  const base = tmpDir('t55-w3-skip-');
  const upperRoot = path.join(base, 'upper');
  const lowerRoot = path.join(base, 'lower');
  writeText(path.join(upperRoot, 'NODE_MODULES', 'dep.mjs'), 'export const k = process.env.ANTHROPIC_API_KEY;\n');
  writeText(path.join(lowerRoot, 'node_modules', 'dep.mjs'), 'export const k = process.env.ANTHROPIC_API_KEY;\n');
  const upper = policySafe001(upperRoot);
  const lower = policySafe001(lowerRoot);
  rows.push({
    row: 'scan-surface SKIP_DIRECTORIES deliberately case-sensitive (README L174)',
    upperDirScanned: { root: '<tmp>/upper (NODE_MODULES/dep.mjs)', filesScanned: upper.metrics?.filesScanned ?? null, violations: upper.metrics?.violations ?? null, passed: upper.passed, detail: upper.violations?.map?.((v) => v.path ?? v.file) ?? null },
    lowerDirSkipped: { root: '<tmp>/lower (node_modules/dep.mjs)', filesScanned: lower.metrics?.filesScanned ?? null, violations: lower.metrics?.violations ?? null, passed: lower.passed },
    // the README's rationale is "making it CI would SKIP vendor trees that are scanned today":
    // the UPPER tree is scanned and the key read is detected; the lower one is skipped (0 files).
    rationaleHolds: (upper.metrics?.filesScanned ?? 0) > 0 && upper.passed === false && (lower.metrics?.filesScanned ?? -1) === 0,
    note: 'the lower tree additionally fails with the empty-scan-set violation (fail-closed), which is why its exit/passed value alone is not the discriminator — filesScanned is',
  });
  cleanup(base);
}

// (3) binary extension list — already case-insensitive (README L168)
{
  const base = tmpDir('t55-w3-bin-');
  const root = path.join(base, 'repo');
  writeText(path.join(root, 'assets', 'LOGO.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]));
  writeText(path.join(root, 'assets', 'other.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]));
  const r = await runCliJson(['preview', '--root', root, '--json'], { strict: false });
  const ex = Object.fromEntries((r.json?.selection?.excluded ?? []).map((e) => [e.path, e.reason]));
  rows.push({
    row: 'binary extension list already insensitive (README L168)',
    excluded: ex,
    rationaleHolds: /binary/.test(String(ex['assets/LOGO.PNG'] ?? '')) && /binary/.test(String(ex['assets/other.png'] ?? '')),
    note: 'both spellings are excluded with a binary reason ⇒ the list is case-insensitive',
  });
  cleanup(base);
}

// (4) policy.scanRoots — an ABSENT root walks nothing and must be a violation, not a silent pass.
//     Note (t55 measurement): on a case-INSENSITIVE filesystem a case-mismatched root still resolves,
//     so the README's wording "a case mismatch walks nothing" holds only on case-sensitive platforms.
{
  const base = tmpDir('t55-w3-roots-');
  const root = path.join(base, 'repo');
  writeText(path.join(root, 'src', 'app.mjs'), 'export const a = 1;\n');
  const wrongCase = policySafe001(root, { scanRoots: ['SRC'] });
  const absent = policySafe001(root, { scanRoots: ['NOPE'] });
  const right = policySafe001(root, { scanRoots: ['src'] });
  rows.push({
    row: 'policy.scanRoots: an unresolvable root ⇒ empty scan set = violation (README L173)',
    caseMismatchedRoot: { scanRoots: ['SRC'], passed: wrongCase.passed, filesScanned: wrongCase.metrics?.filesScanned ?? null },
    absentRoot: { scanRoots: ['NOPE'], passed: absent.passed, filesScanned: absent.metrics?.filesScanned ?? null },
    correctRoot: { scanRoots: ['src'], passed: right.passed, filesScanned: right.metrics?.filesScanned ?? null },
    // fail-closed for a root that resolves to nothing; the case-mismatch sub-claim is platform-dependent
    rationaleHolds: absent.passed === false && (absent.metrics?.filesScanned ?? -1) === 0 && right.passed === true,
    docNuance: 'on this case-insensitive filesystem `SRC` resolves to `src` (filesScanned=' + (wrongCase.metrics?.filesScanned ?? null) + '), so README L173’s "a case mismatch walks nothing" is only true on case-sensitive filesystems',
  });
  cleanup(base);
}

const summary = { rows: rows.length, allRationalesHold: rows.every((r) => r.rationaleHolds) };
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ cwd: process.cwd(), rows, summary }, null, 2)}\n`);
else {
  for (const r of rows) console.log(`${r.rationaleHolds ? 'OK  ' : 'FAIL'} ${r.row}`);
  console.log(`summary=${JSON.stringify(summary)}`);
}
process.exitCode = summary.allRationalesHold ? 0 : 1;

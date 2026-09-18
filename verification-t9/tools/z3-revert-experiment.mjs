#!/usr/bin/env node
// verification-t9/tools/z3-revert-experiment.mjs — t66/Z3: the "one exclusion table" experiment.
//
// Method (behavioural, not code-reading): build a copy of the repository, measure BOTH paths
// (check/SAFE_002 and preview) on it, then remove ONLY the two audit-tree entries
// (`verification`, `verification-t9`) from the copy's DEFAULT_EXCLUDED_PATHS and measure both again.
//   * If both paths move together (SAFE_002's `selected` jumps AND preview starts including
//     verification/** files), the two paths really do read one table.
//   * If only one moves, a second hand-copied table still exists somewhere.
//
// The real repository is never modified: all edits happen in a throwaway copy outside it.
//
// Usage: node verification-t9/tools/z3-revert-experiment.mjs [--copy <dir>] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const opt = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PROBE = path.join(HERE, 'z3-f19-scan-surface.mjs');

const copy = path.resolve(opt('--copy', path.join(os.tmpdir(), `t66-z3-${Date.now()}`)));
const KEEP = ['packages', 'adapters', 'schemas', 'docs', '.github', 'demo', 'package.json', 'qgate.config.json'];
fs.rmSync(copy, { recursive: true, force: true });
fs.mkdirSync(copy, { recursive: true });
for (const entry of KEEP) {
  const from = path.join(ROOT, entry);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(copy, entry), {
    recursive: true,
    filter: (src) => !/[\\/]\.qgate[\\/](evidence|reports)[\\/]/.test(`${src}${path.sep}`) && !/[\\/]node_modules[\\/]/.test(`${src}${path.sep}`),
  });
}
// Synthesise the audit trees the real repository has (content is irrelevant, the count is what matters).
fs.mkdirSync(path.join(copy, 'verification', 'evidence'), { recursive: true });
fs.mkdirSync(path.join(copy, 'verification-t9', 'artifacts-v8'), { recursive: true });
for (let i = 1; i <= 20; i += 1) fs.writeFileSync(path.join(copy, 'verification', 'evidence', `ledger-probe-${i}.json`), '{}');
for (let i = 1; i <= 40; i += 1) fs.writeFileSync(path.join(copy, 'verification-t9', 'artifacts-v8', `probe-${i}.json`), '{}');
fs.writeFileSync(path.join(copy, 'verification', 'trace-matrix.json'), '{}');

// The copy needs the probe tool and the engine test helpers it imports.
fs.mkdirSync(path.join(copy, 'verification-t9', 'tools'), { recursive: true });
fs.copyFileSync(PROBE, path.join(copy, 'verification-t9', 'tools', 'z3-f19-scan-surface.mjs'));

// --mirror-audit: instead of synthesising a small audit tree, mirror the REAL `verification/**` and
// `verification-t9/**` trees so the absolute `selected` numbers are directly comparable with the
// pre-fix figure quoted by the implementer (660).
const mirrorAudit = process.argv.includes('--mirror-audit');
if (mirrorAudit) {
  for (const entry of ['verification', 'verification-t9']) {
    const from = path.join(ROOT, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(copy, entry), { recursive: true, force: true });
  }
}

function measure(root) {
  const outPath = path.join(os.tmpdir(), `t66-z3-measure-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const fd = fs.openSync(outPath, 'w');
  let res;
  try {
    res = spawnSync(process.execPath, [path.join(root, 'verification-t9', 'tools', 'z3-f19-scan-surface.mjs'), '--root', root, '--json'], {
      cwd: root,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  const text = fs.readFileSync(outPath, 'utf8');
  fs.rmSync(outPath, { force: true });
  const jsonText = text.slice(text.indexOf('{'));
  let parsed = null;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = null;
  }
  return { exit: res.status, parsed, rawHead: text.slice(0, 200) };
}

const control = measure(copy);

// Patch ONLY the two audit-tree entries in the copy's single table.
const selectionPath = path.join(copy, 'packages', 'qgate', 'src', 'selection.mjs');
const original = fs.readFileSync(selectionPath, 'utf8');
const patched = original.replace("  'verification',\n  'verification-t9',\n]);", ']);');
const patchApplied = patched !== original;
if (patchApplied) fs.writeFileSync(selectionPath, patched);

const reverted = patchApplied ? measure(copy) : null;

// Leave the copy's code restored so the artefact (if the operator keeps it) is not a landmine.
if (patchApplied) fs.writeFileSync(selectionPath, original);

const report = {
  copy,
  probe: 'verification-t9/tools/z3-f19-scan-surface.mjs',
  patch: { target: 'packages/qgate/src/selection.mjs', removed: "  'verification',\n  'verification-t9',\n]);", applied: patchApplied, bytesRemoved: original.length - patched.length },
  control: control.parsed,
  reverted: reverted?.parsed ?? null,
  delta: control.parsed && reverted?.parsed
    ? {
        check_selected: reverted.parsed.check_safe002.selected - control.parsed.check_safe002.selected,
        preview_included: reverted.parsed.preview.included - control.parsed.preview.included,
        preview_audit_tree_entries: reverted.parsed.preview.includedInAuditTree - control.parsed.preview.includedInAuditTree,
        secretPathsExcluded_control: control.parsed.check_safe002.secretPathsExcluded,
        secretPathsExcluded_reverted: reverted.parsed.check_safe002.secretPathsExcluded,
      }
    : null,
  summary: control.parsed && reverted?.parsed
    ? {
        bothPathsMovedTogether: reverted.parsed.check_safe002.selected > control.parsed.check_safe002.selected && reverted.parsed.preview.includedInAuditTree > control.parsed.preview.includedInAuditTree,
        controlExcludesAuditTrees: control.parsed.preview.includedInAuditTree === 0,
        revertingBringsAuditTreesBackOnPreview: reverted.parsed.preview.includedInAuditTree > 0,
        revertingBringsAuditTreesBackOnCheck: reverted.parsed.check_safe002.selected > control.parsed.check_safe002.selected,
        safetyNotRegressedByRevert: reverted.parsed.check_safe002.secretPathsExcluded === control.parsed.check_safe002.secretPathsExcluded && control.parsed.check_safe002.passed === true,
      }
    : null,
};
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  console.log(`copy=${copy} patchApplied=${patchApplied}`);
  console.log(`control : check.selected=${control.parsed?.check_safe002.selected} preview.included=${control.parsed?.preview.included} preview.auditTree=${control.parsed?.preview.includedInAuditTree}`);
  console.log(`reverted: check.selected=${reverted?.parsed?.check_safe002.selected} preview.included=${reverted?.parsed?.preview.included} preview.auditTree=${reverted?.parsed?.preview.includedInAuditTree}`);
  console.log(`delta=${JSON.stringify(report.delta)}`);
  console.log(`summary=${JSON.stringify(report.summary)}`);
}

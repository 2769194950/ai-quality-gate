#!/usr/bin/env node
// verification-t9/tools/z3-f19-scan-surface.mjs — t66/Z3: measure the F19 scan surface on BOTH paths
// (check/SAFE_002 and preview) and print them as machine-readable numbers, so the "one exclusion table"
// claim can be tested behaviourally (revert the table in a copy and watch BOTH paths move together)
// instead of by reading code.
//
// Usage: node verification-t9/tools/z3-f19-scan-surface.mjs [--root <dir>] [--json]
//   --root defaults to the repository root; point it at a COPY to run the before/after experiment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { policySafe002 } from '../../packages/qgate/src/policy.mjs';
import { runCliJson } from '../../packages/qgate/test/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const opt = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const ROOT = path.resolve(opt('--root', path.resolve(HERE, '..', '..')));

// ── path 1: check (SAFE_002), the predicate the root config's `no-secret-paths` check uses ──
const safe002 = policySafe002(ROOT);

// ── path 2: preview (the engine CLI, which resolves its own exclusion configuration) ──
const cfg = path.join(ROOT, 'qgate.config.json');
const preview = await runCliJson(['preview', '--config', cfg, '--json'], { cwd: ROOT, strict: false });
const included = preview.json?.selection?.included ?? [];
const inAuditTrees = included.filter((p) => p === 'verification' || p.startsWith('verification/') || p.startsWith('verification-t9/'));
const inRuntimeTrees = included.filter((p) => p.startsWith('.qgate/'));
const excludedByReason = {};
for (const e of preview.json?.selection?.excluded ?? []) excludedByReason[e.reason] = (excludedByReason[e.reason] || 0) + 1;

const report = {
  root: ROOT,
  cwd: process.cwd(),
  check_safe002: {
    passed: safe002.passed,
    violations: safe002.violations.map((v) => v.message),
    selected: safe002.metrics.selected,
    secretPathsExcluded: safe002.metrics.secretPathsExcluded,
    secretPathRules: safe002.metrics.secretPathRules,
    widestInclude: safe002.metrics.widestInclude,
  },
  preview: {
    exit: preview.status,
    ok: preview.json?.ok ?? null,
    included: included.length,
    includedInAuditTree: inAuditTrees.length,
    includedInRuntimeOutputTree: inRuntimeTrees.length,
    auditTreeSample: inAuditTrees.slice(0, 5),
    selectedCountField: preview.json?.counts?.selected ?? null,
    excludedByReason,
    invariants: preview.json?.invariants ?? null,
    secretPathsSelected: (preview.json?.invariants?.secretPathsSelected ?? []).length,
  },
  summary: {
    checkScanExcludesAuditTrees: !included.some(() => false) && safe002.metrics.selected < 400,
    previewExcludesAuditTrees: inAuditTrees.length === 0,
    previewExcludesRuntimeOutput: inRuntimeTrees.length === 0,
    safe002NotRegressed: safe002.passed === true && safe002.metrics.secretPathsExcluded >= 1,
    checkAndPreviewAgreeOnAuditTrees: inAuditTrees.length === 0 && safe002.metrics.selected === included.length,
  },
};
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  console.log(`root=${ROOT}`);
  console.log(`check/SAFE_002 : passed=${safe002.passed} selected=${safe002.metrics.selected} secretPathsExcluded=${safe002.metrics.secretPathsExcluded} violations=${safe002.violations.length}`);
  console.log(`preview        : exit=${preview.status} included=${included.length} inAuditTrees=${inAuditTrees.length} inRuntimeOutput=${inRuntimeTrees.length} selectedField=${preview.json?.counts?.selected ?? null} excluded=${JSON.stringify(excludedByReason)}`);
  console.log(`summary=${JSON.stringify(report.summary)}`);
}

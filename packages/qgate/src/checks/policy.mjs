// `policy` — SAFE_001 / SAFE_002 / SAFE_003 / CONTRACT_001 enforcement (§5.1).
import path from 'node:path';
import { runPolicy, resolveRepoRoot } from '../policy.mjs';
import { evidence, fileEvidence } from '../evidence.mjs';
import { fileExists } from '../util/fsx.mjs';
import { toPosix } from '../util/glob.mjs';
import { normalizeRel, absOf, result } from './_shared.mjs';

/**
 * Evidence paths are resolved against the project root (`ctx.root`), but the policy scan
 * surface can sit outside it (a repository-level scan driven by a nested `projectRoot`).
 * Emitting the scan-root-relative path directly would produce a reference that resolves
 * nowhere, so every file reference is expressed project-relative (REQ-007).
 */
function projectRelative(root, absPath) {
  return toPosix(path.relative(root, absPath));
}

export function checkPolicy(ctx, check) {
  const repoRoot = ctx.repoRoot ?? resolveRepoRoot(ctx.root);
  // SAFE_002 audits the selection result of the inspected repository itself
  // (`include` can only re-admit paths that the selector actually walks), while
  // SAFE_001/SAFE_003/CONTRACT_001 scan the implementation surface.
  const isSelectionPolicy = check.policyId === 'SAFE_002';
  const scannerRoot = isSelectionPolicy ? ctx.root : ctx.policyScanRoot ?? repoRoot;
  const outcome = runPolicy(check.policyId, scannerRoot, {
    configPath: ctx.configAbsPath ?? ctx.configPath ?? 'qgate.config.json',
    files: check.expectedFiles ?? null,
    scanRoots: ctx.policyScanRoots ?? null,
  });
  const prefix = `POLICY_VIOLATION_${check.policyId}`;
  const configSource = ctx.configPath ?? 'qgate.config.json';
  const evidenceList = [];

  if (Array.isArray(check.expectedFiles) && check.expectedFiles.length > 0) {
    for (const rel of check.expectedFiles.slice(0, 5)) {
      const relNorm = normalizeRel(rel);
      const absDeclared = absOf(scannerRoot, relNorm);
      evidenceList.push(
        fileExists(absDeclared)
          ? fileEvidence(ctx.root, projectRelative(ctx.root, absDeclared), 'declared scan target')
          : evidence(configSource, 'json_pointer', `declared scan target not found: ${relNorm}`),
      );
    }
  }
  const sampleFile = (outcome.files ?? []).find((rel) => fileExists(absOf(repoRoot, rel)));
  if (sampleFile) {
    evidenceList.push(
      fileEvidence(ctx.root, projectRelative(ctx.root, absOf(repoRoot, sampleFile)), `policy scan sample (${outcome.metrics.filesScanned ?? 0} file(s) scanned)`),
    );
  }
  evidenceList.push(evidence(configSource, 'json_pointer', `${check.policyId} metrics=${JSON.stringify(outcome.metrics)}`));
  for (const violation of outcome.violations.slice(0, 8)) {
    const pointer = String(violation.pointer ?? '/');
    const target = pointer.startsWith('/') ? pointer.slice(1) : pointer;
    const targetNorm = normalizeRel(target);
    const scanRootForTarget = isSelectionPolicy ? scannerRoot : repoRoot;
    const absTarget = absOf(scanRootForTarget, targetNorm);
    if (targetNorm && targetNorm !== '.' && fileExists(absTarget)) {
      evidenceList.push(fileEvidence(ctx.root, projectRelative(ctx.root, absTarget), violation.message));
    } else {
      evidenceList.push(evidence(configSource, 'json_pointer', `${pointer} ${violation.message}`));
    }
  }

  const passed = outcome.violations.length === 0;
  const message = passed ? null : `${prefix}: ${outcome.violations.slice(0, 5).map((v) => v.message).join('; ')}`;
  return { ...result(passed, evidenceList, message), outcome };
}

export const type = 'policy';
export const description = 'enforce SAFE_001|SAFE_002|SAFE_003|CONTRACT_001 invariants';

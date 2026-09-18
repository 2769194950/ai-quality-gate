// `trace_matrix` — bidirectional traceability check (§5.3.3, REQ-006).
import { evidence, missingFileEvidence } from '../evidence.mjs';
import { judgeTraceMatrix, readJsonFile } from '../trace.mjs';
import { fileExists } from '../util/fsx.mjs';
import { normalizeRel, absOf, result } from './_shared.mjs';

export function checkTraceMatrix(ctx, check) {
  const requirementsFile = normalizeRel(check.requirementsFile);
  const traceFile = normalizeRel(check.traceFile);
  const requirements = readJsonFile(absOf(ctx.root, requirementsFile));
  const trace = readJsonFile(absOf(ctx.root, traceFile));
  const ledgerIndex = ctx.loadLedgerIndex ? ctx.loadLedgerIndex() : null;
  // Coverage basis: the test ids the evidence ledger records (§5.3.3). The ledger index
  // aggregates them append-only, so a `--stage` run can never shrink the basis.
  const judgement = judgeTraceMatrix({
    root: ctx.root,
    requirements,
    trace,
    ledgerIndex,
    enforce: check.enforce ?? 'strict',
    testIdSource: check.testIdSource ?? 'ledger-index',
    // Rule 6 input: the *current* configuration, so append-only ledger history can
    // never certify a testId whose carrying check has been deleted (H8).
    configuredCheckIds: Array.isArray(ctx.configuredCheckIds) ? ctx.configuredCheckIds : null,
    configSource: ctx.configPath ?? null,
  });

  const evidenceList = [];
  if (requirements === null) {
    evidenceList.push(missingFileEvidence(ctx.configPath, requirementsFile, `not found: ${requirementsFile}`));
  } else {
    const count = Array.isArray(requirements.requirements) ? requirements.requirements.length : 0;
    evidenceList.push(evidence(requirementsFile, 'json_pointer', `/requirements (length=${count})`));
  }
  if (trace === null) {
    evidenceList.push(missingFileEvidence(ctx.configPath, traceFile, `not found: ${traceFile}`));
  } else {
    evidenceList.push(evidence(traceFile, 'trace', `/summary (covered=${judgement.summary.covered}, uncovered=${judgement.summary.uncovered})`));
  }
  const ledgerRel = (ctx.ledgerIndexRel ?? 'verification/evidence/ledger-index.json').split('\\').join('/');
  const ledgerCount = (ledgerIndex?.testIds ?? []).length;
  // The coverage basis is machine-readable in this excerpt through the existing
  // `testIdSource` field of the judgement: "trace-only" appears only when the
  // configuration opted in explicitly, so a green verdict never hides a
  // self-certifying basis.
  const ledgerDetail =
    judgement.testIdSource === 'trace-only'
      ? 'testIdSource=trace-only (coverage certified from the trace document; not dependent on ledger testId evidence)'
      : `testIdSource=ledger-index testIds=${ledgerCount}${ledgerCount === 0 ? ' (coverage basis missing / not evaluated)' : ''}`;
  // The ledger index is referenced only when it is actually on disk (no `--write` run yet
  // means the first run of a fresh checkout has no index at all).
  evidenceList.push(
    fileExists(absOf(ctx.root, ledgerRel))
      ? evidence(ledgerRel, 'ledger', ledgerDetail)
      : missingFileEvidence(ctx.configPath, ledgerRel, ledgerDetail),
  );
  for (const violation of judgement.violations.slice(0, 8)) {
    const detail = `${violation.prefix}: ${violation.pointer || '/'} ${violation.message}`;
    // A missing trace file cannot be referenced as `kind="trace"` (it would dangle);
    // the deciding artefact is then the configuration itself.
    evidenceList.push(trace === null ? missingFileEvidence(ctx.configPath, traceFile, detail) : evidence(traceFile, 'trace', detail));
  }

  const passed = judgement.violations.length === 0;
  const prefix = judgement.violations.find((v) => v.prefix === 'TRACE_GAP')?.prefix ?? judgement.violations[0]?.prefix ?? 'TRACE_GAP';
  const message = passed ? null : `${prefix}: ${judgement.violations.slice(0, 5).map((v) => v.message).join('; ')}`;
  return { ...result(passed, evidenceList, message), judgement };
}

export const type = 'trace_matrix';
export const description = 'verify bidirectional requirement ↔ test ↔ evidence coverage';

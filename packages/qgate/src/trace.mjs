// Trace-matrix construction and consistency rules (docs/01-architecture.md §5.3.3, REQ-006).
import path from 'node:path';
import fs from 'node:fs';
import { traceMatrixSchemaVersion, stageOrder, checkTestIds } from './contract.mjs';
import { readTextIfExists, writeFileAtomic, stringifyJson } from './util/fsx.mjs';
import { parsePointer, evaluatePointer, MISSING } from './util/jsonptr.mjs';

export const consistencyRules = Object.freeze([
  'summary.requirements == requirements.length and covered + uncovered == requirements',
  'every trace requirementId exists in the requirements index (bidirectional)',
  'orphanTestIds == |ledgerIndex.testIds - union(testIds)| == 0',
  'enforce=strict => any P0/P1 entry with covered=false fails the check (TRACE_GAP)',
  'coverageRatio == round(covered / requirements, 4)',
  'every testId that justifies coverage must still be produced by a check of the *current* configuration (historical, append-only ledger evidence may not certify a configuration whose carrying check was deleted)',
  'testIdSource="ledger-index" with no ledger testId evidence is reported as not evaluated (fail-closed); only an explicit testIdSource="trace-only" may certify coverage from the trace document alone',
]);

export function readJsonFile(absPath) {
  const text = readTextIfExists(absPath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { __parseError: true };
  }
}

/**
 * Normalise `docs/requirements-index.json` into
 * `[{requirementId, priority, testIds, stage, codePaths, declaredCovered, uncoveredReason}]`.
 *
 * `declaredCovered` carries the index's own `covered` flag when the requirement owner
 * states it. That statement is evidence about the *test suite* (the owner knows whether
 * a test exists), so the trace check treats a declared-uncovered P0/P1 requirement as a
 * finding instead of letting the static check→testId mapping certify it.
 */
export function normalizeRequirementsIndex(document) {
  const entries = [];
  if (!document || document.__parseError || !Array.isArray(document.requirements)) return entries;
  for (const entry of document.requirements) {
    if (!entry || typeof entry !== 'object') continue;
    entries.push({
      requirementId: entry.id ?? entry.requirementId ?? null,
      title: entry.title ?? null,
      priority: entry.priority ?? 'P2',
      testIds: Array.isArray(entry.testIds) ? [...entry.testIds] : [],
      stage: Array.isArray(entry.stage) ? [...entry.stage] : [],
      codePaths: Array.isArray(entry.codePaths) ? [...entry.codePaths] : [],
      covered: null,
      declaredCovered: typeof entry.covered === 'boolean' ? entry.covered : null,
      uncoveredReason: typeof entry.uncoveredReason === 'string' && entry.uncoveredReason.length > 0 ? entry.uncoveredReason : null,
    });
  }
  return entries;
}

/** Normalise `verification/trace-matrix.json` into the same shape, honouring recorded `covered`. */
export function normalizeTraceMatrix(document) {
  const entries = [];
  if (!document || document.__parseError || !Array.isArray(document.requirements)) return entries;
  for (const entry of document.requirements) {
    if (!entry || typeof entry !== 'object') continue;
    entries.push({
      requirementId: entry.requirementId ?? entry.id ?? null,
      title: entry.title ?? null,
      priority: entry.priority ?? 'P2',
      testIds: Array.isArray(entry.testIds) ? [...entry.testIds] : [],
      stage: Array.isArray(entry.stage) ? [...entry.stage] : [],
      codePaths: Array.isArray(entry.codePaths) ? [...entry.codePaths] : [],
      covered: typeof entry.covered === 'boolean' ? entry.covered : null,
    });
  }
  return entries;
}

function pointerOf(index) {
  return `/requirements/${index}`;
}

function evaluatedPointer(document, pointer) {
  const value = evaluatePointer(document, pointer);
  return value === MISSING ? undefined : value;
}

/**
 * Evaluate every consistency rule. Returns `{ violations, summary, requirements, testIdSource }`.
 * Violations carry the frozen `TRACE_GAP` / `ORPHAN_TEST_ID` prefixes where they apply.
 */
export function judgeTraceMatrix({
  root,
  requirements,
  trace,
  ledgerIndex,
  enforce = 'strict',
  testIdSource = 'ledger-index',
  configuredCheckIds = null,
  configSource = null,
} = {}) {
  const violations = [];
  const reqDoc = requirements;
  const traceDoc = trace;
  const reqEntries = normalizeRequirementsIndex(reqDoc);
  const traceEntries = normalizeTraceMatrix(traceDoc);
  const ledgerTestIds = Array.isArray(ledgerIndex?.testIds) ? [...new Set(ledgerIndex.testIds)].sort() : [];
  const traceDeclaredTestIds = [...new Set(traceEntries.flatMap((e) => e.testIds))].sort();
  // Coverage rests on the test ids the evidence ledger records (§5.3.3: "以账本中实际
  // 出现的 testId 证据为准"). The ledger index aggregates them append-only, so a run
  // that only executes one stage (`--stage build`, the CI shape) can never shrink the
  // basis. A requirement that the index itself declares uncovered is handled by rule 0.
  //
  // Rule 7 (coverage basis, fail-closed — R1): `testIdSource: "ledger-index"` means the
  // ledger records what actually ran. When the ledger records **no testId at all**,
  // nothing was inspected, and "nothing inspected" must never read as "nothing found"
  // (the same rule the empty safety scan set and an un-evaluable stdout assertion
  // follow). Silently falling back to the trace document would let the trace certify
  // itself on exactly the path an attacker controls — wipe `evidence/**` and the gate
  // turns green again. Only an **explicit** `testIdSource: "trace-only"` may take the
  // trace document as the basis, and that basis is then visible in the verdict
  // (`testIdSource: "trace-only"`, carried into the check's evidence excerpt).
  const traceOnlyDeclared = testIdSource === 'trace-only';
  const hasLedgerEvidence = ledgerTestIds.length > 0;
  const coverageEvaluated = traceOnlyDeclared || hasLedgerEvidence;
  const sourceIds = traceOnlyDeclared ? traceDeclaredTestIds : ledgerTestIds;
  const sourceName = traceOnlyDeclared ? 'trace-only' : 'ledger-index';

  if (!reqDoc || reqDoc.__parseError) {
    violations.push({ rule: 2, prefix: 'TRACE_GAP', pointer: '', message: 'requirements index is missing or not parseable JSON' });
  }
  if (!traceDoc || traceDoc.__parseError) {
    violations.push({ rule: 1, prefix: 'TRACE_GAP', pointer: '', message: 'trace matrix is missing or not parseable JSON' });
  }
  if (violations.length > 0) {
    return { violations, summary: emptySummary(), requirements: [], testIdSource: sourceName };
  }

  const byId = new Map(reqEntries.map((entry, index) => [entry.requirementId, { ...entry, index }]));
  const seenTraceIds = new Set();

  // Rule 0 (declared coverage): the requirements index is authored by the requirement
  // owner and may state, per requirement, that no test covers it. That statement is
  // evidence about the *suite*, not a strictness setting, so a declared-uncovered P0/P1
  // requirement is a finding regardless of `enforce`: otherwise the static
  // check→testId mapping would certify coverage that no test provides.
  for (const entry of reqEntries) {
    if (entry.declaredCovered !== false) continue;
    if (entry.priority !== 'P0' && entry.priority !== 'P1') continue;
    violations.push({
      rule: 0,
      prefix: 'TRACE_GAP',
      pointer: pointerOf(entry.index),
      message: `${entry.requirementId} is declared covered=false by the requirements index${entry.uncoveredReason ? ` (${entry.uncoveredReason})` : ''} but ${entry.testIds.length > 0 ? `its testIds [${entry.testIds.join(', ')}] are only claimed by the static check→testId mapping` : 'it declares no testIds'}`,
    });
  }

  // Rule 6 (carrying check / H8): the ledger index is append-only by contract, so the
  // testIds of *earlier* runs survive a configuration edit. Coverage may therefore be
  // certified by evidence that the current configuration can no longer produce — the
  // exact "delete a check to dodge the gate" hole. Every testId used to justify
  // coverage must still have its carrying check declared by the current configuration;
  // historical ledger entries are kept (append-only is preserved) but they can no
  // longer speak for a check that is gone. The distinguishing input is the current
  // configuration itself (`configuredCheckIds`, taken from the loaded config), never
  // the run history: a run's `testIds` come from the static check→testId mapping of the
  // checks that executed, so a *removed* check leaves its testId in history while the
  // current config no longer names it.
  if (configuredCheckIds === null) {
    violations.push({
      rule: 6,
      prefix: 'TRACE_GAP',
      pointer: '/testIds',
      message: 'the current configuration was not supplied to the trace judgement, so no testId can be tied to a live carrying check (carrier assertion not evaluated)',
    });
  } else {
    const configured = new Set(configuredCheckIds);
    const carriersByTestId = new Map();
    for (const [checkId, testId] of Object.entries(checkTestIds)) {
      if (!carriersByTestId.has(testId)) carriersByTestId.set(testId, []);
      carriersByTestId.get(testId).push(checkId);
    }
    for (const entry of traceEntries) {
      for (const testId of entry.testIds) {
        const carriers = carriersByTestId.get(testId) ?? [];
        const index = byId.get(entry.requirementId)?.index;
        const pointer = index === undefined ? `/requirements/${entry.requirementId}/testIds` : `${pointerOf(index)}/testIds`;
        // A testId with no entry in the frozen check→testId mapping belongs to a project
        // that names its own tests (the mapping is this repository's suite); the
        // coverage rules already handle it. Only a *deleted carrier* is rule 6's subject.
        if (carriers.length === 0) continue;
        if (!carriers.some((checkId) => configured.has(checkId))) {
          violations.push({
            rule: 6,
            prefix: 'TRACE_GAP',
            pointer,
            message: `${entry.requirementId} is covered only by historical evidence: testId ${testId} is produced by check(s) ${carriers.map((id) => `"${id}"`).join(', ')}, which ${carriers.length === 1 ? 'is' : 'are'} absent from the current configuration${configSource ? ` (${configSource})` : ''}`,
          });
        }
      }
    }
  }

  // Rule 7: no evidence basis and no explicit opt-in => the coverage judgement was not
  // evaluated, which is a finding, not a pass.
  if (!coverageEvaluated) {
    violations.push({
      rule: 7,
      prefix: 'TRACE_GAP',
      pointer: '/summary/covered',
      message:
        'coverage basis missing / not evaluated: testIdSource="ledger-index" but the ledger index records no testId evidence, so no coverage can be certified (declare testIdSource:"trace-only" explicitly to certify from the trace document alone)',
    });
  }

  // Rule 1: counts
  if (reqEntries.length !== traceEntries.length) {
    violations.push({
      rule: 1,
      prefix: 'TRACE_GAP',
      pointer: '/summary/requirements',
      message: `trace matrix has ${traceEntries.length} requirement(s) but the index declares ${reqEntries.length}`,
    });
  }
  const declaredSummary = traceDoc.summary ?? {};
  if (typeof declaredSummary.requirements === 'number' && declaredSummary.requirements !== reqEntries.length) {
    violations.push({
      rule: 1,
      prefix: 'TRACE_GAP',
      pointer: '/summary/requirements',
      message: `summary.requirements=${declaredSummary.requirements} does not equal requirements.length=${reqEntries.length}`,
    });
  }
  if (
    typeof declaredSummary.covered === 'number' &&
    typeof declaredSummary.uncovered === 'number' &&
    typeof declaredSummary.requirements === 'number' &&
    declaredSummary.covered + declaredSummary.uncovered !== declaredSummary.requirements
  ) {
    violations.push({
      rule: 1,
      prefix: 'TRACE_GAP',
      pointer: '/summary',
      message: `covered(${declaredSummary.covered}) + uncovered(${declaredSummary.uncovered}) != requirements(${declaredSummary.requirements})`,
    });
  }

  let coveredCount = 0;
  const declaredTestIds = new Set();
  traceEntries.forEach((entry, index) => {
    const pointer = pointerOf(index);
    const requirementId = entry.requirementId;
    if (!requirementId) {
      violations.push({ rule: 2, prefix: 'TRACE_GAP', pointer: `${pointer}/requirementId`, message: `trace entry ${index} has no requirementId` });
      return;
    }
    if (seenTraceIds.has(requirementId)) {
      violations.push({ rule: 2, prefix: 'TRACE_GAP', pointer: `${pointer}/requirementId`, message: `duplicate trace requirementId ${requirementId}` });
    }
    seenTraceIds.add(requirementId);

    const indexed = byId.get(requirementId);
    if (!indexed) {
      // Rule 2: bidirectional coverage
      violations.push({
        rule: 2,
        prefix: 'TRACE_GAP',
        pointer: `${pointer}/requirementId`,
        message: `${requirementId} exists in ${'verification/trace-matrix.json'} but not in docs/requirements-index.json`,
      });
    } else {
      const declared = [...indexed.testIds].sort().join(',');
      const recorded = [...entry.testIds].sort().join(',');
      if (declared !== recorded) {
        violations.push({
          rule: 2,
          prefix: 'TRACE_GAP',
          pointer: `${pointer}/testIds`,
          message: `${requirementId} testIds drift: index=[${declared}] trace=[${recorded}]`,
        });
      }
      if (typeof declaredSummary.requirements === 'number' && traceDoc.requirements.length !== reqEntries.length) {
        /* already reported by rule 1 */
      }
    }

    const effective = entry.testIds.length > 0 && entry.testIds.every((t) => sourceIds.includes(t));
    entry.testIds.forEach((t) => declaredTestIds.add(t));
    if (entry.priority === 'P0' || entry.priority === 'P1') {
      if (entry.testIds.length === 0) {
        violations.push({
          rule: 2,
          prefix: 'TRACE_GAP',
          pointer: `${pointer}/testIds`,
          message: `${requirementId} is ${entry.priority} but declares no testIds`,
        });
      }
    }
    // Rules 4 and 5 are *about* the evidence basis: with no basis they are not
    // evaluated at all (rule 7 reports that), so they must not derive "uncovered"
    // findings from an absent basis.
    if (coverageEvaluated && entry.covered !== null && entry.covered !== effective) {
      violations.push({
        rule: 5,
        prefix: 'TRACE_GAP',
        pointer: `${pointer}/covered`,
        message: `${requirementId} covered=${entry.covered} but computed covered=${effective} from ${sourceName}`,
      });
    }
    entry.computedCovered = coverageEvaluated ? effective : null;
    if (effective) coveredCount += 1;
    else if (coverageEvaluated && enforce === 'strict' && (entry.priority === 'P0' || entry.priority === 'P1')) {
      const missing = entry.testIds.filter((t) => !sourceIds.includes(t));
      violations.push({
        rule: 4,
        prefix: 'TRACE_GAP',
        pointer: `${pointer}/covered`,
        message: `${requirementId} covered=false${missing.length > 0 ? ` (testIds ${missing.join(',')} absent from ${sourceName})` : ' (no testIds declared)'}`,
      });
    }
  });

  // Requirements declared in the index but absent from the trace matrix (rule 2).
  for (const entry of reqEntries) {
    if (!seenTraceIds.has(entry.requirementId)) {
      violations.push({
        rule: 2,
        prefix: 'TRACE_GAP',
        pointer: `/requirements/${entry.index}`,
        message: `${entry.requirementId} exists in docs/requirements-index.json but not in verification/trace-matrix.json`,
      });
    }
  }

  // Rule 3: orphan test ids (evidence-derived: skipped when there is no basis)
  const orphans = coverageEvaluated ? sourceIds.filter((id) => !declaredTestIds.has(id)) : [];
  if (orphans.length > 0) {
    violations.push({
      rule: 3,
      prefix: 'ORPHAN_TEST_ID',
      pointer: '/summary/orphanTestIds',
      message: `orphan testIds present in ${sourceName} but referenced by no requirement: ${orphans.join(',')}`,
    });
  }
  if (coverageEvaluated && typeof declaredSummary.orphanTestIds === 'number' && declaredSummary.orphanTestIds !== orphans.length) {
    violations.push({
      rule: 3,
      prefix: 'ORPHAN_TEST_ID',
      pointer: '/summary/orphanTestIds',
      message: `summary.orphanTestIds=${declaredSummary.orphanTestIds} but computed ${orphans.length}`,
    });
  }

  // Rule 5: coverage ratio (evidence-derived: skipped when there is no basis)
  const ratio = reqEntries.length === 0 ? 0 : Math.round((coveredCount / reqEntries.length) * 10000) / 10000;
  if (coverageEvaluated && typeof declaredSummary.coverageRatio === 'number') {
    const drift = Math.abs(declaredSummary.coverageRatio - ratio) > 1e-9;
    const recordedCovered = typeof declaredSummary.covered === 'number' ? declaredSummary.covered : null;
    if (drift) {
      violations.push({
        rule: 5,
        prefix: 'TRACE_GAP',
        pointer: '/summary/coverageRatio',
        message: `summary.coverageRatio=${declaredSummary.coverageRatio} but computed ${ratio}`,
      });
    }
    if (recordedCovered !== null && recordedCovered !== coveredCount) {
      violations.push({
        rule: 5,
        prefix: 'TRACE_GAP',
        pointer: '/summary/covered',
        message: `summary.covered=${recordedCovered} but computed ${coveredCount}`,
      });
    }
  }

  const summary = {
    requirements: reqEntries.length,
    covered: coveredCount,
    uncovered: reqEntries.length - coveredCount,
    orphanTestIds: orphans.length,
    coverageRatio: ratio,
  };

  return {
    violations: violations.sort((a, b) => (a.rule - b.rule) || (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0)),
    summary,
    requirements: traceEntries.map((entry, index) => ({ ...entry, index, testIds: [...entry.testIds], stage: [...entry.stage], codePaths: [...entry.codePaths] })),
    testIdSource: sourceName,
    ledgerTestIds,
  };
}

function emptySummary() {
  return { requirements: 0, covered: 0, uncovered: 0, orphanTestIds: 0, coverageRatio: 0 };
}

/**
 * Extract `requirementId -> title` from the requirements markdown, using the
 * heading lines that carry the id (e.g. `### REQ-DEMO-001 — …`).
 */
export function titlesFromMarkdown(root, markdownPath) {
  const titles = new Map();
  const text = readTextIfExists(path.join(root, markdownPath.split('/').join(path.sep)));
  if (text === null) return titles;
  const heading = /^#{1,6}\s+((?:REQ|T)-[A-Z0-9-]+-\d{3,4})\s*(?:[-—:]\s*)?(.*)$/gm;
  let match;
  while ((match = heading.exec(text)) !== null) {
    const id = match[1];
    const title = match[2].trim();
    if (!titles.has(id) && title.length > 0) titles.set(id, title);
  }
  return titles;
}

/**
 * Build a trace matrix document from the requirements index plus the ledger index.
 * Pure function of its inputs except `generatedAt` / `runId`.
 */
export function buildTraceMatrix({
  root,
  requirementsPath = 'docs/requirements-index.json',
  requirementsMarkdown = null,
  ledgerIndex = null,
  ledgerIndexPath = 'verification/evidence/ledger-index.json',
  generatedAt,
  runId,
} = {}) {
  const reqDoc = readJsonFile(path.join(root, requirementsPath.split('/').join(path.sep)));
  // Where the requirement titles live is declared by the index itself (`source`), so a
  // fixture whose documents sit next to the index still gets real titles instead of a
  // placeholder.
  const markdown = requirementsMarkdown ?? (typeof reqDoc?.source === 'string' && reqDoc.source.length > 0 ? reqDoc.source : 'docs/00-requirements.md');
  const titles = titlesFromMarkdown(root, markdown);
  const ledgerTestIds = [...new Set(ledgerIndex?.testIds ?? [])].sort();
  const entries = normalizeRequirementsIndex(reqDoc).map((entry) => {
    const covered = entry.testIds.length > 0 && entry.testIds.every((t) => ledgerTestIds.includes(t));
    const title = entry.title ?? titles.get(entry.requirementId) ?? `${entry.requirementId} (title not found in ${markdown})`;
    return {
      requirementId: entry.requirementId,
      title,
      priority: entry.priority,
      stage: entry.stage.length > 0 ? entry.stage : [...stageOrder],
      testIds: entry.testIds,
      codePaths: entry.codePaths,
      covered,
      evidence: covered
        ? [
            {
              path: ledgerIndexPath,
              kind: 'ledger',
              excerpt: `${entry.testIds.join(',')}@${runId ?? 'none'}`,
            },
          ]
        : [],
    };
  });
  const covered = entries.filter((e) => e.covered).length;
  const orphans = ledgerTestIds.filter((id) => !entries.some((e) => e.testIds.includes(id)));
  return {
    schemaVersion: traceMatrixSchemaVersion,
    generated_at: generatedAt,
    generated_by: 'qgate trace',
    // §5.3.3 freezes `run_id` as a string; when the matrix is generated before any run
    // exists there is no run to reference, so the document says so explicitly instead of
    // emitting `null` (which the schema rejects).
    run_id: typeof runId === 'string' && runId.length > 0 ? runId : 'none',
    pipeline: [...stageOrder],
    summary: {
      requirements: entries.length,
      covered,
      uncovered: entries.length - covered,
      orphanTestIds: orphans.length,
      coverageRatio: entries.length === 0 ? 0 : Math.round((covered / entries.length) * 10000) / 10000,
    },
    requirements: entries,
  };
}

export function writeTraceMatrix(absPath, document) {
  writeFileAtomic(absPath, stringifyJson(document));
  return absPath;
}

export { evaluatedPointer };

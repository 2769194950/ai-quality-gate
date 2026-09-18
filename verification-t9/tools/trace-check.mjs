#!/usr/bin/env node
// verification/tools/trace-check.mjs 鈥?assertion #8 evidence.
// `qgate trace --json` must report covered=true and non-empty testIds for every requirement and
// the summary counters must agree with the arrays (搂5.3.3 consistency rules, doc l.671-677).
// Usage: node verification/tools/trace-check.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const load = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, ''));

// t60 self-repair: the trace file used to be HARDCODED to a superseded revision (artifacts-v7), so this
// tool could report a clean verdict about an artifact that no longer describes the current tree.
// The revision input is now required and a missing file fails closed (exit 3).
const traceArg = argv.includes('--trace') ? argv[argv.indexOf('--trace') + 1] : null;
if (!traceArg) {
  console.error('UNPARSABLE: --trace <file> is required (which revision trace matrix is being checked must be explicit)');
  process.exit(3);
}
if (!fs.existsSync(path.join(ROOT, traceArg))) {
  console.error(`UNPARSABLE: trace file not found: ${traceArg}`);
  process.exit(3);
}
const trace = load(traceArg);
const config = load('demo/qgate.config.json');
const projectRoot = path.join(ROOT, 'demo', config.projectRoot ?? '.');
const ledgerIndex = JSON.parse(fs.readFileSync(path.join(projectRoot, '.qgate', 'evidence', 'ledger-index.json'), 'utf8').replace(/^\uFEFF/, ''));
const requirementsIndex = JSON.parse(fs.readFileSync(path.join(projectRoot, '.qgate', 'requirements-index.json'), 'utf8').replace(/^\uFEFF/, ''));

const reqs = trace.requirements ?? [];
const ledgerTestIds = new Set(ledgerIndex.testIds ?? []);
const indexIds = new Set((requirementsIndex.requirements ?? []).map((r) => r.id ?? r.requirementId));
const traceIds = reqs.map((r) => r.requirementId);

const notCovered = reqs.filter((r) => r.covered !== true).map((r) => r.requirementId);
const emptyTestIds = reqs.filter((r) => !Array.isArray(r.testIds) || r.testIds.length === 0).map((r) => r.requirementId);
const coveredRuleViolations = reqs.filter((r) => {
  const expected = Array.isArray(r.testIds) && r.testIds.length > 0 && r.testIds.every((t) => ledgerTestIds.has(t));
  return r.covered !== expected;
}).map((r) => r.requirementId);
const coveredWithoutEvidence = reqs.filter((r) => r.covered === true && (!Array.isArray(r.evidence) || r.evidence.length === 0)).map((r) => r.requirementId);
const unionTestIds = new Set(reqs.flatMap((r) => r.testIds ?? []));
const orphans = [...ledgerTestIds].filter((t) => !unionTestIds.has(t));
const missingFromIndex = traceIds.filter((id) => !indexIds.has(id));
const missingFromTrace = [...indexIds].filter((id) => !traceIds.includes(id));

const summary = trace.summary ?? {};
const coveredCount = reqs.filter((r) => r.covered === true).length;
const checks = {
  everyRequirementCovered: notCovered.length === 0,
  everyRequirementHasTestIds: emptyTestIds.length === 0,
  coveredFlagMatchesFrozenRule: coveredRuleViolations.length === 0,
  coveredRequiresEvidence: coveredWithoutEvidence.length === 0,
  summaryRequirementsEqualsArrayLength: summary.requirements === reqs.length,
  summaryCoveredPlusUncoveredConsistent: summary.covered + summary.uncovered === summary.requirements,
  summaryCoveredEqualsCounted: summary.covered === coveredCount,
  summaryUncoveredEqualsCounted: summary.uncovered === reqs.length - coveredCount,
  orphanTestIdsZero: summary.orphanTestIds === 0 && orphans.length === 0,
  coverageRatioMatches: summary.coverageRatio === Math.round((coveredCount / reqs.length) * 10000) / 10000,
  pipelineIsFiveStages: JSON.stringify(trace.pipeline) === JSON.stringify(['requirements', 'design', 'build', 'review', 'verify']),
  generatedByIsQgateTrace: trace.generated_by === 'qgate trace',
  requirementIdsBidirectional: missingFromIndex.length === 0 && missingFromTrace.length === 0,
};

const report = {
  traceFile: traceArg,
  projectRoot: config.projectRoot,
  requirementCount: reqs.length,
  summary,
  computed: { coveredCount, uncoveredCount: reqs.length - coveredCount, coverageRatio: Math.round((coveredCount / reqs.length) * 10000) / 10000, ledgerTestIdCount: ledgerTestIds.size, unionTestIdCount: unionTestIds.size },
  notCovered,
  emptyTestIds,
  coveredRuleViolations,
  coveredWithoutEvidence,
  orphans,
  missingFromIndex,
  missingFromTrace,
  checks,
  allChecksPass: Object.values(checks).every(Boolean),
};

if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'OK  ' : 'FAIL'} ${k}`);
  console.log(`requirements=${reqs.length} covered=${coveredCount} uncovered=${reqs.length - coveredCount} summary=${JSON.stringify(summary)}`);
  console.log(`allChecksPass=${report.allChecksPass}`);
}
process.exitCode = report.allChecksPass ? 0 : 1;







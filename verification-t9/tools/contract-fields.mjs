#!/usr/bin/env node
// verification/tools/contract-fields.mjs 闁?assertions #9/#11 evidence.
// Compares the documented field sets of docs/01-architecture.md (閹?.1 config, 閹?.2 RunResult,
// 閹?.3 artefacts, 閹?.1 approval) against (a) the four frozen JSON Schemas and (b) the real
// artefacts produced at runtime. Documented sets are transcribed by hand; each carries the doc
// line range it came from. Usage: node verification/tools/contract-fields.mjs [--runresult <file>] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const runResultArg = argv.includes('--runresult') ? argv[argv.indexOf('--runresult') + 1] : null;
const asJson = argv.includes('--json');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, ''));

const CONFIG_DOC = {
  top: { lines: '319-325', fields: ['version', 'provider', 'gates', 'policy', 'projectRoot', 'selection', 'grouping'] },
  provider: { lines: '333-339', fields: ['type', 'script', 'timeoutMs', 'model', 'endpoint', 'fixture', 'confidenceThreshold'] },
  policy: { lines: '345-348', fields: ['evidenceDir', 'reportDir', 'failFast', 'scanRoots'] },
  selection: { lines: '354-361', fields: ['include', 'exclude', 'extensions', 'defaultExcludedPaths', 'maxFileSizeBytes', 'maxFilesPerGroup', 'tokenBudgetPerGroup', 'ruleFile'] },
  grouping: { lines: '367-369', fields: ['maxFilesPerGroup', 'tokenBudgetPerGroup', 'tokensPerFile'] },
  gate: { lines: '375-379', fields: ['id', 'stage', 'required', 'checks', 'humanGate'] },
  humanGate: { lines: '409-416', fields: ['role', 'gateId', 'approvalRecord', 'enforcement'] },
  checkCommon: { lines: '393-398', fields: ['id', 'type', 'required', 'severity', 'onFail', 'description'] },
};
const CHECK_DOC = {
  file_exists: ['file', 'minCount'],
  file_not_exists: ['file'],
  regex: ['files', 'pattern', 'flags', 'mode', 'minMatches', 'countMode', 'encoding'],
  command: ['run', 'expectExitCode', 'timeoutMs', 'cwd', 'captureStdout', 'stdoutRegex'],
  json_assert: ['file', 'assertions'],
  trace_matrix: ['requirementsFile', 'traceFile', 'enforce', 'testIdSource'],
  policy: ['policyId', 'expectedFiles'],
};
const RUNRESULT_DOC = {
  top: { lines: '496-503', fields: ['version', 'run_id', 'started_at', 'finished_at', 'duration_ms', 'overall_passed', 'provider', 'gates'] },
  provider: { lines: '502', fields: ['type', 'degraded', 'detail'] },
  gate: { lines: '509-515', fields: ['id', 'stage', 'required', 'passed', 'humanGate', 'blockers', 'checks'] },
  humanGate: { lines: '513', fields: ['role', 'approvalRecord', 'approvalState', 'approvedBy', 'approvedAt'] },
  blocker: { lines: '521-524', fields: ['checkId', 'severity', 'message', 'evidence'] },
  check: { lines: '530-534', fields: ['id', 'type', 'passed', 'severity', 'evidence'] },
  evidence: { lines: '544-546', fields: ['path', 'kind', 'excerpt'] },
};
const LEDGER_DOC = {
  ledger: { lines: '592-601', fields: ['schemaVersion', 'ledgerId', 'runId', 'started_at', 'finished_at', 'projectRoot', 'configPath', 'configSha256', 'provider', 'entries'] },
  entry: { lines: '601', fields: ['gateId', 'stage', 'checkId', 'type', 'required', 'passed', 'severity', 'durationMs', 'testId', 'evidence'] },
  index: { lines: '607-613', fields: ['schemaVersion', 'updated_at', 'runIds', 'ledgers', 'testIds'] },
  indexEntry: { lines: '611', fields: ['runId', 'path', 'sha256', 'overall_passed', 'started_at'] },
};
const TRACE_DOC = {
  root: { lines: '656-661', fields: ['schemaVersion', 'generated_at', 'generated_by', 'run_id', 'pipeline', 'summary', 'requirements'] },
  requirement: { lines: '662-669', fields: ['requirementId', 'title', 'priority', 'stage', 'testIds', 'codePaths', 'covered', 'evidence'] },
  summary: { lines: '661', fields: ['requirements', 'covered', 'uncovered', 'orphanTestIds', 'coverageRatio'] },
};
const APPROVAL_DOC = { lines: '894-901', fields: ['schemaVersion', 'gateId', 'role', 'decision', 'approvedBy', 'approvedAt', 'claims', 'notes'] };

function deref(schema, node) {
  let cur = node;
  const seen = new Set();
  while (cur && typeof cur === 'object' && typeof cur.$ref === 'string') {
    if (seen.has(cur.$ref)) break;
    seen.add(cur.$ref);
    const m = /^#\/\$defs\/(.+)$/.exec(cur.$ref);
    if (!m) break;
    cur = schema.$defs?.[m[1]];
  }
  return cur ?? node;
}
function propNames(schema, node, depth = 0) {
  const resolved = deref(schema, node);
  if (!resolved || typeof resolved !== 'object' || depth > 6) return new Set();
  const out = new Set(Object.keys(resolved.properties ?? {}));
  for (const key of ['allOf', 'oneOf', 'anyOf']) for (const sub of resolved[key] ?? []) for (const name of propNames(schema, sub, depth + 1)) out.add(name);
  return out;
}
const sorted = (set) => [...set].sort();
const diff = (documented, actual) => {
  const actualSet = actual instanceof Set ? actual : new Set(actual);
  return {
    documented: sorted(new Set(documented)),
    actual: sorted(actualSet),
    missing: sorted(new Set(documented.filter((f) => !actualSet.has(f)))),
    extra: sorted(new Set([...actualSet].filter((f) => !documented.includes(f)))),
  };
};
const compare = (doc, actualSet) => {
  const d = diff(doc.fields, actualSet);
  return { docLines: doc.lines, ...d, match: d.missing.length === 0 && d.extra.length === 0 };
};

const cfg = read('schemas/config.schema.json');
const rr = read('schemas/run-result.schema.json');
const led = read('schemas/evidence-ledger.schema.json');
const tr = read('schemas/trace-matrix.schema.json');

const schemaCompare = {
  'config.schema.json': {
    top: compare(CONFIG_DOC.top, propNames(cfg, cfg)),
    provider: compare(CONFIG_DOC.provider, propNames(cfg, cfg.$defs.provider)),
    policy: compare(CONFIG_DOC.policy, propNames(cfg, cfg.$defs.policySettings)),
    selection: compare(CONFIG_DOC.selection, propNames(cfg, cfg.$defs.selectionSettings)),
    grouping: compare(CONFIG_DOC.grouping, propNames(cfg, cfg.$defs.groupingSettings)),
    gate: compare(CONFIG_DOC.gate, propNames(cfg, cfg.$defs.gate)),
    humanGate: compare(CONFIG_DOC.humanGate, propNames(cfg, cfg.$defs.humanGate)),
    checkCommon: compare(CONFIG_DOC.checkCommon, propNames(cfg, cfg.$defs.checkBase)),
    ...Object.fromEntries(Object.entries(CHECK_DOC).map(([type, fields]) => {
      const defName = `check${type.split('_').map((s) => s[0].toUpperCase() + s.slice(1)).join('')}`;
      return [`check.${type}`, compare({ lines: '402-410', fields: [...CONFIG_DOC.checkCommon.fields, ...fields] }, propNames(cfg, cfg.$defs[defName]))];
    })),
  },
  'run-result.schema.json': {
    top: compare(RUNRESULT_DOC.top, propNames(rr, rr)),
    provider: compare(RUNRESULT_DOC.provider, propNames(rr, rr.$defs.provider)),
    gate: compare(RUNRESULT_DOC.gate, propNames(rr, rr.$defs.gate)),
    humanGate: compare(RUNRESULT_DOC.humanGate, propNames(rr, rr.$defs.humanGateResult)),
    blocker: compare(RUNRESULT_DOC.blocker, propNames(rr, rr.$defs.blocker)),
    check: compare(RUNRESULT_DOC.check, propNames(rr, rr.$defs.checkResult)),
    evidence: compare(RUNRESULT_DOC.evidence, propNames(rr, rr.$defs.evidence)),
  },
  'evidence-ledger.schema.json': {
    ledger: compare(LEDGER_DOC.ledger, propNames(led, led.$defs.ledgerDocument)),
    entry: compare(LEDGER_DOC.entry, propNames(led, led.$defs.ledgerEntry)),
    index: compare(LEDGER_DOC.index, propNames(led, led.$defs.ledgerIndexDocument)),
    indexEntry: compare(LEDGER_DOC.indexEntry, propNames(led, led.$defs.ledgerIndexEntry)),
  },
  'trace-matrix.schema.json': {
    root: compare(TRACE_DOC.root, propNames(tr, tr)),
    requirement: compare(TRACE_DOC.requirement, propNames(tr, tr.$defs.requirementTrace)),
    summary: compare(TRACE_DOC.summary, propNames(tr, tr.properties?.summary ?? {})),
  },
};

const keysOf = (obj) => (obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : []);
// t60 self-repair: the runtime comparison used to be wrapped in `if (fs.existsSync(...))`, so a missing
// file silently removed the `real-runresult-vs-doc` comparison while the tool still reported
// `mismatches: 0` — a silent skip that reads as a pass (the same defect class as a stale baseline).
// Now the revision input is REQUIRED and a missing file fails closed.
if (!argv.includes('--runresult') || !runResultArg) {
  console.error('UNPARSABLE: --runresult <file> is required — the runtime field-surface comparison is not optional; a missing input is not a pass');
  process.exit(3);
}
const runResultPath = path.isAbsolute(runResultArg) ? runResultArg : path.join(ROOT, runResultArg);
if (!fs.existsSync(runResultPath)) {
  console.error(`UNPARSABLE: runresult file not found: ${runResultArg}`);
  process.exit(3);
}
let realRunResult = null;
if (true) {
  const value = JSON.parse(fs.readFileSync(runResultPath, 'utf8').replace(/^\uFEFF/, '').replace(/^[^{[]*/, ''));
  const gates = value.gates ?? [];
  // union over the whole run, not one sampled object: a passing run has zero blockers, and a
  // single empty sample would masquerade as a field-set mismatch
  const unionKeys = (items) => {
    const s = new Set();
    for (const it of items) for (const k of keysOf(it)) s.add(k);
    return s;
  };
  const allBlockers = gates.flatMap((g) => g?.blockers ?? []);
  const allChecks = gates.flatMap((g) => g?.checks ?? []);
  const allEvidence = allChecks.flatMap((c) => c?.evidence ?? []);
  const allHumanGates = gates.map((g) => g?.humanGate).filter((h) => h && typeof h === 'object');
  const levelOrNone = (doc, set, label) =>
    set.size === 0
      ? { docLines: doc.lines, documented: sorted(new Set(doc.fields)), actual: [], missing: [], extra: [], match: null, note: `not exercised in this run: ${label}` }
      : compare(doc, set);
  realRunResult = {
    file: runResultArg,
    top: compare(RUNRESULT_DOC.top, keysOf(value)),
    provider: compare(RUNRESULT_DOC.provider, keysOf(value.provider)),
    gate: compare(RUNRESULT_DOC.gate, keysOf(gates[0] ?? {})),
    humanGate: levelOrNone(RUNRESULT_DOC.humanGate, unionKeys(allHumanGates), 'no non-null humanGate object'),
    blocker: levelOrNone(RUNRESULT_DOC.blocker, unionKeys(allBlockers), 'run has no blockers (gate passed)'),
    check: levelOrNone(RUNRESULT_DOC.check, unionKeys(allChecks), 'run has no checks'),
    evidence: levelOrNone(RUNRESULT_DOC.evidence, unionKeys(allEvidence), 'run has no evidence objects'),
    sampled: { gateCount: gates.length, blockerObjects: allBlockers.length, checkObjects: allChecks.length, humanGateObjects: allHumanGates.length, evidenceObjects: allEvidence.length },
  };
}

const configFiles = ['demo/qgate.config.json', 'packages/qgate/test/_canonical-config.json', 'packages/qgate/examples/valid/five-stage.json'];
const realConfigs = configFiles.map((file) => {
  const value = read(file);
  const gate = (value.gates ?? []).find((g) => g && typeof g === 'object') ?? {};
  const check = (gate.checks ?? []).find((c) => c && typeof c === 'object') ?? {};
  return {
    file,
    levels: {
      top: compare(CONFIG_DOC.top, keysOf(value)),
      provider: compare(CONFIG_DOC.provider, keysOf(value.provider)),
      policy: compare(CONFIG_DOC.policy, keysOf(value.policy)),
      selection: compare(CONFIG_DOC.selection, keysOf(value.selection)),
      grouping: compare(CONFIG_DOC.grouping, keysOf(value.grouping)),
      gate: compare(CONFIG_DOC.gate, keysOf(gate)),
      check: compare({ lines: '393-410', fields: [...CONFIG_DOC.checkCommon.fields, ...(CHECK_DOC[check.type] ?? [])] }, keysOf(check)),
    },
  };
});

const approvalSchemaPresent = ['config', 'run-result', 'evidence-ledger', 'trace-matrix'].some((n) => JSON.stringify(read(`schemas/${n}.schema.json`)).includes('approval.json'));
const report = {
  method: 'documented field tables transcribed by hand (line ranges cited) vs schema property sets (union over allOf/oneOf/anyOf branches) vs real artefacts',
  documentedSets: { CONFIG_DOC, CHECK_DOC, RUNRESULT_DOC, LEDGER_DOC, TRACE_DOC, APPROVAL_DOC },
  schemaCompare,
  realRunResult,
  realConfigs,
  section91Approval: {
    documented: APPROVAL_DOC,
    dedicatedSchemaFile: approvalSchemaPresent,
    note: 'schemas/README.md maps only config / run-result / evidence-ledger / trace-matrix; 閹?.1 approval.json therefore has no JSON Schema and is only checkable textually (plus the run-result humanGate approvedBy/approvedAt form).',
  },
};

const mismatches = [];
for (const [schemaName, levels] of Object.entries(schemaCompare)) {
  for (const [level, cmp] of Object.entries(levels)) {
    if (!cmp.match) mismatches.push({ kind: 'schema-vs-doc', schema: schemaName, level, missing: cmp.missing, extra: cmp.extra });
  }
}
for (const rc of realConfigs) {
  for (const [level, cmp] of Object.entries(rc.levels)) {
    if (cmp.extra.length > 0) mismatches.push({ kind: 'real-config-uses-undocumented-field', file: rc.file, level, extra: cmp.extra });
  }
}
if (realRunResult) {
  for (const [level, cmp] of Object.entries(realRunResult)) {
    if (typeof cmp?.match !== 'boolean') continue;
    if (!cmp.match) mismatches.push({ kind: 'real-runresult-vs-doc', level, missing: cmp.missing, extra: cmp.extra });
  }
}
report.mismatches = mismatches;

if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  for (const [schemaName, levels] of Object.entries(schemaCompare)) {
    for (const [level, cmp] of Object.entries(levels)) console.log(`${cmp.match ? 'OK  ' : 'DIFF'} ${schemaName} :: ${level} (doc l.${cmp.docLines}) missing=${JSON.stringify(cmp.missing)} extra=${JSON.stringify(cmp.extra)}`);
  }
  if (realRunResult) {
    for (const [level, cmp] of Object.entries(realRunResult)) {
      if (typeof cmp?.match !== 'boolean') continue;
      console.log(`${cmp.match ? 'OK  ' : 'DIFF'} real RunResult :: ${level} missing=${JSON.stringify(cmp.missing)} extra=${JSON.stringify(cmp.extra)}`);
    }
    console.log(`sampled from ${JSON.stringify(realRunResult.sampled)}`);
  }
  for (const rc of realConfigs) for (const [level, cmp] of Object.entries(rc.levels)) if (cmp.extra.length) console.log(`DIFF ${rc.file} :: ${level} uses undocumented ${JSON.stringify(cmp.extra)}`);
  console.log(`mismatch count = ${mismatches.length}`);
}







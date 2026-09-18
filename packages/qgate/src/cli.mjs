// qgate CLI module: the importable command surface (§6). All paths are derived from `import.meta.url` and
// from the supplied arguments, so every command works from any cwd without
// `npm install` and without relying on PATH.
//
// Exit codes (§6.3): 0 passed | 1 gate failed | 2 config error | 3 internal error.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  describeContract,
  detectContractDrift,
  commands as contractCommands,
  globalOptions,
  stageOrder,
  exitCodes,
  checkTestIds,
} from './contract.mjs';
import { loadConfig, defaultPolicy, defaultSelection } from './config.mjs';
import { runPipeline, stripRuntimeFields } from './core.mjs';
import { buildTraceMatrix, judgeTraceMatrix, readJsonFile, normalizeRequirementsIndex } from './trace.mjs';
import { loadLedgerIndex, DEFAULT_EVIDENCE_DIR } from './ledger.mjs';
import { renderLedgerReport } from './report.mjs';
import { selectFiles, assertNoSecretPathsSelected } from './selection.mjs';
import { groupFiles } from './grouping.mjs';
import { loadRuleChain, matchRule, PROJECT_RULE_PATH } from './rules.mjs';
import { resolveEvidence } from './evidence.mjs';
import { QgateError, configError, notFoundError, internalError, evidenceError, driftError, ioError } from './errors.mjs';
import { stringifyJson, writeFileAtomic } from './util/fsx.mjs';
import { redact } from './util/text.mjs';
import {
  assertStage,
  buildStageManifest,
  formatStageExplanation,
  makeInvalidEvidence,
  makeOfflineEvidence,
  normalizeOcrResult,
  readJsonInput,
  writeStageEvidence,
} from './stage-review.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const SRC_ROOT = HERE;
const CONTRACT_RECORD = path.join(PACKAGE_ROOT, 'gates', 'contract.json');

const COMMAND_NAMES = contractCommands.map((c) => c.name);

// --------------------------------------------------------------- argument model
const COMMAND_OPTIONS = {
  contract: { '--check': 'flag' },
  check: { '--stage': 'value', '--gate': 'multi', '--fail-fast': 'flag' },
  trace: { '--write': 'flag' },
  preview: { '--rule': 'value' },
  report: { '--last': 'value', '--longest': 'value' },
  explain: { '--gate': 'value', '--check': 'value', '--requirement': 'value' },
  stage: { '--mode': 'value', '--result': 'value', '--diff': 'value', '--evidence': 'value' },
};

const GLOBAL_OPTION_SPEC = new Map(globalOptions.map((option) => [option.name, option.takesValue]));

function parseArgs(argv) {
  const args = argv.slice();
  let command = null;
  const options = { json: false, summary: false, quiet: false, color: 'auto', out: null, config: 'qgate.config.json', root: null };
  const own = {};
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) {
      if (command === null) command = token;
      else positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const inlineValue = eq === -1 ? null : token.slice(eq + 1);

    if (command === null) {
      // Global options may precede the command name.
      if (!GLOBAL_OPTION_SPEC.has(name)) throw configError(`unknown option "${name}" before a command`, pointerForOption(name));
      if (GLOBAL_OPTION_SPEC.get(name)) {
        const value = inlineValue ?? args[++i];
        if (value === undefined) throw configError(`option "${name}" requires a value`, pointerForOption(name));
        if (name === '--config') options.config = value;
        else if (name === '--root') options.root = value;
        else if (name === '--color') options.color = value;
        else if (name === '--out') options.out = value;
      } else {
        setBooleanOption(options, name);
      }
      continue;
    }

    const ownSpec = COMMAND_OPTIONS[command] ?? {};
    if (Object.prototype.hasOwnProperty.call(ownSpec, name)) {
      const kind = ownSpec[name];
      if (kind === 'flag') {
        own[name] = true;
      } else {
        const value = inlineValue ?? args[++i];
        if (value === undefined) throw configError(`option "${name}" requires a value`, pointerForOption(name));
        if (kind === 'multi') {
          own[name] = [...(own[name] ?? []), value];
        } else {
          own[name] = value;
        }
      }
      continue;
    }
    if (GLOBAL_OPTION_SPEC.has(name)) {
      if (GLOBAL_OPTION_SPEC.get(name)) {
        const value = inlineValue ?? args[++i];
        if (value === undefined) throw configError(`option "${name}" requires a value`, pointerForOption(name));
        if (name === '--config') options.config = value;
        else if (name === '--root') options.root = value;
        else if (name === '--color') options.color = value;
        else if (name === '--out') options.out = value;
      } else {
        setBooleanOption(options, name);
      }
      continue;
    }
    throw configError(`unknown option "${name}" for command "${command}"`, pointerForOption(name));
  }

  if (command === null) throw configError('no command given; expected one of ' + COMMAND_NAMES.join('|'), { jsonPointer: '' });
  if (!COMMAND_NAMES.includes(command)) throw configError(`unknown command "${command}"; expected one of ${COMMAND_NAMES.join('|')}`, { jsonPointer: '' });
  if (command === 'stage') {
    if (positional.length !== 2 || !['review', 'ingest', 'explain'].includes(positional[1])) {
      throw configError('stage requires exactly <stage> <review|ingest|explain>', { jsonPointer: '' });
    }
  } else if (positional.length > 0) throw configError(`unexpected positional argument "${positional[0]}"`, { jsonPointer: '' });
  if (options.json && options.summary) throw configError('--json and --summary are mutually exclusive', { jsonPointer: '' });
  if (!['auto', 'always', 'never'].includes(options.color)) throw configError(`--color must be one of auto|always|never (got "${options.color}")`, { jsonPointer: '' });
  return { command, options, own, positional };
}

function setBooleanOption(options, name) {
  switch (name) {
    case '--json':
      options.json = true;
      break;
    case '--summary':
      options.summary = true;
      break;
    case '--quiet':
      options.quiet = true;
      break;
    default:
      throw configError(`unknown option "${name}"`, pointerForOption(name));
  }
}

function pointerForOption(name) {
  return { jsonPointer: '', details: [{ jsonPointer: '', expected: 'known CLI option', actual: name, message: `unknown option ${name}` }] };
}

function log(ctx, io, message) {
  if (ctx.options.quiet || ctx.options.json) return;
  io.stderr(`${message}\n`);
}

// ------------------------------------------------------------------- command io
function emit(ctx, io, value, { text = null, exitCode = 0 } = {}) {
  let body;
  if (ctx.options.json) {
    // --json: the machine-readable document only (§6.1: no prefix, no logs, no colour).
    body = stringifyJson(value);
  } else if (ctx.options.summary) {
    // --summary: human-readable tables (§6.2 describes each command's summary as a
    // table). Falling back to JSON only when a command has no table form keeps the two
    // modes meaningfully different.
    body = `${text ?? stringifyJson(value)}\n`;
  } else {
    body = `${text ?? stringifyJson(value)}\n`;
  }
  io.stdout(body);
  if (ctx.options.out) {
    writeFileAtomic(ctx.options.out, stringifyJson(value));
  }
  return exitCode;
}

function emitError(ctx, io, error) {
  const qgateError = toQgateError(error);
  const payload = qgateError.toJSON();
  if (ctx?.options?.json) {
    io.stdout(stringifyJson(redactDeep(payload)));
  } else {
    io.stderr(`${qgateError.code}: ${qgateError.message}\n`);
    if (qgateError.jsonPointer) io.stderr(`  jsonPointer: ${qgateError.jsonPointer}\n`);
    for (const detail of qgateError.details ?? []) {
      io.stderr(`  - ${detail.jsonPointer || '/'}: ${detail.message ?? ''} (expected: ${detail.expected ?? '-'}, actual: ${detail.actual ?? '-'})\n`);
    }
  }
  return qgateError.exitCode ?? exitCodes.INTERNAL_ERROR;
}

function toQgateError(error) {
  if (error instanceof QgateError) return error;
  const wrapped = internalError(`uncaught ${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`);
  wrapped.stack = error?.stack;
  return wrapped;
}

function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = redactDeep(value[key]);
    return out;
  }
  return value;
}

function load(ctx, { optional = false } = {}) {
  if (optional) {
    const defaultConfigPath = path.resolve(process.cwd(), ctx.options.config);
    const explicit = ctx.options.config !== 'qgate.config.json';
    if (!explicit && !fs.existsSync(defaultConfigPath)) {
      const loaded = { config: defaultConfig(), root: ctx.options.root ? path.resolve(process.cwd(), ctx.options.root) : process.cwd(), absPath: defaultConfigPath, text: '', sha256: '' };
      ctx.loaded = loaded;
      return loaded;
    }
  }
  const loaded = loadConfig(ctx.options.config, { root: ctx.options.root, cwd: process.cwd() });
  ctx.loaded = loaded;
  return loaded;
}

/** Defaults used by commands that do not strictly require a configuration file. */
function defaultConfig() {
  return {
    version: '1.0',
    provider: { type: 'deterministic', script: null, timeoutMs: 30000, model: null, endpoint: null, fixture: null, confidenceThreshold: 0.7 },
    policy: { ...defaultPolicy },
    selection: { ...defaultSelection },
    grouping: { maxFilesPerGroup: defaultSelection.maxFilesPerGroup, tokenBudgetPerGroup: defaultSelection.tokenBudgetPerGroup, tokensPerFile: 4 },
    projectRoot: null,
    gates: [],
    meta: { configPath: 'qgate.config.json', humanGateCount: 0, approvalsMissing: 3, declaredGateOrder: [] },
  };
}

function checkSummary(runResult, meta) {
  const notRun = meta?.notRun ?? [];
  return {
    overall_passed: runResult.overall_passed,
    gates: runResult.gates.map((gate) => ({
      id: gate.id,
      stage: gate.stage,
      required: gate.required,
      passed: gate.passed,
      humanGate: gate.humanGate ? gate.humanGate.approvalState : null,
      blockers: gate.blockers.length,
      checks: gate.checks.length,
    })),
    // `gates[]` mirrors the RunResult (frozen key set, §5.2). Gates that a
    // --stage/--gate filter or fail-fast left un-run are reported here instead, so
    // the machine-readable contract never grows an undeclared key.
    not_run_gates: notRun.map((entry) => ({ id: entry.id, stage: entry.stage, reason: entry.reason })),
    run_id: runResult.run_id,
    provider: runResult.provider,
    approvals_missing: meta?.approvalsMissing ?? 0,
  };
}

/**
 * §6.2 summary shapes — the machine-readable **envelope** these builders produce is
 * written by `--summary --out <file>`; plain `--summary` prints the human-readable
 * table instead (`--json` stays the frozen document, §5.2/§5.3.3). Measured output
 * surfaces per command are described by `commandOkSemantics` in `src/contract.mjs`.
 */
function contractSummary(described, extras = {}) {
  return {
    ok: true,
    configSchemaVersion: described.configSchemaVersion,
    runResultSchemaVersion: described.runResultSchemaVersion,
    stages: described.stages,
    checkTypes: described.checkTypes,
    humanGates: described.humanGates.map((g) => ({ gateId: g.gateId, role: g.role })),
    exitCodes: described.exitCodes,
    commands: described.commands.map((c) => c.name),
    ...extras,
  };
}

function traceSummary(document, judge, target, written) {
  return {
    ok: true,
    written: Boolean(written),
    traceFile: target.traceFile,
    requirementsFile: target.requirementsFile,
    summary: judge.summary,
    requirements: document.requirements.map((entry) => ({
      requirementId: entry.requirementId,
      priority: entry.priority,
      testIds: entry.testIds,
      covered: entry.covered,
    })),
    violations: judge.violations,
  };
}

function previewSummary(value) {
  const byReason = {};
  for (const entry of value.selection.excluded) byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1;
  return {
    ok: true,
    root: value.root,
    included: value.selection.included.length,
    excluded: value.selection.excluded.length,
    excludedByReason: byReason,
    groups: value.groups.map((group) => ({ id: group.id, files: group.files.length, downgraded: group.downgraded, tokens: group.tokens })),
    ruleSources: value.rules.sources,
    secretPathsSelected: value.invariants.secretPathsSelected.length,
  };
}

function checkSummaryText(runResult, meta) {
  const lines = [];
  lines.push('stage        | gate                 | required | passed | blockers | checks');
  lines.push('-------------|----------------------|----------|--------|----------|-------');
  for (const gate of runResult.gates) {
    lines.push(
      `${gate.stage.padEnd(12)} | ${gate.id.padEnd(20)} | ${String(gate.required).padEnd(8)} | ${String(gate.passed).padEnd(6)} | ${String(gate.blockers.length).padEnd(8)} | ${gate.checks.length}`,
    );
  }
  lines.push('');
  lines.push(`overall_passed=${runResult.overall_passed} run_id=${runResult.run_id} provider=${runResult.provider.type}${runResult.provider.degraded ? ' (degraded)' : ''}`);
  for (const entry of meta.notRun ?? []) {
    lines.push(`  not-run ${entry.stage}/${entry.id}: ${entry.reason}`);
  }
  if (meta.approvalsMissing > 0) lines.push(`approvals_missing=${meta.approvalsMissing} human gate(s) not configured`);
  if (meta.ledgerRelPath) lines.push(`ledger=${meta.ledgerRelPath}`);
  if (meta.ledgerIndexRelPath) lines.push(`ledger-index=${meta.ledgerIndexRelPath}`);
  for (const gate of runResult.gates) {
    for (const blocker of gate.blockers) {
      lines.push(`  blocker[${blocker.severity}] ${blocker.checkId}: ${blocker.message}`);
    }
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------- commands
async function commandContract(ctx, io) {
  const described = describeContract();
  if (ctx.own['--check']) {
    const recorded = readJsonFile(CONTRACT_RECORD);
    if (recorded === null || recorded.__parseError) {
      throw driftError(`frozen contract record is missing or unreadable: ${path.relative(PACKAGE_ROOT, CONTRACT_RECORD)}`, {
        details: [{ jsonPointer: '', expected: 'readable frozen contract record', actual: CONTRACT_RECORD, message: 'contract record not found' }],
      });
    }
    const drift = detectContractDrift(recorded);
    if (drift.length > 0) {
      throw driftError(`contract drift detected (${drift.length} item(s))`, {
        details: drift.map((item) => ({ jsonPointer: '', expected: 'frozen mapping', actual: item, message: item })),
      });
    }
    const text = [
      'contract self-check: OK',
      `stages(${described.stages.length}): ${described.stages.join(' -> ')}`,
      `humanGates(${described.humanGates.length}): ${described.humanGates.map((g) => `${g.gateId}:${g.role}`).join(', ')}`,
      `checkTypes(${described.checkTypes.length}): ${described.checkTypes.join('|')}`,
      `exitCodes: ${Object.entries(described.exitCodes).map(([k, v]) => `${k}=${v}`).join(', ')}`,
      `commands(${described.commands.length}): ${described.commands.map((c) => c.name).join(', ')}`,
    ].join('\n');
    return emit(ctx, io, ctx.options.summary ? contractSummary(described, { checked: true, drift: [] }) : { ...described, checked: true, drift: [] }, { text });
  }
  const text = [
    `configSchemaVersion=${described.configSchemaVersion} runResultSchemaVersion=${described.runResultSchemaVersion}`,
    `stages: ${described.stages.join(' -> ')}`,
    `checkTypes: ${described.checkTypes.join(' | ')}`,
    `humanGates: ${described.humanGates.map((g) => `${g.gateId}(${g.role})`).join(', ')}`,
    `exitCodes: 0=passed 1=gate_failed 2=config_error 3=internal_error`,
    `commands: ${described.commands.map((c) => `${c.name}[${c.params.join(' ')}]`).join(', ')}`,
  ].join('\n');
  return emit(ctx, io, ctx.options.summary ? contractSummary(described) : described, { text });
}

async function commandCheck(ctx, io) {
  const loaded = load(ctx);
  log(ctx, io, `qgate check: config=${ctx.options.config} root=${loaded.root}`);
  if (ctx.own['--stage'] && !stageOrder.includes(ctx.own['--stage'])) {
    throw configError(`--stage must be one of ${stageOrder.join('|')} (got "${ctx.own['--stage']}")`, { jsonPointer: '' });
  }
  for (const gateId of ctx.own['--gate'] ?? []) {
    if (!loaded.config.gates.some((gate) => gate.id === gateId)) {
      throw configError(`--gate "${gateId}" is not a configured gate id (configured: ${loaded.config.gates.map((g) => g.id).join(', ')})`, { jsonPointer: '/gates' });
    }
  }
  const { runResult, meta } = await runPipeline(loaded, {
    stage: ctx.own['--stage'] ?? null,
    gateIds: ctx.own['--gate'] ?? null,
    failFast: Boolean(ctx.own['--fail-fast']),
    machineReadableStdout: Boolean(ctx.options.json || ctx.options.summary),
  });
  log(ctx, io, `qgate check: overall_passed=${runResult.overall_passed} run_id=${runResult.run_id}`);
  const value = ctx.options.summary ? checkSummary(runResult, meta) : runResult;
  return emit(ctx, io, value, { text: checkSummaryText(runResult, meta), exitCode: runResult.overall_passed ? exitCodes.PASSED : exitCodes.GATE_FAILED });
}

function traceTargets(ctx, loaded) {
  const gates = loaded.config.gates ?? [];
  const traceGate = gates.find((gate) => gate.checks.some((check) => check.type === 'trace_matrix'));
  if (!traceGate) {
    throw configError('configuration contains no trace_matrix check; qgate trace has nothing to evaluate', { jsonPointer: '/gates' });
  }
  const check = traceGate.checks.find((c) => c.type === 'trace_matrix');
  return {
    requirementsFile: check.requirementsFile,
    traceFile: check.traceFile,
    enforce: check.enforce,
    testIdSource: check.testIdSource,
  };
}

async function commandTrace(ctx, io) {
  const loaded = load(ctx);
  const target = traceTargets(ctx, loaded);
  const ledgerIndexRel = `${loaded.config.policy.evidenceDir}/ledger-index.json`.replace(/\/+/g, '/');
  const ledgerIndex = loadLedgerIndex(loaded.root, loaded.config.policy.evidenceDir);
  const runId = ledgerIndex?.runIds?.[ledgerIndex.runIds.length - 1] ?? null;
  const generatedAt = ledgerIndex?.updated_at ?? new Date(0).toISOString();
  const document = buildTraceMatrix({
    root: loaded.root,
    requirementsPath: target.requirementsFile,
    ledgerIndex,
    ledgerIndexPath: ledgerIndexRel,
    generatedAt,
    runId,
  });
  if (ctx.own['--write']) {
    const abs = path.join(loaded.root, target.traceFile.split('/').join(path.sep));
    writeFileAtomic(abs, stringifyJson(document));
    log(ctx, io, `qgate trace: wrote ${target.traceFile}`);
  } else {
    log(ctx, io, `qgate trace: generated in memory (use --write to persist ${target.traceFile})`);
  }
  const judge = judgeTraceMatrix({
    root: loaded.root,
    requirements: readJsonFile(path.join(loaded.root, target.requirementsFile.split('/').join(path.sep))),
    trace: ctx.own['--write'] ? document : readJsonFile(path.join(loaded.root, target.traceFile.split('/').join(path.sep))),
    ledgerIndex,
    enforce: target.enforce,
    testIdSource: target.testIdSource,
    configuredCheckIds: loaded.config.gates.flatMap((gate) => gate.checks.map((check) => check.id)),
  });
  log(ctx, io, `qgate trace: covered=${judge.summary.covered}/${judge.summary.requirements} orphans=${judge.summary.orphanTestIds} violations=${judge.violations.length}`);
  for (const violation of judge.violations.slice(0, 8)) {
    log(ctx, io, `qgate trace: ${violation.prefix} ${violation.pointer || '/'} ${violation.message}`);
  }
  const text = renderTraceText(document, judge, target, Boolean(ctx.own['--write']));
  // `--json` carries the frozen §5.3.3 document itself (schemas/trace-matrix.schema.json
  // is additionalProperties:false, so a `violations` key would make the engine's own
  // output schema-invalid). The violations stay observable: they are logged to stderr,
  // listed by `--summary`, and reflected in the document's `covered`/`summary` fields.
  const value = ctx.options.summary ? traceSummary(document, judge, target, Boolean(ctx.own['--write'])) : document;
  return emit(ctx, io, value, { text, exitCode: exitCodes.PASSED });
}

function renderTraceText(document, judge, target, written) {
  const lines = [];
  lines.push(`${written ? 'wrote' : 'evaluated'} ${target.traceFile} (requirements: ${target.requirementsFile})`);
  lines.push('requirementId            | priority | testIds        | covered');
  lines.push('-------------------------|----------|----------------|--------');
  for (const entry of document.requirements) {
    lines.push(`${String(entry.requirementId).padEnd(24)} | ${String(entry.priority).padEnd(8)} | ${entry.testIds.join(',').padEnd(14)} | ${entry.covered}`);
  }
  lines.push('');
  lines.push(`summary: requirements=${judge.summary.requirements} covered=${judge.summary.covered} uncovered=${judge.summary.uncovered} orphanTestIds=${judge.summary.orphanTestIds} coverageRatio=${judge.summary.coverageRatio} testIdSource=${judge.testIdSource}`);
  for (const violation of judge.violations) lines.push(`  violation[rule ${violation.rule}] ${violation.prefix}: ${violation.message}`);
  return lines.join('\n');
}

async function commandPreview(ctx, io) {
  const loaded = load(ctx, { optional: true });
  const rootOverride = ctx.options.root ? path.resolve(process.cwd(), ctx.options.root) : loaded.root;
  const root = rootOverride;
  if (!fs.existsSync(root)) {
    throw notFoundError(`--root does not exist: ${root}`, {
      jsonPointer: '',
      details: [{ jsonPointer: '', expected: 'existing directory', actual: root, message: `preview root not found: ${root}` }],
    });
  }
  const selectionOptions = loaded.config.selection ?? {};
  const selected = selectFiles(root, selectionOptions);
  const groups = groupFiles(root, selected.included, loaded.config.grouping ?? {});
  const chain = loadRuleChain({ root, rulePath: ctx.own['--rule'] ?? selectionOptions.ruleFile ?? null });
  const ruleMatch = selected.included.map((file) => matchRule(chain, file) ?? { file, ruleSource: 'none', ruleId: null, match: null, severity: null, category: null, priority: null });
  const secretAudit = assertNoSecretPathsSelected(root);
  const value = {
    ok: true,
    degraded: false,
    root,
    selection: { included: selected.included, excluded: selected.excluded },
    groups: groups.map((group) => ({ id: group.id, files: group.files, downgraded: group.downgraded, tokens: group.tokens })),
    ruleMatch,
    rules: {
      sources: chain.map((layer) => ({ source: layer.source, path: layer.path, pathKind: layer.pathKind ?? 'file', rules: layer.rules.length })),
      projectPath: PROJECT_RULE_PATH,
      note: 'pathKind="pseudo" marks the built-in layer: its rules are engine constants, not a file, so `path` is an identifier rather than a resolvable location',
    },
    invariants: { secretPathsSelected: secretAudit.violations, ocrAvailable: false },
  };
  const lines = [];
  lines.push(`root=${root}`);
  lines.push(`included=${selected.included.length} excluded=${selected.excluded.length} groups=${groups.length} maxFilesPerGroup=${loaded.config.grouping?.maxFilesPerGroup ?? 10}`);
  const byReason = new Map();
  for (const entry of selected.excluded) byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
  for (const [reason, count] of [...byReason.entries()].sort()) lines.push(`  excluded[${reason}]=${count}`);
  for (const group of groups) lines.push(`  ${group.id} files=${group.files.length} downgraded=${group.downgraded} tokens=${group.tokens}`);
  lines.push(`secretPathsSelected=${secretAudit.violations.length} (must be 0)`);
  return emit(ctx, io, ctx.options.summary ? previewSummary(value) : value, { text: lines.join('\n') });
}

async function commandReport(ctx, io) {
  const loaded = load(ctx);
  const evidenceDir = loaded.config.policy.evidenceDir;
  const reportDir = loaded.config.policy.reportDir;
  const index = loadLedgerIndex(loaded.root, evidenceDir);
  if (!index || !Array.isArray(index.ledgers) || index.ledgers.length === 0) {
    throw notFoundError(`no ledger found under ${evidenceDir}; run "qgate check" first`, {
      jsonPointer: '',
      details: [{ jsonPointer: '', expected: `${evidenceDir}/ledger-index.json with entries`, actual: `${evidenceDir}`, message: 'ledger index is empty or missing' }],
    });
  }
  const last = toPositiveInt(ctx.own['--last'], 1, '--last');
  const longest = toPositiveInt(ctx.own['--longest'], 1, '--longest');
  const ordered = [...index.ledgers];
  const byLast = [...ordered].slice().reverse().slice(0, last);
  const durations = byLast.map((entry) => {
    const ledger = readJsonFile(path.join(loaded.root, entry.path.split('/').join(path.sep)));
    const started = ledger && !ledger.__parseError ? Date.parse(ledger.started_at ?? '') : NaN;
    const finished = ledger && !ledger.__parseError ? Date.parse(ledger.finished_at ?? '') : NaN;
    return { entry, ledger, durationMs: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : -1 };
  });
  durations.sort((a, b) => b.durationMs - a.durationMs);
  const picked = durations.slice(0, Math.max(1, longest));
  const reports = [];
  for (const item of picked) {
    const ledger = item.ledger;
    if (!ledger || ledger.__parseError) {
      throw ioError(`ledger file is missing or not parseable: ${item.entry.path}`, {
        jsonPointer: '',
        details: [{ jsonPointer: '', expected: 'parseable ledger JSON', actual: item.entry.path, message: 'ledger unreadable' }],
      });
    }
    const markdown = renderLedgerReport(ledger, { runId: ledger.runId, ledgerRelPath: item.entry.path, ledgerIndexRelPath: index.path ?? `${evidenceDir}/ledger-index.json` });
    const rel = `${reportDir}/report-${ledger.runId}.md`.replace(/\/+/g, '/');
    writeFileAtomic(path.join(loaded.root, rel.split('/').join(path.sep)), markdown);
    reports.push({ run_id: ledger.runId, overall_passed: item.entry.overall_passed ?? null, path: rel });
  }
  const lines = reports.map((r) => `${r.run_id} overall_passed=${r.overall_passed} -> ${r.path}`);
  return emit(ctx, io, { ok: true, reports }, { text: lines.join('\n') });
}

function toPositiveInt(value, fallback, flag) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw configError(`${flag} must be a positive integer (got "${value}")`, { jsonPointer: '' });
  }
  return parsed;
}

async function commandExplain(ctx, io) {
  const locators = ['--gate', '--check', '--requirement'].filter((name) => ctx.own[name] !== undefined);
  if (locators.length !== 1) {
    throw configError(`explain requires exactly one of --gate|--check|--requirement (got ${locators.length === 0 ? 'none' : locators.join(', ')})`, { jsonPointer: '' });
  }
  const loaded = load(ctx);
  const kind = locators[0].slice(2);
  const id = ctx.own[locators[0]];

  if (kind === 'requirement') {
    const target = traceTargets(ctx, loaded);
    const index = loadLedgerIndex(loaded.root, loaded.config.policy.evidenceDir);
    const reqDoc = readJsonFile(path.join(loaded.root, target.requirementsFile.split('/').join(path.sep)));
    const entries = normalizeRequirementsIndex(reqDoc);
    const entry = entries.find((e) => e.requirementId === id);
    if (!entry) {
      throw internalError(`unknown requirement "${id}" in ${target.requirementsFile}`, {
        jsonPointer: '/requirements',
        details: [{ jsonPointer: '/requirements', expected: 'known requirementId', actual: id, message: 'subject not found' }],
      });
    }
    const ledgerTestIds = index?.testIds ?? [];
    const covered = entry.testIds.length > 0 && entry.testIds.every((t) => ledgerTestIds.includes(t));
    const ledgerIndexRel = `${loaded.config.policy.evidenceDir}/ledger-index.json`.replace(/\/+/g, '/');
    const evidence = covered
      ? [{ path: ledgerIndexRel, kind: 'ledger', excerpt: `${entry.testIds.join(',')}` }]
      : [];
    assertResolvable(loaded.root, evidence);
    const related = Object.entries(checkTestIds).filter(([, testId]) => entry.testIds.includes(testId)).map(([checkId, testId]) => ({ checkId, testId }));
    const value = {
      ok: covered,
      subject: { kind: 'requirement', id },
      passed: covered,
      reason: covered
        ? `every testId (${entry.testIds.join(', ')}) appears in ${ledgerIndexRel}`
        : `testIds [${entry.testIds.join(', ')}] are not all present in the ledger index (present: ${ledgerTestIds.filter((t) => entry.testIds.includes(t)).join(', ') || 'none'})`,
      evidence,
      relatedRequirements: related,
    };
    return emit(ctx, io, value, { text: `${id} covered=${covered}\n${value.reason}`, exitCode: exitCodes.PASSED });
  }

  const { runResult } = await runPipeline(loaded, { stage: null, gateIds: null, failFast: true, writeLedger: false });
  if (kind === 'gate') {
    const gate = runResult.gates.find((g) => g.id === id);
    if (!gate) {
      throw internalError(`unknown gate "${id}"; configured gates: ${runResult.gates.map((g) => g.id).join(', ')}`, {
        jsonPointer: '/gates',
        details: [{ jsonPointer: '/gates', expected: 'configured gate id', actual: id, message: 'subject not found' }],
      });
    }
    const evidence = gate.blockers.flatMap((b) => b.evidence ?? []);
    assertResolvable(loaded.root, evidence);
    const reasons = [
      ...gate.blockers.map((b) => `${b.checkId}: ${b.message}`),
      ...gate.checks.filter((c) => c.passed === false && !gate.blockers.some((b) => b.checkId === c.id)).map((c) => `${c.id}: recorded but non-blocking (severity=${c.severity})`),
    ];
    const value = {
      ok: gate.passed,
      subject: { kind: 'gate', id },
      passed: gate.passed,
      reason: gate.passed
        ? `gate "${id}" (stage=${gate.stage}) passed: ${gate.checks.length} check(s), ${gate.humanGate ? `humanGate=${gate.humanGate.approvalState}` : 'no human gate'}`
        : reasons.join('; ') || 'gate failed without a recorded blocker',
      evidence: evidence.length > 0 ? evidence : gate.checks.flatMap((c) => c.evidence).slice(0, 3),
      relatedRequirements: relatedRequirementsForChecks(gate.checks.map((c) => c.id)),
    };
    return emit(ctx, io, value, { text: `${id} passed=${gate.passed}\n${value.reason}`, exitCode: exitCodes.PASSED });
  }

  const owner = runResult.gates.find((g) => g.checks.some((c) => c.id === id));
  const check = owner?.checks.find((c) => c.id === id);
  if (!check) {
    throw internalError(`unknown check "${id}"; configured checks: ${runResult.gates.flatMap((g) => g.checks.map((c) => c.id)).join(', ')}`, {
      jsonPointer: '/gates',
      details: [{ jsonPointer: '/gates', expected: 'configured check id', actual: id, message: 'subject not found' }],
    });
  }
  assertResolvable(loaded.root, check.evidence);
  const blocker = owner.blockers.find((b) => b.checkId === id);
  const value = {
    ok: check.passed,
    subject: { kind: 'check', id },
    passed: check.passed,
    reason: check.passed
      ? `check "${id}" (${check.type}, severity=${check.severity}) passed in gate "${owner.id}"`
      : blocker
        ? blocker.message
        : `check "${id}" (${check.type}, severity=${check.severity}) failed but is non-blocking in gate "${owner.id}"`,
    evidence: check.evidence,
    relatedRequirements: relatedRequirementsForChecks([id]),
  };
  return emit(ctx, io, value, { text: `${id} passed=${check.passed}\n${value.reason}`, exitCode: exitCodes.PASSED });
}

async function commandStage(ctx, io) {
  const stage = assertStage(ctx.positional[0]);
  const action = ctx.positional[1];
  const loaded = load(ctx, { optional: true });
  const root = loaded.root;
  const emitStage = (value, text, exitCode = 0) => {
    // `--out` names the canonical evidence file for stage commands. It has
    // already been written by writeStageEvidence and must not be overwritten
    // by the generic command envelope writer.
    const savedOut = ctx.options.out;
    ctx.options.out = null;
    const code = emit(ctx, io, value, { text, exitCode });
    ctx.options.out = savedOut;
    return code;
  };
  if (action === 'review') {
    const manifest = buildStageManifest({ stage, root, configPath: loaded.absPath, diff: ctx.own['--diff'] ?? null });
    const mode = ctx.own['--mode'] ?? 'offline';
    if (!['offline', 'ingest'].includes(mode)) throw configError('--mode must be offline|ingest for stage review', { jsonPointer: '/mode' });
    if (mode === 'ingest') {
      if (!ctx.own['--result']) throw configError('stage review --mode ingest requires --result', { jsonPointer: '/result' });
      const result = readJsonInput(root, ctx.own['--result']);
      const evidence = normalizeOcrResult({ stage, manifest, result, source: ctx.own['--result'] });
      const written = writeStageEvidence(root, evidence, ctx.options.out);
      return emitStage({ ...evidence, output: written.path, manifest }, formatStageExplanation(evidence));
    }
    const evidence = makeOfflineEvidence({ stage, manifest });
    const written = writeStageEvidence(root, evidence, ctx.options.out);
    return emitStage({ ...evidence, output: written.path, manifest }, formatStageExplanation(evidence));
  }
  if (action === 'ingest') {
    if (!ctx.own['--result']) throw configError('stage ingest requires --result', { jsonPointer: '/result' });
    const manifest = buildStageManifest({ stage, root, configPath: loaded.absPath, diff: ctx.own['--diff'] ?? null });
    let evidence;
    try {
      evidence = normalizeOcrResult({ stage, manifest, result: readJsonInput(root, ctx.own['--result']), source: ctx.own['--result'] });
    } catch (error) {
      evidence = makeInvalidEvidence({ stage, manifest, reason: error.code ?? 'OCR_RESULT_INVALID' });
      writeStageEvidence(root, evidence, ctx.options.out);
      throw error;
    }
    const written = writeStageEvidence(root, evidence, ctx.options.out);
    return emitStage({ ...evidence, output: written.path }, formatStageExplanation(evidence));
  }
  const evidenceRel = ctx.own['--evidence'] ?? `.qgate/evidence/ai/${stage}.json`;
  const evidence = readJsonInput(root, evidenceRel);
  if (!evidence || evidence.kind !== 'qgate-stage-review-evidence' || evidence.stage !== stage) {
    throw evidenceError(`stage evidence does not match ${stage}`, { jsonPointer: '/stage', details: [{ jsonPointer: '/stage', expected: stage, actual: evidence?.stage ?? null, message: 'stage evidence mismatch' }] });
  }
  return emit(ctx, io, evidence, { text: formatStageExplanation(evidence), exitCode: evidence.valid ? 0 : 1 });
}

function relatedRequirementsForChecks(checkIds) {
  const testIds = checkIds.map((id) => checkTestIds[id]).filter(Boolean);
  return testIds.map((testId) => ({ testId }));
}

function assertResolvable(root, evidenceList) {
  for (const ref of evidenceList ?? []) {
    try {
      resolveEvidence(root, ref, {});
    } catch (error) {
      throw evidenceError(`evidence reference is unresolvable: ${ref.path}`, {
        jsonPointer: '/evidence/path',
        details: [{ jsonPointer: '/evidence/path', expected: 'resolvable evidence reference', actual: `${ref.path}#${ref.kind}`, message: error.message }],
      });
    }
  }
}

// ------------------------------------------------------------------ dispatcher
/**
 * Run one CLI invocation. `io.stdout` / `io.stderr` receive the exact bytes the
 * process would emit, so the runner serves both `bin/qgate.mjs` and callers that
 * embed the engine (tests, CI scripts). Returns the process exit code.
 */
export async function runCli(argv, capture = null) {
  const io = normalizeIo(capture);
  const ctx = { options: { json: false, summary: false, quiet: false, color: 'auto', out: null, config: 'qgate.config.json', root: null }, own: {}, io };
  try {
    const parsed = parseArgs(argv);
    ctx.command = parsed.command;
    ctx.options = parsed.options;
    ctx.own = parsed.own;
    ctx.positional = parsed.positional ?? [];
  } catch (error) {
    // Parameter validation itself failed, so the parsed options are unavailable —
    // but the caller may still have asked for a machine-readable error, which §6.5
    // requires on stdout. Detect the flag directly from argv.
    if (argv.includes('--json')) ctx.options = { ...ctx.options, json: true };
    return emitError(ctx, io, error);
  }

  try {
    switch (ctx.command) {
      case 'contract':
        return await commandContract(ctx, io);
      case 'check':
        return await commandCheck(ctx, io);
      case 'trace':
        return await commandTrace(ctx, io);
      case 'preview':
        return await commandPreview(ctx, io);
      case 'report':
        return await commandReport(ctx, io);
      case 'explain':
        return await commandExplain(ctx, io);
      case 'stage':
        return await commandStage(ctx, io);
      default:
        throw configError(`unknown command "${ctx.command}"`, { jsonPointer: '' });
    }
  } catch (error) {
    log(ctx, io, `qgate ${ctx.command}: failed with ${error?.code ?? 'INTERNAL_ERROR'}`);
    return emitError(ctx, io, error);
  }
}

/**
 * Resolve the IO sink. A capture object may supply `stdout` / `stderr`
 * callbacks and always receives the emitted chunks on `chunks`.
 */
function normalizeIo(capture) {
  if (!capture) {
    return {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    };
  }
  if (typeof capture.stdout === 'function' && typeof capture.stderr === 'function') return capture;
  const chunks = { out: [], err: [] };
  return {
    stdout: (text) => {
      chunks.out.push(String(text));
      capture.stdout?.(text);
    },
    stderr: (text) => {
      chunks.err.push(String(text));
      capture.stderr?.(text);
    },
    chunks,
  };
}

/** Capture sink for in-process callers: `collectIo()` -> `{ io, out(), err() }`. */
export function collectIo() {
  const out = [];
  const err = [];
  return {
    io: { stdout: (text) => out.push(String(text)), stderr: (text) => err.push(String(text)) },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

export default runCli;

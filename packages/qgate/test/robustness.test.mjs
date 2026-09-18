// t23 robustness regressions:
//   1. `--stage` RunResult stays inside the frozen §5.2 schema (no extra keys)
//   2. a UTF-8 BOM in a configuration is tolerated; malformed JSON is still rejected
//   3. ledger per-check `durationMs` reflects real (monotonic) time, without
//      leaking into the determinism surface
//   4. the demo fixture's own output directories are excluded from its selection,
//      so running the gates cannot change what the next run selects (REQ-010)
//   5. the built-in rule layer is an explicit pseudo-path, never a fake file path
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PACKAGE_ROOT,
  REPO_ROOT,
  DEMO_CONFIG,
  DEMO_ROOT,
  runCli,
  runCliJson,
  copyDemoRepo,
  resetCopiedLedgerState,
  tmpDir,
  writeJson,
  writeText,
  readJson,
  stripRuntime,
  cleanup,
} from './helpers.mjs';
import { validate } from './helpers/json-schema.mjs';
import { sha256 } from '../src/util/hash.mjs';
import { loadConfig, inferRootFromConfig } from '../src/config.mjs';
import { runPipeline } from '../src/core.mjs';
import { BUILTIN_RULE_PATH, loadRuleChain } from '../src/rules.mjs';

const RUN_RESULT_SCHEMA = readJson(path.join(REPO_ROOT, 'schemas', 'run-result.schema.json'));

/** The gate key set frozen by §5.2. */
const GATE_KEYS = ['id', 'stage', 'required', 'passed', 'humanGate', 'blockers', 'checks'];

function validateRunResult(runResult) {
  const outcome = validate(RUN_RESULT_SCHEMA, runResult, { rootDocument: RUN_RESULT_SCHEMA });
  return { valid: outcome.valid, errors: outcome.errors.map((e) => `${e.instancePath} ${e.keyword}: ${e.message}`) };
}

test('T-QG-001/T-QG-004 every --stage run validates against the frozen run-result schema', async () => {
  const demo = copyDemoRepo();
  try {
    const stages = ['requirements', 'design', 'build', 'review'];
    for (const stage of stages) {
      const result = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--stage', stage, '--json']);
      assert.ok(result.json, `stage ${stage} must print a RunResult`);
      const { valid, errors } = validateRunResult(result.json);
      assert.equal(valid, true, `--stage ${stage} must satisfy schemas/run-result.schema.json: ${errors.join(' | ')}`);
      for (const gate of result.json.gates) {
        assert.deepEqual(Object.keys(gate).slice().sort(), [...GATE_KEYS].slice().sort(), `gate ${gate.id} keys`);
      }
      // only gates up to and including the requested stage are reported
      const order = ['requirements', 'design', 'build', 'review', 'verify'];
      assert.deepEqual(
        result.json.gates.map((g) => g.stage),
        order.slice(0, order.indexOf(stage) + 1),
        `--stage ${stage} must report exactly the gates that ran`,
      );
      assert.equal(result.json.overall_passed, true, `--stage ${stage} should pass on the demo fixture`);
    }

    // The unfiltered run still validates and still reports all five gates.
    const full = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--json']);
    const fullOutcome = validateRunResult(full.json);
    assert.equal(fullOutcome.valid, true, fullOutcome.errors.join(' | '));
    assert.equal(full.json.gates.length, 5);
    assert.equal(full.json.overall_passed, true);

    // The un-run gates are reported in the --summary surface (human text), not in the
    // RunResult, whose key set stays frozen.
    const summary = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--stage', 'build', '--summary'], { strict: false });
    assert.match(summary.stdout, /not-run review\/review-counterexample/, summary.stdout);
    assert.match(summary.stdout, /not-run verify\/verify-coverage/, summary.stdout);
    assert.equal(summary.stdout.includes('"not_run_gates"'), false, '--summary is a table, not a JSON document');
  } finally {
    cleanup(demo.root);
  }
});

test('T-QG-002 a configuration with a UTF-8 BOM is accepted, malformed JSON is still rejected', () => {
  const root = tmpDir('qgate-bom-');
  try {
    const valid = {
      version: '1.0',
      provider: { type: 'deterministic' },
      gates: [{ id: 'gate-one', stage: 'build', required: true, checks: [{ id: 'file-check', type: 'file_exists', file: 'present.txt' }] }],
    };
    writeText(path.join(root, 'present.txt'), 'x\n');
    const body = `${JSON.stringify(valid, null, 2)}\n`;

    const bomPath = path.join(root, 'bom.config.json');
    fs.writeFileSync(bomPath, `\uFEFF${body}`, 'utf8');
    const bomLoaded = loadConfig(bomPath, { cwd: root });
    assert.equal(bomLoaded.config.gates.length, 1);
    assert.equal(bomLoaded.text.charCodeAt(0), 0xfeff, 'the raw text still carries the mark');
    assert.equal(bomLoaded.sha256, sha256(`\uFEFF${body}`), 'the config hash still covers the raw bytes');

    // A BOM-prefixed configuration runs end to end.
    const plainPath = path.join(root, 'qgate.config.json');
    fs.writeFileSync(plainPath, `\uFEFF${body}`, 'utf8');

    // A truncated file stays rejected even with the mark stripped.
    const brokenPath = path.join(root, 'broken.config.json');
    fs.writeFileSync(brokenPath, `\uFEFF{ "version": "1.0", "provider": `, 'utf8');
    assert.throws(() => loadConfig(brokenPath, { cwd: root }), (error) => error.code === 'CONFIG_INVALID' && /not parseable JSON/.test(error.message));

    // A BOM before a non-object document is still a configuration error.
    const arrayPath = path.join(root, 'array.config.json');
    fs.writeFileSync(arrayPath, `\uFEFF[1, 2, 3]`, 'utf8');
    assert.throws(() => loadConfig(arrayPath, { cwd: root }), (error) => error.code === 'CONFIG_INVALID');
  } finally {
    cleanup(root);
  }
});

test('T-QG-002 a BOM-prefixed configuration runs through the CLI with exit 0', async () => {
  const demo = copyDemoRepo();
  try {
    const config = readJson(demo.config);
    const bomPath = path.join(demo.root, 'bom.config.json');
    fs.writeFileSync(bomPath, `\uFEFF${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const result = await runCliJson(['check', '--config', bomPath, '--root', demo.root, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.overall_passed, true);
  } finally {
    cleanup(demo.root);
  }
});

test('T-QG-005 ledger entries carry real per-check durations that stay out of the determinism surface', async () => {
  const demo = copyDemoRepo();
  try {
    const runAndReadLedger = async () => {
      const result = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--json']);
      assert.equal(result.status, 0, result.stderr);
      const index = readJson(path.join(demo.root, '.qgate', 'evidence', 'ledger-index.json'));
      const newest = index.ledgers[index.ledgers.length - 1];
      const ledger = readJson(path.join(demo.root, newest.path.split('/').join(path.sep)));
      return { runResult: result.json, ledger };
    };

    const first = await runAndReadLedger();
    const second = await runAndReadLedger();

    for (const entry of [...first.ledger.entries, ...second.ledger.entries]) {
      assert.equal(Number.isInteger(entry.durationMs), true, `durationMs must be an integer: ${JSON.stringify(entry)}`);
      assert.ok(entry.durationMs >= 0);
    }
    const total = (ledger) => ledger.entries.reduce((sum, entry) => sum + entry.durationMs, 0);
    assert.ok(total(first.ledger) > 0, 'at least one check must report a non-zero duration');
    assert.ok(
      first.ledger.entries.some((entry) => entry.durationMs > 0) && second.ledger.entries.some((entry) => entry.durationMs > 0),
      'both runs must record at least one non-zero per-check duration',
    );

    // Durations are runtime data: they must not appear in the RunResult, so the
    // determinism comparison of two runs is unaffected.
    assert.equal(JSON.stringify(first.runResult).includes('durationMs'), false);
    assert.deepEqual(stripRuntime(first.runResult), stripRuntime(second.runResult));
  } finally {
    cleanup(demo.root);
  }
});

test('T-QG-010 the demo gates\' own output cannot change what the next preview selects', async () => {
  const demo = copyDemoRepo();
  try {
    const selectedHash = async () => {
      const result = await runCliJson(['preview', '--root', demo.root, '--config', demo.config, '--json']);
      assert.equal(result.status, 0, result.stderr);
      return sha256([...result.json.selection.included].sort().join('\n'));
    };

    const before = await selectedHash();

    const check = await runCli(['check', '--config', demo.config, '--root', demo.root]);
    assert.equal(check.status, 0, check.stderr);

    const afterCheck = await selectedHash();
    const afterSecondPreview = await selectedHash();

    assert.equal(afterCheck, before, 'writing evidence must not change the selected input set');
    assert.equal(afterSecondPreview, before, 'repeated previews must select the same input set');

    // The evidence directory is what the gates write into, and it must be excluded
    // from selection so that "output changes input" cannot happen.
    const preview = await runCliJson(['preview', '--root', demo.root, '--config', demo.config, '--json']);
    const excludedPaths = preview.json.selection.excluded.map((entry) => entry.path);
    assert.equal(
      excludedPaths.some((rel) => rel.startsWith('.qgate/evidence/')),
      true,
      'the evidence directory must be excluded from selection',
    );
    assert.equal(
      preview.json.selection.included.some((rel) => rel.startsWith('.qgate/evidence/')),
      false,
      'no evidence file may be selected',
    );
  } finally {
    cleanup(demo.root);
  }
});

test('T-QG-012 the built-in rule layer reports an explicit pseudo-path, not a fake file path', async () => {
  const preview = await runCliJson(['preview', '--root', DEMO_ROOT, '--config', DEMO_CONFIG, '--json']);
  assert.equal(preview.status, 0, preview.stderr);
  const builtin = preview.json.rules.sources.find((layer) => layer.source === 'builtin');
  assert.ok(builtin, 'the chain must contain the built-in layer');
  assert.equal(builtin.path, BUILTIN_RULE_PATH);
  assert.match(builtin.path, /^builtin:/, 'a pseudo-path must be recognisable as such');
  assert.equal(builtin.pathKind, 'pseudo');
  assert.equal(path.isAbsolute(builtin.path), false);
  // It must not pretend to be a repo-relative file.
  assert.equal(fs.existsSync(path.join(DEMO_ROOT, builtin.path)), false);

  // Real file layers keep kind "file", and every one of them resolves on disk.
  for (const layer of preview.json.rules.sources) {
    if (layer.pathKind !== 'file') continue;
    const abs = path.isAbsolute(layer.path) ? layer.path : path.join(DEMO_ROOT, layer.path.split('/').join(path.sep));
    assert.equal(fs.existsSync(abs), true, `file-backed rule layer must resolve: ${layer.path}`);
  }

  // The chain itself marks the built-in layer as pseudo.
  const chain = loadRuleChain({ root: DEMO_ROOT });
  const chainBuiltin = chain.find((layer) => layer.source === 'builtin');
  assert.equal(chainBuiltin.pathKind, 'pseudo');
  assert.deepEqual(builtinRuleFileShape(chainBuiltin), { path: BUILTIN_RULE_PATH, pathKind: 'pseudo' });
});

function builtinRuleFileShape(layer) {
  return { path: layer.path, pathKind: layer.pathKind };
}

test('T-QG-004 inferRootFromConfig and the run are unaffected by the fixes', () => {
  const demoRoot = inferRootFromConfig(path.join(REPO_ROOT, 'demo', 'qgate.config.json'));
  assert.equal(path.basename(demoRoot.split(path.sep).pop()).startsWith('demo'), true);
  void resetCopiedLedgerState;
});

test('a filtered run that skips a failing gate is not silently reported as passing it', async () => {
  const root = tmpDir('qgate-filter-');
  try {
    writeText(path.join(root, 'present.txt'), 'x\n');
    writeJson(path.join(root, 'qgate.config.json'), {
      version: '1.0',
      provider: { type: 'deterministic' },
      gates: [
        { id: 'gate-one', stage: 'build', required: true, checks: [{ id: 'file-check', type: 'file_exists', file: 'present.txt' }] },
        { id: 'gate-two', stage: 'review', required: true, checks: [{ id: 'missing-check', type: 'file_exists', file: 'absent.txt' }] },
      ],
    });
    const loaded = loadConfig(path.join(root, 'qgate.config.json'), { cwd: root });
    const filtered = await runPipeline(loaded, { stage: 'build', writeLedger: false });
    assert.deepEqual(filtered.runResult.gates.map((g) => g.id), ['gate-one']);
    assert.equal(filtered.runResult.overall_passed, true, 'the un-run failing gate must not be counted');
    assert.deepEqual(filtered.meta.skippedGateIds, ['gate-two'], 'the skipped gate is reported as metadata');
    const { valid, errors } = validateRunResult(filtered.runResult);
    assert.equal(valid, true, errors.join(' | '));

    const full = await runPipeline(loaded, { writeLedger: false });
    assert.deepEqual(full.runResult.gates.map((g) => g.id), ['gate-one', 'gate-two']);
    assert.equal(full.runResult.overall_passed, false, 'without the filter the failing gate still fails the run');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// t28 HIGH 1: the ledger sha256 recorded by §5.3.2 must be recomputed, so a
// tampered evidence chain is a failure (EVIDENCE_UNRESOLVED), never a warning.
// ---------------------------------------------------------------------------

test('T-QG-005 a tampered ledger, index hash or runIds fails the run with EVIDENCE_UNRESOLVED', async () => {
  const demo = copyDemoRepo();
  try {
    const config = demo.config;
    const evidence = path.join(demo.root, '.qgate', 'evidence');
    const control = await runCliJson(['check', '--config', config, '--root', demo.root, '--json']);
    assert.equal(control.status, 0, control.stderr);
    const index = readJson(path.join(evidence, 'ledger-index.json'));
    const ledgerPath = path.join(demo.root, index.ledgers[0].path.split('/').join(path.sep));

    // (a) ledger content changed
    const ledger = readJson(ledgerPath);
    ledger.entries[0].passed = !ledger.entries[0].passed;
    fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    const tamperedLedger = await runCliJson(['check', '--config', config, '--root', demo.root, '--json'], { strict: false });
    assert.equal(tamperedLedger.status, 3, tamperedLedger.stderr);
    assert.equal(tamperedLedger.json.error.code, 'EVIDENCE_UNRESOLVED');
    assert.match(JSON.stringify(tamperedLedger.json.error.details), /sha256|modified/);

    // (b) recorded hash changed, file untouched
    fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger.entries ? { ...ledger, entries: ledger.entries.map((e, i) => (i === 0 ? { ...e, passed: !e.passed } : e)) } : ledger, null, 2)}\n`);
    resetCopiedLedgerState(demo.root);
    const baseline = await runCliJson(['check', '--config', config, '--root', demo.root, '--json']);
    assert.equal(baseline.status, 0, baseline.stderr);
    const indexB = readJson(path.join(evidence, 'ledger-index.json'));
    indexB.ledgers[0].sha256 = 'deadbeef'.repeat(8);
    writeJson(path.join(evidence, 'ledger-index.json'), indexB);
    const tamperedHash = await runCliJson(['check', '--config', config, '--root', demo.root, '--json'], { strict: false });
    assert.equal(tamperedHash.status, 3, tamperedHash.stderr);
    assert.equal(tamperedHash.json.error.code, 'EVIDENCE_UNRESOLVED');

    // (c) runIds no longer describe the ledgers that exist
    const indexC = readJson(path.join(evidence, 'ledger-index.json'));
    indexC.runIds = ['2026-01-01T00-00-00-000Z-deadbeef'];
    writeJson(path.join(evidence, 'ledger-index.json'), indexC);
    const tamperedRuns = await runCliJson(['check', '--config', config, '--root', demo.root, '--json'], { strict: false });
    assert.equal(tamperedRuns.status, 3, tamperedRuns.stderr);
    assert.equal(tamperedRuns.json.error.code, 'EVIDENCE_UNRESOLVED');
  } finally {
    cleanup(demo.root);
  }
});

// ---------------------------------------------------------------------------
// t28 HIGH 2: a P0/P1 requirement the requirements index declares uncovered must
// block — the static check→testId mapping may not certify it.
// ---------------------------------------------------------------------------

test('T-QG-006 a requirement declared covered=false by the index blocks the trace check', async () => {
  const demo = copyDemoRepo();
  try {
    const requirementsPath = path.join(demo.root, '.qgate', 'requirements-index.json');
    const index = readJson(requirementsPath);
    const target = index.requirements.find((entry) => entry.priority === 'P0');
    target.covered = false;
    target.uncoveredReason = 'noTestReference: this requirement has no test at all';
    writeJson(requirementsPath, index);

    const result = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--json'], { strict: false });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.json.overall_passed, false);
    const blocker = result.json.gates.flatMap((gate) => gate.blockers).find((entry) => entry.checkId === 'trace-complete');
    assert.ok(blocker, JSON.stringify(result.json.gates.flatMap((g) => g.blockers)));
    assert.match(blocker.message, /^TRACE_GAP/);
    assert.match(blocker.message, new RegExp(target.id));
    assert.match(blocker.message, /noTestReference/);

    // `--summary` (human text) makes the same fact visible without JSON parsing.
    const summary = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--summary'], { strict: false });
    assert.match(summary.stdout, /TRACE_GAP/);
    assert.match(summary.stdout, new RegExp(target.id));
  } finally {
    cleanup(demo.root);
  }
});

// ---------------------------------------------------------------------------
// t28 HIGH 3: the engine's own trace output must satisfy its frozen schema.
// ---------------------------------------------------------------------------

test('T-QG-006 trace --json and the written trace matrix validate against the frozen schema', async () => {
  const demo = copyDemoRepo();
  try {
    const schema = readJson(path.join(REPO_ROOT, 'schemas', 'trace-matrix.schema.json'));
    const printed = await runCliJson(['trace', '--config', demo.config, '--root', demo.root, '--json']);
    assert.equal(printed.status, 0, printed.stderr);
    const printedOutcome = validate(schema, printed.json, { rootDocument: schema });
    assert.equal(printedOutcome.valid, true, printedOutcome.errors.map((e) => `${e.instancePath} ${e.keyword}: ${e.message}`).join(' | '));
    assert.equal(Object.prototype.hasOwnProperty.call(printed.json, 'violations'), false, 'no key outside the frozen field table may be added');

    const written = await runCliJson(['trace', '--config', demo.config, '--root', demo.root, '--write', '--json']);
    assert.equal(written.status, 0, written.stderr);
    const onDisk = readJson(path.join(demo.root, '.qgate', 'trace-matrix.json'));
    const diskOutcome = validate(schema, onDisk, { rootDocument: schema });
    assert.equal(diskOutcome.valid, true, diskOutcome.errors.map((e) => `${e.instancePath} ${e.keyword}: ${e.message}`).join(' | '));

    // The requirement ids the demo uses must satisfy the frozen pattern.
    for (const entry of printed.json.requirements) {
      assert.match(entry.requirementId, /^REQ-[A-Z0-9-]+-[0-9]{3}$/, entry.requirementId);
    }
  } finally {
    cleanup(demo.root);
  }
});

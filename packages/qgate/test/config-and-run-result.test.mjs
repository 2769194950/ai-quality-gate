// T-QG-001 / T-QG-002 / T-QG-003 / T-QG-004 — configuration contract:
// a legal configuration is accepted, six illegal configurations are rejected with
// exit code 2 and a JSON Pointer, and the RunResult key set equals the frozen
// schema exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
  INVALID_DIR,
  VALID_CONFIG,
  runCliJson,
  copyDemoRepo,
  tmpDir,
  writeJson,
  writeText,
  readJson,
  cleanup,
} from './helpers.mjs';
import { validateConfig } from '../src/config.mjs';
import { runResultKeys, gateKeys, checkResultKeys, blockerKeys } from '../src/contract.mjs';

test('T-QG-002 legal five-stage configuration validates and yields five ordered gates', async () => {
  const root = tmpDir('qgate-valid-');
  try {
    // The legal example is a structural five-stage configuration; materialise the
    // artefacts it declares so the run is genuinely green (no path is special-cased).
    const config = readJson(VALID_CONFIG);
    writeText(path.join(root, 'REQUIREMENTS.md'), ['# Requirements', '', 'REQ-DEMO-001', 'REQ-DEMO-002', 'REQ-DEMO-003', 'REQ-DEMO-004', ''].join('\n'));
    writeText(path.join(root, 'openapi.yaml'), ['requestId: x', 'traceId: y', 'amount: 100', 'currency: USD', 'Idempotency-Key: z', ''].join('\n'));
    writeJson(path.join(root, 'index.json'), {
      schemaVersion: '1.0',
      requirements: [
        { id: 'REQ-DEMO-001', priority: 'P0', testIds: ['T-DEMO-001'], stage: ['requirements'], codePaths: [] },
        { id: 'REQ-DEMO-002', priority: 'P0', testIds: ['T-DEMO-002'], stage: ['verify'], codePaths: [] },
      ],
    });
    writeJson(path.join(root, 'package.json'), { type: 'module', dependencies: {} });
    writeJson(path.join(root, 'severity-mix.json'), { threshold: 0.7, blockers: [], findings: [] });
    writeText(path.join(root, 'test/one.test.mjs'), '// fixture suite\n');
    writeText(path.join(root, 'test/two.test.mjs'), '// fixture suite\n');
    for (const name of ['a', 'b', 'c']) writeJson(path.join(root, `invalid/${name}.json`), { broken: name });
    writeJson(path.join(root, 'trace-matrix.json'), {
      schemaVersion: '1.0',
      summary: { requirements: 2, covered: 2, uncovered: 0, orphanTestIds: 0, coverageRatio: 1 },
      requirements: [
        { requirementId: 'REQ-DEMO-001', priority: 'P0', testIds: ['T-DEMO-001'], covered: true },
        { requirementId: 'REQ-DEMO-002', priority: 'P0', testIds: ['T-DEMO-002'], covered: true },
      ],
    });
    const configPath = path.join(root, 'qgate.config.json');
    writeJson(configPath, config);

    const result = await runCliJson(['check', '--config', configPath, '--json']);
    assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.json?.gates?.flatMap((g) => g.blockers) ?? [])}`);
    assert.ok(result.json, 'stdout must be parseable JSON');
    assert.deepEqual(
      result.json.gates.map((g) => g.stage),
      ['requirements', 'design', 'build', 'review', 'verify'],
    );
    assert.equal(result.json.overall_passed, true);
  } finally {
    cleanup(root);
  }
});

test('T-QG-002 six illegal configurations exit 2 with CONFIG_INVALID and a jsonPointer', async () => {
  const files = fs.readdirSync(INVALID_DIR).filter((f) => f.endsWith('.json')).sort();
  assert.equal(files.length, 6, 'exactly six counter-example configurations are frozen');
  for (const file of files) {
    const result = await runCliJson(['check', '--config', path.join(INVALID_DIR, file), '--json']);
    assert.equal(result.status, 2, `${file} must exit 2 (stderr: ${result.stderr})`);
    assert.equal(result.json.error.code, 'CONFIG_INVALID', file);
    assert.ok(result.json.error.details.length > 0, `${file} must carry details`);
    assert.match(result.json.error.details[0].jsonPointer, /^\//, file);
    assert.equal(result.json.run_id, undefined, `${file} must not start a run`);
    assert.equal(/run_id/.test(result.stdout), false, `${file} stdout must not contain a run id`);
  }
});

test('T-QG-002 unknown check.type reports the exact offending pointer', async () => {
  const result = await runCliJson(['check', '--config', path.join(INVALID_DIR, 'unknown-check-type.json'), '--json']);
  assert.equal(result.status, 2);
  assert.equal(result.json.error.jsonPointer, '/gates/0/checks/0/type');
  assert.match(result.json.error.message, /file_exist/);
});

test('T-QG-002 validateConfig rejects a missing provider and an illegal human gate position', () => {
  assert.throws(
    () => validateConfig({ version: '1.0', gates: [{ id: 'a-b', stage: 'build', checks: [{ id: 'c-d', type: 'file_exists', file: 'x' }] }] }),
    (error) => error.code === 'CONFIG_INVALID' && /missing required field "type"/.test(error.message),
  );
  assert.throws(
    () => validateConfig({ version: '1.0', provider: {}, gates: [{ id: 'a-b', stage: 'build', checks: [{ id: 'c-d', type: 'file_exists', file: 'x' }] }] }),
    (error) => error.code === 'CONFIG_INVALID' && error.jsonPointer === '/provider/type',
  );
  assert.throws(
    () =>
      validateConfig({
        version: '1.0',
        provider: { type: 'deterministic' },
        gates: [
          {
            id: 'build-gate',
            stage: 'build',
            checks: [{ id: 'c-d', type: 'file_exists', file: 'x' }],
            humanGate: { role: 'reviewer', enforcement: 'blocking' },
          },
        ],
      }),
    (error) => error.code === 'CONFIG_INVALID' && /handover/.test(error.message),
  );
});

test('T-QG-004 RunResult key sets match the frozen schema exactly', async () => {
  const demo = copyDemoRepo();
  try {
    const result = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const run = result.json;
    assert.deepEqual(Object.keys(run).slice().sort(), [...runResultKeys].slice().sort());
    assert.equal(run.version, '1.0');
    assert.match(run.run_id, /^[0-9T:.\-Z]+-[0-9a-f]{8}$/);
    assert.ok(Date.parse(run.finished_at) >= Date.parse(run.started_at));
    assert.ok(Number.isInteger(run.duration_ms) && run.duration_ms >= 0);
    assert.deepEqual(Object.keys(run.provider).slice().sort(), ['degraded', 'detail', 'type']);
    assert.equal(run.gates.length, 5);
    for (const gate of run.gates) {
      assert.deepEqual(Object.keys(gate).slice().sort(), [...gateKeys].slice().sort(), `gate ${gate.id}`);
      for (const check of gate.checks) {
        assert.deepEqual(Object.keys(check).slice().sort(), [...checkResultKeys].slice().sort(), `check ${check.id}`);
        assert.ok(check.evidence.length >= 1, `check ${check.id} must carry evidence`);
      }
      for (const blocker of gate.blockers) {
        assert.deepEqual(Object.keys(blocker).slice().sort(), [...blockerKeys].slice().sort(), `blocker ${blocker.checkId}`);
        assert.ok(blocker.evidence.length >= 1);
      }
    }
    assert.equal(run.overall_passed, run.gates.filter((g) => g.required).every((g) => g.passed));
  } finally {
    cleanup(demo.root);
  }
});

test('T-QG-004 every evidence reference of a passing run resolves', async () => {
  const demo = copyDemoRepo();
  try {
    const result = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--json']);
    const refs = result.json.gates.flatMap((g) => [
      ...g.checks.flatMap((c) => c.evidence),
      ...g.blockers.flatMap((b) => b.evidence),
    ]);
    assert.ok(refs.length > 0);
    for (const ref of refs) {
      assert.ok(['file', 'stdout', 'json_pointer', 'ledger', 'trace'].includes(ref.kind), JSON.stringify(ref));
      assert.equal(typeof ref.excerpt, 'string');
      assert.ok(ref.excerpt.length <= 4096);
      // §5.3.1: only `kind="file"` must denote an existing file. `ledger`/`trace`
      // references may legally point at a ledger/index that the run is about to
      // create, and `stdout`/`json_pointer` are inline by nature. The dedicated
      // evidence-resolution coverage (REQ-007) lives in check "trace-complete",
      // which does resolve its ledger reference.
      if (ref.kind === 'file') {
        assert.ok(fs.existsSync(path.join(demo.root, ref.path.split('/').join(path.sep))), `missing evidence file ${ref.path}`);
      }
    }
  } finally {
    cleanup(demo.root);
  }
});

test('T-QG-004 --summary prints the five gates as a human-readable table, not JSON', async () => {
  const demo = copyDemoRepo();
  try {
    const asJson = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--json']);
    const asSummary = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--summary'], { strict: false });
    assert.equal(asSummary.status, 0, asSummary.stderr);
    assert.equal(asJson.status, 0, asJson.stderr);
    assert.deepEqual(
      Object.keys(asJson.json).sort(),
      ['duration_ms', 'finished_at', 'gates', 'overall_passed', 'provider', 'run_id', 'started_at', 'version'],
    );
    assert.deepEqual(
      asJson.json.gates.map((g) => g.id),
      ['req-spec', 'interface-frozen', 'build-deterministic', 'review-counterexample', 'verify-coverage'],
    );
    assert.deepEqual(
      asJson.json.gates.map((g) => g.stage),
      ['requirements', 'design', 'build', 'review', 'verify'],
    );

    // §6.2 describes --summary as a human-readable table: one line per gate. It must
    // therefore NOT be JSON (otherwise the mode would be indistinguishable from --json).
    assert.equal(asSummary.stdout.trimStart().startsWith('{'), false, 'summary output must not be a JSON document');
    const rows = asSummary.stdout
      .split('\n')
      .filter((line) => /^\w+\s*\|/.test(line) && !line.startsWith('stage'));
    assert.deepEqual(
      rows.map((line) => line.split('|')[0].trim()),
      ['requirements', 'design', 'build', 'review', 'verify'],
      `summary table rows:\n${asSummary.stdout}`,
    );
    for (const gateId of ['req-spec', 'interface-frozen', 'build-deterministic', 'review-counterexample', 'verify-coverage']) {
      assert.match(asSummary.stdout, new RegExp(gateId), `summary must list gate ${gateId}`);
    }
    assert.match(asSummary.stdout, /^overall_passed=true/m);
    assert.match(asSummary.stdout, /gate\s*\|\s*required\s*\|\s*passed/, 'the table must carry a header row');
  } finally {
    cleanup(demo.root);
  }
});
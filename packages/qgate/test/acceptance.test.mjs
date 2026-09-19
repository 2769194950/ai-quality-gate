// Acceptance coverage for the CLI's exit-code matrix (§6.3/§6.4), the human gate
// (REQ-008/REQ-016), the provider abstraction (REQ-014) and secret redaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PACKAGE_ROOT,
  REPO_ROOT,
  QGATE_BIN,
  DEMO_CONFIG,
  FIXTURE_RECORDINGS,
  runCli,
  runCliJson,
  copyDemoRepo,
  resetCopiedLedgerState,
  tmpDir,
  writeJson,
  writeText,
  readJson,
  cleanup,
  canSpawnSubprocess,
} from './helpers.mjs';
import { createProvider, classifyFindings, requestFingerprint, DEFAULT_CONFIDENCE_THRESHOLD, PROBE_REQUEST, probeFingerprint } from '../src/provider.mjs';
import { redact, clip } from '../src/util/text.mjs';
import { runPipeline } from '../src/core.mjs';
import { loadConfig } from '../src/config.mjs';
import { policySafe001 } from '../src/policy.mjs';

/** Drop the four runtime fields so two runs can be compared for equality (§5.5). */
function stripRunResultFields(runResult) {
  const clone = JSON.parse(JSON.stringify(runResult));
  for (const field of ['run_id', 'started_at', 'finished_at', 'duration_ms']) delete clone[field];
  return clone;
}

/**
 * Run one gate built from a single check against a throwaway project root and
 * report the CLI exit code plus the gate verdict.
 */
async function runSingleCheckGate(t, { check, files = {} }) {
  const root = tmpDir('qgate-t26-');
  for (const [rel, body] of Object.entries(files)) writeText(path.join(root, rel.split('/').join(path.sep)), body);
  const configPath = path.join(root, 'qgate.config.json');
  writeJson(configPath, {
    version: '1.0',
    provider: { type: 'deterministic' },
    gates: [{ id: 'gate-one', stage: 'build', required: true, checks: [check] }],
  });
  const result = await runCliJson(['check', '--config', configPath, '--json'], { cwd: root, strict: false });
  const gate = result.json?.gates?.[0] ?? null;
  t.after?.(() => cleanup(root));
  cleanup(root);
  return { result, gate };
}

test('T-QG-009 a required evidence file that disappears makes the gate fail with exit 1', async () => {
  const demo = copyDemoRepo();
  try {
    fs.rmSync(path.join(demo.root, '.qgate', 'evidence', 'coverage.json'));
    const result = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--json']);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.json.overall_passed, false);
    const blockers = result.json.gates.flatMap((gate) => gate.blockers);
    assert.equal(blockers.length > 0, true);
    const blocker = blockers.find((entry) => entry.checkId === 'coverage-threshold');
    assert.ok(blocker, JSON.stringify(blockers));
    assert.match(blocker.message, /^FILE_MISSING/);
    assert.match(blocker.message, /\.qgate\/evidence\/coverage\.json/);
    assert.ok(blocker.evidence.length >= 1);
  } finally {
    cleanup(demo.root);
  }
});

test('T-QG-008 a missing human-gate approval blocks the gate with HUMAN_GATE_NOT_APPROVED', async () => {
  const demo = copyDemoRepo({ skipApprovals: true });
  try {
    const result = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--json']);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.json.overall_passed, false);
    const gated = result.json.gates.filter((gate) => gate.humanGate);
    assert.equal(gated.length, 3, 'the demo carries exactly three human gates');
    for (const gate of gated) {
      assert.equal(gate.humanGate.approvalState, 'missing');
      assert.equal(gate.passed, false);
      const blocker = gate.blockers.find((entry) => entry.checkId === gate.id);
      assert.ok(blocker, `gate ${gate.id} must record a human-gate blocker`);
      assert.match(blocker.message, /^HUMAN_GATE_NOT_APPROVED/);
      assert.equal(blocker.severity, 'blocker');
    }
    const ungoverned = result.json.gates.filter((gate) => !gate.humanGate);
    assert.equal(ungoverned.every((gate) => gate.humanGate === null), true, 'humanGate must be an explicit null');
  } finally {
    cleanup(demo.root);
  }
});

test('T-QG-008 a rejected decision is recorded as rejected, not as missing', async () => {
  const demo = copyDemoRepo();
  try {
    const record = path.join(demo.root, '.qgate', 'approvals', 'req-to-design', 'approval.json');
    const approval = readJson(record);
    approval.decision = 'rejected';
    writeJson(record, approval);
    const result = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--json']);
    assert.equal(result.status, 1);
    const gate = result.json.gates.find((entry) => entry.id === 'req-spec');
    assert.equal(gate.humanGate.approvalState, 'rejected');
    assert.match(gate.blockers[0].message, /^HUMAN_GATE_NOT_APPROVED/);
  } finally {
    cleanup(demo.root);
  }
});

test('T-QG-016 a required:false gate does not change overall_passed but reports approvalState', async () => {
  const demo = copyDemoRepo({ skipApprovals: true });
  try {
    // Flip the review gate to required:false: its missing approval must be recorded
    // but must no longer drive overall_passed.
    const config = readJson(demo.config);
    const gate = config.gates.find((entry) => entry.id === 'review-counterexample');
    gate.required = false;
    const configPath = path.join(demo.root, 'optional-gate.config.json');
    writeJson(configPath, config);

    const result = await runCliJson(['check', '--config', configPath, '--root', demo.root, '--json']);
    assert.equal(result.json.gates.find((entry) => entry.id === 'review-counterexample').humanGate.approvalState, 'missing');
    assert.equal(result.json.gates.find((entry) => entry.id === 'review-counterexample').required, false);
    assert.equal(result.json.overall_passed, false, 'the other required gates still fail');
    const optional = result.json.gates.find((entry) => entry.id === 'review-counterexample');
    assert.equal(optional.required, false);
    assert.ok(!result.json.gates.filter((entry) => entry.required).some((entry) => entry.id === 'review-counterexample'));
  } finally {
    cleanup(demo.root);
  }
});

test('T-QG-011 a relative --config is resolved against the cwd; the run result is not', async () => {
  // Documented semantics (and the honest limit of the "two cwd" determinism claim):
  //   * a RELATIVE --config is resolved against the current working directory, so the
  //     same relative string is only usable from a directory where it exists;
  //   * once the file is found, the project root is inferred from the config file's
  //     own location, so the resulting RunResult does not depend on the cwd.
  // Use a throwaway project so this path-semantics test never races with or
  // inherits ledger state from other tests or a user's local demo run.
  const fixture = tmpDir('qgate-cwd-');
  const demoDir = path.join(fixture, 'demo');
  try {
    fs.mkdirSync(demoDir, { recursive: true });
    fs.cpSync(DEMO_CONFIG.replace(/qgate\.config\.json$/, 'mini-service'), path.join(demoDir, 'mini-service'), {
      recursive: true,
    });
    const fixtureConfig = path.join(demoDir, 'qgate.config.json');
    writeJson(fixtureConfig, readJson(DEMO_CONFIG));
    const relativeConfig = 'demo/qgate.config.json';

    const fromRepoRoot = await runCliJson(['check', '--config', relativeConfig, '--json'], { cwd: fixture });
    assert.equal(fromRepoRoot.status, 0, fromRepoRoot.stderr);

    const foreignCwd = await runCliJson(['check', '--config', relativeConfig, '--json'], { cwd: PACKAGE_ROOT, strict: false });
    assert.equal(foreignCwd.status, 2, 'the same relative path is not resolvable from another cwd');
    assert.equal(foreignCwd.json.error.code, 'CONFIG_NOT_FOUND');

    const absoluteFromForeignCwd = await runCliJson(['check', '--config', fixtureConfig, '--json'], { cwd: PACKAGE_ROOT });
    assert.equal(absoluteFromForeignCwd.status, 0, absoluteFromForeignCwd.stderr);
    assert.deepEqual(
      stripRunResultFields(fromRepoRoot.json),
      stripRunResultFields(absoluteFromForeignCwd.json),
      'with a resolvable config path the RunResult must be identical across cwds',
    );
  } finally {
    cleanup(fixture);
  }
});

test('T-QG-011 exit code 2 covers unknown commands and illegal option combinations', async () => {
  const cases = [
    ['nonsense', '--json'],
    ['check', '--config', 'demo/qgate.config.json', '--json', '--summary'],
    ['check', '--config', 'demo/qgate.config.json', '--unknown-flag', '--json'],
    ['check', '--config', 'demo/qgate.config.json', '--stage', 'not-a-stage', '--json'],
    ['explain', '--config', 'demo/qgate.config.json', '--json'],
    ['explain', '--config', 'demo/qgate.config.json', '--gate', 'req-spec', '--check', 'req-doc-exists', '--json'],
    ['check', '--config', 'demo/missing.config.json', '--json'],
  ];
  for (const args of cases) {
    const result = await runCliJson(args, { cwd: REPO_ROOT, strict: false });
    assert.equal(result.status, 2, `qgate ${args.join(' ')} must exit 2 (stderr: ${result.stderr})`);
    assert.ok(result.json, `qgate ${args.join(' ')} must print a JSON document on stdout (§6.5): ${result.stdout}`);
    assert.equal(['CONFIG_INVALID', 'CONFIG_NOT_FOUND'].includes(result.json.error.code), true, `${args.join(' ')} :: ${JSON.stringify(result.json.error)}`);
  }
});

test('T-QG-011 exit code 3 covers unknown explain subjects and unresolvable evidence', async () => {
  const unknownGate = await runCliJson(['explain', '--config', DEMO_CONFIG, '--gate', 'no-such-gate', '--json']);
  assert.equal(unknownGate.status, 3, unknownGate.stderr);
  assert.equal(unknownGate.json.error.code, 'INTERNAL_ERROR');

  const unknownCheck = await runCliJson(['explain', '--config', DEMO_CONFIG, '--check', 'no-such-check', '--json']);
  assert.equal(unknownCheck.status, 3);
  assert.equal(unknownCheck.json.error.code, 'INTERNAL_ERROR');

  const unknownRequirement = await runCliJson(['explain', '--config', DEMO_CONFIG, '--requirement', 'REQ-DEMO-999', '--json']);
  assert.equal(unknownRequirement.status, 3);
  assert.equal(unknownRequirement.json.error.code, 'INTERNAL_ERROR');
});

test('T-QG-014 a scripted provider replays its fixture and never reaches the network', async () => {
  const fixture = readJson(FIXTURE_RECORDINGS);
  assert.equal(fixture.recordings.length >= 2, true);
  const provider = createProvider(
    { type: 'scripted', script: 'packages/qgate/examples/fixtures/scripted-provider.mjs', fixture: 'packages/qgate/examples/fixtures/provider-recordings.json' },
    { root: REPO_ROOT },
  );
  assert.equal(provider.degraded, false);

  const request = fixture.recordings[0].request;
  const hit = await provider.findings(request);
  assert.equal(hit.ok, true);
  assert.equal(hit.matched, true);
  assert.equal(hit.fingerprint, fixture.recordings[0].fingerprint);
  assert.equal(hit.findings.length, fixture.recordings[0].findings.length);

  const miss = await provider.findings({ ...request, checkId: 'a-check-that-was-never-recorded' });
  assert.equal(miss.ok, false, 'an unmatched fixture must fail deterministically');
  assert.equal(miss.matched, false);
  assert.equal(miss.error.code, 'PROVIDER_FAILED');
  assert.deepEqual(miss.findings, []);
});

test('T-QG-014 llm and external providers degrade to deterministic without breaking the run', async () => {
  for (const type of ['llm', 'external']) {
    const provider = createProvider({ type }, { root: REPO_ROOT });
    assert.equal(provider.type, 'deterministic');
    assert.equal(provider.requestedType, type);
    assert.equal(provider.degraded, true);
    const outcome = await provider.findings({ check: 'x' });
    assert.equal(outcome.ok, true);
  }
});

test('T-QG-013 only high-severity findings above the confidence threshold become blockers', () => {
  const findings = [
    { id: 'b', severity: 'blocker', confidence: 0.99 },
    { id: 'h', severity: 'high', confidence: DEFAULT_CONFIDENCE_THRESHOLD },
    { id: 'medium-high-confidence', severity: 'medium', confidence: 0.99 },
    { id: 'high-low-confidence', severity: 'high', confidence: 0.2 },
    { id: 'low', severity: 'low', confidence: 0.9 },
  ];
  const { blockers, findings: downgraded } = classifyFindings(findings, { confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD });
  assert.deepEqual(blockers.map((entry) => entry.id), ['b', 'h']);
  assert.deepEqual(downgraded.map((entry) => entry.id), ['medium-high-confidence', 'high-low-confidence', 'low']);
  assert.equal(downgraded[0].downgradeReason, 'severity_below_high');
  assert.equal(downgraded[1].downgradeReason, 'confidence_below_threshold');
});

test('T-QG-014 a scripted provider with a working script lets gate failures surface as exit 1', async () => {
  const root = tmpDir('qgate-provider-');
  try {
    writeText(path.join(root, 'script.mjs'), 'export function run() { return []; }\n');
    writeText(path.join(root, 'throwing.mjs'), 'export function run() { throw new Error("boom"); }\n');
    writeJson(path.join(root, 'fixture.json'), {
      schemaVersion: '1.0',
      recordings: [{ scenario: 'probe', request: PROBE_REQUEST, fingerprint: probeFingerprint(), findings: [] }],
    });
    const gates = [{ id: 'ai-gate', stage: 'review', required: true, checks: [{ id: 'ai-check-1', type: 'file_exists', file: 'nothing.md' }] }];

    // Working script: the run reaches the gates, so a missing file is exit 1 ...
    writeJson(path.join(root, 'qgate.config.json'), {
      version: '1.0',
      provider: { type: 'scripted', script: 'script.mjs', fixture: 'fixture.json' },
      gates,
    });
    const result = await runCli(['check', '--config', path.join(root, 'qgate.config.json'), '--json'], { cwd: root });
    assert.equal(result.status, 1, result.stderr);

    // ... while a script that throws is an explicit provider failure (exit 3), and a
    // config that cannot be found is a configuration error (exit 2). None of these
    // is a silent pass, and none of them is a crash.
    writeJson(path.join(root, 'throwing.config.json'), {
      version: '1.0',
      provider: { type: 'scripted', script: 'throwing.mjs', fixture: 'fixture.json' },
      gates,
    });
    const throwing = await runCliJson(['check', '--config', path.join(root, 'throwing.config.json'), '--json'], { cwd: root, strict: false });
    assert.equal(throwing.status, 3, throwing.stderr);
    assert.equal(throwing.json.error.code, 'PROVIDER_FAILED');

    const broken = await runCli(['check', '--config', path.join(root, 'absent.config.json'), '--json'], { cwd: root });
    assert.equal(broken.status, 2);
  } finally {
    cleanup(root);
  }
});

test('T-QG-003 a command check never reports an unevaluated stdoutRegex as passed', async () => {
  const root = tmpDir('qgate-stdout-');
  try {
    const runGate = async (id, extra) => {
      const configPath = path.join(root, `${id}.config.json`);
      writeJson(configPath, {
        version: '1.0',
        provider: { type: 'deterministic' },
        gates: [
          {
            id: 'gate-one',
            stage: 'build',
            required: true,
            checks: [{ id, type: 'command', required: true, severity: 'high', run: [process.execPath, '--version'], expectExitCode: 0, ...extra }],
          },
        ],
      });
      const loaded = loadConfig(configPath, { cwd: root });
      const { runResult } = await runPipeline(loaded, { writeLedger: false });
      return { runResult, check: runResult.gates[0].checks[0] };
    };

    // stdout capture on: the assertion is evaluated against the captured stdout.
    const evaluated = await runGate('cmd-evaluated', { captureStdout: true, stdoutRegex: 'v\\d+\\.' });
    assert.equal(evaluated.check.passed, true);
    assert.ok(
      evaluated.check.evidence.some((entry) => /^stdout: v\d+\./.test(entry.excerpt)),
      `stdout must actually be captured: ${JSON.stringify(evaluated.check.evidence)}`,
    );

    // stdout capture off while a stdout assertion is configured: un-evaluable, so the
    // check must FAIL with a readable reason (regression for the earlier false pass).
    const unevaluable = await runGate('cmd-unevaluable', { captureStdout: false, stdoutRegex: 'v\\d+\\.' });
    assert.equal(unevaluable.check.passed, false, 'an un-evaluable assertion must never be recorded as passed');
    assert.equal(unevaluable.runResult.overall_passed, false);
    assert.equal(unevaluable.runResult.gates[0].blockers.length, 1);
    assert.match(unevaluable.runResult.gates[0].blockers[0].message, /^COMMAND_FAILED/);
    assert.match(unevaluable.runResult.gates[0].blockers[0].message, /could not be evaluated/);
    assert.match(unevaluable.runResult.gates[0].blockers[0].message, /captureStdout=false/);
    assert.ok(unevaluable.check.evidence.some((entry) => /NOT evaluated/.test(entry.excerpt)));

    // No stdout assertion configured: the verdict rests on the exit code alone.
    const noAssertion = await runGate('cmd-no-assertion', { captureStdout: true });
    assert.equal(noAssertion.check.passed, true);
  } finally {
    cleanup(root);
  }
});

test('T-QG-010 secret values are redacted in evidence, stdout and stderr', async () => {
  const root = tmpDir('qgate-redact-');
  try {
    const secretValue = 'super-secret-value-1234567890';
    writeText(path.join(root, 'notes.md'), `API_KEY=${secretValue}\n`);
    writeJson(path.join(root, 'qgate.config.json'), {
      version: '1.0',
      provider: { type: 'deterministic' },
      gates: [
        {
          id: 'gate-one',
          stage: 'build',
          required: true,
          checks: [
            { id: 'regex-secret', type: 'regex', files: ['notes.md'], pattern: 'API_KEY=\\S+', mode: 'count', minMatches: 1 },
            { id: 'json-secret', type: 'json_assert', file: 'qgate.config.json', assertions: [{ pointer: '/version', equals: '1.0' }] },
          ],
        },
      ],
    });
    const result = await runCli(['check', '--config', path.join(root, 'qgate.config.json'), '--json'], { cwd: root });
    assert.equal(result.stdout.includes(secretValue), false, 'stdout must not leak the secret value');
    assert.equal(result.stderr.includes(secretValue), false, 'stderr must not leak the secret value');
    assert.match(result.stdout, /REDACTED|pattern=/, 'the check itself must still be reported');

    const direct = await runCli(['explain', '--config', path.join(root, 'qgate.config.json'), '--check', 'regex-secret', '--json'], { cwd: root });
    assert.equal(direct.stdout.includes(secretValue), false);

    // The redactor is also covered directly.
    assert.equal(redact(`API_KEY=${secretValue}`).includes(secretValue), false);
    assert.ok(redact(`API_KEY=${secretValue}`).includes('REDACTED'));
    assert.equal(clip('x'.repeat(9000)).length <= 4096, true);
  } finally {
    cleanup(root);
  }
});

test('T-QG-010 the package declares no runtime dependency and the CLI needs no install', () => {
  const pkg = readJson(path.join(PACKAGE_ROOT, 'package.json'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.type, 'module');
  assert.equal(fs.existsSync(QGATE_BIN), true);
  const nodeModules = path.join(PACKAGE_ROOT, 'node_modules');
  assert.equal(fs.existsSync(nodeModules), false, 'the engine must run without an install step');
  void resetCopiedLedgerState;
  void runPipeline;
  void loadConfig;
  void canSpawnSubprocess;
});

// ---------------------------------------------------------------------------
// t26 BLOCKER A: `required` decides the gate verdict; `severity` only presents it.
// ---------------------------------------------------------------------------

test('T-QG-003 a failed required check blocks the gate even with the default severity', async (t) => {
  // `regex` defaults to severity "medium" (§5.1) — the shape used by the frozen
  // reference example. Before the fix this produced blockers=[], gate.passed=true
  // and exit 0: a required check was silently ignored.
  const { result, gate } = await runSingleCheckGate(t, {
    check: { id: 'pattern-check', type: 'regex', files: ['docs/notes.md'], pattern: 'MUST-BE-PRESENT', mode: 'count', minMatches: 1 },
    files: { 'docs/notes.md': 'nothing matches here\n' },
  });
  assert.equal(result.status, 1, `exit must be 1 (stderr: ${result.stderr})`);
  assert.equal(result.json.overall_passed, false);
  assert.equal(gate.passed, false);
  assert.equal(gate.checks[0].severity, 'medium', 'the documented default severity for regex');
  assert.equal(gate.checks[0].passed, false);
  assert.deepEqual(gate.blockers.map((entry) => entry.checkId), ['pattern-check']);
});

test('T-QG-003 a failed non-required check is reported but does not block', async (t) => {
  const { result, gate } = await runSingleCheckGate(t, {
    check: { id: 'pattern-check', type: 'regex', required: false, files: ['docs/notes.md'], pattern: 'MUST-BE-PRESENT', mode: 'count', minMatches: 1 },
    files: { 'docs/notes.md': 'nothing matches here\n' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.overall_passed, true);
  assert.equal(gate.passed, true);
  assert.equal(gate.checks[0].passed, false, 'the failure is still reported in checks[]');
  assert.deepEqual(gate.blockers, []);
});

test('T-QG-003 onFail:"warn" is the explicit opt-out and does not block', async (t) => {
  const { result, gate } = await runSingleCheckGate(t, {
    check: { id: 'pattern-check', type: 'regex', required: true, onFail: 'warn', files: ['docs/notes.md'], pattern: 'MUST-BE-PRESENT', mode: 'count', minMatches: 1 },
    files: { 'docs/notes.md': 'nothing matches here\n' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.overall_passed, true);
  assert.equal(gate.passed, true);
  assert.equal(gate.checks[0].passed, false);
  assert.deepEqual(gate.blockers, []);
});

test('T-QG-003 a failed required low-severity check still blocks', async (t) => {
  const { result, gate } = await runSingleCheckGate(t, {
    check: { id: 'pattern-check', type: 'regex', required: true, severity: 'low', files: ['docs/notes.md'], pattern: 'MUST-BE-PRESENT', mode: 'count', minMatches: 1 },
    files: { 'docs/notes.md': 'nothing matches here\n' },
  });
  assert.equal(result.status, 1);
  assert.equal(gate.passed, false);
  assert.deepEqual(gate.blockers.map((entry) => entry.checkId), ['pattern-check']);
  assert.equal(gate.blockers[0].severity, 'low', 'severity is presentation only');
});

// ---------------------------------------------------------------------------
// t26 BLOCKER B: SAFE_001 must detect environment key *reads* and must not fire on
// prose that merely names a key.
// ---------------------------------------------------------------------------

test('T-QG-012 SAFE_001 detects environment key reads in all three access forms', (t) => {
  // Assembled at runtime: the sample text must not live in this file, otherwise the
  // default whole-repository scan would flag the fixture itself.
  const ENV = ['proc', 'ess.env'].join('');
  const ANTHROPIC = ['ANTHROPIC', '_API', '_KEY'].join('');
  const OPENAI = ['OPENAI', '_API', '_KEY'].join('');
  const SECRET = ['MY', '_SECRET', '_TOKEN'].join('');
  const forms = [
    `const a = ${ENV}.${ANTHROPIC};`,
    `const b = ${ENV}['${ANTHROPIC}'];`,
    `const c = ${ENV}["${ANTHROPIC}"];`,
    `const d = ${ENV}.${OPENAI};`,
    `const e = ${ENV}.${SECRET};`,
    `const f = ${ENV}._KEY;`,
    `const g = ${ENV}.${['GITHUB', '_TOKEN'].join('')};`,
    `const h = ${ENV}.${['DB', '_PASSWORD'].join('')};`,
  ];
  const root = tmpDir('qgate-safe001-');
  t.after(() => cleanup(root));
  forms.forEach((line, index) => writeText(path.join(root, `sample-${index}.mjs`), `${line}\n`));
  const outcome = policySafe001(root);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.violations.length, forms.length, JSON.stringify(outcome.violations));
  for (const violation of outcome.violations) {
    assert.match(violation.message, /environment key read/);
  }
});

test('T-QG-012 SAFE_001 stays clean on prose and documentation that merely names a key', (t) => {
  const root = tmpDir('qgate-safe001-prose-');
  t.after(() => cleanup(root));
  const lines = [
    '// this comment merely names the api key concept',
    '/** the api key field is documented in prose, not read anywhere */',
    'const helper = "unused description mentioning the api key";',
    'const url = "https://example.invalid/path";',
    'const socket = internet.isConnected;',
    '| `SAFE_001` | configuration, scripts and docs must not read the api key |',
  ];
  writeText(path.join(root, 'notes.mjs'), `${lines.join('\n')}\n`);
  writeText(path.join(root, 'README.md'), `${lines.join('\n')}\n`);
  const outcome = policySafe001(root);
  assert.equal(outcome.passed, true, JSON.stringify(outcome.violations));
  assert.equal(outcome.violations.length, 0);
});

test('T-QG-012 an empty scan set is an error, not a pass (SAFE_001 / SAFE_003)', (t) => {
  const root = tmpDir('qgate-empty-scan-');
  t.after(() => cleanup(root));
  const outcome = policySafe001(root, { scanRoots: ['packages'] });
  assert.equal(outcome.passed, false, 'scanning nothing must never be reported as finding nothing');
  assert.equal(outcome.metrics.filesScanned, 0);
  assert.match(JSON.stringify(outcome.violations), /empty scan set/);
});

test('T-QG-010 QGATE_REPO_ROOT can no longer redirect or empty the safety scan', async (t) => {
  // The variable used to point the policy scan at an arbitrary (possibly empty)
  // directory: setting it to an empty tree made SAFE_001/SAFE_003 pass without
  // inspecting anything. The override is gone, so the scan root is a pure function of
  // the configuration.
  const demo = copyDemoRepo();
  const decoy = tmpDir('qgate-decoy-');
  t.after(() => {
    cleanup(demo.root);
    cleanup(decoy);
  });
  const withOverride = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--json'], {
    env: { QGATE_REPO_ROOT: decoy },
  });
  const withoutOverride = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--json']);
  assert.equal(withOverride.status, withoutOverride.status, 'the env var must not change the verdict');
  assert.deepEqual(stripRunResultFields(withOverride.json), stripRunResultFields(withoutOverride.json));

  const { runPipeline: run } = await import('../src/core.mjs');
  const loaded = loadConfig(demo.config, { root: demo.root, cwd: REPO_ROOT });
  const probe = await run(loaded, { writeLedger: false });
  const policyChecks = probe.runResult.gates.flatMap((gate) => gate.checks).filter((check) => check.type === 'policy');
  assert.ok(policyChecks.length > 0, 'the demo config runs policy checks');
  assert.equal(policyChecks.every((check) => check.passed === true), true, JSON.stringify(policyChecks));
});

// ---------------------------------------------------------------------------
// t26 false pass: an unevaluable provider must fail explicitly.
// ---------------------------------------------------------------------------

test('T-QG-014 a scripted provider whose fixture lacks the probe recording fails with exit 3', async (t) => {
  const root = tmpDir('qgate-provider-miss-');
  t.after(() => cleanup(root));
  writeText(path.join(root, 'script.mjs'), 'export function run() { return []; }\n');
  writeJson(path.join(root, 'fixture.json'), {
    schemaVersion: '1.0',
    recordings: [{ scenario: 'unrelated', request: { checkId: 'something-else' }, fingerprint: requestFingerprint({ checkId: 'something-else' }), findings: [] }],
  });
  writeJson(path.join(root, 'qgate.config.json'), {
    version: '1.0',
    provider: { type: 'scripted', script: 'script.mjs', fixture: 'fixture.json' },
    gates: [{ id: 'gate-one', stage: 'build', required: true, checks: [{ id: 'file-check', type: 'file_exists', file: 'present.txt' }] }],
  });
  writeText(path.join(root, 'present.txt'), 'x\n');

  const result = await runCliJson(['check', '--config', path.join(root, 'qgate.config.json'), '--json'], { cwd: root, strict: false });
  assert.equal(result.status, 3, `an unevaluable provider must exit 3 (stderr: ${result.stderr})`);
  assert.equal(result.json.error.code, 'PROVIDER_FAILED');
  assert.match(result.json.error.message, /probe/i);
});

test('T-QG-014 a missing or empty scripted fixture is rejected instead of silently passing', async (t) => {
  const root = tmpDir('qgate-provider-empty-');
  t.after(() => cleanup(root));
  writeText(path.join(root, 'script.mjs'), 'export function run() { return []; }\n');
  writeText(path.join(root, 'present.txt'), 'x\n');
  const gates = [{ id: 'gate-one', stage: 'build', required: true, checks: [{ id: 'file-check', type: 'file_exists', file: 'present.txt' }] }];

  writeJson(path.join(root, 'empty-fixture.json'), { schemaVersion: '1.0', recordings: [] });
  writeJson(path.join(root, 'empty.config.json'), {
    version: '1.0',
    provider: { type: 'scripted', script: 'script.mjs', fixture: 'empty-fixture.json' },
    gates,
  });
  const empty = await runCliJson(['check', '--config', path.join(root, 'empty.config.json'), '--json'], { cwd: root, strict: false });
  assert.equal(empty.status, 3);
  assert.equal(empty.json.error.code, 'PROVIDER_FAILED');
  assert.match(empty.json.error.message, /no recordings/);

  writeJson(path.join(root, 'missing.config.json'), {
    version: '1.0',
    provider: { type: 'scripted', script: 'script.mjs', fixture: 'absent.json' },
    gates,
  });
  const missing = await runCliJson(['check', '--config', path.join(root, 'missing.config.json'), '--json'], { cwd: root, strict: false });
  assert.equal(missing.status, 3);
  assert.equal(missing.json.error.code, 'PROVIDER_FAILED');
  assert.match(missing.json.error.message, /not found/);
});

test('T-QG-014 the shipped scripted fixture answers the engine provider probe', async () => {
  const provider = createProvider(
    { type: 'scripted', script: 'packages/qgate/examples/fixtures/scripted-provider.mjs', fixture: 'packages/qgate/examples/fixtures/provider-recordings.json' },
    { root: REPO_ROOT },
  );
  assert.equal(provider.probeMatches, true);
  const probe = await provider.findings(PROBE_REQUEST);
  assert.equal(probe.ok, true);
  assert.equal(probe.fingerprint, probeFingerprint());
});

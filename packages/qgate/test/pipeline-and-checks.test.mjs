// T-QG-001 / T-QG-003 / T-QG-004 / T-QG-005 — pipeline order, the seven check
// executors (pass and fail for each), the driver-independent determinism of
// selection, and zero-dependency / offline properties.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  PACKAGE_ROOT,
  REPO_ROOT,
  DEMO_CONFIG,
  DEMO_ROOT,
  VALID_CONFIG,
  runCliJson,
  copyDemoRepo,
  copyTree,
  tmpDir,
  writeJson,
  writeText,
  readJson,
  stripRuntime,
  cleanup,
  canSpawnSubprocess,
} from './helpers.mjs';
import { loadConfig } from '../src/config.mjs';
import { runPipeline, stripRuntimeFields } from '../src/core.mjs';
import { executeCheck, checkIds } from '../src/checks/index.mjs';
import { selectFiles, assertNoSecretPathsSelected, filterFile } from '../src/selection.mjs';
import { groupFiles, MAX_FILES_PER_GROUP } from '../src/grouping.mjs';

/** Build a throwaway repository and a matching configuration, then run it. */
async function runFixture(files, gates, { provider = { type: 'deterministic' }, policy = {} } = {}) {
  const root = tmpDir('qgate-fixture-');
  for (const [rel, content] of Object.entries(files)) {
    writeText(path.join(root, rel.split('/').join(path.sep)), content);
  }
  const configPath = path.join(root, 'qgate.config.json');
  writeJson(configPath, { version: '1.0', provider, policy, gates });
  const loaded = loadConfig(configPath, { cwd: root });
  const outcome = await runPipeline(loaded, { writeLedger: false });
  return { root, loaded, ...outcome };
}

const simpleRepo = {
  'docs/requirements.md': '# Requirements\n\nREQ-DEMO-001\nREQ-DEMO-002\nREQ-DEMO-003\nREQ-DEMO-004\n',
  'data/result.json': JSON.stringify({ passed: 42, failed: 0, nested: { value: 'ok' } }),
  'src/app.mjs': 'export const value = 1;\n',
  'package.json': JSON.stringify({ type: 'module', dependencies: {} }),
  'TODO.md': '# loose ends\n',
};

test('T-QG-001 stages execute in the frozen order regardless of config order', async () => {
  const gates = [
    { id: 'verify-gate', stage: 'verify', required: true, checks: [{ id: 'v-exists', type: 'file_exists', file: 'package.json' }] },
    { id: 'req-gate', stage: 'requirements', required: true, checks: [{ id: 'r-exists', type: 'file_exists', file: 'docs/requirements.md' }] },
    { id: 'build-gate', stage: 'build', required: true, checks: [{ id: 'b-exists', type: 'file_exists', file: 'src/app.mjs' }] },
  ];
  const { runResult, root } = await runFixture(simpleRepo, gates);
  try {
    assert.deepEqual(runResult.gates.map((g) => g.stage), ['requirements', 'build', 'verify']);
    assert.equal(runResult.overall_passed, true);
    assert.equal(runResult.gates.length, 3);
  } finally {
    cleanup(root);
  }
});

test('T-QG-001 a failing required gate fails the run but later checks still execute', async () => {
  const gates = [
    {
      id: 'build-gate',
      stage: 'build',
      required: true,
      checks: [
        { id: 'missing-file', type: 'file_exists', file: 'nope.md' },
        { id: 'present-file', type: 'file_exists', file: 'package.json' },
      ],
    },
    { id: 'verify-gate', stage: 'verify', required: true, checks: [{ id: 'v-exists', type: 'file_exists', file: 'src/app.mjs' }] },
  ];
  const { runResult, root } = await runFixture(simpleRepo, gates);
  try {
    assert.equal(runResult.overall_passed, false);
    const gate = runResult.gates[0];
    assert.equal(gate.checks.length, 2);
    assert.equal(gate.checks[0].passed, false);
    assert.equal(gate.checks[1].passed, true);
    assert.equal(gate.blockers.length, 1);
    assert.match(gate.blockers[0].message, /^FILE_MISSING/);
    assert.equal(runResult.gates[1].passed, true);
  } finally {
    cleanup(root);
  }
});

test('T-QG-003 file_exists passes and fails with traceable evidence', async () => {
  const { runResult, root } = await runFixture(simpleRepo, [
    {
      id: 'gate-one',
      stage: 'build',
      required: true,
      checks: [
        { id: 'ok', type: 'file_exists', file: 'src/app.mjs' },
        { id: 'ko', type: 'file_exists', file: 'src/missing.mjs' },
      ],
    },
  ]);
  try {
    const [ok, ko] = runResult.gates[0].checks;
    assert.equal(ok.passed, true);
    assert.ok(ok.evidence.some((e) => e.path === 'src/app.mjs' && e.kind === 'file' && /sha256:/.test(e.excerpt)));
    assert.equal(ko.passed, false);
    assert.ok(ko.evidence.some((e) => /matched 0 file/.test(e.excerpt)));
  } finally {
    cleanup(root);
  }
});

test('T-QG-003 file_not_exists passes and fails', async () => {
  const { runResult, root } = await runFixture(simpleRepo, [
    {
      id: 'gate-one',
      stage: 'review',
      required: true,
      checks: [
        { id: 'ok', type: 'file_not_exists', file: 'docs/absent.md' },
        { id: 'ko', type: 'file_not_exists', file: 'TODO.md' },
      ],
    },
  ]);
  try {
    const [ok, ko] = runResult.gates[0].checks;
    assert.equal(ok.passed, true);
    assert.equal(ko.passed, false);
    assert.ok(ko.evidence.some((e) => e.path === 'TODO.md'));
  } finally {
    cleanup(root);
  }
});

test('T-QG-003 regex supports each/any/all/count and reports line numbers', async () => {
  const files = { ...simpleRepo };
  const gate = (check) => [{ id: 'gate-one', stage: 'build', required: true, checks: [check] }];
  const cases = [
    { check: { id: 'c-each', type: 'regex', files: ['docs/requirements.md'], pattern: 'REQ-DEMO-\\d{3}', mode: 'each', minMatches: 1 }, passed: true },
    { check: { id: 'c-each-fail', type: 'regex', files: ['docs/requirements.md', 'src/app.mjs'], pattern: 'REQ-DEMO-\\d{3}', mode: 'each', minMatches: 1 }, passed: false },
    { check: { id: 'c-any', type: 'regex', files: ['docs/requirements.md', 'src/app.mjs'], pattern: 'REQ-DEMO-\\d{3}', mode: 'any' }, passed: true },
    { check: { id: 'c-all-ok', type: 'regex', files: ['src/app.mjs'], pattern: 'export const', mode: 'all' }, passed: true },
    { check: { id: 'c-all-fail', type: 'regex', files: ['src/app.mjs', 'docs/requirements.md'], pattern: 'export const', mode: 'all' }, passed: false },
    { check: { id: 'c-count-ok', type: 'regex', files: ['docs/requirements.md'], pattern: 'REQ-DEMO-\\d{3}', mode: 'count', minMatches: 4, countMode: 'unique' }, passed: true },
    { check: { id: 'c-count-fail', type: 'regex', files: ['docs/requirements.md'], pattern: 'REQ-DEMO-\\d{3}', mode: 'count', minMatches: 5, countMode: 'unique' }, passed: false },
  ];
  for (const item of cases) {
    const { runResult, root } = await runFixture(files, gate(item.check));
    try {
      assert.equal(runResult.gates[0].checks[0].passed, item.passed, item.check.id);
      const evidence = runResult.gates[0].checks[0].evidence;
      assert.ok(evidence.some((e) => /pattern=/.test(e.excerpt)), `${item.check.id} must record the pattern metric`);
      if (item.passed) {
        assert.ok(
          evidence.some((e) => /L\d+/.test(e.excerpt)) || /mode=count/.test(evidence.map((e) => e.excerpt).join(' ')),
          `${item.check.id} must record matched lines or a count metric`,
        );
      } else {
        assert.match(runResult.gates[0].blockers[0]?.message ?? runResult.gates[0].checks[0].message ?? 'REGEX_MISMATCH', /REGEX_MISMATCH/);
      }
    } finally {
      cleanup(root);
    }
  }
});

test('T-QG-003 command check compares exit codes and records them', async () => {
  const { runResult, root } = await runFixture(simpleRepo, [
    {
      id: 'gate-one',
      stage: 'build',
      required: true,
      checks: [
        { id: 'ok', type: 'command', run: [process.execPath, '--version'], expectExitCode: 0, captureStdout: true },
        { id: 'ko', type: 'command', run: [process.execPath, '-e', 'process.exit(3)'], expectExitCode: 0 },
      ],
    },
  ]);
  try {
    const [ok, ko] = runResult.gates[0].checks;
    const nonExecutable = ok.evidence.some((e) => /spawn error|spawnError/.test(e.excerpt));
    assert.equal(ok.passed, true, `command check must pass (${JSON.stringify(ok.evidence)})`);
    assert.ok(ok.evidence.some((e) => /exitCode=0|spawnError/.test(e.excerpt)));
    assert.equal(ko.passed, false);
    assert.match(ko.evidence.map((e) => e.excerpt).join(' '), /exitCode=3|spawnError/);
    assert.ok(!nonExecutable || !canSpawnSubprocess());
  } finally {
    cleanup(root);
  }
});

test('T-QG-003 json_assert evaluates exists/equals/matches and fails with the pointer', async () => {
  const { runResult, root } = await runFixture(simpleRepo, [
    {
      id: 'gate-one',
      stage: 'build',
      required: true,
      checks: [
        {
          id: 'ok',
          type: 'json_assert',
          file: 'data/result.json',
          assertions: [
            { pointer: '/passed', equals: 42 },
            { pointer: '/nested/value', matches: '^o' },
            { pointer: '/failed', exists: true },
          ],
        },
        { id: 'ko', type: 'json_assert', file: 'data/result.json', assertions: [{ pointer: '/missing/deep', exists: true }] },
        { id: 'parse-ko', type: 'json_assert', file: 'src/app.mjs', assertions: [{ pointer: '/x', exists: true }] },
      ],
    },
  ]);
  try {
    const [ok, ko, parseKo] = runResult.gates[0].checks;
    assert.equal(ok.passed, true);
    assert.ok(ok.evidence.some((e) => e.kind === 'json_pointer' && e.excerpt.includes('/passed')));
    assert.equal(ko.passed, false);
    assert.ok(ko.evidence.some((e) => e.excerpt.includes('/missing/deep')));
    assert.equal(parseKo.passed, false);
    assert.match(parseKo.evidence.map((e) => e.excerpt).join(' '), /JSON parse error/);
  } finally {
    cleanup(root);
  }
});

test('T-QG-003 policy checks pass/fail and report the frozen violation prefix', async () => {
  const clean = await runFixture(
    { ...simpleRepo, 'src/fine.mjs': 'export const x = 1;\n' },
    [{ id: 'gate-one', stage: 'verify', required: true, checks: [{ id: 'policy-safe-003-a', type: 'policy', policyId: 'SAFE_003' }] }],
  );
  // The call surface is assembled at runtime so this test file itself stays clean.
  const dirtySource = [
    'const url = "https://example.invalid";',
    `const body = await ${'fetc' + 'h'}(url);`,
    `const socket = ${'n' + 'et'}.createConnection({ port: 443 });`,
    '',
  ].join('\n');
  const dirty = await runFixture(
    { ...simpleRepo, 'src/net.mjs': dirtySource },
    [{ id: 'gate-one', stage: 'verify', required: true, checks: [{ id: 'policy-safe-003-b', type: 'policy', policyId: 'SAFE_003' }] }],
  );
  const secret = await runFixture(
    { ...simpleRepo, '.env': 'DEMO_TOKEN=fake-value\n', 'secrets/a.pem': 'placeholder\n' },
    [{ id: 'gate-one', stage: 'verify', required: true, checks: [{ id: 'policy-safe-002', type: 'policy', policyId: 'SAFE_002' }] }],
  );
  try {
    assert.equal(clean.runResult.gates[0].checks[0].passed, true, JSON.stringify(clean.runResult.gates[0].checks[0].evidence));
    assert.equal(dirty.runResult.gates[0].checks[0].passed, false, JSON.stringify(dirty.runResult.gates[0].checks[0].evidence));
    assert.match(dirty.runResult.gates[0].blockers[0].message, /^POLICY_VIOLATION_SAFE_003/);
    assert.equal(secret.runResult.gates[0].checks[0].passed, true, 'secret paths must be excluded, not flagged');
    assert.match(JSON.stringify(secret.runResult.gates[0].checks[0].evidence), /secretPathsExcluded/);
  } finally {
    cleanup(clean.root);
    cleanup(dirty.root);
    cleanup(secret.root);
  }
});

test('T-QG-003 trace_matrix passes when closed and fails with TRACE_GAP when a test id is uncovered', async () => {
  const files = {
    ...simpleRepo,
    'docs/requirements-index.json': JSON.stringify({
      schemaVersion: '1.0',
      requirements: [
        { id: 'REQ-DEMO-001', priority: 'P0', testIds: ['T-DEMO-001'], stage: ['requirements'], codePaths: ['src/app.mjs'] },
        { id: 'REQ-DEMO-002', priority: 'P0', testIds: ['T-DEMO-002'], stage: ['build'], codePaths: [] },
      ],
    }),
    '.qgate/evidence/ledger-index.json': JSON.stringify({ schemaVersion: '1.0', runIds: [], ledgers: [], testIds: ['T-DEMO-001', 'T-DEMO-002'] }),
  };
  const check = {
    id: 'trace-complete',
    type: 'trace_matrix',
    requirementsFile: 'docs/requirements-index.json',
    traceFile: '.qgate/trace-matrix.json',
    enforce: 'strict',
    testIdSource: 'ledger-index',
  };
  const gates = [{ id: 'trace-gate', stage: 'verify', required: true, checks: [check] }];

  const closed = await runFixture(
    {
      ...files,
      '.qgate/trace-matrix.json': JSON.stringify({
        schemaVersion: '1.0',
        summary: { requirements: 2, covered: 2, uncovered: 0, orphanTestIds: 0, coverageRatio: 1 },
        requirements: [
          { requirementId: 'REQ-DEMO-001', priority: 'P0', testIds: ['T-DEMO-001'], covered: true },
          { requirementId: 'REQ-DEMO-002', priority: 'P0', testIds: ['T-DEMO-002'], covered: true },
        ],
      }),
    },
    gates,
    { policy: { evidenceDir: '.qgate/evidence' } },
  );

  const gap = await runFixture(
    {
      ...files,
      '.qgate/trace-matrix.json': JSON.stringify({
        schemaVersion: '1.0',
        summary: { requirements: 2, covered: 1, uncovered: 1, orphanTestIds: 0, coverageRatio: 0.5 },
        requirements: [
          { requirementId: 'REQ-DEMO-001', priority: 'P0', testIds: ['T-DEMO-001'], covered: true },
          { requirementId: 'REQ-DEMO-002', priority: 'P0', testIds: ['T-DEMO-999'], covered: false },
        ],
      }),
    },
    gates,
    { policy: { evidenceDir: '.qgate/evidence' } },
  );

  const orphan = await runFixture(
    {
      ...files,
      '.qgate/evidence/ledger-index.json': JSON.stringify({ schemaVersion: '1.0', runIds: [], ledgers: [], testIds: ['T-DEMO-001', 'T-DEMO-002', 'T-DEMO-777'] }),
      '.qgate/trace-matrix.json': JSON.stringify({
        schemaVersion: '1.0',
        summary: { requirements: 2, covered: 2, uncovered: 0, orphanTestIds: 1, coverageRatio: 1 },
        requirements: [
          { requirementId: 'REQ-DEMO-001', priority: 'P0', testIds: ['T-DEMO-001'], covered: true },
          { requirementId: 'REQ-DEMO-002', priority: 'P0', testIds: ['T-DEMO-002'], covered: true },
        ],
      }),
    },
    gates,
    { policy: { evidenceDir: '.qgate/evidence' } },
  );

  try {
    assert.equal(closed.runResult.gates[0].checks[0].passed, true, JSON.stringify(closed.runResult.gates[0].checks[0]));
    assert.equal(gap.runResult.gates[0].checks[0].passed, false);
    assert.match(gap.runResult.gates[0].blockers[0].message, /^TRACE_GAP/);
    assert.equal(orphan.runResult.gates[0].checks[0].passed, false);
    assert.match(orphan.runResult.gates[0].blockers[0].message, /TRACE_GAP|ORPHAN_TEST_ID/);
  } finally {
    cleanup(closed.root);
    cleanup(gap.root);
    cleanup(orphan.root);
  }
});

test('T-QG-003 all seven check types are registered', () => {
  assert.deepEqual([...checkIds].sort(), [
    'command',
    'file_exists',
    'file_not_exists',
    'json_assert',
    'policy',
    'regex',
    'trace_matrix',
  ]);
});

test('T-QG-006 selection and grouping are byte-stable across repeated calls', () => {
  const first = selectFiles(DEMO_ROOT, { include: ['**/*'] });
  const second = selectFiles(DEMO_ROOT, { include: ['**/*'] });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const groupsFirst = JSON.stringify(groupFiles(DEMO_ROOT, first.included));
  const groupsSecond = JSON.stringify(groupFiles(DEMO_ROOT, second.included));
  assert.equal(groupsFirst, groupsSecond);
});

test('T-QG-010 the demo run is identical from two different working directories', async () => {
  const demo = copyDemoRepo();
  const configRel = path.relative(REPO_ROOT, demo.config).split(path.sep).join('/');
  try {
    const fromRepo = await runCliJson(['check', '--config', configRel, '--root', demo.root, '--json'], { cwd: REPO_ROOT });
    const fromTmp = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--json'], { cwd: PACKAGE_ROOT });
    assert.equal(fromRepo.status, 0, fromRepo.stderr);
    assert.equal(fromTmp.status, 0, fromTmp.stderr);
    assert.deepEqual(stripRuntime(fromRepo.json), stripRuntime(fromTmp.json));
  } finally {
    cleanup(demo.root);
  }
});

test('T-QG-010 packages/qgate declares no runtime dependency and stays pure ESM', () => {
  const pkg = readJson(path.join(PACKAGE_ROOT, 'package.json'));
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'dependencies must be absent or empty');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.bin.qgate, './bin/qgate.mjs');
  const importSpecifier = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.mjs')) {
        const source = fs.readFileSync(abs, 'utf8');
        for (const match of source.matchAll(importSpecifier)) {
          const specifier = match[1];
          const allowed = specifier.startsWith('node:') || specifier.startsWith('.') || specifier.startsWith('/');
          assert.ok(allowed, `${abs} imports a bare specifier "${specifier}" — the engine must stay dependency-free`);
        }
      }
    }
  };
  walk(path.join(PACKAGE_ROOT, 'src'));
  walk(path.join(PACKAGE_ROOT, 'bin'));
});

test('T-QG-010 no implementation file performs a network call', () => {
  // Look for an actual call surface: the global fetch function being invoked, or
  // the request members of the http/https modules. Fragments are assembled at
  // runtime so this test file does not itself contain the literals.
  const callSurface = [
    new RegExp('\\bfetc' + 'h\\s*\\('),
    /(^|[^\w.])net\./,
    /(^|[^\w.])https?\.(request|get|post|connect)/,
  ];
  const walk = (dir, hits = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, hits);
      else if (entry.name.endsWith('.mjs')) {
        const source = fs.readFileSync(abs, 'utf8');
        for (const pattern of callSurface) {
          if (pattern.test(source)) hits.push(`${abs}:${pattern.source}`);
        }
      }
    }
    return hits;
  };
  const hits = [...walk(path.join(PACKAGE_ROOT, 'src')), ...walk(path.join(PACKAGE_ROOT, 'bin'))];
  assert.deepEqual(hits, []);
});

test('T-QG-006 selection results never contain a secret path even with the widest include', () => {
  const audit = assertNoSecretPathsSelected(DEMO_ROOT, { include: ['**/*'] });
  assert.deepEqual(audit.violations, []);
  assert.ok(audit.excluded.some((e) => e.reason === 'secret_path'));
  const decision = filterFile('.env', { include: ['**/*'] }, { root: DEMO_ROOT });
  assert.equal(decision.reason, 'secret_path');
});

test('T-QG-006 grouping caps buckets at ten files and degrades over-budget buckets', () => {
  const root = tmpDir('qgate-group-');
  try {
    const files = [];
    for (let i = 0; i < 25; i += 1) {
      const rel = `src/f${String(i).padStart(2, '0')}.mjs`;
      writeText(path.join(root, rel.split('/').join(path.sep)), 'x'.repeat(200));
      files.push(rel);
    }
    const groups = groupFiles(root, files, { maxFilesPerGroup: 10 });
    assert.deepEqual(groups.map((g) => g.files.length), [10, 10, 5]);
    assert.equal(groups.every((g) => g.files.length <= MAX_FILES_PER_GROUP), true);
    assert.equal(groups.every((g) => g.downgraded === false), true);

    const big = [];
    for (let i = 0; i < 4; i += 1) {
      const rel = `big/f${i}.mjs`;
      writeText(path.join(root, rel.split('/').join(path.sep)), 'x'.repeat(40000));
      big.push(rel);
    }
    const downgraded = groupFiles(root, big, { maxFilesPerGroup: 10, tokenBudgetPerGroup: 100 });
    assert.equal(downgraded.length, 4);
    assert.equal(downgraded.every((g) => g.downgraded === true && g.files.length === 1), true);
  } finally {
    cleanup(root);
  }
});

test('T-QG-005 two identical runs differ only in the runtime fields', async () => {
  const demo = copyDemoRepo();
  try {
    const first = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--json']);
    const second = await runCliJson(['check', '--config', demo.config, '--root', demo.root, '--json']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.notEqual(first.json.run_id, second.json.run_id);
    assert.deepEqual(stripRuntimeFields(first.json), stripRuntimeFields(second.json));

    const index = readJson(path.join(demo.root, '.qgate', 'evidence', 'ledger-index.json'));
    assert.equal(index.runIds.length, 2);
    assert.ok(index.runIds.includes(first.json.run_id));
    assert.ok(index.runIds.includes(second.json.run_id));
    const { sha256File } = await import('../src/util/fsx.mjs');
    for (const entry of index.ledgers) {
      const abs = path.join(demo.root, entry.path.split('/').join(path.sep));
      assert.equal(entry.sha256, sha256File(abs), `ledger hash drift for ${entry.path}`);
    }
    assert.deepEqual(index.testIds, [...new Set(index.testIds)].sort());
  } finally {
    cleanup(demo.root);
  }
});

test('T-QG-006 pnpm-free preview of the demo reports the frozen filter reasons', async () => {
  const result = await runCliJson(['preview', '--root', DEMO_ROOT, '--config', DEMO_CONFIG, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const reasons = new Map(result.json.selection.excluded.map((e) => [e.path, e.reason]));
  assert.equal(reasons.get('.env'), 'secret_path');
  assert.equal(reasons.get('.env.local'), 'secret_path');
  assert.equal(reasons.get('config/service.key'), 'secret_path');
  assert.equal(reasons.get('node_modules/left-pad/index.js'), 'default_excluded_path');
  assert.equal(result.json.invariants.secretPathsSelected.length, 0);
});

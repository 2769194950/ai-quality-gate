// Conformance tests for the four frozen JSON Schemas under schemas/
// (docs/01-architecture.md §5, docs/00-requirements.md REQ-QUALITY-GATE-004).
//
// These tests exercise the schemas with a real evaluator, not with string
// matching: the canonical §5.1 configuration must be valid, check.type
// "file_exist" must be invalid, and a RunResult with a missing or an extra
// baseline field must be invalid (the additionalProperties:false proof of the
// REQ-QUALITY-GATE-004 key-set assertion).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './helpers/json-schema.mjs';
import { DEMO_CONFIG, DEMO_ROOT, PACKAGE_ROOT, runCli, runCliJson, copyTree, tmpDir, writeJson, readJson, cleanup } from './helpers.mjs';
import { describeContract, detectContractDrift } from '../src/contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const schemasDir = path.join(repoRoot, 'schemas');
const SCHEMA_NAMES = ['config', 'run-result', 'evidence-ledger', 'trace-matrix'];
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

function loadSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(schemasDir, `${name}.schema.json`), 'utf8'));
}

const schemas = Object.fromEntries(SCHEMA_NAMES.map((name) => [name, loadSchema(name)]));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The canonical config from docs/01-architecture.md §5.1, verbatim. */
const canonicalConfig = {
  version: '1.0',
  projectRoot: '.',
  provider: {
    type: 'deterministic',
    timeoutMs: 30000,
    fixture: 'packages/qgate/examples/fixtures/provider-recordings.json',
    confidenceThreshold: 0.7,
  },
  policy: {
    evidenceDir: 'verification/evidence',
    reportDir: 'verification/reports',
    failFast: false,
    scanRoots: ['packages/qgate/src', 'packages/qgate/bin', 'schemas'],
  },
  selection: {
    include: ['**/*'],
    exclude: [],
    extensions: ['.mjs', '.js', '.json', '.md', '.yaml', '.yml', '.txt'],
    defaultExcludedPaths: ['.git', 'node_modules', 'dist', 'build', 'coverage', '.qgate/evidence', 'verification/evidence'],
    maxFileSizeBytes: 262144,
    maxFilesPerGroup: 10,
    tokenBudgetPerGroup: 12000,
    ruleFile: '.opencodereview/rule.json',
  },
  grouping: {
    maxFilesPerGroup: 10,
    tokenBudgetPerGroup: 12000,
    tokensPerFile: 4,
  },
  gates: [
    {
      id: 'req-spec',
      stage: 'requirements',
      required: true,
      checks: [
        { id: 'req-doc-exists', type: 'file_exists', file: 'docs/00-requirements.md', required: true, severity: 'high', description: 'the requirements document must exist' },
        {
          id: 'req-ids-present', type: 'regex', required: true, severity: 'high',
          files: ['docs/00-requirements.md'],
          pattern: 'REQ-QUALITY-GATE-\\d{3}', flags: 'gm', mode: 'count', minMatches: 12,
          countMode: 'unique',
        },
        {
          id: 'req-index-valid', type: 'json_assert', required: true,
          file: 'docs/requirements-index.json',
          assertions: [
            { pointer: '/requirements/0/id', exists: true },
            { pointer: '/requirements', exists: true },
          ],
        },
      ],
      humanGate: {
        role: 'product',
        approvalRecord: 'verification/approvals/req-to-design/approval.json',
        enforcement: 'blocking',
      },
    },
    {
      id: 'interface-frozen',
      stage: 'design',
      required: true,
      checks: [
        {
          id: 'contract-fields-present', type: 'regex', required: true,
          files: ['docs/01-architecture.md'],
          pattern: 'requirementId|overall_passed|json_assert|trace_matrix|humanGate',
          mode: 'each', minMatches: 5,
        },
        { id: 'schemas-exist', type: 'file_exists', file: 'schemas/*.schema.json', required: true },
      ],
      humanGate: {
        role: 'architect',
        approvalRecord: 'verification/approvals/design-to-build/approval.json',
        enforcement: 'blocking',
      },
    },
    {
      id: 'build-deterministic',
      stage: 'build',
      required: true,
      checks: [
        { id: 'no-dep', type: 'json_assert', required: true, file: 'packages/qgate/package.json', assertions: [{ pointer: '/dependencies', equals: {} }] },
        {
          id: 'unit-tests', type: 'command', required: true, severity: 'high',
          run: ['node', '--test', 'packages/qgate/test/'],
          expectExitCode: 0, timeoutMs: 120000, captureStdout: true,
          stdoutRegex: '^# pass \\d+',
        },
        {
          id: 'no-bypass', type: 'policy', required: true,
          policyId: 'SAFE_001', onFail: 'fail',
          expectedFiles: ['packages/qgate/src/config.mjs', 'packages/qgate/src/core.mjs'],
        },
      ],
    },
    {
      id: 'review-counterexample',
      stage: 'review',
      required: true,
      checks: [
        {
          id: 'negative-fixtures', type: 'file_exists',
          file: 'packages/qgate/examples/invalid/*.json', minCount: 1,
          required: true, severity: 'high',
        },
        {
          id: 'invalid-must-fail', type: 'json_assert', required: true, severity: 'high',
          file: 'verification/negative/oom-unknown-type.result.json',
          assertions: [{ pointer: '/exitCode', equals: 2 }],
        },
        {
          id: 'review-no-bypass', type: 'policy', required: true, severity: 'high',
          policyId: 'CONTRACT_001', onFail: 'fail',
          expectedFiles: ['docs/01-architecture.md', 'schemas/config.schema.json'],
        },
      ],
      humanGate: {
        role: 'reviewer',
        approvalRecord: 'verification/approvals/review-to-verify/approval.json',
        enforcement: 'blocking',
      },
    },
    {
      id: 'verify-coverage',
      stage: 'verify',
      required: true,
      checks: [
        {
          id: 'trace-complete', type: 'trace_matrix', required: true,
          requirementsFile: 'docs/requirements-index.json',
          traceFile: 'verification/trace-matrix.json',
          enforce: 'strict', testIdSource: 'ledger-index',
        },
      ],
    },
  ],
};

/** A fresh evidence reference; returns a new array each call so tests cannot leak mutations. */
const validEvidence = () => [{ path: 'docs/00-requirements.md', kind: 'file', excerpt: 'sha256:9f2c0d' }];

/** A RunResult that satisfies every required key exactly (mirrors §5.2). */
function validRunResult() {
  return {
    version: '1.0',
    run_id: '2026-05-05T10-22-31-004Z-a1b2c3d4',
    started_at: '2026-05-05T10:22:31.004Z',
    finished_at: '2026-05-05T10:22:33.918Z',
    duration_ms: 2914,
    overall_passed: false,
    provider: { type: 'deterministic', degraded: false, detail: 'offline-fixture' },
    gates: [
      {
        id: 'req-spec',
        stage: 'requirements',
        required: true,
        passed: true,
        humanGate: {
          role: 'product',
          approvalRecord: 'verification/approvals/req-to-design/approval.json',
          approvalState: 'approved',
          approvedBy: 'product-owner',
          approvedAt: '2026-05-04T09:00:00Z',
        },
        blockers: [],
        checks: [
          { id: 'req-doc-exists', type: 'file_exists', passed: true, severity: 'high', evidence: validEvidence() },
          { id: 'req-ids-present', type: 'regex', passed: true, severity: 'medium', evidence: validEvidence() },
        ],
      },
      {
        id: 'verify-coverage',
        stage: 'verify',
        required: true,
        passed: false,
        humanGate: null,
        blockers: [
          {
            checkId: 'trace-complete',
            severity: 'high',
            message: 'TRACE_GAP: REQ-QUALITY-GATE-014 covered=false',
            evidence: [{ path: 'verification/trace-matrix.json', kind: 'trace', excerpt: '/requirements/13/covered' }],
          },
        ],
        checks: [
          { id: 'trace-complete', type: 'trace_matrix', passed: false, severity: 'high', evidence: [{ path: 'verification/trace-matrix.json', kind: 'trace', excerpt: '/requirements/13' }] },
        ],
      },
    ],
  };
}

const validLedger = {
  schemaVersion: '1.0',
  ledgerId: '2026-05-05T10-22-31-004Z-a1b2c3d4',
  runId: '2026-05-05T10-22-31-004Z-a1b2c3d4',
  started_at: '2026-05-05T10:22:31.004Z',
  finished_at: '2026-05-05T10:22:33.918Z',
  projectRoot: '.',
  configPath: 'demo/qgate.config.json',
  configSha256: '6b1f0a77c2d4e5f60718293a4b5c6d7e',
  provider: { type: 'deterministic', degraded: false, detail: 'offline-fixture' },
  entries: [
    {
      gateId: 'req-spec', stage: 'requirements', checkId: 'req-doc-exists', type: 'file_exists',
      required: true, passed: true, severity: 'high', durationMs: 3, testId: 'T-QG-001', evidence: validEvidence(),
    },
    {
      gateId: 'verify-coverage', stage: 'verify', checkId: 'trace-complete', type: 'trace_matrix',
      required: true, passed: false, severity: 'high', durationMs: 11, testId: 'T-QG-006',
      evidence: [{ path: 'verification/trace-matrix.json', kind: 'trace', excerpt: '/requirements/13' }],
    },
    {
      gateId: 'build-deterministic', stage: 'build', checkId: 'unit-tests', type: 'command',
      required: true, passed: true, severity: 'high', durationMs: 120, testId: null, evidence: validEvidence(),
    },
  ],
};

const validLedgerIndex = {
  schemaVersion: '1.0',
  updated_at: '2026-05-05T10:22:33.918Z',
  runIds: ['2026-05-04T08-11-02-115Z-77aa11bb', '2026-05-05T10-22-31-004Z-a1b2c3d4'],
  ledgers: [
    {
      runId: '2026-05-04T08-11-02-115Z-77aa11bb',
      path: 'verification/evidence/ledger-2026-05-04T08-11-02-115Z-77aa11bb.json',
      sha256: 'c4d90f1e2a3b4c5d6e7f8091a2b3c4d5',
      overall_passed: false,
      started_at: '2026-05-04T08:11:02.115Z',
    },
    {
      runId: '2026-05-05T10-22-31-004Z-a1b2c3d4',
      path: 'verification/evidence/ledger-2026-05-05T10-22-31-004Z-a1b2c3d4.json',
      sha256: '8ad1c2b3e4f5061728394a5b6c7d8e9f',
      overall_passed: false,
      started_at: '2026-05-05T10:22:31.004Z',
    },
  ],
  testIds: ['T-QG-001', 'T-QG-006'],
};

const validTraceMatrix = {
  schemaVersion: '1.0',
  generated_at: '2026-05-05T10:22:33.918Z',
  generated_by: 'qgate trace',
  run_id: '2026-05-05T10-22-31-004Z-a1b2c3d4',
  pipeline: ['requirements', 'design', 'build', 'review', 'verify'],
  summary: { requirements: 2, covered: 1, uncovered: 1, orphanTestIds: 0, coverageRatio: 0.5 },
  requirements: [
    {
      requirementId: 'REQ-QUALITY-GATE-001',
      title: '门禁契约引擎必须按有序阶段执行',
      priority: 'P0',
      stage: ['requirements', 'design', 'build', 'review', 'verify'],
      testIds: ['T-QG-001'],
      codePaths: ['packages/qgate/src/pipeline.mjs', 'packages/qgate/src/checks/*.mjs'],
      covered: true,
      evidence: [
        { path: 'verification/evidence/ledger-index.json', kind: 'ledger', excerpt: 'T-QG-001@2026-05-05T10-22-31-004Z-a1b2c3d4' },
      ],
    },
    {
      requirementId: 'REQ-QUALITY-GATE-014',
      title: 'provider 可替换，确定性 provider 由离线 fixture 驱动',
      priority: 'P1',
      stage: ['build', 'verify'],
      testIds: ['T-QG-014'],
      codePaths: ['packages/qgate/src/providers/*.mjs'],
      covered: false,
      evidence: [],
    },
  ],
};

function expectValid(name, value, label) {
  const result = validate(schemas[name], value);
  assert.equal(result.valid, true, `${label}: expected valid, got ${JSON.stringify(result.errors, null, 2)}`);
}

function expectInvalid(name, value, label, keyword = null) {
  const result = validate(schemas[name], value);
  assert.equal(result.valid, false, `${label}: expected invalid but the schema accepted it`);
  if (keyword) {
    const accepted = [keyword, 'oneOf'];
    assert.ok(
      result.errors.some((e) => accepted.includes(e.keyword)),
      `${label}: expected a "${keyword}" (or oneOf) error, got ${JSON.stringify(result.errors)}`,
    );
  }
  return result;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// Schema document shape
// ---------------------------------------------------------------------------

test('all four schemas exist, parse, and declare draft 2020-12 with a unique non-empty $id', () => {
  const ids = new Set();
  for (const name of SCHEMA_NAMES) {
    const schema = schemas[name];
    assert.equal(schema.$schema, DRAFT_2020_12, `${name}: $schema must point at draft 2020-12`);
    assert.equal(typeof schema.$id, 'string', `${name}: $id must be a string`);
    assert.ok(schema.$id.length > 0, `${name}: $id must be non-empty`);
    assert.ok(!ids.has(schema.$id), `${name}: $id "${schema.$id}" is not unique`);
    ids.add(schema.$id);
    assert.equal(typeof schema.title, 'string', `${name}: title is required`);
    assert.equal(typeof schema.description, 'string', `${name}: description is required`);
    assert.ok(schema.description.length > 80, `${name}: description must explain the contract it encodes`);
    // type/required/enum must appear somewhere in every schema document.
    const serialized = JSON.stringify(schema);
    for (const keyword of ['"type"', '"required"', '"enum"']) {
      assert.ok(serialized.includes(keyword), `${name}: document must use ${keyword}`);
    }
  }
  assert.equal(ids.size, 4);
});

test('version constants are pinned to "1.0" as required', () => {
  assert.equal(schemas.config.properties.version.const, '1.0');
  assert.equal(schemas['run-result'].properties.version.const, '1.0');
  assert.equal(schemas['evidence-ledger'].$defs.ledgerDocument.properties.schemaVersion.const, '1.0');
  assert.equal(schemas['evidence-ledger'].$defs.ledgerIndexDocument.properties.schemaVersion.const, '1.0');
  assert.equal(schemas['trace-matrix'].properties.schemaVersion.const, '1.0');
  // and the negative direction is real: another version is rejected
  expectInvalid('config', { ...clone(canonicalConfig), version: '1.1' }, 'config.version 1.1', 'const');
  expectInvalid('run-result', { ...validRunResult(), version: '2.0' }, 'run-result.version 2.0', 'const');
});

// ---------------------------------------------------------------------------
// Enum parity with the frozen contract
// ---------------------------------------------------------------------------

test('enums stay in sync with the frozen contract values', () => {
  const checkEnums = Object.values(schemas.config.$defs)
    .filter((definition) => Array.isArray(definition.properties?.type?.enum))
    .map((definition) => definition.properties.type.enum);
  assert.deepEqual(
    checkEnums.find((values) => values.length === 7),
    ['file_exists', 'file_not_exists', 'regex', 'command', 'json_assert', 'trace_matrix', 'policy'],
  );
  assert.deepEqual(
    schemas.config.$defs.provider.properties.type.enum,
    ['deterministic', 'scripted', 'llm', 'external'],
  );
  assert.deepEqual(
    schemas.config.$defs.gate.properties.stage.enum,
    ['requirements', 'design', 'build', 'review', 'verify'],
  );
  assert.deepEqual(
    schemas['run-result'].$defs.evidence.properties.kind.enum,
    ['file', 'stdout', 'json_pointer', 'ledger', 'trace'],
  );
  assert.deepEqual(
    schemas['run-result'].$defs.severity.enum,
    ['blocker', 'high', 'medium', 'low'],
  );
  assert.deepEqual(
    schemas.config.$defs.checkPolicy.properties.policyId.enum,
    ['SAFE_001', 'SAFE_002', 'SAFE_003', 'CONTRACT_001'],
  );
  assert.deepEqual(
    schemas['evidence-ledger'].$defs.ledgerEntry.properties.stage.enum,
    ['requirements', 'design', 'build', 'review', 'verify'],
  );
  assert.deepEqual(
    schemas['trace-matrix'].$defs.requirementTrace.properties.priority.enum,
    ['P0', 'P1', 'P2'],
  );
});

// ---------------------------------------------------------------------------
// config.schema.json
// ---------------------------------------------------------------------------

test('config: the canonical §5.1 example is valid', () => {
  expectValid('config', canonicalConfig, 'canonical config');
});

// ---------------------------------------------------------------------------
// Newly declared §5.1 fields (t10 ruling 1, option (a))
// ---------------------------------------------------------------------------

test('config: the newly declared top-level, provider, policy and check fields are legal', () => {
  // projectRoot / selection / grouping at the top level, plus the nested tables.
  expectValid('config', canonicalConfig, 'canonical config with projectRoot, selection, grouping');
  const minimal = {
    version: '1.0',
    projectRoot: 'mini-service',
    provider: { type: 'deterministic', fixture: 'fixtures/recordings.json', confidenceThreshold: 0.86 },
    policy: { scanRoots: ['packages', 'adapters'] },
    selection: { ruleFile: '.opencodereview/rule.json' },
    grouping: { maxFilesPerGroup: 10, tokenBudgetPerGroup: 12000, tokensPerFile: 4 },
    gates: [{
      id: 'g-one',
      stage: 'build',
      checks: [{ id: 'c-one', type: 'policy', policyId: 'SAFE_002', expectedFiles: ['a.mjs', 'b.mjs'] }],
    }],
  };
  expectValid('config', minimal, 'minimal config using only the newly declared fields');
  // Explicit nulls are the documented defaults for the nullable ones.
  expectValid('config', {
    version: '1.0',
    provider: { type: 'deterministic', fixture: null, confidenceThreshold: 0 },
    policy: { scanRoots: null },
    selection: { ruleFile: null },
    gates: [{ id: 'g-one', stage: 'build', checks: [{ id: 'c-one', type: 'policy', policyId: 'SAFE_001', expectedFiles: null }] }],
  }, 'nullable newly declared fields set to null');
});

test('config: the newly declared fields still reject unknown neighbours and bad types', () => {
  const cases = [
    ['unknown top-level field beside the new ones', (c) => { c.scanRoots = ['x']; }],
    ['selection with an undeclared property', (c) => { c.selection.unexpected = true; }],
    ['grouping with an undeclared property', (c) => { c.grouping.unexpected = true; }],
    ['policy with an undeclared property', (c) => { c.policy.unexpected = true; }],
    ['provider with an undeclared property', (c) => { c.provider.unexpected = true; }],
    ['expectedFiles with an undeclared sibling', (c) => { c.gates[2].checks[2].unexpected = true; }],
  ];
  for (const [label, mutate] of cases) {
    const broken = clone(canonicalConfig);
    mutate(broken);
    expectInvalid('config', broken, label, 'additionalProperties');
  }

  const typeCases = [
    ['projectRoot not a string', (c) => { c.projectRoot = 7; }],
    ['selection not an object', (c) => { c.selection = []; }],
    ['grouping not an object', (c) => { c.grouping = 'fast'; }],
    ['confidenceThreshold above 1', (c) => { c.provider.confidenceThreshold = 1.5; }],
    ['confidenceThreshold below 0', (c) => { c.provider.confidenceThreshold = -0.1; }],
    ['provider.fixture not a string or null', (c) => { c.provider.fixture = 42; }],
    ['policy.scanRoots holding a non-string', (c) => { c.policy.scanRoots = [1, 2]; }],
    ['expectedFiles holding a non-string', (c) => { c.gates[2].checks[2].expectedFiles = [{}]; }],
    ['selection.maxFileSizeBytes below 1', (c) => { c.selection.maxFileSizeBytes = 0; }],
    ['grouping.tokensPerFile below 1', (c) => { c.grouping.tokensPerFile = 0; }],
    ['selection.ruleFile not a string or null', (c) => { c.selection.ruleFile = false; }],
  ];
  for (const [label, mutate] of typeCases) {
    const broken = clone(canonicalConfig);
    mutate(broken);
    expectInvalid('config', broken, label);
  }
});

test('config: check.type "file_exist" is still invalid after the field-table extension', () => {
  const broken = clone(canonicalConfig);
  broken.gates[0].checks[0].type = 'file_exist';
  const result = expectInvalid('config', broken, 'check.type=file_exist still rejected');
  assert.ok(
    result.errors.some((e) => e.keyword === 'enum' || e.keyword === 'oneOf'),
    `expected a discriminator failure, got ${JSON.stringify(result.errors)}`,
  );
});

test('config: the checked-in canonical fixture matches the §5.1 example and stays valid', () => {
  const fixturePath = path.join(here, '_canonical-config.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  assert.deepEqual(fixture, canonicalConfig, 'test/_canonical-config.json must equal the §5.1 example used by the tests');
  expectValid('config', fixture, 'checked-in canonical config fixture');
});

test('config: check.type "file_exist" is invalid', () => {
  const broken = clone(canonicalConfig);
  broken.gates[0].checks[0].type = 'file_exist';
  const result = expectInvalid('config', broken, 'config with check.type=file_exist');
  assert.ok(
    result.errors.some((e) => /oneOf|allOf|const|enum/.test(e.keyword)),
    `expected a discriminator failure, got ${JSON.stringify(result.errors)}`,
  );
});

test('config: unknown fields are rejected at every level (additionalProperties:false)', () => {
  const top = clone(canonicalConfig);
  top.extraTopLevel = true;
  expectInvalid('config', top, 'unknown top-level field', 'additionalProperties');

  const gateLevel = clone(canonicalConfig);
  gateLevel.gates[0].owner = 'someone';
  expectInvalid('config', gateLevel, 'unknown gate field', 'additionalProperties');

  const checkLevel = clone(canonicalConfig);
  checkLevel.gates[0].checks[0].unexpected = 'x';
  expectInvalid('config', checkLevel, 'unknown check field', 'additionalProperties');

  const humanGateLevel = clone(canonicalConfig);
  humanGateLevel.gates[0].humanGate.enforcement_level = 'blocking';
  expectInvalid('config', humanGateLevel, 'unknown humanGate field', 'additionalProperties');
});

test('config: required fields and enum values are enforced', () => {
  expectInvalid('config', { provider: { type: 'deterministic' }, gates: [] }, 'missing version');
  expectInvalid('config', { version: '1.0', provider: { type: 'deterministic' } }, 'missing gates');
  expectInvalid('config', { version: '1.0', gates: [{ id: 'g1', stage: 'build', checks: [{ id: 'c1', type: 'file_exists', file: 'a' }] }] }, 'missing provider');
  expectInvalid('config', { version: '1.0', provider: { type: 'nope' }, gates: [{ id: 'g1', stage: 'build', checks: [{ id: 'c1', type: 'file_exists', file: 'a' }] }] }, 'bad provider.type');
  expectInvalid('config', { version: '1.0', provider: { type: 'deterministic' }, gates: [{ id: 'g1', stage: 'ship-it', checks: [{ id: 'c1', type: 'file_exists', file: 'a' }] }] }, 'bad stage');
  expectInvalid('config', { version: '1.0', provider: { type: 'deterministic' }, gates: [] }, 'empty gates', 'minItems');
  expectInvalid('config', { version: '1.0', provider: { type: 'deterministic' }, gates: [{ id: 'g1', stage: 'build', checks: [] }] }, 'empty checks', 'minItems');
  expectInvalid('config', { version: '1.0', provider: { type: 'scripted' }, gates: [{ id: 'g1', stage: 'build', checks: [{ id: 'c1', type: 'file_exists', file: 'a' }] }] }, 'scripted provider without script');
  expectInvalid('config', { version: '1.0', provider: { type: 'deterministic' }, gates: [{ id: 'Bad_ID', stage: 'build', checks: [{ id: 'c1', type: 'file_exists', file: 'a' }] }] }, 'gate.id pattern', 'pattern');
  expectInvalid('config', { version: '1.0', provider: { type: 'deterministic' }, gates: [{ id: 'g1', stage: 'build', checks: [{ id: 'c1', type: 'policy', policyId: 'SAFE_009' }] }] }, 'bad policyId', 'const-or-enum');
});

test('config: the seven check types each accept their documented field table', () => {
  const checks = {
    file_exists: { id: 'c1', type: 'file_exists', file: 'a/*.md', minCount: 2 },
    file_not_exists: { id: 'c2', type: 'file_not_exists', file: 'secrets/**' },
    regex: { id: 'c3', type: 'regex', files: ['a.md'], pattern: 'x', flags: 'gm', mode: 'count', minMatches: 1, countMode: 'unique', encoding: 'utf8' },
    command: { id: 'c4', type: 'command', run: ['node', '--test'], expectExitCode: 0, timeoutMs: 60000, cwd: '.', captureStdout: true, stdoutRegex: 'ok' },
    json_assert: { id: 'c5', type: 'json_assert', file: 'a.json', assertions: [{ pointer: '/dependencies', equals: {} }, { pointer: '/name', exists: true }, { pointer: '/name', matches: '^q' }] },
    trace_matrix: { id: 'c6', type: 'trace_matrix', requirementsFile: 'docs/requirements-index.json', traceFile: 'verification/trace-matrix.json', enforce: 'strict', testIdSource: 'ledger-index' },
    policy: { id: 'c7', type: 'policy', policyId: 'SAFE_003', onFail: 'fail' },
  };
  for (const [type, check] of Object.entries(checks)) {
    const cfg = {
      version: '1.0',
      provider: { type: 'deterministic' },
      gates: [{ id: 'gate-one', stage: 'build', checks: [check] }],
    };
    expectValid('config', cfg, `config with a ${type} check`);
  }
  // command.timeoutMs lower bound and regex.flags alphabet are real constraints
  expectInvalid('config', { version: '1.0', provider: { type: 'deterministic' }, gates: [{ id: 'g1', stage: 'build', checks: [{ id: 'c1', type: 'command', run: ['node'], timeoutMs: 10 }] }] }, 'command.timeoutMs too small', 'minimum');
  expectInvalid('config', { version: '1.0', provider: { type: 'deterministic' }, gates: [{ id: 'g1', stage: 'build', checks: [{ id: 'c1', type: 'regex', files: ['a.md'], pattern: 'x', flags: 'gz' }] }] }, 'regex.flags alphabet', 'pattern');
  expectInvalid('config', { version: '1.0', provider: { type: 'deterministic' }, gates: [{ id: 'g1', stage: 'build', checks: [{ id: 'c1', type: 'json_assert', file: 'a.json', assertions: [{ pointer: '/x' }] }] }] }, 'assertion without exists|equals|matches', 'anyOf');
  expectInvalid('config', { version: '1.0', provider: { type: 'deterministic' }, gates: [{ id: 'g1', stage: 'build', checks: [{ id: 'c1', type: 'json_assert', file: 'a.json', assertions: [{ pointer: 'x' }] }] }] }, 'assertion pointer not starting with /', 'pattern');
});

// ---------------------------------------------------------------------------
// run-result.schema.json — the REQ-004 key-set proof
// ---------------------------------------------------------------------------

test('run-result: a fully populated result is valid', () => {
  expectValid('run-result', validRunResult(), 'valid RunResult');
});

test('run-result: a MISSING baseline field is invalid', () => {
  for (const key of ['version', 'run_id', 'started_at', 'finished_at', 'duration_ms', 'overall_passed', 'provider', 'gates']) {
    const broken = validRunResult();
    delete broken[key];
    expectInvalid('run-result', broken, `RunResult missing ${key}`, 'required');
  }
});

test('run-result: an EXTRA field is invalid', () => {
  const top = validRunResult();
  top.stdout = 'leaked log line';
  expectInvalid('run-result', top, 'RunResult with an extra top-level field', 'additionalProperties');

  const gate = validRunResult();
  gate.gates[0].notes = 'extra';
  expectInvalid('run-result', gate, 'gate with an extra field', 'additionalProperties');

  const check = validRunResult();
  check.gates[0].checks[0].message = 'extra';
  expectInvalid('run-result', check, 'check with an extra field', 'additionalProperties');

  const blocker = validRunResult();
  blocker.gates[1].blockers[0].rule = 4;
  expectInvalid('run-result', blocker, 'blocker with an extra field', 'additionalProperties');

  const evidence = validRunResult();
  evidence.gates[0].checks[0].evidence[0].sha256 = 'deadbeef';
  expectInvalid('run-result', evidence, 'evidence with an extra field', 'additionalProperties');

  const humanGate = validRunResult();
  humanGate.gates[0].humanGate.claimId = 'interface-frozen';
  expectInvalid('run-result', humanGate, 'humanGate with an extra field', 'additionalProperties');
});

test('run-result: gate.humanGate must be an object or exactly null', () => {
  const absent = validRunResult();
  delete absent.gates[0].humanGate;
  expectInvalid('run-result', absent, 'gate without the humanGate key', 'required');

  const omitted = validRunResult();
  omitted.gates[0].humanGate = { role: 'product' };
  const omittedResult = expectInvalid('run-result', omitted, 'humanGate missing approvalState/approvedBy/approvedAt');
  assert.ok(
    omittedResult.errors.some((e) => e.keyword === 'required' || e.keyword === 'oneOf'),
    `expected a required/oneOf failure, got ${JSON.stringify(omittedResult.errors)}`,
  );

  const badState = validRunResult();
  badState.gates[0].humanGate.approvalState = 'maybe';
  expectInvalid('run-result', badState, 'humanGate.approvalState outside the enum');

  expectValid('run-result', validRunResult(), 'humanGate null on a gate without a human gate');
});

test('run-result: evidence arrays must be non-empty and kinds are frozen', () => {
  const empty = validRunResult();
  empty.gates[0].checks[0].evidence = [];
  expectInvalid('run-result', empty, 'check with empty evidence', 'minItems');

  const emptyBlocker = validRunResult();
  emptyBlocker.gates[1].blockers[0].evidence = [];
  expectInvalid('run-result', emptyBlocker, 'blocker with empty evidence', 'minItems');

  const badKind = validRunResult();
  badKind.gates[0].checks[0].evidence[0].kind = 'screenshot';
  expectInvalid('run-result', badKind, 'evidence.kind outside the five frozen values');

  const longExcerpt = validRunResult();
  longExcerpt.gates[0].checks[0].evidence[0].excerpt = 'x'.repeat(4097);
  expectInvalid('run-result', longExcerpt, 'evidence.excerpt over 4096 characters', 'maxLength');

  const badSeverity = validRunResult();
  badSeverity.gates[0].checks[0].severity = 'critical';
  expectInvalid('run-result', badSeverity, 'severity outside the frozen four values');
});

// ---------------------------------------------------------------------------
// evidence-ledger.schema.json
// ---------------------------------------------------------------------------

test('evidence-ledger: both the ledger and the ledger index validate', () => {
  expectValid('evidence-ledger', validLedger, 'ledger document');
  expectValid('evidence-ledger', validLedgerIndex, 'ledger index document');
});

test('evidence-ledger: append-only/index invariants are enforced', () => {
  const wrongSchemaVersion = clone(validLedger);
  wrongSchemaVersion.schemaVersion = '1.1';
  expectInvalid('evidence-ledger', wrongSchemaVersion, 'ledger schemaVersion 1.1');

  const wrongProjectRoot = clone(validLedger);
  wrongProjectRoot.projectRoot = 'E:/ai-quality-gate';
  expectInvalid('evidence-ledger', wrongProjectRoot, 'ledger projectRoot must be "."', 'const');

  const missingEntryField = clone(validLedger);
  delete missingEntryField.entries[0].durationMs;
  expectInvalid('evidence-ledger', missingEntryField, 'ledger entry missing durationMs', 'required');

  const unknownEntryField = clone(validLedger);
  unknownEntryField.entries[0].blocker = true;
  expectInvalid('evidence-ledger', unknownEntryField, 'ledger entry with an extra field', 'additionalProperties');

  const emptyEvidence = clone(validLedger);
  emptyEvidence.entries[0].evidence = [];
  expectInvalid('evidence-ledger', emptyEvidence, 'ledger entry with empty evidence', 'minItems');

  const badTestId = clone(validLedger);
  badTestId.entries[0].testId = null;
  badTestId.entries[1].testId = null;
  badTestId.entries[2].testId = null;
  badTestId.entries.push({ ...validLedger.entries[0], checkId: 'req-ids-present', testId: 'T-QG-1' });
  expectInvalid('evidence-ledger', badTestId, 'ledger testId not matching the frozen pattern', 'pattern');

  const missingIndexArray = clone(validLedgerIndex);
  delete missingIndexArray.testIds;
  expectInvalid('evidence-ledger', missingIndexArray, 'ledger index missing testIds', 'required');

  const ledgerAsIndex = validate(schemas['evidence-ledger'].$defs.ledgerIndexDocument, validLedger);
  assert.equal(ledgerAsIndex.valid, false, 'a ledger document must not satisfy the index variant');
  const indexAsLedger = validate(schemas['evidence-ledger'].$defs.ledgerDocument, validLedgerIndex);
  assert.equal(indexAsLedger.valid, false, 'a ledger index document must not satisfy the ledger variant');
  const ambiguous = validate(schemas['evidence-ledger'], { schemaVersion: '1.0' });
  assert.equal(ambiguous.valid, false, 'a document matching neither variant must not validate');
});

// ---------------------------------------------------------------------------
// trace-matrix.schema.json
// ---------------------------------------------------------------------------

test('trace-matrix: a covered and an uncovered requirement both validate', () => {
  expectValid('trace-matrix', validTraceMatrix, 'trace matrix document');
  const allUncovered = clone(validTraceMatrix);
  allUncovered.requirements = [allUncovered.requirements[1]];
  allUncovered.summary = { requirements: 1, covered: 0, uncovered: 1, orphanTestIds: 0, coverageRatio: 0 };
  expectValid('trace-matrix', allUncovered, 'trace matrix with zero coverage');
});

test('trace-matrix: requirementId, testId, priority and covered/evidence rules are enforced', () => {
  const badRequirementId = clone(validTraceMatrix);
  badRequirementId.requirements[0].requirementId = 'REQ-QUALITY-GATE-1';
  expectInvalid('trace-matrix', badRequirementId, 'requirementId not matching ^REQ-[A-Z0-9-]+-[0-9]{3}$', 'pattern');

  const shortRequirementId = clone(validTraceMatrix);
  shortRequirementId.requirements[0].requirementId = 'REQ-QUALITY-GATE-0017';
  expectInvalid('trace-matrix', shortRequirementId, 'requirementId with four digits', 'pattern');

  const badTestId = clone(validTraceMatrix);
  badTestId.requirements[0].testIds = ['T-QG-01'];
  expectInvalid('trace-matrix', badTestId, 'testId not matching ^T-[A-Z0-9-]+-[0-9]{3}$', 'pattern');

  const badPriority = clone(validTraceMatrix);
  badPriority.requirements[0].priority = 'P3';
  expectInvalid('trace-matrix', badPriority, 'priority outside P0|P1|P2');

  const coveredWithoutEvidence = clone(validTraceMatrix);
  coveredWithoutEvidence.requirements[0].evidence = [];
  expectInvalid('trace-matrix', coveredWithoutEvidence, 'covered=true with empty evidence', 'minItems');

  const uncoveredWithEvidence = clone(validTraceMatrix);
  uncoveredWithEvidence.requirements[1].evidence = [{ path: 'x', kind: 'file', excerpt: 'y' }];
  expectInvalid('trace-matrix', uncoveredWithEvidence, 'covered=false with evidence attached', 'maxItems');

  const p0WithoutTestIds = clone(validTraceMatrix);
  p0WithoutTestIds.requirements[0].testIds = [];
  expectInvalid('trace-matrix', p0WithoutTestIds, 'P0 requirement without testIds', 'minItems');

  const wrongPipeline = clone(validTraceMatrix);
  wrongPipeline.pipeline = ['requirements', 'design', 'build', 'review'];
  expectInvalid('trace-matrix', wrongPipeline, 'pipeline shorter than five stages', 'minItems');

  const missingTitle = clone(validTraceMatrix);
  delete missingTitle.requirements[0].title;
  expectInvalid('trace-matrix', missingTitle, 'requirement trace missing title', 'required');

  const badStage = clone(validTraceMatrix);
  badStage.requirements[0].stage = ['deploy'];
  expectInvalid('trace-matrix', badStage, 'stage outside the five frozen stages');

  const badRatio = clone(validTraceMatrix);
  badRatio.summary.coverageRatio = 1.5;
  expectInvalid('trace-matrix', badRatio, 'coverageRatio above 1', 'maximum');

  const extraField = clone(validTraceMatrix);
  extraField.requirements[0].owner = 'architect';
  expectInvalid('trace-matrix', extraField, 'requirement trace with an extra field', 'additionalProperties');
});

// ---------------------------------------------------------------------------
// Field-table coverage audit: no missing and no surplus baseline fields
// ---------------------------------------------------------------------------

test('the four schemas cover every frozen §5 field-table entry and nothing surplus', () => {
  const documented = {
    'config:top': ['version', 'provider', 'gates', 'policy', 'projectRoot', 'selection', 'grouping'],
    'config:provider': ['type', 'script', 'timeoutMs', 'model', 'endpoint', 'fixture', 'confidenceThreshold'],
    'config:policySettings': ['evidenceDir', 'reportDir', 'failFast', 'scanRoots'],
    'config:selectionSettings': ['include', 'exclude', 'extensions', 'defaultExcludedPaths', 'maxFileSizeBytes', 'maxFilesPerGroup', 'tokenBudgetPerGroup', 'ruleFile'],
    'config:groupingSettings': ['maxFilesPerGroup', 'tokenBudgetPerGroup', 'tokensPerFile'],
    'config:gate': ['id', 'stage', 'required', 'checks', 'humanGate'],
    'config:humanGate': ['role', 'gateId', 'approvalRecord', 'enforcement'],
    'config:check.shared': ['id', 'type', 'required', 'severity', 'onFail', 'description'],
    'config:check.file_exists': ['file', 'minCount'],
    'config:check.file_not_exists': ['file'],
    'config:check.regex': ['files', 'pattern', 'flags', 'mode', 'minMatches', 'countMode', 'encoding'],
    'config:check.command': ['run', 'expectExitCode', 'timeoutMs', 'cwd', 'captureStdout', 'stdoutRegex'],
    'config:check.json_assert': ['file', 'assertions'],
    'config:check.json_assert.assertion': ['pointer', 'exists', 'equals', 'matches'],
    'config:check.trace_matrix': ['requirementsFile', 'traceFile', 'enforce', 'testIdSource'],
    'config:check.policy': ['policyId', 'expectedFiles'],
    'run-result:top': ['version', 'run_id', 'started_at', 'finished_at', 'duration_ms', 'overall_passed', 'provider', 'gates'],
    'run-result:provider': ['type', 'degraded', 'detail'],
    'run-result:gate': ['id', 'stage', 'required', 'passed', 'humanGate', 'blockers', 'checks'],
    'run-result:humanGate': ['role', 'approvalRecord', 'approvalState', 'approvedBy', 'approvedAt'],
    'run-result:blocker': ['checkId', 'severity', 'message', 'evidence'],
    'run-result:check': ['id', 'type', 'passed', 'severity', 'evidence'],
    'run-result:evidence': ['path', 'kind', 'excerpt'],
    'ledger:document': ['schemaVersion', 'ledgerId', 'runId', 'started_at', 'finished_at', 'projectRoot', 'configPath', 'configSha256', 'provider', 'entries'],
    'ledger:entry': ['gateId', 'stage', 'checkId', 'type', 'required', 'passed', 'severity', 'durationMs', 'testId', 'evidence'],
    'ledger:index': ['schemaVersion', 'updated_at', 'runIds', 'ledgers', 'testIds'],
    'ledger:indexEntry': ['runId', 'path', 'sha256', 'overall_passed', 'started_at'],
    'trace:document': ['schemaVersion', 'generated_at', 'generated_by', 'run_id', 'pipeline', 'summary', 'requirements'],
    'trace:summary': ['requirements', 'covered', 'uncovered', 'orphanTestIds', 'coverageRatio'],
    'trace:requirement': ['requirementId', 'title', 'priority', 'stage', 'testIds', 'codePaths', 'covered', 'evidence'],
  };

  // Each check variant repeats the shared fields plus its own per-type fields,
  // so subtract the shared set before comparing against the §5.1 per-type table.
  const sharedCheckKeys = new Set(['id', 'type', 'required', 'severity', 'onFail', 'description']);
  const perTypeCheckKeys = (defName) =>
    Object.keys(schemas.config.$defs[defName].properties).filter((key) => !sharedCheckKeys.has(key));

  const actual = {
    'config:top': Object.keys(schemas.config.properties),
    'config:provider': Object.keys(schemas.config.$defs.provider.properties),
    'config:policySettings': Object.keys(schemas.config.$defs.policySettings.properties),
    'config:selectionSettings': Object.keys(schemas.config.$defs.selectionSettings.properties),
    'config:groupingSettings': Object.keys(schemas.config.$defs.groupingSettings.properties),
    'config:gate': Object.keys(schemas.config.$defs.gate.properties),
    'config:humanGate': Object.keys(schemas.config.$defs.humanGate.properties),
    'config:check.shared': Object.keys(schemas.config.$defs.checkBase.properties),
    'config:check.file_exists': perTypeCheckKeys('checkFileExists'),
    'config:check.file_not_exists': perTypeCheckKeys('checkFileNotExists'),
    'config:check.regex': perTypeCheckKeys('checkRegex'),
    'config:check.command': perTypeCheckKeys('checkCommand'),
    'config:check.json_assert': perTypeCheckKeys('checkJsonAssert'),
    'config:check.json_assert.assertion': perTypeCheckKeys('jsonAssertion'),
    'config:check.trace_matrix': perTypeCheckKeys('checkTraceMatrix'),
    'config:check.policy': perTypeCheckKeys('checkPolicy'),
    'run-result:top': Object.keys(schemas['run-result'].properties),
    'run-result:provider': Object.keys(schemas['run-result'].$defs.provider.properties),
    'run-result:gate': Object.keys(schemas['run-result'].$defs.gate.properties),
    'run-result:humanGate': Object.keys(schemas['run-result'].$defs.humanGateResult.properties),
    'run-result:blocker': Object.keys(schemas['run-result'].$defs.blocker.properties),
    'run-result:check': Object.keys(schemas['run-result'].$defs.checkResult.properties),
    'run-result:evidence': Object.keys(schemas['run-result'].$defs.evidence.properties),
    'ledger:document': Object.keys(schemas['evidence-ledger'].$defs.ledgerDocument.properties),
    'ledger:entry': Object.keys(schemas['evidence-ledger'].$defs.ledgerEntry.properties),
    'ledger:index': Object.keys(schemas['evidence-ledger'].$defs.ledgerIndexDocument.properties),
    'ledger:indexEntry': Object.keys(schemas['evidence-ledger'].$defs.ledgerIndexEntry.properties),
    'trace:document': Object.keys(schemas['trace-matrix'].properties),
    'trace:summary': Object.keys(schemas['trace-matrix'].properties.summary.properties),
    'trace:requirement': Object.keys(schemas['trace-matrix'].$defs.requirementTrace.properties),
  };

  const problems = [];
  for (const [entity, expected] of Object.entries(documented)) {
    const got = actual[entity];
    assert.ok(got, `missing schema entity ${entity}`);
    const missing = expected.filter((k) => !got.includes(k));
    const surplus = got.filter((k) => !expected.includes(k));
    if (missing.length > 0) problems.push(`${entity}: missing [${missing.join(',')}]`);
    if (surplus.length > 0) problems.push(`${entity}: surplus [${surplus.join(',')}]`);
  }
  assert.deepEqual(problems, [], `field-table drift detected:\n${problems.join('\n')}`);
});

test('config.schema.json declares the required-key set of every entity', () => {
  assert.deepEqual(schemas.config.required, ['version', 'provider', 'gates']);
  assert.deepEqual(schemas.config.$defs.provider.required, ['type']);
  assert.deepEqual(schemas.config.$defs.gate.required, ['id', 'stage', 'checks']);
  assert.deepEqual(schemas.config.$defs.humanGate.required, ['role', 'enforcement']);
  assert.deepEqual(schemas.config.$defs.checkBase.required, ['id', 'type']);
  assert.deepEqual(schemas['run-result'].required, ['version', 'run_id', 'started_at', 'finished_at', 'duration_ms', 'overall_passed', 'provider', 'gates']);
  assert.deepEqual(schemas['run-result'].$defs.gate.required, ['id', 'stage', 'required', 'passed', 'humanGate', 'blockers', 'checks']);
  assert.deepEqual(schemas['run-result'].$defs.blocker.required, ['checkId', 'severity', 'message', 'evidence']);
  assert.deepEqual(schemas['run-result'].$defs.checkResult.required, ['id', 'type', 'passed', 'severity', 'evidence']);
  assert.deepEqual(schemas['evidence-ledger'].$defs.ledgerDocument.required, ['schemaVersion', 'ledgerId', 'runId', 'started_at', 'finished_at', 'projectRoot', 'configPath', 'configSha256', 'provider', 'entries']);
  assert.deepEqual(schemas['evidence-ledger'].$defs.ledgerIndexDocument.required, ['schemaVersion', 'updated_at', 'runIds', 'ledgers', 'testIds']);
  assert.deepEqual(schemas['trace-matrix'].required, ['schemaVersion', 'generated_at', 'generated_by', 'run_id', 'pipeline', 'summary', 'requirements']);
  assert.deepEqual(schemas['trace-matrix'].$defs.requirementTrace.required, ['requirementId', 'title', 'priority', 'stage', 'testIds', 'codePaths', 'covered', 'evidence']);
});

// ---------------------------------------------------------------------------
// §6.6 self-description vs reality (t41)
// ---------------------------------------------------------------------------

/**
 * `commandOkSemantics` used to claim `check: "= overall_passed"` — a field that exists
 * in **no** output surface (`check --json` is the 8-key RunResult, `--summary` is text,
 * `--summary --out` is the 6-key envelope) while `contract --check` still exited 0,
 * because the self-check compares the record with the built-in constants and never with
 * the real output. This test measures the three surfaces and holds the self-description
 * to them, so the description cannot describe a field that does not exist again.
 */
test('T-QG-007/T-QG-015 the §6.6 `ok` self-description matches the three real output surfaces', async () => {
  const root = tmpDir('qgate-selfdesc-');
  try {
    copyTree(DEMO_ROOT, path.join(root, 'mini-service'));
    writeJson(path.join(root, 'qgate.config.json'), readJson(DEMO_CONFIG));
    const invocations = {
      contract: ['contract'],
      check: ['check', '--config', 'qgate.config.json'],
      trace: ['trace', '--config', 'qgate.config.json'],
      preview: ['preview', '--config', 'qgate.config.json'],
      report: ['report', '--config', 'qgate.config.json'],
      explain: ['explain', '--config', 'qgate.config.json', '--check', 'req-doc-exists'],
    };

    const measured = {};
    for (const [name, base] of Object.entries(invocations)) {
      const json = await runCliJson([...base, '--json'], { cwd: root });
      const envelopePath = path.join(root, `${name}-envelope.json`);
      await runCli([...base, '--summary', '--out', envelopePath], { cwd: root });
      assert.ok(fs.existsSync(envelopePath), `${name} --summary --out must write an envelope`);
      const summary = await runCli([...base, '--summary'], { cwd: root });
      measured[name] = {
        json: Object.prototype.hasOwnProperty.call(json.json, 'ok'),
        jsonValue: json.json.ok,
        jsonPassed: json.json.passed,
        envelope: Object.prototype.hasOwnProperty.call(readJson(envelopePath), 'ok'),
        summaryText: /\bok\b/.test(summary.stdout),
      };
    }

    // The frozen record and the self-description must say the same thing (the drift
    // check does not compare this field — see the §9.3 finding in the t41 report).
    const described = describeContract().commandOkSemantics;
    const recorded = readJson(path.join(PACKAGE_ROOT, 'gates', 'contract.json')).commandOkSemantics;
    assert.deepEqual(recorded, described, 'gates/contract.json must carry the same commandOkSemantics as describeContract()');

    // The specific old defect: no command may be described with a value-expression for a
    // field it does not emit.
    assert.notEqual(described.check, '= overall_passed');
    assert.ok(!described.check.includes('present'), `check emits no ok field anywhere: ${described.check}`);

    for (const [name, claim] of Object.entries(described)) {
      const real = measured[name];
      assert.ok(typeof claim === 'string' && claim.length > 0, `${name}: the semantics must be stated`);
      // Each claim must name all three surfaces explicitly, and every named surface is
      // checked against what the command actually emitted. `[^;]*` tolerates word order
      // ("present in --json and in --summary --out").
      const surfaceClaim = (surface) => {
        if (new RegExp(`absent[^;]*${surface}`).test(claim)) return false;
        if (new RegExp(`present[^;]*${surface}`).test(claim)) return true;
        return null;
      };
      const expectations = {
        json: surfaceClaim('--json'),
        envelope: surfaceClaim('--summary --out'),
        summaryText: surfaceClaim('--summary text'),
      };
      if (claim.startsWith('absent from every output surface')) {
        for (const surface of Object.keys(expectations)) expectations[surface] = expectations[surface] ?? false;
      }
      assert.ok(
        Object.values(expectations).every((value) => value !== null),
        `${name}: the claim must state --json, --summary --out and the --summary text: ${claim}`,
      );
      // Every command's failure path must also be described: the §6.5 error document
      // carries `ok: false` for all six (measured below).
      assert.match(claim, /error document .*ok=false/, `${name}: the error surface must be stated`);
      assert.deepEqual(
        { json: real.json, envelope: real.envelope, summaryText: real.summaryText },
        expectations,
        `${name}: measured surfaces disagree with the claim "${claim}"`,
      );
      assert.ok(!claim.includes('= overall_passed') || real.json || real.envelope, `${name}: the claim names a field the surfaces do not carry`);
    }

    // Where the description states an equation, the equation must hold.
    assert.match(described.explain, /subject\.passed/);
    assert.equal(measured.explain.jsonValue, measured.explain.jsonPassed, 'explain.ok must equal explain.passed');
    // ...and the value `check` really carries is the one the old claim pointed at.
    const checkJson = await runCliJson(['check', '--config', 'qgate.config.json', '--json'], { cwd: root });
    assert.equal(typeof checkJson.json.overall_passed, 'boolean');

    // The failure surface: the §6.5 error document carries ok=false for every command.
    const failing = await runCliJson(['trace', '--config', 'no-such-config.json', '--json'], { cwd: root, strict: false });
    assert.equal(failing.status, 2);
    assert.deepEqual(Object.keys(failing.json).sort(), ['error', 'ok'], 'the error document is exactly {ok, error}');
    assert.equal(failing.json.ok, false, 'the error document must carry ok=false');
  } finally {
    cleanup(root);
  }
});

test('T-QG-007 §9.3 the self-check compares every described constant, not just seven', () => {
  // Before t43 `detectContractDrift` compared stages/checkTypes/humanGates/commands/
  // exitCodes/configSchemaVersion/runResultSchemaVersion only, so editing any other
  // constant in src/contract.mjs without updating gates/contract.json stayed invisible
  // to `contract --check`. Every described key must now be compared (record ↔ constants;
  // description ↔ real output is covered by the test above).
  const record = readJson(path.join(PACKAGE_ROOT, 'gates', 'contract.json'));
  assert.deepEqual(detectContractDrift(record), [], 'the shipped frozen record must be in sync');

  const described = describeContract();
  for (const key of Object.keys(described)) {
    const mutated = JSON.parse(JSON.stringify(record));
    const value = mutated[key];
    if (Array.isArray(value)) mutated[key] = [...value, 'SENTINEL'];
    else if (value !== null && typeof value === 'object') mutated[key] = { ...value, __sentinel__: true };
    else mutated[key] = typeof value === 'boolean' ? !value : `${String(value)}-sentinel`;
    const drift = detectContractDrift(mutated);
    assert.ok(drift.some((item) => item.startsWith(`${key}:`)), `${key} must be compared (drift: ${JSON.stringify(drift).slice(0, 200)})`);
  }

  // A record field the self-description does not know about is drift too.
  const extra = { ...JSON.parse(JSON.stringify(record)), notADescribedField: 1 };
  assert.ok(detectContractDrift(extra).some((item) => item.startsWith('notADescribedField:')));
});

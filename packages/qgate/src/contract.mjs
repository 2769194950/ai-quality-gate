// Frozen contract constants and self-description (docs/01-architecture.md §3, §5.1, §6, §9.3).
// Nothing in this file may be renamed without a contract change.

export const configSchemaVersion = '1.0';
export const runResultSchemaVersion = '1.0';
export const ledgerSchemaVersion = '1.0';
export const traceMatrixSchemaVersion = '1.0';

/** §3.1 — fixed stage order, not configurable. */
export const stageOrder = Object.freeze(['requirements', 'design', 'build', 'review', 'verify']);

/** §3.2 — exactly three human gates, fixed positions. */
export const humanGates = Object.freeze([
  Object.freeze({
    gateId: 'req-to-design',
    from: 'requirements',
    to: 'design',
    role: 'product',
    enforcement: 'blocking',
    approvalRecord: 'verification/approvals/req-to-design/approval.json',
  }),
  Object.freeze({
    gateId: 'design-to-build',
    from: 'design',
    to: 'build',
    role: 'architect',
    enforcement: 'blocking',
    approvalRecord: 'verification/approvals/design-to-build/approval.json',
  }),
  Object.freeze({
    gateId: 'review-to-verify',
    from: 'review',
    to: 'verify',
    role: 'reviewer',
    enforcement: 'blocking',
    approvalRecord: 'verification/approvals/review-to-verify/approval.json',
  }),
]);

/** §5.1 — the seven check types. */
export const checkTypes = Object.freeze([
  'file_exists',
  'file_not_exists',
  'regex',
  'command',
  'json_assert',
  'trace_matrix',
  'policy',
]);

/** §5.1 — provider types. */
export const providerTypes = Object.freeze(['deterministic', 'scripted', 'llm', 'external']);

/** §5.1 — human gate roles. */
export const humanGateRoles = Object.freeze(['product', 'architect', 'reviewer']);

/** §5.1 — approval record decisions. */
export const approvalDecisions = Object.freeze(['approved', 'rejected', 'revise']);

/** §5.1 — approval outcome states recorded on gates[].humanGate. */
export const approvalStates = Object.freeze(['approved', 'missing', 'rejected', 'role_mismatch']);

/** §5.1 — finding severities. */
export const severities = Object.freeze(['blocker', 'high', 'medium', 'low']);

/** Severity rank, higher blocks harder. */
export const severityRank = Object.freeze({ low: 0, medium: 1, high: 2, blocker: 3 });

/** §5.1 — onFail enum. */
export const onFailValues = Object.freeze(['fail', 'warn']);

/** §5.1 — evidence kinds. */
export const evidenceKinds = Object.freeze(['file', 'stdout', 'json_pointer', 'ledger', 'trace']);

/** §5.1 — policy ids. */
export const policyIds = Object.freeze(['SAFE_001', 'SAFE_002', 'SAFE_003', 'CONTRACT_001']);

/** §5.1 — default severity per check type. */
export const defaultSeverity = Object.freeze({
  file_exists: 'high',
  file_not_exists: 'high',
  regex: 'medium',
  command: 'high',
  json_assert: 'high',
  trace_matrix: 'high',
  policy: 'high',
});

/** §6.3 — frozen exit codes. */
export const exitCodes = Object.freeze({
  PASSED: 0,
  GATE_FAILED: 1,
  CONFIG_ERROR: 2,
  INTERNAL_ERROR: 3,
});

/** §6.5 — structured error codes. */
export const errorCodes = Object.freeze([
  'CONFIG_INVALID',
  'CONFIG_NOT_FOUND',
  'PROVIDER_FAILED',
  'INTERNAL_ERROR',
  'EVIDENCE_UNRESOLVED',
  'CONTRACT_DRIFT',
  'IO_ERROR',
]);

/** §9.2 — blocker message prefixes (machine readable, frozen). */
export const blockerMessagePrefixes = Object.freeze([
  'CONFIG_INVALID',
  'FILE_MISSING',
  'FILE_PRESENT',
  'REGEX_MISMATCH',
  'COMMAND_FAILED',
  'JSON_ASSERT_FAILED',
  'TRACE_GAP',
  'ORPHAN_TEST_ID',
  'POLICY_VIOLATION_SAFE_001',
  'POLICY_VIOLATION_SAFE_002',
  'POLICY_VIOLATION_SAFE_003',
  'POLICY_VIOLATION_CONTRACT_001',
  'HUMAN_GATE_NOT_APPROVED',
  'PROVIDER_FAILED',
  'EVIDENCE_UNRESOLVED',
]);

/** §5.1 — policy semantics (the assertions each policy id encodes). */
export const policySemantics = Object.freeze({
  SAFE_001: 'no API-key reads or vault references in configuration, scripts or documentation',
  SAFE_002: 'secret paths can never be re-included by any include pattern',
  SAFE_003: 'no network call surface in the implementation',
  CONTRACT_001: 'check.type / stage / field names stay inside the frozen enums and field table',
});

/** §5.1 — policy violation message prefix per policy id. */
export const policyMessagePrefix = Object.freeze({
  SAFE_001: 'POLICY_VIOLATION_SAFE_001',
  SAFE_002: 'POLICY_VIOLATION_SAFE_002',
  SAFE_003: 'POLICY_VIOLATION_SAFE_003',
  CONTRACT_001: 'POLICY_VIOLATION_CONTRACT_001',
});

/** §9.1 — approval record schema keys. */
export const approvalRequiredKeys = Object.freeze([
  'schemaVersion',
  'gateId',
  'role',
  'decision',
  'approvedBy',
  'approvedAt',
  'claims',
]);

/** The complete key set of a RunResult, asserted by REQ-004. */
export const runResultKeys = Object.freeze([
  'version',
  'run_id',
  'started_at',
  'finished_at',
  'duration_ms',
  'overall_passed',
  'provider',
  'gates',
]);

export const gateKeys = Object.freeze([
  'id',
  'stage',
  'required',
  'passed',
  'humanGate',
  'blockers',
  'checks',
]);

export const checkResultKeys = Object.freeze(['id', 'type', 'passed', 'severity', 'evidence']);

export const blockerKeys = Object.freeze(['checkId', 'severity', 'message', 'evidence']);

/** Runtime-only fields: everything else in a RunResult is a pure function of inputs. */
export const runtimeFields = Object.freeze(['run_id', 'started_at', 'finished_at', 'duration_ms']);

/**
 * Test-id mapping used to populate ledger entries (`entries[].testId`) and the
 * ledger-index `testIds` array. Keys are check ids, values are test ids.
 *
 * The mapping is deliberately **total over the sixteen test ids** of
 * `docs/requirements-index.json`: the ledger entries produced by the shipped
 * configurations cover T-QG-001 … T-QG-016, so the `trace_matrix` check can reach
 * `covered=true` for every P0/P1 requirement without inventing evidence.
 */
export const checkTestIds = Object.freeze({
  // requirements / design
  'req-doc-exists': 'T-QG-001',
  'req-ids-present': 'T-QG-002',
  'req-index-valid': 'T-QG-003',
  'contract-doc-exists': 'T-QG-004',
  'contract-fields-present': 'T-QG-005',
  'schemas-exist': 'T-QG-006',
  'interface-exists': 'T-QG-004',
  'interface-fields': 'T-QG-016',
  'rule-file-exists': 'T-QG-012',
  // build
  'no-dep': 'T-QG-010',
  'unit-tests': 'T-QG-011',
  'unit-tests-pass': 'T-QG-011',
  'contract-check': 'T-QG-007',
  'test-results-threshold': 'T-QG-007',
  'coverage-threshold': 'T-QG-007',
  'no-network-surface': 'T-QG-014',
  // review
  'negative-fixtures': 'T-QG-009',
  'invalid-must-fail': 'T-QG-008',
  'severity-mix': 'T-QG-013',
  'provider-fixtures': 'T-QG-014',
  'no-bypass': 'T-QG-015',
  'no-loose-ends': 'T-QG-015',
  // verify
  'trace-complete': 'T-QG-006',
  'trace-covered': 'T-QG-006',
  'no-secret-paths': 'T-QG-012',
  'no-key-reads': 'T-QG-013',
  'command-smoke': 'T-QG-016',
});

/** §6.2 — six commands and their own parameters (contract self-description). */
export const commands = Object.freeze([
  Object.freeze({ name: 'contract', params: ['--check'], json: 'contract self-description', summary: 'contract table' }),
  Object.freeze({ name: 'check', params: ['--stage', '--gate', '--fail-fast'], json: 'RunResult', summary: 'gate table' }),
  Object.freeze({ name: 'trace', params: ['--write'], json: 'trace-matrix', summary: 'requirement table' }),
  Object.freeze({ name: 'preview', params: ['--root', '--rule'], json: 'selection/groups/ruleMatch', summary: 'selection table' }),
  Object.freeze({ name: 'report', params: ['--last', '--longest'], json: 'report list', summary: 'report paths' }),
  Object.freeze({ name: 'explain', params: ['--gate', '--check', '--requirement'], json: 'explanation', summary: 'human explanation' }),
  Object.freeze({ name: 'stage', params: ['<stage>', '<review|ingest|explain>', '--mode', '--result', '--diff'], json: 'stage-review evidence', summary: 'stage review table' }),
]);

/** §6.1 — global options accepted by every command. */
export const globalOptions = Object.freeze([
  Object.freeze({ name: '--config', takesValue: true }),
  Object.freeze({ name: '--root', takesValue: true }),
  Object.freeze({ name: '--json', takesValue: false }),
  Object.freeze({ name: '--summary', takesValue: false }),
  Object.freeze({ name: '--quiet', takesValue: false }),
  Object.freeze({ name: '--color', takesValue: true }),
  Object.freeze({ name: '--out', takesValue: true }),
]);

/** §6.4 — command × exit code matrix. */
export const commandExitMatrix = Object.freeze({
  contract: { normal: 0, gateFailed: null, configError: 2, internalError: 3 },
  check: { normal: 0, gateFailed: 1, configError: 2, internalError: 3 },
  trace: { normal: 0, gateFailed: null, configError: 2, internalError: 3 },
  preview: { normal: 0, gateFailed: null, configError: 2, internalError: 3 },
  report: { normal: 0, gateFailed: 0, configError: 2, internalError: 3 },
  explain: { normal: 0, gateFailed: 0, configError: 2, internalError: 3 },
  stage: { normal: 0, gateFailed: 1, configError: 2, internalError: 3 },
});

/**
 * §6.6 — `ok` semantics per command, **as measured on the real output surfaces** (t41).
 *
 * The three surfaces are `--json` (the command's frozen document), `--summary` (human
 * text) and `--summary --out` (the machine-readable envelope written to the file). An
 * earlier revision described `check` as `= overall_passed`, a field that exists in *no*
 * surface — the self-description was describing a field that does not exist. Each value
 * now states presence/absence per surface and, where the field is present, what it
 * equals (measured, not intended: see the regression test
 * `packages/qgate/test/schema-contract.test.mjs`, "self-description matches the real
 * output surfaces").
 */
export const commandOkSemantics = Object.freeze({
  contract: 'present in --json and in --summary --out (literal true); absent from the --summary text; the §6.5 error document (exit 2/3) carries ok=false',
  check: 'absent from every success surface (--json RunResult, --summary text and --summary --out envelope); the verdict is overall_passed; the §6.5 error document (exit 2/3) carries ok=false',
  trace: 'absent from --json (the frozen trace-matrix document has no ok field) and absent from the --summary text; present in --summary --out only (literal true, violations are listed separately in that envelope); the §6.5 error document (exit 2/3) carries ok=false',
  preview: 'present in --json and in --summary --out (literal true, degradation is reported separately as degraded); absent from the --summary text; the §6.5 error document (exit 2/3) carries ok=false',
  report: 'present in --json and in --summary --out (literal true); absent from the --summary text; the §6.5 error document (exit 2/3) carries ok=false',
  explain: 'present in --json and in --summary --out (= subject.passed); absent from the --summary text; the §6.5 error document (exit 2/3) carries ok=false',
});

/** Frozen self-description returned by `qgate contract --json` (§6.2). */
export function describeContract() {
  return {
    ok: true,
    configSchemaVersion,
    runResultSchemaVersion,
    ledgerSchemaVersion,
    traceMatrixSchemaVersion,
    checkTypes: [...checkTypes],
    stages: [...stageOrder],
    humanGates: humanGates.map((g) => ({ ...g })),
    commands: commands.map((c) => ({ ...c, params: [...c.params] })),
    globalOptions: globalOptions.map((o) => ({ ...o })),
    exitCodes: {
      0: 'passed',
      1: 'gate_failed',
      2: 'config_error',
      3: 'internal_error',
    },
    errorCodes: [...errorCodes],
    blockerMessagePrefixes: [...blockerMessagePrefixes],
    policyIds: [...policyIds],
    policySemantics: { ...policySemantics },
    findings: {
      severities: [...severities],
      defaultSeverity: { ...defaultSeverity },
      blockerRule: 'confidence >= provider.confidenceThreshold AND severity in {high, blocker}; everything else is downgraded to findings',
    },
    runResultKeys: [...runResultKeys],
    gateKeys: [...gateKeys],
    checkResultKeys: [...checkResultKeys],
    blockerKeys: [...blockerKeys],
    commandExitMatrix: JSON.parse(JSON.stringify(commandExitMatrix)),
    commandOkSemantics: { ...commandOkSemantics },
  };
}

/** Canonical JSON string with sorted object keys: order- and formatting-independent. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Contract drift detection: recompute the self-description and compare **every**
 * described surface against the frozen record (§9.3).
 *
 * The comparison used to cover only seven fields (stages/checkTypes/humanGates/
 * commands/exitCodes/configSchemaVersion/runResultSchemaVersion), so a constant edited
 * in this module without updating `gates/contract.json` stayed invisible to
 * `contract --check` (t43 ruling: compare all of them — a pure constant comparison
 * costs nothing).
 *
 * This layer is deliberately **record ↔ constants only**: it never runs the commands,
 * because the root gate itself executes `contract --check` through a `command` check,
 * so spawning `check`/`trace` from here would recurse and inflate CI time.
 * Description ↔ real-output consistency is asserted by the test suite instead
 * (`test/schema-contract.test.mjs`, "self-description matches the three real output
 * surfaces").
 */
export function detectContractDrift(recorded) {
  const actual = describeContract();
  const drift = [];
  const record = recorded !== null && typeof recorded === 'object' ? recorded : {};
  for (const key of Object.keys(actual)) {
    const expected = canonicalJson(actual[key]);
    const got = canonicalJson(record[key]);
    if (expected !== got) drift.push(`${key}: expected ${expected}, got ${got}`);
  }
  for (const key of Object.keys(record)) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) {
      drift.push(`${key}: recorded in the frozen record but not described by describeContract()`);
    }
  }
  return drift;
}

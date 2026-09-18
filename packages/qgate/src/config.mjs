// Configuration loading and strict validation (docs/01-architecture.md §5.1).
// Illegal input never silently passes: every violation produces a readable
// diagnostic carrying a JSON Pointer, and the CLI exits with code 2.
import path from 'node:path';
import fs from 'node:fs';
import {
  configSchemaVersion,
  checkTypes,
  providerTypes,
  stageOrder,
  humanGates,
  humanGateRoles,
  severities,
  defaultSeverity,
  onFailValues,
  policyIds,
} from './contract.mjs';
import { configError, notFoundError, ioError } from './errors.mjs';
import { sha256 } from './util/hash.mjs';
import { stringifyJson, parseJsonText } from './util/fsx.mjs';
import { DEFAULT_EXCLUDED_PATHS } from './selection.mjs';

export const defaultPolicy = Object.freeze({
  evidenceDir: 'verification/evidence',
  reportDir: 'verification/reports',
  failFast: false,
});

export const defaultSelection = Object.freeze({
  include: ['**/*'],
  exclude: [],
  extensions: ['.mjs', '.js', '.json', '.md', '.yaml', '.yml', '.txt'],
  // SINGLE AUTHORITY (t63/F19): this used to be a second, hand-kept copy of the table in
  // `selection.mjs`. The copy drifted: `policySafe002` used the `selection.mjs` list while
  // `preview` used this one, so only one of the two engine paths excluded the evidence
  // trees. Importing the constant keeps both paths on the same table by construction.
  defaultExcludedPaths: [...DEFAULT_EXCLUDED_PATHS],
  maxFileSizeBytes: 262144,
  maxFilesPerGroup: 10,
  tokenBudgetPerGroup: 12000,
});

const GATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const REQ_ID_PATTERN = /^REQ-[A-Z0-9-]+-\d{3,4}$/;
const TEST_ID_PATTERN = /^T-[A-Z0-9-]+-\d{3,4}$/;
const APPROVAL_DEFAULT = (gateId) => `verification/approvals/${gateId}/approval.json`;

const humanGateIds = new Set(humanGates.map((g) => g.gateId));

/**
 * The frozen handover position a gate occupies. §3.2 freezes three positions
 * (`requirements → design`, `design → build`, `review → verify`); the gate that
 * ends a stage is the one that carries the exit approval, so the mapping is
 * position-derived and never depends on the gate id.
 */
export function handoverPositionForStage(stage) {
  if (stage === 'requirements') return humanGates[0];
  if (stage === 'design') return humanGates[1];
  if (stage === 'review') return humanGates[2];
  return null;
}

/** Field tables per §5.1 — declared once so validation and defaults never drift apart. */
const checkFieldTables = {
  file_exists: [
    { name: 'file', type: 'string', required: true },
    { name: 'minCount', type: 'integer', min: 1, default: 1 },
  ],
  file_not_exists: [{ name: 'file', type: 'string', required: true }],
  regex: [
    { name: 'files', type: 'string[]', required: true, minLength: 1 },
    { name: 'pattern', type: 'string', required: true },
    { name: 'flags', type: 'string', default: 'gm', pattern: /^[gimsuy]*$/ },
    { name: 'mode', type: 'enum', values: ['each', 'any', 'all', 'count'], default: 'each' },
    { name: 'minMatches', type: 'integer', min: 1, default: 1 },
    { name: 'countMode', type: 'enum', values: ['total', 'unique'], default: 'total' },
    { name: 'encoding', type: 'enum', values: ['utf8', 'utf16le'], default: 'utf8' },
  ],
  command: [
    { name: 'run', type: 'string[]', required: true, minLength: 1 },
    { name: 'expectExitCode', type: 'integer', min: 0, max: 255, default: 0 },
    { name: 'timeoutMs', type: 'integer', min: 1000, max: 600000, default: 60000 },
    { name: 'cwd', type: 'string', default: null },
    { name: 'captureStdout', type: 'boolean', default: true },
    { name: 'stdoutRegex', type: 'string', default: null },
  ],
  json_assert: [
    { name: 'file', type: 'string', required: true },
    { name: 'assertions', type: 'assertions', required: true, minLength: 1 },
  ],
  trace_matrix: [
    { name: 'requirementsFile', type: 'string', required: true },
    { name: 'traceFile', type: 'string', required: true },
    { name: 'enforce', type: 'enum', values: ['strict', 'lenient'], default: 'strict' },
    { name: 'testIdSource', type: 'enum', values: ['ledger-index', 'trace-only'], default: 'ledger-index' },
  ],
  policy: [
    { name: 'policyId', type: 'enum', values: [...policyIds], required: true },
    { name: 'expectedFiles', type: 'string[]', default: null },
  ],
};

const providerFieldTable = [
  { name: 'type', type: 'enum', values: [...providerTypes], required: true },
  { name: 'script', type: 'string', default: null },
  { name: 'timeoutMs', type: 'integer', min: 500, max: 600000, default: 30000 },
  { name: 'model', type: 'string', default: null },
  { name: 'endpoint', type: 'string', default: null },
  { name: 'fixture', type: 'string', default: null },
  { name: 'confidenceThreshold', type: 'number', min: 0, max: 1, default: 0.7 },
];

const policyFieldTable = [
  { name: 'evidenceDir', type: 'string', default: defaultPolicy.evidenceDir },
  { name: 'reportDir', type: 'string', default: defaultPolicy.reportDir },
  { name: 'failFast', type: 'boolean', default: defaultPolicy.failFast },
  { name: 'scanRoots', type: 'string[]', default: null },
];

const selectionFieldTable = [
  { name: 'include', type: 'string[]', default: [...defaultSelection.include] },
  { name: 'exclude', type: 'string[]', default: [...defaultSelection.exclude] },
  { name: 'extensions', type: 'string[]', default: [...defaultSelection.extensions] },
  { name: 'defaultExcludedPaths', type: 'string[]', default: [...defaultSelection.defaultExcludedPaths] },
  { name: 'maxFileSizeBytes', type: 'integer', min: 1, default: defaultSelection.maxFileSizeBytes },
  { name: 'maxFilesPerGroup', type: 'integer', min: 1, default: defaultSelection.maxFilesPerGroup },
  { name: 'tokenBudgetPerGroup', type: 'integer', min: 1, default: defaultSelection.tokenBudgetPerGroup },
  { name: 'ruleFile', type: 'string', default: null },
];

/** Infer the project root from a configuration path.
 *  A root-level `qgate.config.json` resolves to its own directory; a config kept
 *  inside a `.qgate/` (or `qgate/`) directory resolves to that directory's parent.
 *  A config that sits next to the repository it validates (for example
 *  `demo/qgate.config.json`) declares `projectRoot` instead. */
export function inferRootFromConfig(configAbsPath) {
  const dir = path.dirname(path.resolve(configAbsPath));
  const base = path.basename(dir);
  if (base === '.qgate' || base === 'qgate' || base === '.quality-gate') return path.dirname(dir);
  return dir;
}

function pointer(...tokens) {
  return `/${tokens.map((t) => String(t).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

class Validator {
  constructor() {
    this.details = [];
  }

  push(jsonPointer, expected, actual, message) {
    this.details.push({ jsonPointer, expected, actual, message });
  }

  get failed() {
    return this.details.length > 0;
  }

  toError(summary) {
    const first = this.details[0];
    return configError(`${summary}: ${first.message}`, {
      jsonPointer: first.jsonPointer,
      details: this.details,
    });
  }
}

function typeMatches(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'enum':
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'assertions':
      return Array.isArray(value);
    default:
      return true;
  }
}

function typeLabel(type) {
  return type === 'string[]' ? 'array<string>' : type;
}

/** Validate one object against a field table, returning the normalised value.
 *  Unknown keys are rejected: the contract forbids extra baseline fields. */
function validateFields(validator, obj, table, basePointer, { rejectUnknown = true, allowedExtra = [] } = {}) {
  const out = {};
  const known = new Set(table.map((f) => f.name));
  for (const field of table) {
    const p = pointer(...basePointer.split('/').filter(Boolean), field.name);
    const has = Object.prototype.hasOwnProperty.call(obj, field.name);
    if (!has || obj[field.name] === undefined) {
      if (field.required) {
        validator.push(p, `${field.name}:${typeLabel(field.type)} (required)`, 'undefined', `missing required field "${field.name}"`);
        continue;
      }
      out[field.name] = field.default;
      continue;
    }
    const value = obj[field.name];
    if (value === null && field.default === null) {
      out[field.name] = null;
      continue;
    }
    if (!typeMatches(value, field.type)) {
      validator.push(p, typeLabel(field.type), describeValue(value), `field "${field.name}" must be ${typeLabel(field.type)}`);
      continue;
    }
    if (field.type === 'enum' && !field.values.includes(value)) {
      validator.push(p, field.values.join('|'), String(value), `field "${field.name}" must be one of ${field.values.join('|')}`);
      continue;
    }
    if (typeof value === 'number') {
      if (field.min !== undefined && value < field.min) {
        validator.push(p, `>= ${field.min}`, String(value), `field "${field.name}" must be >= ${field.min}`);
        continue;
      }
      if (field.max !== undefined && value > field.max) {
        validator.push(p, `<= ${field.max}`, String(value), `field "${field.name}" must be <= ${field.max}`);
        continue;
      }
    }
    if (field.minLength !== undefined && Array.isArray(value) && value.length < field.minLength) {
      validator.push(p, `length >= ${field.minLength}`, `length ${value.length}`, `field "${field.name}" must have at least ${field.minLength} element(s)`);
      continue;
    }
    if (field.pattern && typeof value === 'string' && !field.pattern.test(value)) {
      validator.push(p, String(field.pattern), value, `field "${field.name}" has an invalid format`);
      continue;
    }
    out[field.name] = value;
  }
  if (rejectUnknown) {
    for (const key of Object.keys(obj)) {
      if (known.has(key) || allowedExtra.includes(key)) continue;
      validator.push(pointer(...basePointer.split('/').filter(Boolean), key), `one of ${[...known].join(', ')}`, String(key), `unknown field "${key}" is not part of the frozen field table`);
    }
  }
  return out;
}

function describeValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(length=${value.length})`;
  const t = typeof value;
  if (t === 'string') return `string(${value.length})`;
  return `${t}(${String(value)})`;
}

function validateAssertions(validator, assertions, basePointer) {
  const out = [];
  assertions.forEach((assertion, index) => {
    const base = `${basePointer}/${index}`;
    if (assertion === null || typeof assertion !== 'object' || Array.isArray(assertion)) {
      validator.push(base, 'object', describeValue(assertion), 'each assertion must be an object');
      return;
    }
    const table = [
      { name: 'pointer', type: 'string', required: true },
      { name: 'exists', type: 'boolean', default: undefined },
      { name: 'equals', type: 'any', default: undefined },
      { name: 'matches', type: 'string', default: undefined },
    ];
    const known = new Set(table.map((f) => f.name));
    for (const key of Object.keys(assertion)) {
      if (!known.has(key)) {
        validator.push(`${base}/${key}`, [...known].join(', '), key, `unknown assertion field "${key}"`);
      }
    }
    const pointerValue = assertion.pointer;
    if (typeof pointerValue !== 'string' || pointerValue.length === 0) {
      validator.push(`${base}/pointer`, 'non-empty string', describeValue(pointerValue), 'assertion.pointer must be a non-empty JSON Pointer');
      return;
    }
    if (!pointerValue.startsWith('/')) {
      validator.push(`${base}/pointer`, 'JSON Pointer starting with "/"', pointerValue, 'assertion.pointer must start with "/"');
      return;
    }
    if (assertion.exists !== undefined && typeof assertion.exists !== 'boolean') {
      validator.push(`${base}/exists`, 'boolean', describeValue(assertion.exists), 'assertion.exists must be boolean');
      return;
    }
    if (assertion.matches !== undefined && typeof assertion.matches !== 'string') {
      validator.push(`${base}/matches`, 'string', describeValue(assertion.matches), 'assertion.matches must be a string');
      return;
    }
    const hasAny = assertion.exists !== undefined || assertion.equals !== undefined || assertion.matches !== undefined;
    if (!hasAny) {
      validator.push(base, 'at least one of exists|equals|matches', '{}', 'each assertion needs at least one of exists, equals or matches');
      return;
    }
    out.push({ ...assertion, pointer: pointerValue });
  });
  return out;
}

/** Validate a parsed configuration object. Throws QgateError(CONFIG_INVALID) on violation. */
export function validateConfig(raw, { configPath = 'qgate.config.json' } = {}) {
  const validator = new Validator();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    validator.push('', 'object', describeValue(raw), 'configuration root must be a JSON object');
    throw validator.toError('configuration is not valid');
  }

  const topAllowed = ['version', 'provider', 'gates', 'policy', 'selection', 'grouping', 'projectRoot'];
  const topKnown = new Set(topAllowed);
  for (const key of Object.keys(raw)) {
    if (!topKnown.has(key)) {
      validator.push(pointer(key), topAllowed.join('|'), key, `unknown top-level field "${key}" is not part of the frozen field table`);
    }
  }

  if (raw.version !== configSchemaVersion) {
    validator.push('/version', `"${configSchemaVersion}"`, describeValue(raw.version), `version must be the literal "${configSchemaVersion}"`);
  }

  const provider = validateFields(
    validator,
    raw.provider ?? {},
    providerFieldTable,
    '/provider',
    { rejectUnknown: true },
  );
  if (raw.provider === undefined) {
    validator.push('/provider', 'object (required)', 'undefined', 'missing required field "provider"');
  }
  if (provider.type === 'scripted' && !provider.script) {
    validator.push('/provider/script', 'string (required when provider.type="scripted")', 'undefined', 'provider.script is required when provider.type is "scripted"');
  }

  // Unknown keys are rejected in all four sub-tables: `schemas/config.schema.json`
  // declares `additionalProperties: false` on provider/policy/selection/grouping and
  // schemas/README.md promises the contract rejects them, so the engine must not
  // accept what the frozen schema rejects (no engine-accepts/schema-rejects split).
  const policy = validateFields(validator, raw.policy ?? {}, policyFieldTable, '/policy', { rejectUnknown: true });
  const selection = validateFields(validator, raw.selection ?? {}, selectionFieldTable, '/selection', { rejectUnknown: true });
  const groupingTable = [
    { name: 'maxFilesPerGroup', type: 'integer', min: 1, default: defaultSelection.maxFilesPerGroup },
    { name: 'tokenBudgetPerGroup', type: 'integer', min: 1, default: defaultSelection.tokenBudgetPerGroup },
    { name: 'tokensPerFile', type: 'integer', min: 1, default: 4 },
  ];
  const grouping = validateFields(validator, raw.grouping ?? {}, groupingTable, '/grouping', { rejectUnknown: true });

  // gates
  if (!Array.isArray(raw.gates)) {
    validator.push('/gates', 'array<object> (required, length >= 1)', describeValue(raw.gates), 'gates must be an array');
    throw validator.toError('configuration is not valid');
  }
  if (raw.gates.length === 0) {
    validator.push('/gates', 'array<object> with length >= 1', 'array(length=0)', 'gates must contain at least one gate');
    throw validator.toError('configuration is not valid');
  }

  const gates = [];
  const gateIds = new Set();
  const humanGateCount = { value: 0 };
  raw.gates.forEach((rawGate, gateIndex) => {
    const gateBase = `/gates/${gateIndex}`;
    if (rawGate === null || typeof rawGate !== 'object' || Array.isArray(rawGate)) {
      validator.push(gateBase, 'object', describeValue(rawGate), 'each gate must be an object');
      return;
    }
    for (const key of Object.keys(rawGate)) {
      if (!['id', 'stage', 'required', 'checks', 'humanGate'].includes(key)) {
        validator.push(`${gateBase}/${key}`, 'id|stage|required|checks|humanGate', key, `unknown gate field "${key}"`);
      }
    }
    const id = rawGate.id;
    if (typeof id !== 'string') {
      validator.push(`${gateBase}/id`, 'string', describeValue(id), 'gate.id must be a string');
      return;
    }
    if (!GATE_ID_PATTERN.test(id)) {
      validator.push(`${gateBase}/id`, 'pattern ^[a-z0-9][a-z0-9-]{1,63}$', id, `gate.id "${id}" does not match the frozen id pattern`);
    }
    if (gateIds.has(id)) {
      validator.push(`${gateBase}/id`, 'globally unique', id, `duplicate gate.id "${id}"`);
    }
    gateIds.add(id);

    const stage = rawGate.stage;
    if (typeof stage !== 'string') {
      validator.push(`${gateBase}/stage`, stageOrder.join('|'), describeValue(stage), 'gate.stage must be a string');
      return;
    }
    if (!stageOrder.includes(stage)) {
      validator.push(`${gateBase}/stage`, stageOrder.join('|'), stage, `gate.stage "${stage}" is not one of the five frozen stages`);
      return;
    }

    const required = rawGate.required === undefined ? true : rawGate.required;
    if (typeof required !== 'boolean') {
      validator.push(`${gateBase}/required`, 'boolean', describeValue(required), 'gate.required must be boolean');
      return;
    }

    if (!Array.isArray(rawGate.checks) || rawGate.checks.length === 0) {
      validator.push(`${gateBase}/checks`, 'array<object> with length >= 1', describeValue(rawGate.checks), 'gate.checks must be a non-empty array');
      return;
    }

    const checks = [];
    const checkIds = new Set();
    rawGate.checks.forEach((rawCheck, checkIndex) => {
      const checkBase = `/gates/${gateIndex}/checks/${checkIndex}`;
      const check = validateCheck(validator, rawCheck, checkBase);
      if (!check) return;
      if (checkIds.has(check.id)) {
        validator.push(`${checkBase}/id`, 'unique within the gate', check.id, `duplicate check.id "${check.id}" inside gate "${id}"`);
      }
      checkIds.add(check.id);
      checks.push(check);
    });

    let humanGate = null;
    if (rawGate.humanGate !== undefined && rawGate.humanGate !== null) {
      humanGateCount.value += 1;
      const hg = rawGate.humanGate;
      const hgBase = `${gateBase}/humanGate`;
      if (typeof hg !== 'object' || Array.isArray(hg)) {
        validator.push(hgBase, 'object', describeValue(hg), 'humanGate must be an object');
      } else {
        for (const key of Object.keys(hg)) {
          if (!['role', 'approvalRecord', 'enforcement', 'gateId'].includes(key)) {
            validator.push(`${hgBase}/${key}`, 'role|approvalRecord|enforcement|gateId', key, `unknown humanGate field "${key}"`);
          }
        }
        // §3.2 freezes three *handover positions*, not three gate ids. A gate
        // carries a human gate exactly when it sits on one of those stage pairs;
        // its identity is the handover id (`req-to-design` | `design-to-build` |
        // `review-to-verify`) unless the configuration names it explicitly via
        // `humanGate.gateId`.
        const position = handoverPositionForStage(stage);
        if (!position) {
          validator.push(hgBase, `gate stage one of the three handover stages (${humanGates.map((g) => `${g.from}->${g.to}`).join(', ')})`, stage, 'humanGate is only allowed at the three frozen handover points');
        }
        const declaredGateId = hg.gateId === undefined ? position?.gateId ?? null : hg.gateId;
        if (hg.gateId !== undefined) {
          if (typeof hg.gateId !== 'string' || !humanGateIds.has(hg.gateId)) {
            validator.push(`${hgBase}/gateId`, [...humanGateIds].join('|'), describeValue(hg.gateId), `humanGate.gateId must be one of the three frozen handover ids`);
          }
        }
        const expectedRole = position?.role ?? null;
        if (!humanGateRoles.includes(hg.role)) {
          validator.push(`${hgBase}/role`, humanGateRoles.join('|'), describeValue(hg.role), `humanGate.role must be one of ${humanGateRoles.join('|')}`);
        } else if (expectedRole && hg.role !== expectedRole) {
          validator.push(`${hgBase}/role`, expectedRole, hg.role, `the ${position.gateId} handover is signed by role "${expectedRole}", not "${hg.role}"`);
        }
        if (hg.enforcement !== 'blocking') {
          validator.push(`${hgBase}/enforcement`, 'blocking', describeValue(hg.enforcement), 'humanGate.enforcement must be "blocking" (the only frozen value)');
        }
        const approvalDefault = declaredGateId ? APPROVAL_DEFAULT(declaredGateId) : APPROVAL_DEFAULT(id);
        const approvalRecord = hg.approvalRecord === undefined ? approvalDefault : hg.approvalRecord;
        if (typeof approvalRecord !== 'string' || approvalRecord.length === 0) {
          validator.push(`${hgBase}/approvalRecord`, 'non-empty string', describeValue(approvalRecord), 'humanGate.approvalRecord must be a non-empty relative path');
        }
        if (declaredGateId) {
          humanGate = { gateId: declaredGateId, role: hg.role, approvalRecord, enforcement: hg.enforcement };
        }
      }
    }

    gates.push({ id, stage, required, humanGate, checks });
  });

  if (validator.failed) throw validator.toError('configuration is not valid');

  const ordered = gates.slice().sort((a, b) => {
    const sa = stageOrder.indexOf(a.stage);
    const sb = stageOrder.indexOf(b.stage);
    if (sa !== sb) return sa - sb;
    return raw.gates.findIndex((g) => g.id === a.id) - raw.gates.findIndex((g) => g.id === b.id);
  });

  const approvalsMissing = humanGates.filter((hg) => !ordered.some((g) => g.humanGate?.gateId === hg.gateId)).length;

  let projectRoot = null;
  if (raw.projectRoot !== undefined) {
    if (typeof raw.projectRoot !== 'string' || raw.projectRoot.length === 0) {
      validator.push('/projectRoot', 'non-empty POSIX relative path', describeValue(raw.projectRoot), 'projectRoot must be a non-empty relative path');
    } else {
      projectRoot = raw.projectRoot.replace(/\\/g, '/');
    }
  }
  if (validator.failed) throw validator.toError('configuration is not valid');

  return {
    version: configSchemaVersion,
    provider,
    policy: { ...policy, failFast: raw.policy?.failFast ?? defaultPolicy.failFast },
    selection,
    grouping,
    projectRoot,
    gates: ordered,
    meta: {
      configPath,
      humanGateCount: humanGateCount.value,
      approvalsMissing,
      declaredGateOrder: gates.map((g) => g.id),
    },
  };
}

function validateCheck(validator, rawCheck, checkBase) {
  if (rawCheck === null || typeof rawCheck !== 'object' || Array.isArray(rawCheck)) {
    validator.push(checkBase, 'object', describeValue(rawCheck), 'each check must be an object');
    return null;
  }
  const id = rawCheck.id;
  if (typeof id !== 'string' || !GATE_ID_PATTERN.test(id)) {
    validator.push(`${checkBase}/id`, 'pattern ^[a-z0-9][a-z0-9-]{1,63}$', describeValue(id), 'check.id must match the frozen id pattern');
    return null;
  }
  const type = rawCheck.type;
  if (typeof type !== 'string' || !checkTypes.includes(type)) {
    const actual = typeof type === 'string' ? type : describeValue(type);
    validator.push(`${checkBase}/type`, checkTypes.join('|'), actual, `check.type "${actual}" is not allowed`);
    return null;
  }

  const sharedTable = [
    { name: 'id', type: 'string', required: true },
    { name: 'type', type: 'enum', values: [...checkTypes], required: true },
    { name: 'required', type: 'boolean', default: true },
    { name: 'severity', type: 'enum', values: [...severities], default: defaultSeverity[type] },
    { name: 'onFail', type: 'enum', values: [...onFailValues], default: 'fail' },
    { name: 'description', type: 'string', default: '' },
  ];
  const merged = [...sharedTable, ...checkFieldTables[type]];
  const normalized = validateFields(validator, rawCheck, merged, checkBase, { rejectUnknown: true });

  if (type === 'json_assert' && Array.isArray(rawCheck.assertions)) {
    normalized.assertions = validateAssertions(validator, rawCheck.assertions, `${checkBase}/assertions`);
  }
  if (type === 'regex' && typeof rawCheck.pattern === 'string' && rawCheck.pattern.length > 0) {
    try {
      new RegExp(rawCheck.pattern, rawCheck.flags ?? 'gm');
    } catch (error) {
      validator.push(`${checkBase}/pattern`, 'valid JS regular expression source', rawCheck.pattern, `check.pattern is not a valid regular expression: ${error.message}`);
    }
  }
  if (type === 'command' && Array.isArray(normalized.run)) {
    for (let i = 0; i < normalized.run.length; i += 1) {
      if (normalized.run[i].length === 0) {
        validator.push(`${checkBase}/run/${i}`, 'non-empty string', '""', 'command.run elements must be non-empty strings');
      }
    }
    if (normalized.run.length === 0) {
      validator.push(`${checkBase}/run`, 'array<string> with length >= 1', 'array(length=0)', 'command.run must contain the executable as its first element');
    }
  }
  if (type === 'regex' && typeof normalized.pattern === 'string' && normalized.pattern.length === 0) {
    validator.push(`${checkBase}/pattern`, 'non-empty string', '""', 'regex.pattern must be non-empty');
  }
  if (type === 'command' && normalized.stdoutRegex) {
    try {
      new RegExp(normalized.stdoutRegex);
    } catch (error) {
      validator.push(`${checkBase}/stdoutRegex`, 'valid JS regular expression source', normalized.stdoutRegex, `stdoutRegex is invalid: ${error.message}`);
    }
  }
  if (type === 'policy') {
    const extra = rawCheck.expectedFiles;
    if (extra !== undefined) {
      if (!Array.isArray(extra) || extra.some((v) => typeof v !== 'string')) {
        validator.push(`${checkBase}/expectedFiles`, 'array<string>', describeValue(extra), 'policy.expectedFiles must be an array of paths');
      } else {
        normalized.expectedFiles = extra;
      }
    }
  }
  return normalized;
}

/**
 * Load and validate a configuration file.
 * Returns `{ config, absPath, root, sha256, text }`.
 */
export function loadConfig(configPath, { root = null, cwd = process.cwd() } = {}) {
  const absConfigPath = path.isAbsolute(configPath) ? configPath : path.resolve(cwd, configPath);
  let text;
  try {
    text = fs.readFileSync(absConfigPath, 'utf8');
  } catch {
    throw notFoundError(`configuration file not found: ${configPath}`, {
      details: [{ jsonPointer: '', expected: 'readable JSON file', actual: absConfigPath, message: `configuration file not found: ${configPath}` }],
      exitCode: 2,
    });
  }
  let raw;
  try {
    // A leading UTF-8 BOM (Notepad, PowerShell `>` redirection) must not make a
    // perfectly valid configuration unparseable; `parseJsonText` strips the mark
    // only, so genuinely malformed JSON is still rejected.
    raw = parseJsonText(text);
  } catch (error) {
    throw configError(`configuration file is not parseable JSON: ${configPath}`, {
      jsonPointer: '',
      details: [{ jsonPointer: '', expected: 'valid JSON', actual: error.message, message: `JSON parse error: ${error.message}` }],
    });
  }
  const projectRoot = raw.projectRoot
    ? path.resolve(path.dirname(absConfigPath), raw.projectRoot.split('/').join(path.sep))
    : inferRootFromConfig(absConfigPath);
  const config = validateConfig(raw, { configPath });
  return {
    config,
    raw,
    absPath: absConfigPath,
    root: root ? path.resolve(cwd, root) : projectRoot,
    configDeclaredRoot: projectRoot,
    sha256: sha256(text),
    text,
    serialize: () => stringifyJson(raw),
  };
}

/** Validates a raw object without touching the filesystem (used by tests and `preview`). */
export function validateConfigObject(raw, options = {}) {
  return validateConfig(raw, options);
}

export { ioError };
export const requirementIdPattern = REQ_ID_PATTERN;
export const testIdPattern = TEST_ID_PATTERN;

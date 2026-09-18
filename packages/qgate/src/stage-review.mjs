// Stage-oriented semantic review orchestration.
// The qgate core never owns LLM credentials: live OCR results are imported via
// `stage ... ingest`; offline review only produces a deterministic manifest.
import fs from 'node:fs';
import path from 'node:path';
import { stageOrder } from './contract.mjs';
import { configError, evidenceError, ioError } from './errors.mjs';
import { parseJsonText, readTextIfExists, stringifyJson, writeFileAtomic } from './util/fsx.mjs';
import { canonicalJson, sha256 } from './util/hash.mjs';
import { globList, toPosix, walkFiles } from './util/glob.mjs';

export const STAGE_EVIDENCE_SCHEMA_VERSION = '1.0';
export const STAGE_EVIDENCE_DIR = '.qgate/evidence/ai';
const SAFE_RELS = new Set(['docs/00-requirements.md', 'docs/requirements-index.json', 'docs/01-architecture.md', 'verification/trace-matrix.json']);

function relPath(value) {
  const rel = toPosix(value);
  if (!rel || rel.startsWith('/') || /^[A-Za-z]:\//.test(rel) || rel.split('/').includes('..')) return null;
  return rel;
}

function readSource(root, rel) {
  const safe = relPath(rel);
  if (!safe) throw configError(`stage input path is not project-relative: ${rel}`, { jsonPointer: '/stage/input' });
  const abs = path.join(root, safe.split('/').join(path.sep));
  const text = readTextIfExists(abs);
  return text === null ? null : { path: safe, content: text };
}

function existingSources(root, paths) {
  return paths.map((rel) => readSource(root, rel)).filter(Boolean);
}

function stageInputPaths(stage, root, { diff = null } = {}) {
  const paths = [];
  if (stage === 'requirements') paths.push('docs/00-requirements.md', 'docs/requirements-index.json');
  if (stage === 'design') {
    paths.push('docs/01-architecture.md', 'docs/requirements-index.json');
    paths.push(...globList(root, 'schemas/*.schema.json'));
  }
  if (stage === 'build') {
    paths.push('package.json', 'qgate.config.json', 'packages/qgate/package.json');
    paths.push(...globList(root, '**/package.json'));
  }
  if (stage === 'review') {
    paths.push('docs/00-requirements.md', 'docs/01-architecture.md', 'docs/requirements-index.json');
    if (diff) paths.push(diff);
    else paths.push(...walkFiles(root).filter((file) => /\.(mjs|js|json|md|yaml|yml|ts|tsx|jsx)$/.test(file)).slice(0, 200));
  }
  if (stage === 'verify') {
    paths.push('docs/requirements-index.json', 'verification/trace-matrix.json');
    paths.push(...globList(root, '.qgate/evidence/**/*.json'));
    paths.push(...globList(root, 'verification/evidence/**/*.json'));
  }
  return [...new Set(paths.map(toPosix))].sort();
}

export function assertStage(stage) {
  if (!stageOrder.includes(stage)) throw configError(`stage must be one of ${stageOrder.join('|')} (got "${stage}")`, { jsonPointer: '/stage' });
  return stage;
}

export function buildStageManifest({ stage, root, configPath = null, diff = null } = {}) {
  assertStage(stage);
  const absRoot = path.resolve(root || process.cwd());
  const sources = existingSources(absRoot, stageInputPaths(stage, absRoot, { diff }));
  const manifest = {
    schemaVersion: STAGE_EVIDENCE_SCHEMA_VERSION,
    kind: 'qgate-stage-review-manifest',
    stage,
    root: '.',
    config: configPath ? toPosix(path.relative(absRoot, path.resolve(configPath))) : null,
    diff: diff ? relPath(diff) : null,
    purpose: {
      requirements: '审查需求的完整性、可验收性、冲突和追踪要求',
      design: '审查设计是否覆盖需求并遵守冻结接口契约',
      build: '审查构建配置、依赖和实现是否引入语义或供应链风险',
      review: '审查代码变更的语义缺陷、边界条件、安全风险和测试缺口',
      verify: '审查测试、证据和需求追踪是否语义一致',
    }[stage],
    sources: sources.map((source) => ({ path: source.path, content: source.content })),
  };
  manifest.inputFingerprint = `sha256:${sha256(canonicalJson(manifest))}`;
  return manifest;
}

function emptySummary(executed, valid, blockerCount) {
  return { ocrExecuted: executed, ocrResultValid: valid, ocrNoBlockers: valid && blockerCount === 0 };
}

function normalizeSeverity(value) {
  return ['blocker', 'high', 'medium', 'low'].includes(value) ? value : 'medium';
}

function normalizeFinding(raw, index) {
  if (!raw || typeof raw !== 'object') throw evidenceError(`finding[${index}] must be an object`, { jsonPointer: `/findings/${index}` });
  const file = relPath(raw.path);
  if (!file) throw evidenceError(`finding[${index}] has an invalid project-relative path`, { jsonPointer: `/findings/${index}/path` });
  if (typeof raw.content !== 'string' || raw.content.trim() === '') throw evidenceError(`finding[${index}] content is required`, { jsonPointer: `/findings/${index}/content` });
  const startLine = raw.start_line ?? raw.startLine ?? 0;
  const endLine = raw.end_line ?? raw.endLine ?? startLine;
  if (!Number.isInteger(startLine) || startLine < 0 || !Number.isInteger(endLine) || endLine < 0) {
    throw evidenceError(`finding[${index}] line numbers must be non-negative integers`, { jsonPointer: `/findings/${index}` });
  }
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `finding-${String(index + 1).padStart(4, '0')}`,
    path: file,
    startLine,
    endLine,
    content: raw.content,
    category: typeof raw.category === 'string' && raw.category ? raw.category : 'other',
    severity: normalizeSeverity(raw.severity),
    requirementId: raw.requirementId ?? raw.requirement_id ?? null,
    existingCode: typeof raw.existing_code === 'string' ? raw.existing_code : typeof raw.existingCode === 'string' ? raw.existingCode : null,
    suggestionCode: typeof raw.suggestion_code === 'string' ? raw.suggestion_code : typeof raw.suggestionCode === 'string' ? raw.suggestionCode : null,
    source: raw.source ?? 'opencodereview',
  };
}

function rawComments(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.comments)) return result.comments;
  if (Array.isArray(result?.findings)) return result.findings;
  if (Array.isArray(result?.results)) return result.results;
  return [];
}

function makeEvidence({ stage, manifest, provider, executed, valid, degraded, reason, findings, source }) {
  const counts = { total: findings.length, blocker: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const result = {
    schemaVersion: STAGE_EVIDENCE_SCHEMA_VERSION,
    kind: 'qgate-stage-review-evidence',
    stage,
    executed,
    valid,
    degraded: Boolean(degraded),
    degradedReason: reason ?? null,
    provider,
    inputFingerprint: manifest.inputFingerprint,
    findings,
    counts,
    summary: emptySummary(executed, valid, counts.blocker),
    source: source ?? null,
    evidence: [{ path: `${STAGE_EVIDENCE_DIR}/${stage}.json`, kind: 'file', excerpt: `stage=${stage} valid=${valid} findings=${counts.total}` }],
  };
  result.evidenceFingerprint = `sha256:${sha256(canonicalJson(result))}`;
  return result;
}

export function normalizeOcrResult({ stage, manifest, result, source = 'external' } = {}) {
  assertStage(stage);
  if (!result || typeof result !== 'object') throw evidenceError('OCR result must be a JSON object', { jsonPointer: '' });
  const findings = rawComments(result).map(normalizeFinding);
  const skipped = result.status === 'skipped';
  return makeEvidence({
    stage,
    manifest,
    provider: result.provider ?? 'opencodereview',
    executed: result.executed !== false && !skipped,
    valid: result.valid !== false && !skipped,
    degraded: Boolean(result.degraded),
    reason: result.degraded_reason ?? result.degradedReason ?? null,
    findings,
    source,
  });
}

export function makeOfflineEvidence({ stage, manifest, reason = 'OFFLINE_FIXTURE' } = {}) {
  return makeEvidence({ stage, manifest, provider: 'deterministic-fixture', executed: true, valid: true, degraded: true, reason, findings: [], source: 'offline' });
}

export function makeInvalidEvidence({ stage, manifest, reason } = {}) {
  return makeEvidence({ stage, manifest, provider: 'unknown', executed: false, valid: false, degraded: true, reason, findings: [], source: 'failure' });
}

export function writeStageEvidence(root, evidence, out = null) {
  const rel = out ? relPath(out) : `${STAGE_EVIDENCE_DIR}/${evidence.stage}.json`;
  if (!rel) throw configError(`evidence output must be project-relative: ${out}`, { jsonPointer: '/out' });
  const abs = path.join(path.resolve(root), rel.split('/').join(path.sep));
  const materialized = {
    ...evidence,
    evidence: [{ path: rel, kind: 'file', excerpt: `stage=${evidence.stage} valid=${evidence.valid} findings=${evidence.counts.total}` }],
  };
  materialized.evidenceFingerprint = `sha256:${sha256(canonicalJson(materialized))}`;
  writeFileAtomic(abs, stringifyJson(materialized));
  Object.assign(evidence, materialized);
  return { path: rel, absolutePath: abs };
}

export function readJsonInput(root, input) {
  const rel = relPath(input);
  if (!rel) throw configError(`result path must be project-relative: ${input}`, { jsonPointer: '/result' });
  const abs = path.join(path.resolve(root), rel.split('/').join(path.sep));
  try {
    return parseJsonText(fs.readFileSync(abs, 'utf8'));
  } catch (error) {
    throw ioError(`cannot read JSON result: ${rel}`, { jsonPointer: '/result', details: [{ jsonPointer: '/result', expected: 'parseable JSON file', actual: rel, message: error.message }] });
  }
}

export function formatStageExplanation(evidence) {
  const lines = [
    `stage=${evidence.stage} executed=${evidence.executed} valid=${evidence.valid} degraded=${evidence.degraded}`,
    `provider=${evidence.provider} findings=${evidence.counts.total} blocker=${evidence.counts.blocker} high=${evidence.counts.high} medium=${evidence.counts.medium} low=${evidence.counts.low}`,
  ];
  if (evidence.degradedReason) lines.push(`degraded_reason=${evidence.degradedReason}`);
  for (const finding of evidence.findings) lines.push(`${finding.severity} ${finding.path}:${finding.startLine} ${finding.content}`);
  return lines.join('\n');
}

export { SAFE_RELS };

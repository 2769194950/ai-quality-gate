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
import { safeExcerpt } from './util/text.mjs';

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

function declaredDiffPaths(root, diff) {
  if (!diff) return [];
  const source = readSource(root, diff);
  if (!source) return [];
  try {
    const parsed = JSON.parse(source.content);
    const entries = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.files) ? parsed.files : [];
    return entries.map((entry) => typeof entry === 'string' ? entry : entry?.path).filter((entry) => typeof entry === 'string');
  } catch {
    return [];
  }
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
    if (diff) paths.push(diff, ...declaredDiffPaths(root, diff));
    else paths.push(...walkFiles(root).filter((file) => /\.(mjs|js|json|md|yaml|yml|ts|tsx|jsx)$/.test(file)).slice(0, 200));
  }
  if (stage === 'verify') {
    paths.push('docs/requirements-index.json', 'verification/trace-matrix.json');
    paths.push(...globList(root, '.qgate/evidence/**/*.json'));
    paths.push(...globList(root, 'verification/evidence/**/*.json'));
    paths.push(...walkFiles(root).filter((file) => /(^|\/)(test|tests|__tests__)\//.test(toPosix(file)) && /\.(mjs|js|cjs|ts|tsx)$/.test(file)));
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

function emptySummary(executed, valid, blockerCount, executionMode = 'offline') {
  return {
    ocrExecuted: executed,
    ocrResultValid: valid,
    ocrNoBlockers: valid && blockerCount === 0,
    ocrLive: executionMode === 'live' && executed && valid,
  };
}

function normalizeSeverity(value) {
  return ['blocker', 'high', 'medium', 'low'].includes(value) ? value : 'medium';
}

function requirementIdsFromManifest(manifest) {
  const source = (manifest.sources ?? []).find((item) => item.path === 'docs/requirements-index.json');
  if (!source) return null;
  try {
    const parsed = JSON.parse(source.content);
    const ids = new Set();
    for (const item of parsed.requirements ?? []) if (item && typeof item.id === 'string') ids.add(item.id);
    return ids;
  } catch {
    throw evidenceError('requirements index in the stage manifest is not valid JSON', { jsonPointer: '/manifest/sources' });
  }
}

function sourcePathsFromManifest(manifest) {
  return new Set((manifest.sources ?? []).map((item) => item.path).filter((item) => typeof item === 'string'));
}

function normalizeFinding(raw, index, { manifest }) {
  if (!raw || typeof raw !== 'object') throw evidenceError(`finding[${index}] must be an object`, { jsonPointer: `/findings/${index}` });
  const file = relPath(raw.path);
  if (!file) throw evidenceError(`finding[${index}] has an invalid project-relative path`, { jsonPointer: `/findings/${index}/path` });
  if (sourcePathsFromManifest(manifest).size > 0 && !sourcePathsFromManifest(manifest).has(file)) {
    throw evidenceError(`finding[${index}] path is outside the stage manifest`, { jsonPointer: `/findings/${index}/path` });
  }
  if (typeof raw.content !== 'string' || raw.content.trim() === '') throw evidenceError(`finding[${index}] content is required`, { jsonPointer: `/findings/${index}/content` });
  const startLine = raw.start_line ?? raw.startLine ?? 0;
  const endLine = raw.end_line ?? raw.endLine ?? startLine;
  if (!Number.isInteger(startLine) || startLine < 0 || !Number.isInteger(endLine) || endLine < 0) {
    throw evidenceError(`finding[${index}] line numbers must be non-negative integers`, { jsonPointer: `/findings/${index}` });
  }
  const requirementId = raw.requirementId ?? raw.requirement_id ?? null;
  const requirementIds = requirementIdsFromManifest(manifest);
  if (requirementId !== null && (!requirementIds || !requirementIds.has(requirementId))) {
    throw evidenceError(`finding[${index}] references an unknown requirementId`, { jsonPointer: `/findings/${index}/requirementId` });
  }
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `finding-${String(index + 1).padStart(4, '0')}`,
    path: file,
    startLine,
    endLine,
    content: safeExcerpt(raw.content),
    category: typeof raw.category === 'string' && raw.category ? safeExcerpt(raw.category, 256) : 'other',
    severity: normalizeSeverity(raw.severity),
    requirementId,
    existingCode: typeof raw.existing_code === 'string' ? safeExcerpt(raw.existing_code) : typeof raw.existingCode === 'string' ? safeExcerpt(raw.existingCode) : null,
    suggestionCode: typeof raw.suggestion_code === 'string' ? safeExcerpt(raw.suggestion_code) : typeof raw.suggestionCode === 'string' ? safeExcerpt(raw.suggestionCode) : null,
    source: typeof raw.source === 'string' ? safeExcerpt(raw.source, 256) : 'opencodereview',
  };
}

function rawComments(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.comments)) return result.comments;
  if (Array.isArray(result?.findings)) return result.findings;
  if (Array.isArray(result?.results)) return result.results;
  return [];
}

function makeEvidence({ stage, manifest, provider, executed, valid, degraded, reason, findings, source, execution = null }) {
  const counts = { total: findings.length, blocker: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const executionMeta = execution ? {
    mode: execution.mode === 'live' ? 'live' : 'offline',
    cliVersion: execution.cliVersion ?? null,
    model: execution.model ?? null,
    endpointHost: execution.endpointHost ?? null,
  } : { mode: 'offline', cliVersion: null, model: null, endpointHost: null };
  const result = {
    schemaVersion: STAGE_EVIDENCE_SCHEMA_VERSION,
    kind: 'qgate-stage-review-evidence',
    stage,
    executed,
    valid,
    degraded: Boolean(degraded),
    degradedReason: reason ?? null,
    provider,
    executionMode: executionMeta.mode,
    cliVersion: executionMeta.cliVersion,
    model: executionMeta.model,
    endpointHost: executionMeta.endpointHost,
    execution: executionMeta,
    inputFingerprint: manifest.inputFingerprint,
    findings,
    counts,
    summary: emptySummary(executed, valid, counts.blocker, execution?.mode ?? 'offline'),
    source: source ?? null,
    evidence: [{ path: `${STAGE_EVIDENCE_DIR}/${stage}.json`, kind: 'file', excerpt: `stage=${stage} valid=${valid} findings=${counts.total}` }],
  };
  result.evidenceFingerprint = `sha256:${sha256(canonicalJson(result))}`;
  return result;
}

export function normalizeOcrResult({ stage, manifest, result, source = 'external' } = {}) {
  assertStage(stage);
  if (!result || typeof result !== 'object') throw evidenceError('OCR result must be a JSON object', { jsonPointer: '' });
  let payload = result;
  let execution = null;
  if (result.kind === 'qgate-ocr-raw-result') {
    if (result.stage !== stage) throw evidenceError(`OCR result stage does not match ${stage}`, { jsonPointer: '/stage' });
    if (result.inputFingerprint !== manifest.inputFingerprint) throw evidenceError('OCR result inputFingerprint does not match the current manifest', { jsonPointer: '/inputFingerprint' });
    if (result.executionMode !== 'live' || result.provider !== 'opencodereview') throw evidenceError('live OCR result envelope is invalid', { jsonPointer: '/executionMode' });
    if (!result.result || typeof result.result !== 'object' || Array.isArray(result.result)) throw evidenceError('live OCR result payload must be an object', { jsonPointer: '/result' });
    payload = result.result;
    execution = {
      mode: 'live',
      cliVersion: result.cliVersion,
      model: result.model,
      endpointHost: result.endpointHost,
    };
  }
  const findings = rawComments(payload).map((item, index) => normalizeFinding(item, index, { manifest }));
  if (execution && !Array.isArray(payload) && !Array.isArray(payload.comments) && !Array.isArray(payload.findings) && !Array.isArray(payload.results)) {
    throw evidenceError('live OCR result has no recognized findings array', { jsonPointer: '/result' });
  }
  const skipped = payload.status === 'skipped';
  return makeEvidence({
    stage,
    manifest,
    provider: execution ? 'opencodereview' : payload.provider ?? 'opencodereview',
    executed: payload.executed !== false && !skipped,
    valid: payload.valid !== false && !skipped,
    degraded: Boolean(payload.degraded),
    reason: payload.degraded_reason ?? payload.degradedReason ?? null,
    findings,
    source,
    execution,
  });
}

export function makeOfflineEvidence({ stage, manifest, reason = 'OFFLINE_FIXTURE' } = {}) {
  return makeEvidence({ stage, manifest, provider: 'deterministic-fixture', executed: true, valid: true, degraded: true, reason, findings: [], source: 'offline', execution: { mode: 'offline' } });
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

// Evidence reference construction and resolution (docs/01-architecture.md §5.3.1, REQ-007).
// Every judgement must carry evidence, and every evidence path must be resolvable.
import path from 'node:path';
import fs from 'node:fs';
import { evidenceKinds } from './contract.mjs';
import { evidenceError } from './errors.mjs';
import { sha256File, fileExists } from './util/fsx.mjs';
import { clip, safeExcerpt, redact } from './util/text.mjs';

/** Build one evidence reference. `excerpt` is always redacted and clipped. */
export function evidence(refPath, kind, excerpt) {
  if (!evidenceKinds.includes(kind)) {
    throw evidenceError(`invalid evidence kind "${kind}"`, {
      details: [{ jsonPointer: '/evidence/kind', expected: evidenceKinds.join('|'), actual: String(kind), message: `evidence.kind must be one of ${evidenceKinds.join('|')}` }],
    });
  }
  if (typeof refPath !== 'string' || refPath.length === 0) {
    throw evidenceError('evidence.path must be a non-empty project-relative POSIX path', {
      details: [{ jsonPointer: '/evidence/path', expected: 'non-empty string', actual: String(refPath), message: 'evidence.path must be a non-empty string' }],
    });
  }
  return { path: refPath.split(path.sep).join('/'), kind, excerpt: safeExcerpt(excerpt) };
}

/** Evidence for a file that is known to exist; excerpt defaults to its sha256. */
export function fileEvidence(root, refPath, excerpt = null) {
  const abs = path.join(root, refPath.split('/').join(path.sep));
  const digest = sha256File(abs);
  const body = excerpt === null ? (digest ? `sha256:${digest}` : 'sha256:unavailable') : excerpt;
  return evidence(refPath, 'file', body);
}

/**
 * Evidence for a path that is **declared but absent** (the failing branch of
 * `file_exists`/`file_not_exists`, a missing `json_assert`/`trace_matrix` target, a
 * declared path whose glob matched nothing). A `kind="file"` reference would dangle
 * — the file is not on disk — so the deciding artefact is the configuration itself
 * and the absent path is carried in the excerpt (REQ-007, §5.3.1: `file` means
 * "an existing file at `path`"; `json_pointer`/`stdout` are inline by contract).
 */
export function missingFileEvidence(configPath, declaredPath, excerpt = null) {
  const declaring = typeof configPath === 'string' && configPath.length > 0 ? configPath : 'qgate.config.json';
  const body = excerpt === null ? `declared path not found: ${declaredPath}` : excerpt;
  return evidence(declaring.split(path.sep).join('/'), 'json_pointer', body);
}

export function stdoutEvidence(refPath, stdout) {
  return evidence(refPath, 'stdout', stdout);
}

export function jsonPointerEvidence(refPath, pointer, excerpt) {
  return evidence(refPath, 'json_pointer', `${pointer}${excerpt ? ` => ${excerpt}` : ''}`);
}

export function ledgerEvidence(refPath = 'verification/evidence/ledger-index.json', excerpt = '') {
  return evidence(refPath, 'ledger', excerpt);
}

export function traceEvidence(refPath, excerpt = '') {
  return evidence(refPath, 'trace', excerpt);
}

/**
 * Resolve an evidence reference against the repository root.
 * `file` kind must point at an existing file; `ledger`/`trace` must parse as JSON
 * and, for ledger kinds, be listed in the ledger index. Throws EVIDENCE_UNRESOLVED.
 */
export function resolveEvidence(root, ref, { ledgerIndex = null } = {}) {
  const abs = path.join(root, ref.path.split('/').join(path.sep));
  if (ref.kind === 'file') {
    if (!fileExists(abs)) {
      throw evidenceError(`evidence path is not resolvable: ${ref.path}`, {
        jsonPointer: '/evidence/path',
        details: [{ jsonPointer: '/evidence/path', expected: 'existing file', actual: ref.path, message: `evidence file does not exist: ${ref.path}` }],
      });
    }
    return { resolved: true, path: ref.path, sha256: sha256File(abs) };
  }
  if (ref.kind === 'ledger' || ref.kind === 'trace') {
    if (!fileExists(abs)) {
      throw evidenceError(`evidence path is not resolvable: ${ref.path}`, {
        jsonPointer: '/evidence/path',
        details: [{ jsonPointer: '/evidence/path', expected: 'existing file', actual: ref.path, message: `evidence file does not exist: ${ref.path}` }],
      });
    }
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (error) {
      throw evidenceError(`evidence file is not parseable JSON: ${ref.path}`, {
        jsonPointer: '/evidence/path',
        details: [{ jsonPointer: '/evidence/path', expected: 'JSON document', actual: error.message, message: `cannot parse ${ref.path}` }],
      });
    }
    if (ref.kind === 'ledger' && ledgerIndex && Array.isArray(ledgerIndex.runIds)) {
      const runId = parsed.runId ?? parsed.run_id ?? null;
      if (runId && !ledgerIndex.runIds.includes(runId)) {
        throw evidenceError(`ledger evidence is not referenced by the ledger index: ${runId}`, {
          jsonPointer: '/evidence/path',
          details: [{ jsonPointer: '/evidence/path', expected: 'runId present in ledger-index.runIds', actual: runId, message: `ledger ${runId} missing from ledger-index.json` }],
        });
      }
    }
    return { resolved: true, path: ref.path, sha256: sha256File(abs) };
  }
  // stdout / json_pointer are inline by nature: the declaring artefact is the run itself.
  return { resolved: true, path: ref.path, sha256: null };
}

/** Resolve every evidence reference of a RunResult; returns the list of failures. */
export function auditEvidence(root, runResult, { ledgerIndex = null } = {}) {
  const failures = [];
  const seen = [];
  for (const gate of runResult.gates ?? []) {
    for (const check of gate.checks ?? []) {
      for (const ref of check.evidence ?? []) {
        seen.push({ gateId: gate.id, checkId: check.id, ref });
      }
    }
    for (const blocker of gate.blockers ?? []) {
      for (const ref of blocker.evidence ?? []) seen.push({ gateId: gate.id, checkId: blocker.checkId, ref });
    }
  }
  for (const item of seen) {
    try {
      resolveEvidence(root, item.ref, { ledgerIndex });
    } catch (error) {
      failures.push({ ...item, code: error.code, message: error.message });
    }
  }
  return { total: seen.length, failures };
}

/** Redact an arbitrary structure (log surface). */
export function redactDeep(value) {
  if (typeof value === 'string') return redact(clip(value));
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = redactDeep(value[key]);
    return out;
  }
  return value;
}

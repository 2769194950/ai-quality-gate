// Append-only evidence ledger + ledger index (§5.3.2, REQ-005).
import path from 'node:path';
import fs from 'node:fs';
import { ledgerSchemaVersion } from './contract.mjs';
import { sha256File, stringifyJson, ensureDir, writeFileAtomic } from './util/fsx.mjs';
import { readJsonFile } from './trace.mjs';

/** Default evidence directory when `policy.evidenceDir` is not overridden. */
export const DEFAULT_EVIDENCE_DIR = 'verification/evidence';
export const LEDGER_INDEX_NAME = 'ledger-index.json';

export function ledgerIndexRelPath(evidenceDir) {
  return `${evidenceDir}/${LEDGER_INDEX_NAME}`.replace(/\/+/g, '/');
}

export function ledgerRelPath(evidenceDir, runId) {
  return `${evidenceDir}/ledger-${runId}.json`.replace(/\/+/g, '/');
}

/** Read the ledger index, tolerating absence (a first run has no index yet). */
export function loadLedgerIndex(root, evidenceDir = DEFAULT_EVIDENCE_DIR) {
  const rel = ledgerIndexRelPath(evidenceDir);
  const parsed = readJsonFile(path.join(root, rel.split('/').join(path.sep)));
  if (!parsed || parsed.__parseError) return null;
  return parsed;
}

/**
 * Recompute the evidence chain described by §5.3.2.
 *
 * The contract states that `ledgers[].sha256` equals the real sha256 of the ledger
 * file, that `runIds` is append-only and that the index names the ledgers of this
 * run. That integrity claim was written down but never executed, so a tampered
 * ledger or index passed unnoticed. This function is the executor: it returns the
 * list of findings, and callers turn a non-empty list into `EVIDENCE_UNRESOLVED`
 * (§6.5) — a failure, never a warning.
 */
export function verifyLedgerChain(root, evidenceDir = DEFAULT_EVIDENCE_DIR, { index = undefined } = {}) {
  const ledgerIndex = index === undefined ? loadLedgerIndex(root, evidenceDir) : index;
  const problems = [];
  if (!ledgerIndex) return { ok: true, checked: 0, problems };

  const dirAbs = path.join(root, evidenceDir.split('/').join(path.sep));
  const ledgers = Array.isArray(ledgerIndex.ledgers) ? ledgerIndex.ledgers : [];
  const runIds = Array.isArray(ledgerIndex.runIds) ? ledgerIndex.runIds : [];

  // 1. every listed ledger exists and its recorded hash matches the real bytes
  for (const entry of ledgers) {
    const rel = typeof entry?.path === 'string' ? entry.path : null;
    if (!rel) {
      problems.push({ kind: 'ledger-path-missing', runId: entry?.runId ?? null, detail: 'ledgers[] entry has no path' });
      continue;
    }
    const abs = path.join(root, rel.split('/').join(path.sep));
    const actual = sha256File(abs);
    if (actual === null) {
      problems.push({ kind: 'ledger-file-missing', runId: entry.runId ?? null, path: rel, detail: `ledger file does not exist: ${rel}` });
      continue;
    }
    if (typeof entry.sha256 !== 'string' || entry.sha256.length === 0) {
      problems.push({ kind: 'ledger-sha-missing', runId: entry.runId ?? null, path: rel, detail: `ledgers[] entry for ${rel} carries no sha256` });
      continue;
    }
    if (entry.sha256 !== actual) {
      problems.push({
        kind: 'ledger-sha-mismatch',
        runId: entry.runId ?? null,
        path: rel,
        detail: `ledger ${rel} has been modified: recorded sha256=${entry.sha256.slice(0, 16)}… but the file hashes to ${actual.slice(0, 16)}…`,
      });
    }
  }

  // 2. runIds and ledgers[] must describe the same set, without duplicates
  const ledgerRunIds = ledgers.map((entry) => entry?.runId).filter((id) => typeof id === 'string');
  const uniqueRunIds = new Set(runIds);
  if (uniqueRunIds.size !== runIds.length) {
    problems.push({ kind: 'runids-duplicate', detail: 'runIds contains duplicate entries' });
  }
  const missingFromRunIds = ledgerRunIds.filter((id) => !runIds.includes(id));
  if (missingFromRunIds.length > 0) {
    problems.push({ kind: 'runids-mismatch', detail: `runIds is missing ${missingFromRunIds.length} run id(s) present in ledgers[]: ${missingFromRunIds.slice(0, 3).join(', ')}` });
  }
  const missingFromLedgers = runIds.filter((id) => !ledgerRunIds.includes(id));
  if (missingFromLedgers.length > 0) {
    problems.push({ kind: 'ledgers-mismatch', detail: `ledgers[] is missing ${missingFromLedgers.length} run id(s) present in runIds: ${missingFromLedgers.slice(0, 3).join(', ')}` });
  }

  // 3. no unlisted ledger may sit in the evidence directory (a dropped entry hides a run)
  let onDisk = [];
  try {
    onDisk = fs
      .readdirSync(dirAbs)
      .filter((name) => name.startsWith('ledger-') && name.endsWith('.json') && name !== LEDGER_INDEX_NAME)
      .sort();
  } catch {
    onDisk = [];
  }
  const listed = new Set(ledgers.map((entry) => path.basename(String(entry?.path ?? ''))));
  const unlisted = onDisk.filter((name) => !listed.has(name));
  if (unlisted.length > 0) {
    problems.push({ kind: 'ledger-unlisted', detail: `${unlisted.length} ledger file(s) exist in ${evidenceDir} but are not listed in ${LEDGER_INDEX_NAME}: ${unlisted.slice(0, 3).join(', ')}` });
  }

  return { ok: problems.length === 0, checked: ledgers.length, problems };
}

/** The test ids that are actually backed by a ledger entry on disk (not just claimed). */
export function evidencedTestIds(root, evidenceDir = DEFAULT_EVIDENCE_DIR, index = undefined) {
  const ledgerIndex = index === undefined ? loadLedgerIndex(root, evidenceDir) : index;
  const ids = new Set();
  if (!ledgerIndex) return ids;
  for (const entry of Array.isArray(ledgerIndex.ledgers) ? ledgerIndex.ledgers : []) {
    const rel = typeof entry?.path === 'string' ? entry.path : null;
    if (!rel) continue;
    const ledger = readJsonFile(path.join(root, rel.split('/').join(path.sep)));
    if (!ledger || ledger.__parseError || !Array.isArray(ledger.entries)) continue;
    for (const item of ledger.entries) {
      if (typeof item?.testId === 'string' && item.testId.length > 0) ids.add(item.testId);
    }
  }
  return ids;
}

/**
 * Append one ledger file. Append-only semantics: an existing `run_id` is never
 * overwritten — the file is written with `wx` and a numeric suffix is added on
 * collision (which can only happen for a replayed run id).
 */
export function appendLedger(root, evidenceDir, ledger, { runId } = {}) {
  const dirAbs = path.join(root, evidenceDir.split('/').join(path.sep));
  ensureDir(dirAbs);
  const id = runId ?? ledger.runId;
  let attempt = 0;
  for (;;) {
    const name = attempt === 0 ? `ledger-${id}.json` : `ledger-${id}-${attempt}.json`;
    const abs = path.join(dirAbs, name);
    try {
      fs.writeFileSync(abs, stringifyJson(ledger), { flag: 'wx' });
      return { relPath: `${evidenceDir}/${name}`.replace(/\/+/g, '/'), absPath: abs, created: attempt === 0 };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      attempt += 1;
      if (attempt > 9999) throw error;
    }
  }
}

/**
 * Atomically update the ledger index: runIds append-only (write order),
 * `sha256` recomputed from the real file, `testIds` the sorted de-duplicated set
 * of every ledger entry testId.
 */
export function updateLedgerIndex(root, evidenceDir, { runId, startedAt, overallPassed, ledgerRelPath: relPath, ledgerAbsPath, testIds, updatedAt }) {
  const existing = loadLedgerIndex(root, evidenceDir) ?? {
    schemaVersion: ledgerSchemaVersion,
    updated_at: updatedAt,
    runIds: [],
    ledgers: [],
    testIds: [],
  };
  const runIds = Array.isArray(existing.runIds) ? [...existing.runIds] : [];
  if (!runIds.includes(runId)) runIds.push(runId);
  const ledgers = Array.isArray(existing.ledgers) ? existing.ledgers.filter((l) => l.runId !== runId) : [];
  ledgers.push({
    runId,
    path: relPath,
    sha256: sha256File(ledgerAbsPath),
    overall_passed: overallPassed,
    started_at: startedAt,
  });
  const mergedTestIds = new Set([...(Array.isArray(existing.testIds) ? existing.testIds : []), ...testIds]);
  const index = {
    schemaVersion: ledgerSchemaVersion,
    updated_at: updatedAt,
    runIds,
    ledgers,
    testIds: [...mergedTestIds].sort(),
  };
  const abs = path.join(root, ledgerIndexRelPath(evidenceDir).split('/').join(path.sep));
  writeFileAtomic(abs, stringifyJson(index));
  return { index, absPath: abs, relPath: ledgerIndexRelPath(evidenceDir) };
}

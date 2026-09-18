// T-QG-007 — REQ-QUALITY-GATE-007: every evidence reference must resolve, and an
// unresolvable one must be an explicit `EVIDENCE_UNRESOLVED` failure (§6.5), never a
// silent pass.
//
// The tests below exercise the **existing** implementation (src/evidence.mjs, the CLI's
// `explain` path, the seven check executors); no new semantics are invented here.
// Dangling forms covered — at least two, as the requirement demands:
//   1. a `kind="file"` reference whose path does not exist on disk;
//   2. a reference whose file existed when the run was recorded and was deleted
//      afterwards (the `verification/trace-matrix.json` / ledger situation);
//   3. a reference of kind `ledger`/`trace` pointing at a path that is not there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_CONFIG, REPO_ROOT, runCliJson, tmpDir, writeJson, writeText, cleanup } from './helpers.mjs';
import { resolveEvidence, auditEvidence, evidence } from '../src/evidence.mjs';
import { loadConfig } from '../src/config.mjs';
import { runPipeline } from '../src/core.mjs';

/** Every evidence reference a RunResult carries, with its owner. */
function collectEvidence(runResult) {
  const refs = [];
  for (const gate of runResult.gates ?? []) {
    for (const check of gate.checks ?? []) {
      for (const ref of check.evidence ?? []) refs.push({ owner: `check:${check.id}`, ref });
    }
    for (const blocker of gate.blockers ?? []) {
      for (const ref of blocker.evidence ?? []) refs.push({ owner: `blocker:${blocker.checkId}`, ref });
    }
  }
  return refs;
}

/** A reference resolves iff its path exists (only `file`/`ledger`/`trace` name files). */
function isResolvable(root, ref) {
  if (ref.kind !== 'file' && ref.kind !== 'ledger' && ref.kind !== 'trace') return true;
  return fs.existsSync(path.join(root, ref.path.split('/').join(path.sep)));
}

/** Run one gate containing a single check against a throwaway project root. */
async function runSingleCheckGate(check, files = {}, extraConfig = {}) {
  const root = tmpDir('qgate-evidence-');
  for (const [rel, body] of Object.entries(files)) writeText(path.join(root, rel.split('/').join(path.sep)), body);
  const configPath = path.join(root, 'qgate.config.json');
  writeJson(configPath, {
    version: '1.0',
    provider: { type: 'deterministic' },
    ...extraConfig,
    gates: [{ id: 'gate-one', stage: 'build', required: true, checks: [check] }],
  });
  const loaded = loadConfig(configPath, { cwd: root });
  const outcome = await runPipeline(loaded, { writeLedger: false });
  return { root, ...outcome };
}

test('T-QG-007 a kind="file" reference to a missing path raises EVIDENCE_UNRESOLVED', (t) => {
  const root = tmpDir('qgate-evd-');
  t.after(() => cleanup(root));
  writeText(path.join(root, 'present.txt'), 'x\n');

  const okRef = evidence('present.txt', 'file', 'exists');
  const ok = resolveEvidence(root, okRef);
  assert.equal(ok.resolved, true);
  assert.match(ok.sha256, /^[0-9a-f]{64}$/);

  const dangling = evidence('missing.txt', 'file', 'was here once');
  assert.throws(
    () => resolveEvidence(root, dangling),
    (error) => error.code === 'EVIDENCE_UNRESOLVED' && /missing\.txt/.test(error.message),
    'a missing file must be an explicit EVIDENCE_UNRESOLVED, not a silent pass',
  );
});

test('T-QG-007 dangling form 3: a ledger/trace reference to a path that is not there', (t) => {
  const root = tmpDir('qgate-evd-');
  t.after(() => cleanup(root));
  writeText(path.join(root, '.gitkeep'), '');

  for (const ref of [
    evidence('verification/trace-matrix.json', 'trace', '/requirements/0'),
    evidence('verification/evidence/ledger-2.json', 'ledger', 'runId=x'),
  ]) {
    assert.throws(
      () => resolveEvidence(root, ref),
      (error) => error.code === 'EVIDENCE_UNRESOLVED' && error.message.includes(ref.path),
      `${ref.kind} reference must fail loudly`,
    );
  }

  // A ledger that exists but is absent from the ledger index is also unresolved.
  writeJson(path.join(root, 'verification/evidence/ledger-abc.json'), { runId: 'run-abc', overall_passed: true });
  assert.throws(
    () => resolveEvidence(root, evidence('verification/evidence/ledger-abc.json', 'ledger', 'runId=run-abc'), { ledgerIndex: { runIds: [] } }),
    (error) => error.code === 'EVIDENCE_UNRESOLVED' && /run-abc/.test(error.message),
  );

  // Inline kinds (`stdout`, `json_pointer`) are declared by the run itself and need no file.
  assert.equal(resolveEvidence(root, evidence('qgate.config.json', 'json_pointer', '/gates/0')).resolved, true);
  assert.equal(resolveEvidence(root, evidence('qgate.config.json', 'stdout', 'exitCode=0')).resolved, true);
});

test('T-QG-007 no check type may emit a dangling file reference, pass or fail', async () => {
  // Each case is deliberately built to make its check FAIL, so the failure branches —
  // where an implementation is tempted to point at a file that is not there — are what
  // these assertions cover. A dangling reference is detected exactly as the contract
  // says it must be: through resolveEvidence (EVIDENCE_UNRESOLVED).
  const cases = [
    { id: 'file-exists-missing', check: { id: 'check-one', type: 'file_exists', required: true, file: 'docs/absent.md' } },
    { id: 'file-not-exists-present', check: { id: 'check-one', type: 'file_not_exists', required: true, file: '*.txt' }, files: { 'drop.txt': 'x\n' } },
    {
      id: 'regex-no-match',
      check: { id: 'check-one', type: 'regex', required: true, files: ['notes.txt', 'absent/*.md'], pattern: 'NEVER_MATCHES_XYZ', mode: 'count', minMatches: 1 },
      files: { 'notes.txt': 'hello\n' },
    },
    { id: 'command-nonzero', check: { id: 'check-one', type: 'command', required: true, run: [process.execPath, '-e', 'process.exit(7)'], expectExitCode: 0 } },
    { id: 'json-assert-missing', check: { id: 'check-one', type: 'json_assert', required: true, file: 'docs/absent.json', assertions: [{ pointer: '/x', exists: true }] } },
    { id: 'json-assert-malformed', check: { id: 'check-one', type: 'json_assert', required: true, file: 'bad.json', assertions: [{ pointer: '/x', exists: true }] }, files: { 'bad.json': '{ not json' } },
    {
      id: 'trace-matrix-missing',
      check: { id: 'check-one', type: 'trace_matrix', required: true, requirementsFile: 'docs/absent-index.json', traceFile: 'missing/trace.json', enforce: 'strict' },
    },
    {
      id: 'policy-violation',
      check: { id: 'check-one', type: 'policy', required: true, policyId: 'SAFE_001', onFail: 'fail' },
      files: { 'src/app.mjs': 'export const key = process.env.SERVICE_SECRET_KEY;\n' },
      config: { policy: { scanRoots: ['src'] } },
    },
  ];

  for (const item of cases) {
    const { root, runResult } = await runSingleCheckGate(item.check, item.files ?? {}, item.config ?? {});
    try {
      assert.equal(runResult.overall_passed, false, `${item.id}: the case must fail so its failure branch is covered`);
      const refs = collectEvidence(runResult);
      assert.ok(refs.length > 0, `${item.id}: every judgement carries evidence`);
      const dangling = refs.filter(({ ref }) => !isResolvable(root, ref));
      assert.deepEqual(dangling, [], `${item.id}: dangling evidence reference(s)`);
      assert.deepEqual(auditEvidence(root, runResult).failures, [], `${item.id}: auditEvidence`);
      // ...and the resolver itself agrees the references are resolvable.
      for (const { ref } of refs) assert.equal(resolveEvidence(root, ref).resolved, true, `${item.id}: ${ref.kind} ${ref.path}`);
    } finally {
      cleanup(root);
    }
  }
});

test('T-QG-007 dangling form 2: a reference whose file is deleted after the run is detected', async () => {
  // Self-contained: the recorded run resolves, then the artefact it points at is
  // removed — the "trace matrix / ledger reference outlives its file" situation.
  const { root, runResult } = await runSingleCheckGate({ id: 'check-one', type: 'file_exists', required: true, file: 'present.txt' }, { 'present.txt': 'x\n' });
  try {
    assert.equal(runResult.overall_passed, true);
    const fileRefs = collectEvidence(runResult).filter(({ ref }) => ref.kind === 'file');
    assert.ok(fileRefs.length >= 1);
    assert.ok(fileRefs.every(({ ref }) => ref.path === 'present.txt'), 'the run references the matched file');
    assert.deepEqual(auditEvidence(root, runResult).failures, [], 'healthy state: every reference resolves');

    fs.rmSync(path.join(root, 'present.txt'));

    const audit = auditEvidence(root, runResult);
    assert.equal(audit.failures.length, fileRefs.length);
    assert.ok(audit.failures.length >= 1);
    for (const failure of audit.failures) {
      assert.equal(failure.code, 'EVIDENCE_UNRESOLVED');
      assert.equal(failure.ref.path, 'present.txt');
    }
    assert.throws(() => resolveEvidence(root, fileRefs[0].ref), (error) => error.code === 'EVIDENCE_UNRESOLVED');
  } finally {
    cleanup(root);
  }
});

test('T-QG-007 the shipped demo and root configurations emit only resolvable references', async () => {
  // Regression guard for the policy scan surface: it can sit *above* a nested
  // `projectRoot` (the demo scans the repository implementation surface from
  // demo/mini-service), and such references must still resolve against the project root.
  for (const configPath of [DEMO_CONFIG, path.join(REPO_ROOT, 'qgate.config.json')]) {
    const loaded = loadConfig(configPath, { cwd: REPO_ROOT });
    const { runResult } = await runPipeline(loaded, { writeLedger: false });
    const refs = collectEvidence(runResult);
    assert.ok(refs.length > 0, `${configPath} produced evidence`);
    assert.deepEqual(auditEvidence(loaded.root, runResult).failures, [], `${configPath} has dangling evidence`);
    for (const { ref } of refs) {
      assert.equal(resolveEvidence(loaded.root, ref).resolved, true, `${configPath}: ${ref.kind} ${ref.path}`);
    }
    if (configPath === DEMO_CONFIG) {
      const escaping = refs.filter(({ ref }) => ref.kind === 'file' && ref.path.startsWith('..'));
      assert.ok(escaping.length >= 1, 'repository-level policy scans are referenced project-relative');
      for (const { ref } of escaping) {
        assert.equal(fs.existsSync(path.join(loaded.root, ref.path.split('/').join(path.sep))), true);
      }
    }
  }
});

test('T-QG-007 `explain` reports a dangling reference as exit 3 / EVIDENCE_UNRESOLVED', async () => {
  const root = tmpDir('qgate-evd-cli-');
  try {
    writeJson(path.join(root, 'qgate.config.json'), {
      version: '1.0',
      provider: { type: 'deterministic' },
      gates: [{ id: 'gate-one', stage: 'build', required: true, checks: [{ id: 'missing-file', type: 'file_exists', required: true, file: 'docs/absent.md' }] }],
    });
    const explained = await runCliJson(['explain', '--config', path.join(root, 'qgate.config.json'), '--check', 'missing-file', '--json'], { cwd: root, strict: false });
    // Either the evidence resolves (exit 0) or the dangling reference is reported as
    // EVIDENCE_UNRESOLVED (exit 3) — never a silent 0 carrying broken evidence.
    if (explained.status !== 0) {
      assert.equal(explained.status, 3, explained.stderr);
      assert.equal(explained.json.error.code, 'EVIDENCE_UNRESOLVED');
    } else {
      for (const ref of (explained.json.evidence ?? []).filter((ref) => ref.kind === 'file')) {
        assert.equal(fs.existsSync(path.join(root, ref.path.split('/').join(path.sep))), true, `explain returned a dangling reference: ${ref.path}`);
      }
    }
  } finally {
    cleanup(root);
  }
});

test('T-QG-007 the audit is not vacuous: an injected dangling reference is detected', async () => {
  const { root, runResult } = await runSingleCheckGate({ id: 'present-file', type: 'file_exists', required: true, file: 'present.txt' }, { 'present.txt': 'x\n' });
  try {
    assert.equal(runResult.overall_passed, true);
    assert.deepEqual(auditEvidence(root, runResult).failures, [], 'the healthy run resolves');

    // Inject the defect the test is supposed to catch: one reference now points nowhere.
    const broken = JSON.parse(JSON.stringify(runResult));
    broken.gates[0].checks[0].evidence = [evidence('docs/absent.md', 'file', 'injected')];
    const audit = auditEvidence(root, broken);
    assert.equal(audit.failures.length, 1, 'the audit must detect the injected dangling reference');
    assert.equal(audit.failures[0].code, 'EVIDENCE_UNRESOLVED');
  } finally {
    cleanup(root);
  }
});

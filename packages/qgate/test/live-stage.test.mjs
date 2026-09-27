import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { REPO_ROOT, tmpDir, cleanup } from './helpers.mjs';
import { initialize, prepare, ingest, build, finish, assertPrerequisites, contextsFor } from '../../../tools/ci/live-stage.mjs';
import { buildStageManifest } from '../src/stage-review.mjs';
import { buildOcrArgs } from '../../../adapters/opencodereview/bin/ocr-stage-review.mjs';

const AI = '.qgate/evidence/ai';
const TMP = '.qgate/tmp/ocr';
const env = { GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1' };
const read = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
function put(root, rel, data) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), typeof data === 'string' ? data : JSON.stringify(data));
}
function fixture(t) {
  const root = tmpDir('live-sequence-');
  t.after(() => cleanup(root));
  for (const rel of ['packages/qgate/src', 'packages/qgate/bin', 'packages/qgate/gates', 'schemas']) {
    fs.cpSync(path.join(REPO_ROOT, rel), path.join(root, rel), { recursive: true });
  }
  put(root, 'input.txt', 'baseline');
  put(root, 'docs/00-requirements.md', 'requirements');
  put(root, 'docs/01-architecture.md', 'architecture');
  put(root, 'docs/requirements-index.json', { schemaVersion: '1.0', requirements: [] });
  put(root, 'package.json', { type: 'module' });
  put(root, 'packages/qgate/test/run-all.mjs', 'console.log("tests actually ran");');
  put(root, 'adapters/opencodereview/tools/run-tests.mjs', 'console.log("adapter tests actually ran");');
  const gates = [];
  for (const stage of ['requirements', 'design', 'build', 'review', 'verify']) {
    gates.push({ id: `${stage}-files`, stage, required: true, checks: [{ id: `${stage}-file`, type: 'file_exists', file: 'input.txt', required: true }] });
    gates.push({ id: `ai-${stage}-evidence`, stage, required: true, checks: [{ id: `${stage}-valid`, type: 'json_assert', file: `${AI}/${stage}.json`, required: true, assertions: [{ pointer: '/summary/ocrResultValid', equals: true }] }] });
  }
  gates.push({ id: 'verify-trace', stage: 'verify', required: true, checks: [{ id: 'test-trace', type: 'trace_matrix', requirementsFile: 'docs/requirements-index.json', traceFile: 'verification/trace-matrix.json', enforce: 'strict', testIdSource: 'trace-only', required: true }] });
  put(root, 'qgate.config.json', { version: '1.0', provider: { type: 'deterministic' }, policy: { evidenceDir: 'verification/evidence', reportDir: 'verification/reports' }, gates });
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return root;
}
function fakeResult(root, stage, { fingerprint = null, comments = [] } = {}) {
  const manifest = read(root, `${TMP}/${stage}.manifest.json`);
  const count = read(root, `${TMP}/${stage}.batches.json`).count;
  const raw = {
    kind: 'qgate-ocr-raw-result', stage, inputFingerprint: fingerprint ?? manifest.inputFingerprint,
    executionMode: 'live', provider: 'opencodereview', cliVersion: '1.12.8', model: 'fixture-model', endpointHost: 'fixture.invalid', result: { comments },
  };
  put(root, `${TMP}/${stage}.raw.json`, Array.from({ length: count }, () => raw));
}
async function review(root, stage) {
  prepare(root, stage, env);
  fakeResult(root, stage);
  await ingest(root, stage, env);
}

test('all stages consume current evidence; verify excludes its own output and survives final ledger append', async (t) => {
  const root = fixture(t);
  initialize(root, 'all', env);
  await review(root, 'requirements');
  await review(root, 'design');
  const design = read(root, `${TMP}/design.manifest.json`);
  assert.ok(design.sources.some((s) => s.path === `${AI}/requirements.json`));
  build(root, env);
  await review(root, 'review');
  const reviewManifest = read(root, `${TMP}/review.manifest.json`);
  assert.ok(reviewManifest.sources.some((s) => s.path === `${AI}/build-tests.json`));
  put(root, `${AI}/verify.json`, { old: 'must not be read' });
  prepare(root, 'verify', env);
  const manifest = read(root, `${TMP}/verify.manifest.json`);
  for (const stage of ['requirements', 'design', 'build', 'review']) {
    const source = manifest.sources.find((s) => s.path === `${AI}/${stage}.json`);
    assert.deepEqual(JSON.parse(source.content), read(root, `${AI}/${stage}.json`));
  }
  assert.ok(!manifest.sources.some((s) => s.path === `${AI}/verify.json`));
  assert.ok(manifest.sources.some((s) => s.path.startsWith(`${AI}/verify-inputs/`)));
  fakeResult(root, 'verify');
  await ingest(root, 'verify', env);
  finish(root, env);
  const after = buildStageManifest({ stage: 'verify', root, configPath: path.join(root, 'qgate.config.json') });
  assert.equal(after.inputFingerprint, manifest.inputFingerprint);
  assert.equal(read(root, `${AI}/live-run.json`).completed, true);
});

test('changed input, wrong fingerprints and failed prior gates cannot advance the chain', async (t) => {
  const root = fixture(t);
  initialize(root, 'all', env);
  assert.throws(() => prepare(root, 'design', env), /Missing current requirements/);
  prepare(root, 'requirements', env);
  fakeResult(root, 'requirements');
  put(root, 'docs/00-requirements.md', 'changed after model call');
  await assert.rejects(ingest(root, 'requirements', env), /input changed/);
  assert.equal(read(root, `${AI}/requirements.json`).valid, false);
  assert.equal(fs.existsSync(path.join(root, `${TMP}/requirements.raw.json`)), false);
  prepare(root, 'requirements', env);
  fakeResult(root, 'requirements', { fingerprint: 'sha256:' + '0'.repeat(64) });
  await assert.rejects(ingest(root, 'requirements', env), /inputFingerprint/);
  prepare(root, 'requirements', env);
  fakeResult(root, 'requirements');
  fs.unlinkSync(path.join(root, 'input.txt'));
  await assert.rejects(ingest(root, 'requirements', env), /failed/);
  assert.throws(() => prepare(root, 'design', env), /Missing current requirements/);
});

test('stale commit, changed upstream evidence and offline placeholders cannot certify prerequisites', async (t) => {
  const root = fixture(t);
  initialize(root, 'all', env);
  await review(root, 'requirements');
  const state = read(root, `${AI}/live-run.json`);
  assert.throws(() => assertPrerequisites(root, { ...state, commit: '0'.repeat(40) }, 'design'), /Missing current/);
  const evidence = read(root, `${AI}/requirements.json`);
  put(root, `${AI}/requirements.json`, { ...evidence, executionMode: 'offline' });
  assert.throws(() => prepare(root, 'design', env), /Changed requirements evidence/);
  assert.throws(() => initialize(root, 'verify', { ...env, GITHUB_RUN_ID: '101' }), /different commit or run/);
});

test('single-stage review stays partial and does not invent upstream evidence; missing verify prerequisites fail', async (t) => {
  const root = fixture(t);
  initialize(root, 'review', env);
  await review(root, 'review');
  finish(root, env);
  assert.equal(read(root, `${AI}/live-run.json`).scope, 'partial');
  assert.equal(fs.existsSync(path.join(root, `${AI}/requirements.json`)), false);
  assert.throws(() => initialize(root, 'verify', env), /Missing current/);
});

test('context batches retain complete dependency content and scan receives background', (t) => {
  const root = fixture(t);
  const content = 'evidence '.repeat(2400) + 'END-OF-EVIDENCE';
  const manifest = { stage: 'verify', purpose: 'verify evidence', inputFingerprint: 'sha256:test', sources: [{ path: `${AI}/design.json`, content }] };
  const batches = contextsFor(manifest);
  assert.ok(batches.length > 1);
  assert.ok(batches.every((body) => body.length <= 7000));
  assert.ok(batches.at(-1).includes('END-OF-EVIDENCE'));
  assert.throws(() => contextsFor({ ...manifest, sources: [{ path: `${AI}/design.json`, content: 'x '.repeat(150000) }] }), /limit is/);
  put(root, 'paths.json', { files: [{ path: 'input.txt' }] });
  put(root, 'background.md', 'stage-specific instruction');
  const args = buildOcrArgs({ root, diff: 'paths.json', backgroundFile: path.join(root, 'background.md') });
  assert.equal(args[0], 'scan');
  assert.equal(args[args.indexOf('--background') + 1], 'stage-specific instruction');
});

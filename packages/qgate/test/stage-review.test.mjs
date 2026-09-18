import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildStageManifest, normalizeOcrResult } from '../src/stage-review.mjs';
import { runCliJson, tmpDir, writeJson, cleanup } from './helpers.mjs';

test('stage review produces deterministic offline evidence for every frozen stage', async (t) => {
  const root = tmpDir('qgate-stage-');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', '00-requirements.md'), '# requirements\n');
  fs.writeFileSync(path.join(root, 'docs', '01-architecture.md'), '# design\n');
  fs.writeFileSync(path.join(root, 'docs', 'requirements-index.json'), '{"requirements":[]}\n');

  const first = await runCliJson(['stage', 'requirements', 'review', '--mode', 'offline', '--root', root, '--json']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.stage, 'requirements');
  assert.equal(first.json.valid, true);
  assert.equal(first.json.summary.ocrNoBlockers, true);
  assert.match(first.json.inputFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(path.join(root, '.qgate/evidence/ai/requirements.json')), true);

  const stages = ['requirements', 'design', 'build', 'review', 'verify'];
  for (const stage of stages) {
    const result = await runCliJson(['stage', stage, 'review', '--mode', 'offline', '--root', root, '--json']);
    assert.equal(result.status, 0, `${stage}: ${result.stderr}`);
    assert.equal(result.json.stage, stage);
    assert.equal(result.json.valid, true);
  }
});

test('stage ingest normalizes OpenCodeReview comments and preserves suggestion fields', async (t) => {
  const root = tmpDir('qgate-stage-ingest-');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', '00-requirements.md'), '# requirements\n');
  const resultPath = path.join(root, 'ocr.json');
  writeJson(resultPath, {
    status: 'completed',
    comments: [{
      path: 'src/auth.mjs',
      start_line: 42,
      end_line: 43,
      content: '权限检查缺失。',
      category: 'security',
      severity: 'high',
      requirement_id: 'REQ-AUTH-001',
      existing_code: 'return data;',
      suggestion_code: 'return authorize(data);',
    }],
  });
  const result = await runCliJson(['stage', 'review', 'ingest', '--root', root, '--result', 'ocr.json', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.counts.high, 1);
  assert.equal(result.json.summary.ocrNoBlockers, true, 'high findings are advisory in v1');
  assert.equal(result.json.findings[0].requirementId, 'REQ-AUTH-001');
  assert.equal(result.json.findings[0].suggestionCode, 'return authorize(data);');
});

test('stage ingest fails closed for invalid paths and writes invalid evidence', async (t) => {
  const root = tmpDir('qgate-stage-invalid-');
  t.after(() => cleanup(root));
  writeJson(path.join(root, 'ocr.json'), { comments: [{ path: '../secret.txt', content: 'bad', severity: 'blocker' }] });
  const result = await runCliJson(['stage', 'review', 'ingest', '--root', root, '--result', 'ocr.json', '--json'], { strict: false });
  assert.equal(result.status, 3);
  assert.equal(result.json.error.code, 'EVIDENCE_UNRESOLVED');
  const evidence = JSON.parse(fs.readFileSync(path.join(root, '.qgate/evidence/ai/review.json'), 'utf8'));
  assert.equal(evidence.valid, false);
  assert.equal(evidence.summary.ocrNoBlockers, false);
});

test('stage manifests are stable for the same inputs', (t) => {
  const root = tmpDir('qgate-stage-manifest-');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', '00-requirements.md'), '# requirements\n');
  const one = buildStageManifest({ stage: 'requirements', root });
  const two = buildStageManifest({ stage: 'requirements', root });
  assert.deepEqual(one, two);
  const evidence = normalizeOcrResult({ stage: 'requirements', manifest: one, result: { comments: [] } });
  assert.equal(evidence.summary.ocrNoBlockers, true);
});

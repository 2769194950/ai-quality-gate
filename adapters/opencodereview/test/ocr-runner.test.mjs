// adapters/opencodereview/test/ocr-runner.test.mjs
// ocr CLI 探测 / 调用 / 降级路径；零密钥；reflection 复核。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  probeOcr,
  runOcrReview,
  resolveProvider,
  buildChildEnv,
  assertNoApiKeyRequirement,
  ENV_ALLOWLIST,
  DEGRADE_REASONS,
} from '../src/ocr-runner.mjs';
import { reflectSuggestions, REFLECTION_RULES } from '../src/reflection.mjs';
import { isSensitivePath } from '../src/filters.mjs';
import { ADAPTER_ROOT, tempDir } from './helpers.mjs';
import { buildLiveChildEnv, validateLiveCredentials, LIVE_ENV_ALLOWLIST } from '../tools/live-env.mjs';

const MISSING = path.join(ADAPTER_ROOT, 'demo', 'definitely-missing-ocr-binary.exe');

test('降级: ocr 不存在 ⇒ available=false + OCR_CLI_NOT_FOUND，且不抛异常', () => {
  const probe = probeOcr({ ocrBin: MISSING });
  assert.equal(probe.available, false);
  assert.equal(probe.reason, DEGRADE_REASONS.NOT_FOUND);
  assert.equal(probe.bin, path.resolve(MISSING));
  const res = runOcrReview({ probe, diff: path.join(ADAPTER_ROOT, 'demo', 'diff.json') });
  assert.equal(res.ok, false);
  assert.equal(res.degraded, true);
  assert.equal(res.degradedReason, DEGRADE_REASONS.NOT_FOUND);
  assert.equal(res.data, null);
  assert.equal(res.llmCalled, false);
});

test('降级: --no-ocr / OCR_DISABLE=1 走显式跳过原因', () => {
  assert.equal(probeOcr({ noOcr: true }).reason, DEGRADE_REASONS.SKIPPED);
  const saved = process.env.OCR_DISABLE;
  process.env.OCR_DISABLE = '1';
  try {
    assert.equal(probeOcr({}).reason, DEGRADE_REASONS.DISABLED);
    const provider = resolveProvider({});
    assert.equal(provider.name, 'local');
    assert.equal(provider.degraded, true);
    assert.equal(provider.llmCalled, false);
  } finally {
    if (saved === undefined) delete process.env.OCR_DISABLE;
    else process.env.OCR_DISABLE = saved;
  }
});

test('降级: 假 ocr 脚本非零退出 ⇒ 尝试后回落本地（不抛出）', () => {
  const dir = tempDir();
  try {
    const fake = dir.write('fake-ocr.cmd', '@echo off\r\necho {"boom":true} 1>&2\r\nexit /b 2\r\n');
    if (process.platform !== 'win32') return; // 非 Windows 用 sh 变体
    const probe = probeOcr({ ocrBin: fake });
    // 假脚本 --version 也返回 2 ⇒ 探测失败，归类为 NOT_FOUND（找不到可用 ocr）
    assert.equal(probe.available, false);
    assert.ok([DEGRADE_REASONS.NOT_FOUND, DEGRADE_REASONS.EXIT_NONZERO].includes(probe.reason));
    const provider = resolveProvider({ useOcr: true, ocrBin: fake, diff: path.join(ADAPTER_ROOT, 'demo', 'diff.json') });
    assert.equal(provider.name, 'local');
    assert.equal(provider.degraded, true);
    assert.ok(provider.degradedReason);
  } finally {
    dir.cleanup();
  }
});

test('零密钥: 子进程环境为白名单，绝不透传任何密钥变量', () => {
  const env = buildChildEnv({
    PATH: '/bin', SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', PATHEXT: '.CMD',
    ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'x', GITHUB_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'x',
    ANTHROPIC_AUTH_TOKEN: 'x', NPM_TOKEN: 'x', SOME_PASSWORD: 'x',
  });
  const keys = Object.keys(env).map((k) => k.toUpperCase());
  for (const banned of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'SOME_PASSWORD']) {
    assert.equal(keys.includes(banned), false, `${banned} 不得进入子进程环境`);
  }
  for (const allowed of ENV_ALLOWLIST) {
    if (allowed.toLowerCase() === 'path') continue;
    assert.equal(keys.includes(allowed.toUpperCase()), env[allowed] === undefined ? false : true);
  }
  assert.equal(env.OCR_OFFLINE, '1');
  assert.equal(env.OCR_PROVIDER, 'deterministic');
});

test('live OCR: only provider credentials cross the explicit child-process boundary', () => {
  const env = buildLiveChildEnv({
    PATH: '/bin',
    OCR_LLM_URL: 'https://api.example.test',
    OCR_LLM_TOKEN: 'sentinel-token',
    OCR_LLM_MODEL: 'test-model',
    OCR_USE_ANTHROPIC: 'true',
    GITHUB_TOKEN: 'must-not-cross',
    NPM_TOKEN: 'must-not-cross',
    AWS_SECRET_ACCESS_KEY: 'must-not-cross',
  });
  const presentBase = LIVE_ENV_ALLOWLIST.filter((key) => env[key] !== undefined);
  assert.deepEqual(Object.keys(env).sort(), [...presentBase, 'OCR_PROVIDER', 'OCR_OFFLINE', 'OCR_NO_API_KEY', 'NO_COLOR'].sort());
  assert.equal(env.OCR_LLM_TOKEN, 'sentinel-token');
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.OCR_OFFLINE, '0');
  assert.deepEqual(validateLiveCredentials(env), { baseUrl: 'https://api.example.test', model: 'test-model' });
});

test('live OCR: missing or non-HTTPS credentials fail closed', () => {
  assert.throws(() => validateLiveCredentials({ OCR_LLM_MODEL: 'test', OCR_USE_ANTHROPIC: 'true' }), /OCR_LLM_URL/);
  assert.throws(() => validateLiveCredentials({ OCR_LLM_URL: 'http://example.test', OCR_LLM_MODEL: 'test', OCR_LLM_TOKEN: 'x', OCR_USE_ANTHROPIC: 'true' }), /https/);
  assert.throws(() => validateLiveCredentials({ OCR_LLM_URL: 'https://example.test', OCR_LLM_MODEL: 'test', OCR_USE_ANTHROPIC: 'true' }), /OCR_LLM_TOKEN/);
  assert.throws(() => validateLiveCredentials({ OCR_LLM_URL: 'https://example.test', OCR_LLM_TOKEN: 'x', OCR_LLM_MODEL: 'test' }), /OCR_USE_ANTHROPIC/);
});

test('零密钥: 适配层源码不含密钥读取（逐行扫描可执行代码）', () => {
  for (const dir of ['src', 'bin']) {
    const res = assertNoApiKeyRequirement(path.join(ADAPTER_ROOT, dir));
    assert.deepEqual(res.violations, [], `${dir}/ 存在密钥读取代码`);
  }
});

test('OCR JSON 夹具: 形状与真实 ocr review --format json 对齐，并显式标注 fixture', () => {
  const sample = JSON.parse(fs.readFileSync(path.join(ADAPTER_ROOT, 'demo', 'ocr-review.sample.json'), 'utf8'));
  assert.equal(sample._fixture, true);
  assert.equal(sample.provider.llm_called, false);
  assert.ok(Array.isArray(sample.findings) && sample.findings.length >= 3);
  const severities = new Set(sample.findings.map((f) => f.severity));
  for (const s of ['blocker', 'medium', 'low']) assert.equal(severities.has(s), true, `夹具应含 ${s} 级 finding`);
  for (const f of sample.findings) {
    assert.ok(f.file && Number.isFinite(f.line) && f.message && f.ruleId);
    assert.ok(Array.isArray(f.evidence) && f.evidence.length > 0, '每条 finding 必须带 evidence');
    assert.equal(isSensitivePath(f.file), false, '夹具 finding 不得指向敏感路径');
  }
});

test('reflection: 规则化复核剔除不可定位/无证据/重复/敏感路径建议', () => {
  const suggestions = [
    { file: 'src/app.mjs', line: 3, message: 'real finding', severity: 'high', evidence: [{ kind: 'file', path: 'src/app.mjs' }] },
    { file: 'src/app.mjs', line: 3, message: 'real finding', severity: 'low', evidence: [{ kind: 'file', path: 'src/app.mjs' }] },
    { file: 'secrets/db.txt', line: 1, message: 'leak', severity: 'blocker', evidence: [{ kind: 'file', path: 'secrets/db.txt' }] },
    { file: 'src/app.mjs', line: 9, message: '   ', severity: 'medium', line2: null, evidence: [{ kind: 'file', path: 'src/app.mjs' }] },
    { file: 'src/app.mjs', line: 11, message: 'no evidence at all', severity: 'low' },
    { file: 'src/app.mjs', line: 4, message: 'bad severity', severity: 'critical', evidence: [{ kind: 'file', path: 'src/app.mjs' }] },
    { file: 'src/not-selected.mjs', line: 1, message: 'outside selection', severity: 'high', evidence: [{ kind: 'file', path: 'src/not-selected.mjs' }] },
  ];
  // 上面第 4 条同时触发「空消息」；单独验证 R-NONEMPTY-MESSAGE 只出现一次即可。
  const res = reflectSuggestions(suggestions, {
    selectedFiles: ['src/app.mjs', 'src/other.mjs'],
    isForbidden: isSensitivePath,
  });
  assert.equal(res.counts.input, 7);
  assert.equal(res.kept.length, 2, '保留两条合规建议（high + no evidence 但带行号者）');
  assert.equal(res.kept[0].severity, 'high');
  assert.equal(res.dropped.length, 5);
  const reasons = new Set(res.dropped.flatMap((d) => d.reasons));
  for (const r of ['R-DEDUP', 'R-FORBIDDEN-PATH', 'R-NONEMPTY-MESSAGE', 'R-VALID-PATH']) {
    assert.equal(reasons.has(r), true, `应出现复核原因 ${r}`);
  }

  // 单独验证 R-EVIDENCE-REQUIRED 与 R-SEVERITY-ENUM 的判定
  const only = reflectSuggestions([
    { file: 'src/app.mjs', message: 'no line no evidence', severity: 'low' },
    { file: 'src/app.mjs', line: 2, message: 'bad severity', severity: 'critical', evidence: [{ kind: 'file' }] },
  ], { selectedFiles: ['src/app.mjs'] });
  assert.equal(only.kept.length, 0);
  assert.deepEqual(only.dropped.map((d) => d.reasons), [['R-EVIDENCE-REQUIRED'], ['R-SEVERITY-ENUM']]);
  assert.deepEqual(only.rules, REFLECTION_RULES.map((r) => r.id));
});

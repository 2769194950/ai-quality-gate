// adapters/opencodereview/test/rule-format.test.mjs
// 「rule.json 格式不对称」缺陷（verifier I6）的回归测试。
//
// 缺陷（实测复现）：
//   引擎 `qgate` 的规则文件格式是 `{ schemaVersion, rules: [{ id, match, severity, category }] }`；
//   本适配层用的是 `{ include, exclude, includeExtensions, grouping }`。两侧格式不同，
//   且**失效方向不对称**：
//     * 引擎遇到适配层格式 ⇒ **exit 2 / CONFIG_INVALID**（用户立刻知道规则没生效）；
//     * 适配层此前遇到引擎格式 ⇒ **静默忽略**（输出与「完全不带 --rule」逐字段相同，
//       用户以为规则生效了，实际一条都没应用）。
//   「看起来配了、实际没生效」正是确定性工程要消灭的状态，因此不再静默：
//   现在显式上报 degraded:true + degraded_reason=RULE_FORMAT_UNSUPPORTED。
//
// 本文件锁定三件事：
//   1) 引擎格式的规则文件在适配层被**检出并上报**（不是静默）；
//   2) 适配层格式照常工作（不误报）；
//   3) 告警在 --json 与 --md 两种输出里都可见。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { DEMO_DIFF, DEMO_RULE, ADAPTER_ROOT, runPreview, tempDir, writeDiff } from './helpers.mjs';
import { inspectRuleShape, RECOGNIZED_RULE_KEYS } from '../src/rules.mjs';

const ENGINE_FORMAT_RULE = path.join(ADAPTER_ROOT, 'demo', 'rule.engine-format.json');

test('规则格式: 引擎格式 {rules:[{match}]} 被识别为「本层不支持」而非静默', () => {
  const engineShape = JSON.parse(fs.readFileSync(ENGINE_FORMAT_RULE, 'utf8'));
  const verdict = inspectRuleShape(engineShape);
  assert.equal(verdict.ok, false, '引擎格式必须被判为不支持');
  assert.equal(verdict.reason, 'RULE_FORMAT_UNSUPPORTED');
  assert.equal(verdict.kind, 'engine');
  // 适配层格式必须被判为支持（不误报）
  const adapterShape = JSON.parse(fs.readFileSync(DEMO_RULE, 'utf8'));
  assert.equal(inspectRuleShape(adapterShape).ok, true, '适配层格式必须被判为支持');
  // 空对象 / 只有未知键同样不支持
  assert.equal(inspectRuleShape({}).ok, false);
  assert.equal(inspectRuleShape({ somethingElse: 1 }).ok, false);
  assert.ok(RECOGNIZED_RULE_KEYS.includes('include') && RECOGNIZED_RULE_KEYS.includes('exclude'));
});

test('规则格式: 用引擎格式规则时 degraded:true + RULE_FORMAT_UNSUPPORTED（不再静默）', () => {
  const withEngineRule = runPreview(['--diff', DEMO_DIFF, '--rule', ENGINE_FORMAT_RULE, '--json']).payload;
  assert.equal(withEngineRule.degraded, true, '不可识别的规则格式必须让输出 degraded:true');
  // degraded_reason 可能同时含 provider 降级（如 OCR_CLI_NOT_FOUND）——用包含断言，
  // 精确集合由 degraded_reasons 数组给出。
  assert.match(withEngineRule.degraded_reason, /RULE_FORMAT_UNSUPPORTED/);
  assert.equal(withEngineRule.degraded_reasons.includes('RULE_FORMAT_UNSUPPORTED'), true);
  assert.equal(withEngineRule.rules.format_supported, false);
  assert.equal(withEngineRule.rules.unsupported_layers.length, 1);
  const unsupported = withEngineRule.rules.unsupported_layers[0];
  assert.equal(unsupported.reason, 'RULE_FORMAT_UNSUPPORTED');
  assert.equal(unsupported.source, 'cli:--rule');
  assert.match(unsupported.detail, /engine rule format/);
  // 该层的 layer_trace 也要标记出来（逐层可见）
  const cliLayer = withEngineRule.rules.layer_trace.find((t) => t.source === 'cli:--rule');
  assert.equal(cliLayer.format_supported, false);
  assert.equal(cliLayer.format_reason, 'RULE_FORMAT_UNSUPPORTED');
  // 关键：规则确实没有生效（内容被忽略）——但这一次是**可见的**忽略
  assert.equal(withEngineRule.rules.buckets.length, 0, '引擎格式的 rules 不产生分桶（本就未被识别）');
});

test('规则格式: 适配层格式不误报（format_supported=true，规则正常生效）', () => {
  const p = runPreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json']).payload;
  assert.equal(p.rules.format_supported, true, '适配层自己的格式不得被误判为不支持');
  assert.deepEqual(p.rules.unsupported_layers, []);
  assert.equal(p.rules.buckets.length >= 1, true, '适配层格式的 buckets 应生效');
  // degraded 仍应为 true，但原因只能是 ocr 缺失（与规则格式无关）
  if (p.degraded) {
    assert.equal(p.degraded_reason.includes('RULE_FORMAT_UNSUPPORTED'), false, '不得把 ocr 降级与格式问题混为一谈');
  }
});

test('规则格式: 告警在 --md 输出中可见（人类读者也能看到）', () => {
  const md = runPreview(['--diff', DEMO_DIFF, '--rule', ENGINE_FORMAT_RULE, '--md']).markdown;
  assert.ok(md, '--md 必须输出 Markdown');
  assert.match(md, /RULE_FORMAT_UNSUPPORTED/);
  assert.match(md, /规则未生效/);
  assert.match(md, /rules: \[\{ id, match, severity, category \}\]/, '应说明引擎格式与适配层格式的差异');
});

test('规则格式: 无规则文件时不产生格式告警（不误报）', () => {
  const dir = tempDir();
  try {
    const diff = writeDiff(dir.path, 'diff.json', [{ path: 'src/app.mjs' }]);
    const p = runPreview(['--diff', diff, '--json', '--home', path.join(dir.path, 'nohome')]).payload;
    assert.equal(p.rules.format_supported, true);
    assert.deepEqual(p.rules.unsupported_layers, []);
    assert.equal(p.degraded_reason?.includes('RULE_FORMAT_UNSUPPORTED') ?? false, false);
  } finally {
    dir.cleanup();
  }
});

test('规则格式: 项目级规则文件用引擎格式时同样被上报（不只是 --rule 层）', () => {
  const dir = tempDir();
  try {
    const root = path.join(dir.path, 'proj');
    fs.mkdirSync(path.join(root, '.opencodereview'), { recursive: true });
    // 项目级规则文件写成引擎格式
    fs.copyFileSync(ENGINE_FORMAT_RULE, path.join(root, '.opencodereview', 'rule.json'));
    const diff = writeDiff(dir.path, 'diff.json', [{ path: 'src/app.mjs' }]);
    const p = runPreview(['--diff', diff, '--root', root, '--home', path.join(dir.path, 'nohome'), '--json']).payload;
    assert.equal(p.rules.format_supported, false, '项目级规则文件的格式问题也必须上报');
    const layer = p.rules.layer_trace.find((t) => t.source === 'project:.opencodereview/rule.json');
    assert.equal(layer.format_supported, false);
    assert.match(p.degraded_reason, /RULE_FORMAT_UNSUPPORTED/);
  } finally {
    dir.cleanup();
  }
});

// adapters/opencodereview/test/fixtures.test.mjs
// 真实运行产物回归：test/fixtures/ 下的 JSON/Markdown 由 `bin/ocr-preview.mjs` 真实运行生成
// （不是手写样例）。本文件重新运行同一命令，断言输出仍与存档一致 —— 一旦选择/分组语义
// 发生漂移，测试立即失败，而不是静默改变评审范围。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ADAPTER_ROOT, REPO_ROOT, DEMO_DIFF, DEMO_RULE, runPreview, stableJson } from './helpers.mjs';
import { portableize, portableizeText, portableizeWithReport, toPosix, ROOT_TOKENS } from './portable.mjs';

const FIXTURES = path.join(ADAPTER_ROOT, 'test', 'fixtures');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

/**
 * 把与环境相关的绝对路径替换为占位符，使回归断言可跨 cwd / 跨机器复现（GAP-6）。
 * 注意：这里用共享的 `portable.mjs`（基于根前缀的长前缀优先替换），
 * 而不是早期「路径里必须出现 adapters/opencodereview 段」的正则 ——
 * 后者漏掉了 `…/.opencodereview/rule.json`（项目级规则层）与用户级规则路径这两类。
 */
const normalize = (payload) => portableize(payload);
/** Markdown 等自由文本用 portableizeText（路径嵌在表格/句子里）。 */
const scrubText = (text) => portableizeText(text);

// These snapshots describe the deterministic preview contract, so do not let a
// developer's installed OCR CLI change the recorded provider metadata. A
// missing explicit binary also preserves the historical OCR_CLI_NOT_FOUND
// fixture reason without changing the machine's global OCR configuration.
const runOfflinePreview = (argv) => {
  const result = runPreview([...argv, '--ocr-bin', path.join(ADAPTER_ROOT, 'demo', 'no-such-ocr-binary.exe')]);
  if (result.payload?.provider) result.payload.provider.ocr_bin = null;
  return result;
};

test('fixtures: preview.default.json 与当前运行结果一致（真实产物回归）', () => {
  const stored = normalize(readJson('preview.default.json'));
  const now = normalize(runOfflinePreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json']).payload);
  assert.equal(stableJson(now), stableJson(stored), '默认预览结果与存档夹具不一致（选择/分组语义发生漂移）');
  assert.equal(now.mode, 'preview');
  assert.equal(now.llm_called, false);
  assert.equal(now.counts.selected, 14);
  assert.equal(now.counts.excluded, 9);
  assert.equal(now.counts.groups, 4);
  assert.equal(now.counts.downgraded_groups, 0);
  assert.deepEqual(now.safety.violations, []);
  assert.equal(now.safety.no_sensitive_selected, true);
});

test('fixtures: preview.token-budget-300.json 记录 token 预算降级形态', () => {
  const stored = normalize(readJson('preview.token-budget-300.json'));
  const now = normalize(runOfflinePreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--token-budget', '300', '--json']).payload);
  assert.equal(stableJson(now), stableJson(stored), 'token 预算降级结果与存档夹具不一致');
  assert.ok(now.counts.downgraded_groups >= 10, '低预算下应出现大量单文件降级组');
  assert.ok(now.groups.filter((g) => g.downgraded).every((g) => g.file_count === 1 && g.downgrade_reason === 'token_budget_exceeded'));
  assert.equal(now.grouping.invariant_ok, true);
  // 降级不得改变选择集合：安全与选择语义与默认预算完全一致
  const base = runOfflinePreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json']).payload;
  assert.deepEqual(now.selectedPaths, base.selectedPaths);
  assert.deepEqual(now.excludedPaths, base.excludedPaths);
});

test('fixtures: selection.default.md 为真实运行生成的「文件/决策/原因」三列表格', () => {
  const stored = fs.readFileSync(path.join(FIXTURES, 'selection.default.md'), 'utf8');
  const now = runOfflinePreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--md']).markdown;
  assert.ok(now, '--md 必须输出 Markdown');
  assert.equal(scrubText(now), scrubText(stored), 'selection.md 与存档不一致');
  assert.match(stored, /\|\s*文件\s*\|\s*决策\s*\|\s*原因\s*\|/);
  assert.match(stored, /\|\s*`\.env\.production`\s*\|\s*excluded\s*\|/);
  assert.equal(/\|\s*`\.env\.production`\s*\|\s*included\s*\|/.test(stored), false, '密钥路径不得出现在 included 行');
  assert.match(stored, /敏感路径进入 selected = 0 条违规/);
});

test('fixtures: 两次运行的字节级一致性（同一进程内重复调用）', () => {
  const a = runPreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json']);
  const b = runPreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json']);
  assert.equal(a.stdout, b.stdout);
  assert.equal(normalize(a.payload).counts.selected, normalize(b.payload).counts.selected);
});

test('契约: ruleMatch 形状规则成立，字段名与 README §1.2 记录的现状逐字一致', () => {
  const payload = runPreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json']).payload;
  const included = payload.selection.included;
  // §6.2.1 形状规则 1+2：逐文件数组，长度等于 included.length，第 i 项 file 与 included[i] 对应
  assert.ok(Array.isArray(payload.ruleMatch), 'ruleMatch 必须是数组（§6.2.1：不是单个对象）');
  assert.equal(payload.ruleMatch.length, included.length, 'ruleMatch 长度必须等于 selection.included.length');
  payload.ruleMatch.forEach((entry, i) => {
    assert.equal(entry.file, included[i], `ruleMatch[${i}].file 必须等于 selection.included[${i}]`);
  });
  // 本层实际字段名 —— 锁定以防文档与输出漂移
  assert.deepEqual(Object.keys(payload.ruleMatch[0]).sort(), ['decision', 'file', 'pattern', 'priority', 'reason', 'ruleId', 'ruleSource']);
  // 契约 §6.2.1 冻结字段名 —— 明确记录差异，任一方改动都会在此暴露
  for (const sameName of ['file', 'ruleSource', 'ruleId', 'priority']) {
    assert.ok(sameName in payload.ruleMatch[0], `同名契约字段应存在: ${sameName}`);
  }
  assert.equal('pattern' in payload.ruleMatch[0], true, '本层用 pattern 表达契约的 match（同名异写）');
  for (const notYetEmitted of ['match', 'severity', 'category']) {
    assert.equal(notYetEmitted in payload.ruleMatch[0], false, `契约字段 ${notYetEmitted} 当前未输出（已上报待裁决；若已对齐请同步更新本断言与 README §1.2）`);
  }
  // groups[] 成员字段名（含 estimated_tokens vs tokens 的同名异写；t48 新增 excluded_unmaterialized
  // 表示「该组里被剔除的未物化路径数」，与 README §6.1「未物化路径」口径一致）
  assert.deepEqual(Object.keys(payload.groups[0]).sort(), ['downgrade_reason', 'downgraded', 'estimated_tokens', 'excluded_unmaterialized', 'file_count', 'files', 'id']);
  // t48：未物化路径口径字段必须存在（计数不被污染、事实仍可查）
  for (const k of ['unmaterialized', 'selected_materialized', 'groups_dropped_unmaterialized']) {
    assert.ok(k in payload.counts, `counts.${k} 必须存在（t48 计数口径）`);
  }
  assert.ok(Array.isArray(payload.unmaterialized), 'payload.unmaterialized 必须是数组');
  assert.equal(typeof payload.selected[0].materialized, 'boolean', 'selected[].materialized 必须是布尔值');
  // selection 与契约逐字一致
  assert.deepEqual(Object.keys(payload.selection).sort(), ['excluded', 'included']);
  assert.deepEqual(Object.keys(payload.selection.excluded[0]).sort(), ['path', 'reason']);
});

// ── 夹具键集与实现同步（t51 / 欠账 1）──────────────────────────────────────
// 教训：t48 给输出加了 7 个新键，却只重录了受影响的 JSON 夹具的一部分约定——
// 本用例把「凡含 selected[]/groups[] 的已录夹具，都必须带齐当前实现的键集」写成断言，
// 免得下次再加键时又漏录某个夹具（夹具 = 当前真实产物，不能是历史快照）。
test('t51: 已录夹具的键集与当前实现同步（含 t48 新增的全部键）', () => {
  const REQUIRED_TOP_LEVEL = ['unmaterialized', 'selectedPathsMaterialized'];
  const REQUIRED_COUNTS = ['selected_materialized', 'unmaterialized', 'groups_dropped_unmaterialized'];
  const REQUIRED_SELECTED_ITEM = ['materialized'];
  const REQUIRED_GROUP_ITEM = ['excluded_unmaterialized'];

  const fixtureFiles = fs
    .readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json'))
    .sort();
  assert.ok(fixtureFiles.length >= 2, '应至少有 2 个 JSON 夹具');

  const checked = [];
  for (const name of fixtureFiles) {
    const j = readJson(name);
    // 只检查含 selected[] / groups[] 的夹具（即 preview 类产物）
    const hasSelected = Array.isArray(j.selected);
    const hasGroups = Array.isArray(j.groups);
    if (!hasSelected && !hasGroups) continue;
    checked.push(name);
    for (const k of REQUIRED_TOP_LEVEL) {
      assert.ok(Object.prototype.hasOwnProperty.call(j, k), `${name}: 顶层缺少 ${k}`);
    }
    for (const k of REQUIRED_COUNTS) {
      assert.ok(Object.prototype.hasOwnProperty.call(j.counts, k), `${name}: counts 缺少 ${k}`);
    }
    if (hasSelected && j.selected.length > 0) {
      for (const k of REQUIRED_SELECTED_ITEM) {
        assert.ok(Object.prototype.hasOwnProperty.call(j.selected[0], k), `${name}: selected[0] 缺少 ${k}`);
      }
      // 夹具来自真实文件 ⇒ 必然全部物化
      assert.equal(j.selected.every((s) => s.materialized === true), true, `${name}: 夹具内应全部 materialized=true`);
      assert.deepEqual(j.unmaterialized, [], `${name}: 夹具无未物化路径`);
      assert.equal(j.counts.unmaterialized, 0);
      assert.equal(j.counts.selected_materialized, j.selected.length, `${name}: selected_materialized 应等于 selected 数`);
    }
    if (hasGroups && j.groups.length > 0) {
      for (const k of REQUIRED_GROUP_ITEM) {
        assert.ok(Object.prototype.hasOwnProperty.call(j.groups[0], k), `${name}: groups[0] 缺少 ${k}`);
      }
    }
  }
  assert.ok(checked.length >= 2, `应至少检查 2 个 preview 类夹具，实际 ${JSON.stringify(checked)}`);
  // 反向自检：夹具必须与「当前运行结果」一致（不是历史快照）——由上面两条回归用例保证；
  // 这里额外断言 token-budget 夹具也在被检查之列。
  assert.ok(checked.includes('preview.default.json'));
  assert.ok(checked.includes('preview.token-budget-300.json'));
});

// ── GAP-6：scrubber 覆盖面锁定 ──────────────────────────────────────────────
// 这一组测试锁定「三类必须被抹平的路径」+「不得误替非仓库绝对路径」。
// 早期 scrubber 的正则要求路径里出现 `adapters/opencodereview` 段，
// 于是项目级规则路径（…/.opencodereview/rule.json）与用户级规则路径完全漏网 ——
// 这正是 GAP-5 之外让夹具在非规范 cwd 下失败的第二个成因。将来再有人改 scrubber，
// 这几条会立刻失败，避免漏网静默回归。

test('GAP-6: scrubber 抹平三类路径（适配层根 / 仓库根+项目级规则 / 家目录）', () => {
  // 第 1 类：适配层自身路径
  assert.equal(portableize(`${ADAPTER_ROOT}/demo/diff.json`), '<ADAPTER_ROOT>/demo/diff.json');
  // 第 2 类：仓库根下的项目级规则路径（**不含** adapters/opencodereview 段 —— 旧正则的漏网者）
  const projectRule = toPosix(path.join(REPO_ROOT, '.opencodereview', 'rule.json'));
  assert.equal(portableize(projectRule), '<REPO_ROOT>/.opencodereview/rule.json');
  assert.equal(portableize(projectRule).includes('adapters'), false, '项目级规则路径不含适配层段（旧正则因此漏网）');
  // 第 2 类变体：demo 目录下的项目级规则路径（未给 --root 时的推断锚点）
  const demoProjectRule = toPosix(path.join(ADAPTER_ROOT, 'demo', '.opencodereview', 'rule.json'));
  assert.equal(portableize(demoProjectRule), '<ADAPTER_ROOT>/demo/.opencodereview/rule.json');
  // 第 3 类：demo 输入文件路径（source.path / diffPath）
  assert.equal(portableize(toPosix(DEMO_DIFF)), '<ADAPTER_ROOT>/demo/diff.json');
  // 第 3 类补充：家目录下的用户级规则路径
  const homeRule = toPosix(path.join(os.homedir(), '.opencodereview', 'rule.json'));
  assert.equal(portableize(homeRule), '<HOME>/.opencodereview/rule.json');
});

test('GAP-6: scrubber 不误替非仓库绝对路径，且统一分隔符', () => {
  const outside = process.platform === 'win32' ? 'D:\\some\\other\\place\\rule.json' : '/some/other/place/rule.json';
  const out = portableize(outside);
  assert.equal(out, 'D:/some/other/place/rule.json', '非仓库绝对路径只统一分隔符，不得被占位符化');
  for (const [token] of ROOT_TOKENS) assert.equal(out.startsWith(token), false, `不得被 ${token} 误替`);
  // 前缀相似但不相等不得误匹配（…/ai-quality-gate-extra 不是仓库根）
  assert.equal(portableize(`${toPosix(REPO_ROOT)}-extra/x.json`), `${toPosix(REPO_ROOT)}-extra/x.json`);
  // 非字符串原样返回
  assert.equal(portableize(42), 42);
  assert.equal(portableize(null), null);
});

test('GAP-6: 实际输出中三类路径都被抹平，且报告出命中的占位符', () => {
  const payload = runPreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json']).payload;
  const { value, hits } = portableizeWithReport(payload);
  // 夹具里必须已经没有仓库/适配层/家目录的绝对路径
  const text = JSON.stringify(value);
  for (const [, root] of ROOT_TOKENS) {
    assert.equal(text.includes(toPosix(root)), false, `输出中不应残留绝对根路径: ${root}`);
  }
  // 命中的占位符必须覆盖三类（真实输出里同时含适配层路径、demo 项目级规则路径、家目录规则路径）
  assert.equal(hits.has('<ADAPTER_ROOT>'), true, '应命中适配层根路径');
  assert.equal(hits.has('<REPO_ROOT>') || hits.has('<HOME>'), true, '应命中仓库根或家目录路径');
  // 结构仍可断言（占位符化不改变形状）
  assert.equal(value.counts.selected, 14);
  assert.equal(value.counts.excluded, 9);
});

// adapters/opencodereview/test/grouping-rules.test.mjs
// 分组与规则引擎的单元级断言（G1 组上限 / G2 token 降级 / G3 失败回退 / G4 确定性）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  MAX_FILES_PER_GROUP,
  DEFAULT_TOKEN_BUDGET,
  groupFiles,
  groupTokens,
  commonDirPrefix,
  autoSegment,
  assertGroupingInvariants,
  buildBuckets,
} from '../src/grouping.mjs';
import { classifyFile, isSensitivePath, projectRules } from '../src/filters.mjs';
import { resolveRules, effectiveSettings, BUILTIN_RULE, RULE_SOURCES, readRuleFile, RuleError } from '../src/rules.mjs';
import { tempDir, writeRule } from './helpers.mjs';

const mk = (n, size = 100) => Array.from({ length: n }, (_, i) => ({ path: `p/f${String(i).padStart(2, '0')}.mjs`, size, tokens: Math.ceil(size / 4) }));

test('分组常量: MAX_FILES_PER_GROUP=10 与默认 token 预算', () => {
  assert.equal(MAX_FILES_PER_GROUP, 10);
  assert.equal(DEFAULT_TOKEN_BUDGET, 32000);
});

test('分组: 0 个文件 ⇒ 0 组且不抛错', () => {
  const g = groupFiles([], {});
  assert.deepEqual(g.groups, []);
  assert.equal(g.groupCount, 0);
  assert.deepEqual(g.notes, ['empty_selection']);
  assert.equal(assertGroupingInvariants(g).ok, true);
});

test('分组: 显式 maxFilesPerGroup 无法突破硬上限 10', () => {
  const g = groupFiles(mk(12), { maxFilesPerGroup: 999, tokenBudget: 10 ** 6, mode: 'single' });
  assert.equal(g.maxFilesPerGroup, 10);
  assert.ok(g.groups.every((x) => x.fileCount <= 10));
  assert.deepEqual(g.groups.map((x) => x.fileCount), [10, 2]);
});

test('分组: 每个文件恰好出现在一个组里（无重复、无遗漏）', () => {
  const files = mk(23, 120);
  const g = groupFiles(files, { tokenBudget: 10 ** 6, mode: 'auto' });
  const seen = [];
  for (const group of g.groups) seen.push(...group.files);
  assert.equal(seen.length, files.length);
  assert.deepEqual([...new Set(seen)].length, files.length);
  assert.deepEqual(seen.sort(), files.map((f) => f.path).sort());
});

test('分组: token 预算降级为单文件桶并记录原因与预算', () => {
  const g = groupFiles(mk(4, 4000), { tokenBudget: 100 });
  assert.equal(g.downgradedGroups, 4);
  assert.ok(g.groups.every((x) => x.fileCount === 1 && x.downgraded && x.downgradeReason === 'token_budget_exceeded'));
  assert.equal(g.tokenBudget, 100);
});

test('分组: 分组异常时回退 per-file（不产生部分结果）', () => {
  // 注入一次排序异常，验证 G3：分组失败 ⇒ 逐文件桶，绝不产生“半个结论”。
  const files = mk(3, 120);
  const originalSort = Array.prototype.sort;
  let thrown = 0;
  Array.prototype.sort = function patchedSort(...args) {
    if (Array.isArray(this) && this.length > 1 && this[0] && this[0].path) {
      thrown += 1;
      throw new Error('injected grouping failure');
    }
    return originalSort.apply(this, args);
  };
  let g;
  try {
    g = groupFiles(files, { tokenBudget: 1000 });
  } finally {
    Array.prototype.sort = originalSort;
  }
  assert.ok(thrown > 0, '注入的失败必须被触发');
  assert.equal(g.mode, 'per-file');
  assert.ok(g.notes.some((n) => n.startsWith('grouping_failed_fallback:injected grouping failure')));
  assert.equal(g.groups.length, 3);
  assert.ok(g.groups.every((x) => x.fileCount === 1 && x.downgraded && x.downgradeReason === 'grouping_failed'));
  assert.equal(g.invariantCheck, true);
});

test('分组: 显式分桶规则把调用链捆在一起，未命中者按目录分段', () => {
  const files = [
    { path: 'src/chain/a.mjs', size: 10 }, { path: 'src/chain/b.mjs', size: 10 },
    { path: 'src/chain/c.mjs', size: 10 }, { path: 'src/other/d.mjs', size: 10 },
  ];
  const buckets = buildBuckets(files, [{ id: 'chain', patterns: ['src/chain/*.mjs'] }]);
  assert.deepEqual(buckets.map((b) => b.key), ['bucket:chain', 'src/other']);
  assert.deepEqual(buckets[0].files.map((f) => f.path), ['src/chain/a.mjs', 'src/chain/b.mjs', 'src/chain/c.mjs']);
});

test('分组: 公共前缀与自动分段语义稳定', () => {
  assert.equal(commonDirPrefix(['a/b/c.mjs', 'a/b/d.mjs']), 'a/b');
  assert.equal(commonDirPrefix(['a/b/c.mjs', 'a/x/d.mjs']), 'a');
  assert.equal(commonDirPrefix(['a.mjs']), '');
  const seg = autoSegment([
    { path: 'demo/src/reader/one.mjs' }, { path: 'demo/src/reader/two.mjs' }, { path: 'demo/src/util/x.mjs' },
  ]);
  assert.deepEqual(seg.map((s) => s.key), ['demo/src/reader', 'demo/src/util']);
});

test('规则: 内置层永远存在且不含 include（结构上不可能救回敏感路径）', () => {
  // t67：**不要把 process.cwd() 当作根/家目录**。那会让本用例的结果依赖运行目录：
  // 例如从 `demo/mini-service/` 运行时，项目级与用户级路径都指向
  // `demo/mini-service/.opencodereview/rule.json` ⇒ 多出 2 个 loaded 层（实测 3≠1）。
  // 改用**互不相同的文件系统位置**：root = 临时目录（无 .opencodereview 祖先），
  // homeDir = 另一个不存在的路径 ⇒ 只有内置层 loaded，结论与 cwd 无关。
  const isolated = tempDir();
  try {
    const ctx = resolveRules({
      root: isolated.path,
      homeDir: path.join(isolated.path, 'no-such-home'),
    });
    assert.equal(ctx.layers[ctx.layers.length - 1].source, RULE_SOURCES.BUILTIN);
    assert.deepEqual(BUILTIN_RULE.include, []);
    assert.equal(ctx.trace.filter((t) => t.loaded).length, 1);
    // 分母/非空断言：trace 必须把三层都记下来（否则「loaded 数为 1」可能来自空 trace）
    assert.equal(ctx.trace.length >= 3, true, `trace 必须包含至少三层（实际 ${ctx.trace.length}）`);
    assert.deepEqual(
      ctx.trace.filter((t) => t.loaded).map((t) => t.source),
      [RULE_SOURCES.BUILTIN],
      'loaded 的应且仅应是内置层',
    );
    const eff = effectiveSettings(ctx.layers);
    assert.equal(eff.maxFilesPerGroup, 10);
    assert.equal(eff.maxTokensPerGroup, 32000);
  } finally {
    isolated.cleanup();
  }
});

test('规则: 非法规则文件 ⇒ RuleError(CONFIG_INVALID)；缺失文件返回 null', () => {
  const dir = tempDir();
  try {
    const bad = dir.write('bad.json', '{ not json');
    assert.throws(() => readRuleFile(bad, RULE_SOURCES.CLI), (err) => err instanceof RuleError && err.code === 'CONFIG_INVALID');
    const arr = dir.write('arr.json', '[1,2,3]');
    assert.throws(() => readRuleFile(arr, RULE_SOURCES.CLI), RuleError);
    assert.equal(readRuleFile(`${dir.path}/missing.json`, RULE_SOURCES.CLI), null);
    const ok = writeRule(dir.path, 'ok.json', { version: '1.0', include: ['**/*.mjs'] });
    assert.equal(readRuleFile(ok, RULE_SOURCES.CLI).source, RULE_SOURCES.CLI);
  } finally {
    dir.cleanup();
  }
});

test('规则: effectiveSettings 高优先层覆盖低优先层', () => {
  const eff = effectiveSettings([
    { source: 'cli:--rule', includeExtensions: ['.mjs'], grouping: { maxFilesPerGroup: 5 } },
    { source: 'project:.opencodereview/rule.json', includeExtensions: ['.ts'], maxTokensPerGroup: 111, grouping: { maxFilesPerGroup: 3 } },
    { source: RULE_SOURCES.BUILTIN, maxTokensPerGroup: 32000 },
  ]);
  assert.deepEqual(eff.includeExtensions, ['.mjs']);
  assert.equal(eff.maxTokensPerGroup, 111);
  assert.equal(eff.maxFilesPerGroup, 5);
});

test('规则: classifyFile 的判定顺序 —— 安全层先于任何 include', () => {
  const rules = { layers: [{ source: 'cli:flags', include: ['**/*'], exclude: [] }] };
  const verdicts = [
    ['secrets/x.txt', 'sensitive_path_never_included'],
    ['.env', 'sensitive_path_never_included'],
    ['node_modules/a/b.js', 'default_excluded_dir:node_modules'],
    ['assets/logo.png', 'binary_file:extension'],
    ['weird/file.bak', 'unsupported_extension:.bak'],
    ['src/app.mjs', 'included_by_rule'],
  ];
  for (const [p, reason] of verdicts) {
    const v = classifyFile(p, rules, {});
    assert.equal(v.reason, reason, `${p} ⇒ ${reason}`);
    if (reason !== 'included_by_rule') assert.equal(v.decision, 'excluded');
    if (reason === 'sensitive_path_never_included') assert.equal(v.decidedBy, 'safety');
  }
  assert.equal(isSensitivePath('secrets/x.txt'), true);
  assert.equal(projectRules(rules).length, 1);
});

test('规则: --include 追加为最高优先层（priority 0）', () => {
  // t67：同样不依赖 process.cwd()，否则「最高优先层」的断言会随运行目录掺入项目/用户层。
  const isolated = tempDir();
  try {
    const ctx = resolveRules({
      root: isolated.path,
      homeDir: path.join(isolated.path, 'no-such-home'),
      include: ['src/**/*.mjs'],
      exclude: ['**/*.md'],
    });
    assert.equal(ctx.trace[0].source, 'cli:flags');
    assert.equal(ctx.trace[0].priority, 0);
    assert.equal(ctx.layers[0].source, 'cli:flags');
    assert.deepEqual(ctx.layers[0].include, ['src/**/*.mjs']);
    assert.deepEqual(ctx.layers[0].exclude, ['**/*.md']);
  } finally {
    isolated.cleanup();
  }
});

test('分组: groupTokens 按 tokens/size 确定性求和', () => {
  assert.equal(groupTokens([{ path: 'a', tokens: 10 }, { path: 'b', tokens: 5 }]), 15);
  assert.equal(groupTokens([{ path: 'a', size: 40 }, { path: 'b', size: 8 }]), 12);
  assert.equal(groupTokens([]), 0);
});

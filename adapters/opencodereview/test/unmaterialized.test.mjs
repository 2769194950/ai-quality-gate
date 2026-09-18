// adapters/opencodereview/test/unmaterialized.test.mjs
// t48 / R3-L2 回归：diff 声明了但**盘上不存在**的路径，不得污染「评审覆盖面」派生计数，
// 同时「声明了却没物化」这一审计事实必须**仍可查**。
//
// 缺陷（verifier t45 B4 实测）：diff 9 项（3 真实 + 6 个 `gone/*.js`）在 `--diff` / `--diff --root` 下
// 给出 included=9 / selected=9 / groups[].files=9，而 `--root` 对照是 3/3/2
// ⇒ 任何以「selected 文件数 / group 文件数」派生评审覆盖面的计数会**偏高 3 倍**。
//
// captain 已确认：**token 并未膨胀**（未物化项 size/tokens 均为 0），因此本修复
// **不改 token 逻辑**，只修计数口径。
//
// 自证（复核用）：把 `src/ocr-pipeline.mjs` 里 `isMaterialized` 的定义改成 `() => true`
// （即回到「未物化路径也算入选」），本文件的计数用例应失败；恢复后全绿。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createPreview } from '../src/ocr-pipeline.mjs';
import { DEMO_DIFF, DEMO_RULE, runPreview, tempDir, writeDiff } from './helpers.mjs';

/** 构造：3 个真实文件 + 6 个不存在的 `gone/*.js`。 */
function buildMixed(dir) {
  const root = path.join(dir.path, 'repo');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const n of ['app', 'b', 'c']) fs.writeFileSync(path.join(root, 'src', `${n}.mjs`), `export const ${n} = 1;\n`);
  const gone = ['gone/a.js', 'gone/b.js', 'gone/c.js', 'gone/d.js', 'gone/e.js', 'gone/f.js'];
  const diff = writeDiff(dir.path, 'diff.json', ['src/app.mjs', 'src/b.mjs', 'src/c.mjs', ...gone]);
  return { root, diff, gone, real: ['src/app.mjs', 'src/b.mjs', 'src/c.mjs'] };
}

const groupFileSum = (p) => p.groups.reduce((n, g) => n + g.files.length, 0);

test('t48: 未物化路径不进入 groups[].files（覆盖面派生值不受污染）', () => {
  const dir = tempDir();
  try {
    const fx = buildMixed(dir);
    const p = createPreview({ diff: fx.diff, homeDir: path.join(dir.path, 'nohome') }).payload;
    // 未物化路径**不得**出现在任何组的 files 里
    for (const g of p.groups) {
      for (const f of g.files) {
        assert.equal(fx.gone.includes(f), false, `未物化路径不得进入 groups[].files: ${f}`);
      }
    }
    assert.equal(groupFileSum(p), fx.real.length, `groups[].files 合计应为真实文件数 ${fx.real.length}`);
    assert.equal(p.counts.selected_materialized, fx.real.length);
    // 与 --root 对照一致（同一批真实文件）
    const byRoot = createPreview({ root: fx.root, homeDir: path.join(dir.path, 'nohome') }).payload;
    assert.equal(groupFileSum(p), groupFileSum(byRoot), 'diff 与 --root 的组内文件数应一致');
    assert.equal(p.counts.selected_materialized, byRoot.counts.selected_materialized);
  } finally {
    dir.cleanup();
  }
});

test('t48: 未物化事实仍可查（unmaterialized 列表 + selected[].materialized=false）', () => {
  const dir = tempDir();
  try {
    const fx = buildMixed(dir);
    const p = createPreview({ diff: fx.diff, homeDir: path.join(dir.path, 'nohome') }).payload;
    assert.deepEqual([...p.unmaterialized].sort(), [...fx.gone].sort(), '未物化路径必须显式列出（审计事实）');
    assert.equal(p.counts.unmaterialized, fx.gone.length);
    const flagged = p.selected.filter((s) => s.materialized === false).map((s) => s.path);
    assert.deepEqual([...flagged].sort(), [...fx.gone].sort(), 'selected[] 必须逐项标注 materialized:false');
    // 真实文件必须标 true
    for (const r of fx.real) {
      const item = p.selected.find((s) => s.path === r);
      assert.equal(item.materialized, true, `${r} 应标注 materialized:true`);
    }
    // 契约面 selection.included 保持不变（仍是纯字符串数组，含全部声明路径）
    assert.deepEqual([...p.selection.included].sort(), [...fx.real, ...fx.gone].sort());
    assert.ok(p.selection.included.every((x) => typeof x === 'string'), 'selection.included 必须仍是纯字符串数组');
  } finally {
    dir.cleanup();
  }
});

test('t48: 物化后为空的组被丢弃（与 --root 的组数对齐）', () => {
  const dir = tempDir();
  try {
    const fx = buildMixed(dir);
    const p = createPreview({ diff: fx.diff, homeDir: path.join(dir.path, 'nohome') }).payload;
    assert.equal(p.counts.groups, p.groups.length, 'counts.groups 必须等于实际组数');
    // `gone/*` 全未物化 ⇒ 该组物化后为空 ⇒ 应被丢弃，并计数
    assert.equal(p.groups.some((g) => g.id === 'gone'), false, '物化后为空的组不得保留');
    assert.equal(p.counts.groups_dropped_unmaterialized, 1);
    assert.ok(p.groups.every((g) => g.files.length > 0), '不得存在空组');
  } finally {
    dir.cleanup();
  }
});

test('t48: 全部物化时计数与旧口径一致（不引入回归）', () => {
  const dir = tempDir();
  try {
    const fx = buildMixed(dir);
    // 只声明真实文件
    const diff = writeDiff(dir.path, 'only-real.json', fx.real);
    const p = createPreview({ diff, homeDir: path.join(dir.path, 'nohome') }).payload;
    assert.equal(p.counts.unmaterialized, 0);
    assert.equal(p.counts.selected, 3);
    assert.equal(p.counts.selected_materialized, 3);
    assert.equal(p.counts.groups_dropped_unmaterialized, 0);
    assert.deepEqual(p.unmaterialized, []);
    assert.ok(p.selected.every((s) => s.materialized === true));
    assert.equal(groupFileSum(p), 3);
  } finally {
    dir.cleanup();
  }
});

test('t48: demo 夹具不受影响（真实产物 14 入选 / 9 排除 / 4 组，全部物化）', () => {
  const p = runPreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json']).payload;
  assert.equal(p.counts.selected, 14);
  assert.equal(p.counts.selected_materialized, 14);
  assert.equal(p.counts.unmaterialized, 0);
  assert.equal(p.counts.excluded, 9);
  assert.equal(p.counts.groups, 4);
  assert.deepEqual(p.unmaterialized, []);
  assert.equal(groupFileSum(p), 14);
  for (const g of p.groups) assert.equal(g.excluded_unmaterialized, 0, '夹具全部物化 ⇒ 该字段应为 0');
});

test('t48: token 逻辑未被改动（未物化项 tokens 仍为 0，总量不膨胀）', () => {
  const dir = tempDir();
  try {
    const fx = buildMixed(dir);
    const withGhosts = createPreview({ diff: fx.diff, homeDir: path.join(dir.path, 'nohome') }).payload;
    const onlyReal = createPreview({
      diff: writeDiff(dir.path, 'real-only.json', fx.real), homeDir: path.join(dir.path, 'nohome'),
    }).payload;
    const sum = (p) => p.selected.reduce((n, s) => n + (s.tokens || 0), 0);
    const groupSum = (p) => p.groups.reduce((n, g) => n + g.estimated_tokens, 0);
    assert.equal(sum(withGhosts), sum(onlyReal), '未物化路径不得让 token 总量膨胀');
    assert.equal(groupSum(withGhosts), groupSum(onlyReal), '未物化路径不得让组 token 膨胀');
    for (const s of withGhosts.selected.filter((x) => x.materialized === false)) {
      assert.equal(s.tokens, 0, `未物化项 ${s.path} 的 tokens 应为 0`);
      assert.equal(s.size, 0, `未物化项 ${s.path} 的 size 应为 0`);
    }
  } finally {
    dir.cleanup();
  }
});

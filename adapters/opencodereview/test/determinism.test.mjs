// adapters/opencodereview/test/determinism.test.mjs
// GAP-5 / GAP-6 的核心验证：同一输入在**不同 cwd** 下必须产出同一结果（REQ-010「同输入同输出」）。
//
// 缺陷背景：
//   * GAP-5（源码）：`createPreview` 未给 `--root` 时用 `process.cwd()` 作规则锚点，
//     于是项目级规则层路径随调用目录漂移；
//   * GAP-6（测试资产）：夹具把仓库绝对路径固化为期望值，且 scrubber 只覆盖
//     含 `adapters/opencodereview` 段的路径，漏掉 `…/.opencodereview/rule.json`。
// 两者叠加的结果：`cwd=仓库规范路径` 全绿，而 junction 别名 / 非仓库根下 3 条回归失败。
//
// 本测试用**子进程**在真实不同 cwd 下运行 CLI，并令其 `--out` 落盘
// （不通过管道捕获 stdout —— 受限沙箱禁止带管道的子进程 stdio），
// 再把结果读回来逐键比较。若子进程不可用（EPERM），退化为进程内跨 cwd 断言，
// 并把降级事实显式记录，绝不静默跳过。
//
// 如何复核本测试**确实能捕获**该缺陷（「自证」步骤，后来人可照做）：
//   把 `src/ocr-pipeline.mjs` 里 `anchorRoot` 的推断分支临时改回 `: process.cwd()`，
//   只跑 `node adapters/opencodereview/test/determinism.test.mjs` ⇒ 应当失败，
//   报错形如「junction 别名 的 layer_trace/loaded_layers/source.path 与规范路径不一致（GAP-5 回归）」，
//   同时 `fixtures.test.mjs` 应变为 5 通过 / 3 失败（即修复前的基线）；
//   改回推断分支后两者恢复全绿。实测已按此步骤验证过一次。
//   注意：**不要**用 mtime/哈希窗口来判断谁改了什么 —— 本仓库多人并发写同一棵树，
//   那种窗口无法作为作者归属证据（见 README §6.1 的取证说明）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { ADAPTER_ROOT, REPO_ROOT, DEMO_DIFF, DEMO_RULE, runPreview } from './helpers.mjs';
import { portableize, portableizeString, toPosix } from './portable.mjs';

const BIN = path.join(ADAPTER_ROOT, 'bin', 'ocr-preview.mjs');
const JUNCTION = 'E:\\ai-quality-gate';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cwd-'));

/** 在指定 cwd 下运行 CLI，把 JSON 写到临时文件再读回（避免管道 stdio）。 */
function runInCwd(cwd, outName) {
  const outFile = path.join(tmpRoot, outName);
  const res = spawnSync(process.execPath, [BIN, '--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json', '--quiet', '--out', outFile], {
    cwd,
    encoding: 'utf8',
    // 显式 ignore：不建立管道，避免受限沙箱的 spawn EPERM
    stdio: 'ignore',
  });
  if (res.error) return { spawned: false, error: String(res.error.message) };
  if (!fs.existsSync(outFile)) return { spawned: true, exitCode: res.status, payload: null };
  return { spawned: true, exitCode: res.status, payload: JSON.parse(fs.readFileSync(outFile, 'utf8')) };
}

/** 抽取「与 cwd 相关」的那几处路径字段，单独对比（验收要求的三个位置）。 */
function anchorPaths(payload) {
  return {
    layerTraceFiles: payload.rules.layer_trace.map((t) => portableizeString(t.file)),
    loadedLayerFiles: payload.rules.loaded_layers.map((l) => portableizeString(l.file)),
    sourcePath: portableizeString(payload.source.path),
    sizeRoot: portableizeString(payload.selection ? payload.source.path : null),
  };
}

/** 剔除运行时字段后的稳定序列化（用于整体字节级比较）。 */
function stableWithoutRuntime(payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  // 本适配层 preview 目前不含时间戳/随机字段，但显式声明以确保未来加入时不被误判为漂移
  for (const k of ['generated_at', 'run_id', 'started_at', 'finished_at', 'duration_ms']) delete clone[k];
  return JSON.stringify(clone);
}

const CANONICAL = toPosix(REPO_ROOT);

test('GAP-5/GAP-6: 三种 cwd 下 layer_trace / loaded_layers / source.path 完全一致', (t) => {
  const cwds = [
    { label: '规范路径', cwd: REPO_ROOT },
    { label: 'junction 别名', cwd: JUNCTION },
    { label: '非仓库根', cwd: os.homedir() },
  ];
  const available = cwds.filter((c) => fs.existsSync(c.cwd));
  assert.ok(available.length >= 3, `三种 cwd 都必须存在，实际只有 ${available.map((a) => a.label).join(', ')}`);

  const results = [];
  for (const c of available) {
    const r = runInCwd(c.cwd, `out-${c.label.replace(/[^\w]/g, '_')}.json`);
    results.push({ ...c, ...r });
  }

  if (results.some((r) => !r.spawned)) {
    // 受限沙箱：子进程被拒（EPERM）。退化为进程内跨 cwd 断言，并显式标注降级。
    const note = results.find((r) => !r.spawned).error;
    t.diagnostic(`子进程不可用（${note}），退化为进程内跨 cwd 断言`);
    const payloads = available.map((c) => {
      const prev = process.cwd();
      try {
        process.chdir(c.cwd);
        return { label: c.label, payload: runPreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json']).payload };
      } finally {
        process.chdir(prev);
      }
    });
    const first = anchorPaths(payloads[0].payload);
    for (const p of payloads.slice(1)) {
      assert.deepEqual(anchorPaths(p.payload), first, `${p.label} 的锚点路径与规范路径不一致（GAP-5 回归）`);
      assert.equal(stableWithoutRuntime(p.payload), stableWithoutRuntime(payloads[0].payload), `${p.label} 的整体输出与规范路径不一致`);
    }
    return;
  }

  for (const r of results) {
    assert.ok(r.payload, `${r.label} 未产出 JSON（exitCode=${r.exitCode}）`);
    assert.equal(r.exitCode, 0, `${r.label} 退出码应为 0`);
  }

  const first = anchorPaths(results[0].payload);
  for (const r of results) {
    assert.deepEqual(anchorPaths(r.payload), first, `${r.label} 的 layer_trace/loaded_layers/source.path 与规范路径不一致（GAP-5 回归）`);
    assert.equal(
      stableWithoutRuntime(r.payload),
      stableWithoutRuntime(results[0].payload),
      `${r.label} 输出除运行时字段外应与规范路径字节级一致`,
    );
  }
});

test('GAP-5/GAP-6: 输出中不含任何仓库/适配层/家目录绝对路径（夹具与运行时同源）', () => {
  const payload = runPreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json']).payload;
  const portable = portableize(payload);
  const text = JSON.stringify(portable);
  for (const root of [toPosix(REPO_ROOT), toPosix(ADAPTER_ROOT), toPosix(os.homedir())]) {
    assert.equal(text.includes(root), false, `输出不应残留绝对根路径 ${root}`);
  }
  // 占位符确实存在（证明不是「恰好没有绝对路径」而是「被抹平了」）
  assert.match(text, /<ADAPTER_ROOT>/, '应出现 <ADAPTER_ROOT> 占位符');
});

test('GAP-5: 显式 --root 行为未回归（显式参数优先于推断锚点）', () => {
  // 显式给 --root 时，项目级规则层锚点必须落在该 root 下
  const explicitRoot = path.join(ADAPTER_ROOT, 'demo');
  const withRoot = runPreview(['--diff', DEMO_DIFF, '--root', explicitRoot, '--rule', DEMO_RULE, '--json']).payload;
  const projectLayer = withRoot.rules.layer_trace.find((l) => l.priority === 2);
  assert.ok(projectLayer, '应存在项目级（priority 2）规则层');
  assert.equal(
    toPosix(projectLayer.file).startsWith(toPosix(explicitRoot)),
    true,
    `显式 --root 下项目级规则路径应在 root 内，实际 ${projectLayer.file}`,
  );
  // 与 --root 同源的锚点也用于选择阶段（selection 正常产出）
  assert.equal(withRoot.counts.selected, 14);
  assert.deepEqual(withRoot.safety.violations, []);
});

test('GAP-5: 固定 cwd 下重复运行仍字节级一致（确定性未被修复破坏）', () => {
  const a = runPreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json']);
  const b = runPreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json']);
  assert.equal(a.stdout, b.stdout, '同一 cwd 下两次运行必须字节级一致');
});

test('安全不变量未受影响：密钥路径仍不可被 include 重新纳入', () => {
  const payload = runPreview([
    '--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json',
    '--include', '**/*', '--include', '.env*', '--include', 'secrets/**',
  ]).payload;
  assert.deepEqual(payload.safety.violations, []);
  assert.equal(payload.safety.no_sensitive_selected, true);
  assert.equal(payload.selectedPaths.includes('.env.production'), false);
  assert.equal(payload.excludedPaths.includes('.env.production'), true);
});

process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

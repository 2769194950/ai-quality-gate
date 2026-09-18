#!/usr/bin/env node
// adapters/opencodereview/tools/record-fixtures.mjs
// 重录适配层夹具，并统一做占位符化，使夹具与机器/目录/cwd 无关。
//
// 用法：  node adapters/opencodereview/tools/record-fixtures.mjs
//
// 实现说明：这里**在进程内**调用与 CLI 完全相同的代码路径
//   (`src/ocr-pipeline.mjs: createPreview` / `renderMarkdown`)，
// 并用 CLI 相同的键序（sortKeysDeep + JSON.stringify(…, 2)）序列化，
// 因此产物与 `bin/ocr-preview.mjs --json` 的 stdout 逐字节一致。
// 之所以不走子进程：部分受限沙箱禁止带管道的子进程（spawn EPERM），
// 而进程内调用既等价又不受该限制。
//
// 产量：
//   test/fixtures/preview.default.json          默认预览（含 layer_trace / loaded_layers / source.path）
//   test/fixtures/preview.token-budget-300.json token 预算降级形态
//   test/fixtures/selection.default.md          --md 三列表格
//
// 重要：夹具中的绝对路径一律存为占位符（<ADAPTER_ROOT> / <REPO_ROOT> / <HOME>），
// 断言侧由 test/portable.mjs 用同一套规则还原比对。若将来新增会输出绝对路径的字段，
// 本脚本的自检会直接失败（FIXTURE_NOT_PORTABLE），避免静默漏网 —— 这正是 GAP-6 的教训。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreview, renderMarkdown } from '../src/ocr-pipeline.mjs';
import { stableStringify } from '../src/util.mjs';
import { portableize, portableizeText, ADAPTER_ROOT, REPO_ROOT, HOME_DIR, toPosix } from '../test/portable.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const adapterRoot = path.resolve(here, '..');
const demoDiff = path.join(adapterRoot, 'demo', 'diff.json');
const demoRule = path.join(adapterRoot, 'demo', 'rule.json');
const fixtures = path.join(adapterRoot, 'test', 'fixtures');

// 输入一律用**绝对路径**：这样无论从哪个 cwd 重录，输出都相同（cwd 无关）。
const CASES = [
  { file: 'preview.default.json', opts: {} },
  { file: 'preview.token-budget-300.json', opts: { tokenBudget: 300 } },
];

for (const c of CASES) {
  const { payload } = createPreview({ diff: demoDiff, cliRulePath: demoRule, ...c.opts });
  const portable = portableize(payload);
  fs.writeFileSync(path.join(fixtures, c.file), `${stableStringify(portable, 2)}\n`, 'utf8');
  process.stdout.write(`recorded ${c.file}\n`);
}

{
  const { payload } = createPreview({ diff: demoDiff, cliRulePath: demoRule });
  // Markdown 是自由文本（路径嵌在表格里）⇒ 用与断言侧相同的 portableizeText
  const md = portableizeText(renderMarkdown(payload));
  fs.writeFileSync(path.join(fixtures, 'selection.default.md'), md, 'utf8');
  process.stdout.write('recorded selection.default.md\n');
}

// 自检：夹具里不得再出现仓库 / 适配层 / 家目录的绝对路径
const offenders = [];
for (const f of [...CASES.map((c) => c.file), 'selection.default.md']) {
  const text = fs.readFileSync(path.join(fixtures, f), 'utf8');
  for (const root of [toPosix(ADAPTER_ROOT), toPosix(REPO_ROOT), toPosix(HOME_DIR)]) {
    if (root && text.includes(root)) offenders.push(`${f}: contains ${root}`);
  }
}
if (offenders.length > 0) {
  process.stderr.write(`FIXTURE_NOT_PORTABLE:\n${offenders.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('all fixtures portable (no absolute repo/home paths embedded)\n');

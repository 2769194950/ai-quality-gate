// adapters/opencodereview/test/network-vocab.test.mjs
//
// t56 / F12（medium）回归：适配层网络**模块词表**必须与引擎侧对齐。
//
// 与 t54 是**两条不同的缺陷**，本文件刻意分开记录，避免下一轮复核混淆：
//   * t54（已修）：**语法形态**——导入网络模块这件事本身即违规（`import … from` / `import()` / `require()`）。
//     t54 的 12 例确实全部同判，但**其样本未含 `dns` / `undici`**，所以那条结论覆盖不到词表维度。
//   * t56（本文件）：**词表内容**——引擎 `NET_MODULE_NAMES = ['https?','net','dns','tls','dgram','undici']`
//     含 `dns` 与 `undici`，适配层 `NET_MODULES` 早期漏了这两个（`http` 在引擎侧由正则片段 `https?` 覆盖）。
//     结果：`import 'node:dns'` / `require('undici')` 这类导入面**引擎报、适配层不报**。
// 两条并存不矛盾：词表齐全之后，t54 的形态判定才能在每个网络模块上生效。
//
// verifier 在 report-v7 的 W4 里构造的 22 格（模块名 × {import_from, require}）本文件等价覆盖：
//   http / https / net / tls / dgram / dns / http2 / undici / axios / node-fetch / got
//
// 自证（临时回退修复点后本文件必须失败，恢复后全绿）：
//   * 回退点：src/ocr-runner.mjs 的 NET_MODULES 里删掉 `'node:dns'`/`'dns'`（或 `undici` 两项）
//     ⇒ 「引擎词表每一项都必须同判」与「词表 ⊇ 引擎词表」两条用例失败。
//
// 边界不放宽：非网络模块（node:fs / os / node:path / node:crypto）与注释、否定行、纯字面量仍不报。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { NET_MODULES, scanNetworkSurface, assertNoApiKeyRequirement } from '../src/ocr-runner.mjs';
import { ADAPTER_ROOT, tempDir } from './helpers.mjs';

/**
 * 从**引擎源码文本**里解析权威词表（只读，不 import 引擎模块）。
 *
 * 为什么读文本而不是 import：适配层与引擎之间只允许「CLI 契约」对接，
 * 直接 import `packages/qgate/src/policy.mjs` 会把适配层绑到引擎内部实现上，
 * 破坏分层（引擎可自由重构内部结构）。读文本只是**测试期**断言，不进入运行时路径。
 * 这是 captain 在 t56 里点名的首选方案的退化版：做不到「单一来源导出」，
 * 就退化为「补词表 + 自检漂移」，而不是为了自动化去破坏分层。
 */
function enginePolicyPath() {
  // 自证/隔离测试场景可用环境变量把「引擎词表来源」指向真实仓库（临时副本树里没有
  // packages/ 这一层，若按相对路径解析会 ENOENT —— 那是**定位失败**，不是漂移信号）。
  const override = process.env.OCR_ENGINE_POLICY_PATH;
  if (override) return override;
  return path.join(ADAPTER_ROOT, '..', '..', 'packages', 'qgate', 'src', 'policy.mjs');
}

/** 解析引擎的 `const NET_MODULE_NAMES = [...]` 字面量，展开其中的正则片段。 */
export function readEngineNetworkVocab() {
  const p = enginePolicyPath();
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (err) {
    // 读不到必须**响亮失败**，绝不静默跳过——否则漂移自检会退化成永远通过的摆设。
    throw new Error(`无法读取引擎词表来源 ${p}: ${err.message}`);
  }
  const m = /const\s+NET_MODULE_NAMES\s*=\s*\[([^\]]*)\]/.exec(text);
  if (!m) {
    throw new Error(`引擎源码里找不到 NET_MODULE_NAMES 字面量（${p}）——引擎可能重构了；` +
      `请更新本自检的解析方式，不要直接删掉这条自检。`);
  }
  const raws = m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  if (raws.length === 0) throw new Error('NET_MODULE_NAMES 解析为空——解析方式需要更新');
  // 引擎用的是正则片段：`https?` ⇒ 展开为 http / https；其余为字面模块名。
  const expanded = [];
  for (const raw of raws) {
    if (raw === 'https?') expanded.push('http', 'https');
    else expanded.push(raw);
  }
  return { raws, expanded };
}

/** 适配层词表归一化：去掉 `node:` 前缀（引擎侧的词表不含前缀，靠 `(?:node:)?` 可选匹配）。 */
function adapterVocab() {
  return new Set(NET_MODULES.map((m) => String(m).replace(/^node:/, '')));
}

// ── 1. 漂移自检：适配层词表 ⊇ 引擎词表 ───────────────────────────────────────

test('t56/F12: 适配层网络词表 ⊇ 引擎 NET_MODULE_NAMES（防下次再漂移）', () => {
  const { raws, expanded } = readEngineNetworkVocab();
  const mine = adapterVocab();
  const missing = expanded.filter((n) => !mine.has(n));
  assert.deepEqual(
    missing,
    [],
    `适配层 NET_MODULES 缺少引擎词表项 ${JSON.stringify(missing)}；` +
      `引擎原字面量 = ${JSON.stringify(raws)}，适配层 = ${JSON.stringify([...mine].sort())}`,
  );
});

test('t56/F12: 漂移自检本身有效 —— 故意抽掉一项必须报警（不是永远通过的摆设）', () => {
  // 用**合成输入**验证「缺少项」计算本身有效，而不是再算一遍真实词表
  // （那会与上一条用例重复，且无法区分「计算有效」与「词表恰好齐全」）。
  const missingOf = (have, need) => need.filter((n) => !have.has(n));
  assert.deepEqual(missingOf(new Set(['a', 'b']), ['a', 'b']), [], '齐全时不得报警');
  assert.deepEqual(missingOf(new Set(['a']), ['a', 'b']), ['b'], '缺一项必须报警');
  assert.deepEqual(missingOf(new Set([]), ['dns', 'undici']), ['dns', 'undici'], 'F12 的缺陷形态必须被捕获');
  // 再用真实引擎词表确认：若把 dns/undici 抽掉，正是这两项缺失（锁定 F12 的缺陷形态）
  const { expanded } = readEngineNetworkVocab();
  const missing = missingOf(new Set(expanded.filter((m) => m !== 'dns' && m !== 'undici')), expanded);
  assert.deepEqual(missing.sort(), ['dns', 'undici'], '抽掉 dns/undici 后必须恰好缺这两项');
});

test('t56/F12: 引擎词表来源可读且未为空（防解析静默失效）', () => {
  const { raws, expanded } = readEngineNetworkVocab();
  assert.ok(raws.length >= 6, `引擎原字面量项数异常：${JSON.stringify(raws)}`);
  for (const must of ['dns', 'undici', 'net', 'tls', 'dgram']) {
    assert.ok(expanded.includes(must), `引擎词表应含 ${must}`);
  }
});

// ── 2. 22 格对照：模块名 × {import_from, require} ─────────────────────────────

test('t56/F12: 22 格模块词表对照 —— 引擎词表每一项的两种形态都必须被适配层报出', () => {
  // verifier W4 的 11 个模块名（含适配层与引擎**都不应报**的非网络/第三方包，用于锁定边界）
  const NET_MODULES_UNDER_TEST = ['http', 'https', 'net', 'tls', 'dgram', 'dns', 'http2', 'undici', 'axios', 'node-fetch', 'got'];
  const { expanded } = readEngineNetworkVocab();
  const engineSet = new Set(expanded);

  const forms = [];
  for (const m of NET_MODULES_UNDER_TEST) {
    forms.push({ m, kind: 'import_from', src: `import * as x from '${m}';` });
    forms.push({ m, kind: 'require', src: `const x = require('${m}');` });
  }
  assert.equal(forms.length, 22, '格数必须恰好 22（与 verifier W4 的扫描等价）');

  const dir = tempDir();
  const rows = [];
  try {
    forms.forEach((f, i) => dir.write(`g${String(i).padStart(2, '0')}.mjs`, `${f.src}\n`));
    const r = assertNoApiKeyRequirement(dir.path);
    forms.forEach((f, i) => {
      const file = `g${String(i).padStart(2, '0')}.mjs`;
      const reported = r.networkViolations.some((v) => v.startsWith(file));
      rows.push({ ...f, file, reported, engineReports: engineSet.has(f.m) });
    });
  } finally {
    dir.cleanup();
  }

  // 引擎词表内的模块必须报（这就是 F12 的修复目标）
  const shouldReport = rows.filter((r) => r.engineReports);
  for (const r of shouldReport) {
    assert.equal(r.reported, true, `引擎词表含 ${r.m} ⇒ 适配层必须报出（${r.kind}）: ${r.src}`);
  }
  // 引擎词表外的（http2/axios/node-fetch/got）**刻意不报**：这两类是引擎的
  // NET_CLIENT_NAMES / 其它 matcher 覆盖面，不在本次 F12 修复的词表维度内。
  // 这里如实锁定现状（不是「两边一样」），并在 README 里记为已知不对称。
  for (const r of rows.filter((x) => !x.engineReports)) {
    assert.equal(
      r.reported,
      false,
      `引擎词表外模块的导入面当前**不报**（本次不改，属已知不对称）: ${r.src}`,
    );
  }
  assert.equal(shouldReport.length, 14, `引擎词表内应有 7 模块 × 2 形态 = 14 格，实得 ${shouldReport.length}`);
});

test('t56/F12: 非网络模块的导入面不得被词表扩张误报（边界不放宽）', () => {
  const SAFE = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import os from 'os';",
    "const crypto = require('node:crypto');",
    "import { readFileSync } from 'node:fs';",
    "const zlib = require('zlib');",
  ];
  for (const src of SAFE) {
    assert.deepEqual(scanNetworkSurface(src).violations, [], `非网络模块不得报: ${src}`);
  }
});

test('t56/F12: 词表扩张后注释/否定行/纯字面量仍未报（边界不放宽）', () => {
  const SAFE = [
    '// see node:dns docs',
    '// require("undici") is forbidden — offline only',
    // t64/F16：星号行须**确实在块注释内**才跳过 —— 把开启符一并给出
    '/**\n * import * as d from "node:dns";\n */',
    '# undici.get(url)',
    "const s = 'node:dns';",
    'const t = `undici`;',
  ];
  for (const src of SAFE) {
    assert.deepEqual(scanNetworkSurface(src).violations, [], `注释/字面量不得报: ${src}`);
  }
});

test('t56/F12: dns / undici 的四种形态都报（与 t54 的形态判定叠加后生效）', () => {
  const CASES = [
    ["import dns from 'node:dns';", 'network-module-import'],
    ["const dns = require('dns');", 'network-module-import'],
    ['await import("node:undici");', 'network-module-import'],
    ["import { request } from 'undici';", 'network-module-import'],
  ];
  for (const [src, via] of CASES) {
    const r = scanNetworkSurface(src);
    assert.ok(r.violations.length > 0, `必须报出: ${src}`);
    assert.equal(r.violations[0].via, via, `via 标签: ${src}`);
  }
  // 词表已含 dns ⇒ 别名调用也进入调用面判定
  const aliased = scanNetworkSurface("const dns = require('node:dns');\ndns.resolve4('example.com');");
  assert.ok(aliased.violations.length >= 1, 'dns 别名调用必须被检出');
});

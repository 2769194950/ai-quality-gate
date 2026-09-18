// adapters/opencodereview/test/network-import.test.mjs
//
// t54 / R3-L3（low）回归：**导入网络模块这件事本身就是网络面**。
//
// 缺陷：引擎侧 SAFE_003 的 matcher 明确带 `network module import/require` 标签，
// 即 `import https from 'node:https';` 单独出现（不调用）也算违规；而适配层早期只在
// 「别名被调用」时才报（aliasRe 需要 `h.request(...)` 这种调用点）。于是同一个
// SAFE_003 断言在两侧的保证强度不同：引擎报、适配层不报，用户无法判断该信哪一侧。
//
// 修复：src/ocr-runner.mjs 的 scanNetworkSurface() 增加导入面判定
// `isNetworkModuleImport()`，命中后以 via='network-module-import' 报出。
//
// 自证方式（临时回退修复点后本文件必须失败，恢复后全绿）：
//   * 回退点 A：删掉 scanNetworkSurface() 里 `if (isNetworkModuleImport(line)) {...}` 分支
//     ⇒ 本文件「导入面」用例全部失败（silent），其余用例仍绿。
//   * 回退点 B：把 NET_IMPORT_RE 的 `import\s+(?:[\s\S]*?\s+from\s+)?` 分支改成必须有 `from`
//     ⇒ 「裸动态导入」用例失败。
//   回退后不得修改断言来迁就实现——断言按**引擎同判**独立写就（见文件末尾对照说明）。
//
// 边界（本文件同样锁定「不放宽」）：非网络模块（node:fs / node:path）、注释行、纯模块名
// 字符串字面量都不得被报，否则修复会变成新的可用性缺陷（也会把文档判成违规）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanNetworkSurface, assertNoApiKeyRequirement } from '../src/ocr-runner.mjs';
import { tempDir } from './helpers.mjs';

// 四种「导入但不调用」形态 + 调用形态，全部必须报。
const IMPORT_FORMS = [
  ['静态默认导入（无调用）', "import https from 'node:https';"],
  ['静态命名空间导入（无调用）', "import * as h from 'node:http';"],
  ['裸动态导入（不绑定）', 'await import("node:https");'],
  ['裸动态导入（绑定但从不调用）', 'const m = await import("node:https");'],
  ['require（不绑定调用）', "const h = require('node:http');"],
  ['裸 require（赋值给未使用变量）', "let p; p = require('node:tls');"],
];

// 调用形态：修复前后都必须报（证明修复没有用「导入面」替换掉既有调用面判定）。
const CALL_FORMS = [
  ['静态导入后调用', "import https from 'node:https';\nhttps.request('https://x');"],
  ['require 后调用', "const h = require('node:http');\nh.request('http://x');"],
  ['命名空间别名后调用', "import * as h from 'node:http';\nh.request('http://x');"],
  ['全局 fetch', "fetch('https://x');"],
  ['直接模块成员调用', "https.get('https://x');"],
];

test('t54: 导入网络模块本身即违规 —— 四种形态都不依赖调用点', () => {
  for (const [label, src] of IMPORT_FORMS) {
    const r = scanNetworkSurface(src);
    assert.ok(
      r.violations.length > 0,
      `导入网络模块必须报（${label}）: ${JSON.stringify(src)}`,
    );
    assert.equal(r.violations[0].via, 'network-module-import', `via 标签（${label}）`);
  }
});

test('t54: 调用形态仍照旧报出（修复未替换既有调用面判定）', () => {
  for (const [label, src] of CALL_FORMS) {
    const r = scanNetworkSurface(src);
    assert.ok(r.violations.length > 0, `调用面必须报（${label}）: ${JSON.stringify(src)}`);
  }
  // 静态导入 + 调用：导入行与调用行各自报一行，via 各自正确
  const r = scanNetworkSurface("import https from 'node:https';\nhttps.request('https://x');");
  assert.equal(r.violations.length, 2, '导入行与调用行应各报一次');
  assert.equal(r.violations[0].via, 'network-module-import');
  assert.equal(r.violations[1].via, 'imported-module-alias');
});

test('t54: 非网络模块不得被导入面判定误报', () => {
  const SAFE = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const p = require('node:path');",
    "import os from 'os';",
    "const { readFileSync } = require('node:fs');",
    "import { join } from 'node:path';",
  ];
  for (const src of SAFE) {
    assert.deepEqual(scanNetworkSurface(src).violations, [], `非网络模块不得报: ${src}`);
  }
});

test('t54: 注释行与否定行内的网络导入写法不被报（边界不放宽）', () => {
  const SAFE = [
    '// import https from "node:https";',
    '// require("node:https")',
    '# import https from "node:https"',
    '<!-- import https from "node:https" -->',
    '// never require("node:https") — offline only',
    '// 不得 import("node:https")',
    '// no network: fetch is forbidden',
    // t64/F16：以星号开头的行**只有在真正处于块注释内**时才被跳过。下面给出「确实在
    // 块注释内」的形态（开启符在文本中可见），它必须保持静默。
    '/**\n * import https from "node:https";\n */',
    '/*\n * require("node:https")\n */',
  ];
  for (const src of SAFE) {
    assert.deepEqual(scanNetworkSurface(src).violations, [], `注释/否定行不得报: ${src}`);
  }
});

test('t54: 纯模块名字符串字面量不被报（只有真实导入语法才算）', () => {
  for (const src of ["const s = 'node:https';", 'const s = "node:http";', 'const s = `net`;']) {
    assert.deepEqual(scanNetworkSurface(src).violations, [], `纯字面量不得报: ${src}`);
  }
});

// 与引擎 SAFE_003 的同判锁定。此处记录的是**实测**引擎行为（packages/qgate/src/policy.mjs
// 的 policySafe003），不是猜测：引擎对下面两类文本同样报 / 同样不报，适配层保持一致。
test('t54: 与引擎同判（文本级同形边界，含字面量内嵌导入语法）', () => {
  const ENGINE_REPORTS = [
    'const s = "require(\'node:https\')";',
    "const s = 'import https from \"node:https\"';",
    "const s = 'import * as h from \"node:http\"';",
  ];
  for (const src of ENGINE_REPORTS) {
    assert.ok(
      scanNetworkSurface(src).violations.length > 0,
      `引擎对此文本报违规，适配层必须同判: ${JSON.stringify(src)}`,
    );
  }
  const BOTH_SILENT = [
    "const s = 'import node:https';",
    "const s = 'import fs from \"node:fs\"';",
    "const s = 'require(\"node:fs\")';",
  ];
  for (const src of BOTH_SILENT) {
    assert.deepEqual(
      scanNetworkSurface(src).violations,
      [],
      `引擎对此文本不报，适配层必须同判: ${JSON.stringify(src)}`,
    );
  }
});

test('t54: 端到端（目录级断言）同样捕获导入面，且与 selection 无关', () => {
  const dir = tempDir();
  try {
    IMPORT_FORMS.forEach(([label, src], i) => {
      dir.write(`imp${i}.mjs`, `${src}\n`);
    });
    dir.write('safe.mjs', "import fs from 'node:fs';\nfs.readFileSync('x');\n");
    const r = assertNoApiKeyRequirement(dir.path);
    assert.equal(r.ok, false, '存在网络导入面时 ok 必须为 false');
    IMPORT_FORMS.forEach(([label], i) => {
      const hits = r.networkViolations.filter((v) => v.startsWith(`imp${i}.mjs`));
      assert.equal(hits.length, 1, `目录级必须报出（${label}）`);
      assert.match(hits[0], /\[network-module-import\]/, `目录级 via 标签（${label}）`);
    });
    assert.equal(
      r.networkViolations.some((v) => v.startsWith('safe.mjs')),
      false,
      '非网络模块文件不得被报',
    );
  } finally {
    dir.cleanup();
  }
});

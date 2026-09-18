// adapters/opencodereview/test/crossline-and-comment.test.mjs
//
// t64 回归：三项同族缺陷（都是「漏判 ⇒ 本层更松」或「对答案而非对规则」）。
//
//   * **F15（medium）跨行链式调用漏判**：适配层早期**按行**扫描命名客户端调用，而引擎按整段
//     匹配 ⇒ prettier 把长链式调用折行后（`const r = await ky\n  .get(url);`）适配层看不见。
//     prettier 默认就会这样折行，所以这是**常见代码形态**，不是边角情形。
//   * **F16（low）未闭合 `/*` 之后 ` * ` 行失明**：`isCommentLine()` 把 ` * …` 一律当 JSDoc
//     续行跳过，于是未闭合注释之后的真实代码被跳过（引擎 t46 已按 fail-closed 修过同族问题）。
//   * **F17（low）名规则拼写变体**：NTFS ADS 形态（`.env::$DATA`）只被扩展名白名单**兜住**，
//     `reason` 是 `unsupported_extension` 而不是名规则 —— 「对答案而非对规则」（R3-B1 判据）。
//
// 自证（临时回退修复点后本文件必须失败）：
//   * F15 回退点：删掉 src/ocr-runner.mjs 里 scanNetworkSurface() 末尾的「跨行链式」单元循环。
//   * F16 回退点：把 splitLogicalUnits() 里 `insideOpenBlock(idx)` 改回 `true`
//     （即恢复「星号行一律当注释」的旧行为）。
//   * F17 回退点：把 filters.mjs 的 isSensitivePath 改回不做 stripAlternateDataStream。
//
// 刻意保留的方向（不得以「同判」为名改掉）：`XMLHttpRequest()`/`WebSocket()` 直接调用本层报、
// 引擎不报（fail-closed），此文件不涉及，但 `network-client.test.mjs` 有专门用例锁死。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanNetworkSurface } from '../src/ocr-runner.mjs';
import { classifyFile, isSensitivePath, stripAlternateDataStream } from '../src/filters.mjs';
import { ADAPTER_ROOT, tempDir } from './helpers.mjs';

const RULES = { layers: [{ source: 'cli:flags', include: ['**/*'], exclude: [] }] };

/** 引擎判定（只读，不 import 引擎内部实现 —— 经 CLI 契约对接是边界，测试期读源码文本可接受）。 */
async function engineReports(src) {
  const { policySafe003 } = await import(
    pathToFileURLSafe(process.env.OCR_ENGINE_POLICY_PATH
      || path.join(ADAPTER_ROOT, '..', '..', 'packages', 'qgate', 'src', 'policy.mjs'))
  );
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 't64-eng-'));
  try {
    fs.writeFileSync(path.join(d, 'sample.mjs'), `${src}\n`);
    return policySafe003(d, {}).passed === false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}
function pathToFileURLSafe(p) {
  const u = new URL('file:///');
  u.pathname = String(p).replace(/\\/g, '/').replace(/^\//, '');
  return u.href;
}

// ── F15：跨行链式调用 ───────────────────────────────────────────────────────

test('t64/F15: prettier 折行的跨行链式调用必须被检出（修复前 5/7 漏判）', () => {
  const CASES = [
    ['名字与成员折到下一行', 'const r = await ky\n  .get(url);'],
    ['多级缩进', 'const r = await axios\n    .get(url);'],
    ['成员与实参都折行', 'const r = await client\n  .post(\n    url,\n    body,\n  );'],
    ['member=request 折行', 'const r = await got\n  .request(url);'],
    ['node-fetch 折行', 'const r = await node-fetch\n  .get(url);'],
    ['await 与名字同折（对照：修复前已报）', 'const r = await\n  ky.get(url);'],
    ['单行（对照）', 'const r = await ky.get(url);'],
  ];
  for (const [label, src] of CASES) {
    const r = scanNetworkSurface(src);
    assert.ok(r.violations.length > 0, `跨行链式调用必须报出（${label}）: ${JSON.stringify(src)}`);
    assert.equal(r.violations[0].via, 'named-network-client-call', `via 标签（${label}）`);
  }
});

test('t64/F15: 跨行补报不得与按行结果重复计数', () => {
  // 单行已报出的调用，跨行单元补报必须跳过（否则同一个调用被算两次）
  const one = scanNetworkSurface('const r = await ky.get(url);');
  assert.equal(one.violations.length, 1, `单行调用应恰好 1 条，实际 ${one.violations.length}`);
  // 折行后仍然是 1 条（不是 2 条）
  const two = scanNetworkSurface('const r = await ky\n  .get(url);');
  assert.equal(two.violations.length, 1, `折行调用应恰好 1 条，实际 ${two.violations.length}`);
  assert.equal(two.violations[0].line, 1, '报出的行号应为逻辑单元起始行');
});

test('t64/F15: 跨行链式不得引入误报 —— t58 的良性对照（22 条）仍全部静默', () => {
  const BENIGN = [
    'const v = cache.get(key);',
    "const v = headers.get('x');",
    'const m = new Map();',
    'const v = new Map().get(k);',
    'const body = response.get(name);',
    'const v = map.get(k);',
    'const v = config.get(key);',
    'const v = store.get(key);',
    'const v = registry.get(name);',
    'const v = session.get(id);',
    'const v = pool.get(id);',
    'const v = env.get(key);',
    'const v = params.get(key);',
    'const v = query.get(key);',
    'const v = formData.get(key);',
    'const v = urlSearchParams.get(k);',
    'const v = buffer.get(idx);',
    'const v = dictionary.get(k);',
    'const v = lookup.get(k);',
    'const v = memo.get(k);',
    'const v = this.cache.get(k);',
    'cache.set(k, v);',
  ];
  assert.ok(BENIGN.length >= 22, `良性集应 ≥22 条（实际 ${BENIGN.length}）`);
  for (const src of BENIGN) {
    assert.deepEqual(scanNetworkSurface(src).violations, [], `良性对照不得误报: ${src}`);
  }
  // 良性对照的**折行**形态同样不得误报（跨行逻辑单元不得把无关名字拼成命中）
  const BENIGN_MULTILINE = [
    'const v = cache\n  .get(key);',
    'const v = headers\n  .get(\'x\');',
    'const v = new Map()\n  .get(k);',
    'const v = this.cache\n  .get(k);',
  ];
  for (const src of BENIGN_MULTILINE) {
    assert.deepEqual(scanNetworkSurface(src).violations, [], `良性折行不得误报: ${JSON.stringify(src)}`);
  }
});

// ── F16：未闭合块注释之后的星号行 ────────────────────────────────────────────

test('t64/F16: 未闭合 /* 之后的 ` * ` 行不得被跳过（fail-closed）', () => {
  const MUST_REPORT = [
    ['未闭合 /* + 星号行（客户端调用）', '/*\n * axios.get(url);'],
    ['未闭合 /* + 星号行（模块导入）', '/*\n * const h = require("node:https");'],
    ['未闭合 /* 同行有内容 + 星号行', '/* oops\n * ky.get(url);'],
    ['未闭合 /** + 星号行', '/**\n * ky.get(url);'],
    ['未闭合 /* 后普通行（对照：修复前已报）', '/*\naxios.get(url);'],
  ];
  for (const [label, src] of MUST_REPORT) {
    assert.ok(scanNetworkSurface(src).violations.length > 0, `必须报出（${label}）: ${JSON.stringify(src)}`);
  }
});

test('t64/F16: 真正闭合的块注释/JSDoc 仍必须静默（不得把文档判成违规）', () => {
  const SAFE = [
    '/**\n * axios.get(url);\n */',
    '/*\n * const h = require("node:https");\n */',
    '/**\n * ky.get(url);\n */\nconst x = 1;',
    '/**\n * @param {string} url\n * @returns {Promise}\n */\nexport function f(url) { return url; }',
    '/* 单行闭合 */',
  ];
  for (const src of SAFE) {
    assert.deepEqual(scanNetworkSurface(src).violations, [], `已闭合注释必须静默: ${JSON.stringify(src)}`);
  }
});

test('t64/F16: 孤立星号片段按代码处理（与引擎同判，实测引擎同样报）', () => {
  // 关键不变量：合法 JSDoc 中 `*/` 总在其 `*` 行**之后**；若文本里根本没有开启符，
  // 这个星号就不属于任何注释块。实测引擎对同一文本**报**（本层此前因「星号行一律跳过」而不报）。
  const FRAGMENTS = [
    ' * import https from "node:https";',
    ' * const r = await axios.get(url);',
    ' * import * as d from "node:dns";',
  ];
  for (const src of FRAGMENTS) {
    assert.ok(scanNetworkSurface(src).violations.length > 0, `孤立星号片段必须按代码处理: ${src}`);
  }
});

test('t64/F16: 行注释形态（// · # · <!--）仍全部跳过', () => {
  const SAFE = [
    '// axios.get(url);',
    '# ky.get(url)',
    '<!-- node-fetch.get(url) -->',
    '// require("node:https")',
  ];
  for (const src of SAFE) {
    assert.deepEqual(scanNetworkSurface(src).violations, [], `行注释不得报: ${src}`);
  }
});

test('t64/F16: 与引擎逐例同判（交叉验证，不是自说自话）', async () => {
  const CASES = [
    '/*\n * axios.get(url);',
    '/**\n * axios.get(url);\n */',
    ' * import https from "node:https";',
    '/* 单行闭合 */',
    'const r = await ky\n  .get(url);',
    'const v = cache\n  .get(key);',
  ];
  for (const src of CASES) {
    const eng = await engineReports(src);
    const adp = scanNetworkSurface(src).violations.length > 0;
    assert.equal(adp, eng, `两侧必须同判: ${JSON.stringify(src)}（引擎=${eng} 适配层=${adp}）`);
  }
});

test('t64/F16: 状态机压力 —— 真实注释形态不得误报、不得崩溃', () => {
  const SAFE = [
    '/**\n * Module doc.\n */\nimport fs from "node:fs";\nexport const a = 1;',
    '/**\n * Never call axios.get(url) here.\n */\nexport const a = 1;',
    '/* one */\nconst a = 1;\n/* two */\nconst b = 2;',
    'const a = 1;\n */\nconst b = 2;',
    'const a = 1; // note\n/* doc */\nconst b = 2;',
    'const a = 1; // axios.get(url) forbidden',
    '/*\nimport https from "node:https";\n*/\nconst a = 1;',
    '/**\r\n * doc\r\n */\r\nconst a = 1;',
    '',
    '// just a comment',
  ];
  for (const src of SAFE) {
    assert.deepEqual(
      scanNetworkSurface(src).violations,
      [],
      `不得误报（也不得崩溃）: ${JSON.stringify(src)}`,
    );
  }
  // 注释之后紧跟真实调用时仍必须报（状态机不得把注释后的代码一并吞掉）
  assert.ok(scanNetworkSurface('/**\n * doc\n */\nfetch(url);').violations.length > 0, 'JSDoc 之后的真实 fetch 必须报');
  assert.ok(scanNetworkSurface('/*\nfetch(url);\nconst x = 1;').violations.length > 0, '未闭合注释到文件末尾仍必须报');
});

// ── F17：名规则变体（reason 必须是名规则，不是扩展名兜底）──────────────────────

test('t64/F17: NTFS ADS 变体由**名规则**命中（reason=secret_path，不是 extension 兜底）', () => {
  const CASES = [
    '.env::$DATA',
    '.env:stream',
    '.env::$INDEX_ALLOCATION',
    'credentials.json::$DATA',
    'secrets/db.txt::$DATA',
    'id_rsa::$DATA',
    'config/tls/server.pem::$DATA',
  ];
  for (const f of CASES) {
    const v = classifyFile(f, RULES, {});
    assert.equal(v.decision, 'excluded', `${f} 必须被排除`);
    assert.match(
      String(v.reason),
      /^sensitive_path_never_included$/,
      `${f} 的 reason 必须是名规则命中（实测 ${v.reason}）——不得靠扩展名白名单兜住`,
    );
    assert.equal(v.ruleId, 'SAFETY-001-SENSITIVE-PATH', `${f} 的 ruleId`);
  }
});

test('t64/F17: 修复前形态对照 —— ADS 曾落到 unsupported_extension（兜底而非名规则）', () => {
  // 这条用例锁定「兜底 vs 名规则」的区别本身：把 ADS 后缀原样送去判扩展名，
  // 得到的一定是不在白名单里的 `.env::$DATA` ⇒ 这正是修复前 reason 的来源。
  // 修复后 isSensitivePath 先切 ADS，所以名规则先命中。
  assert.equal(stripAlternateDataStream('.env::$DATA'), '.env');
  assert.equal(stripAlternateDataStream('.env:stream'), '.env');
  assert.equal(stripAlternateDataStream('secrets/db.txt::$DATA'), 'secrets/db.txt');
  assert.equal(stripAlternateDataStream('config/tls/server.pem::$DATA'), 'config/tls/server.pem');
  assert.equal(stripAlternateDataStream('src/app.mjs'), 'src/app.mjs', '无 ADS 的路径不得被改动');
  // 只切**最后一段**里的冒号后缀：目录段里的冒号不受影响
  assert.equal(stripAlternateDataStream('weird:dir/a.mjs'), 'weird:dir/a.mjs', '目录段的冒号不得被切');
  assert.equal(stripAlternateDataStream('weird:dir/a.mjs:stream'), 'weird:dir/a.mjs', '只切最后一段');
  assert.equal(isSensitivePath('.env::$DATA'), true);
  assert.equal(isSensitivePath('.env'), true);
  assert.equal(isSensitivePath('src/app.mjs'), false, '普通文件不得被误判');
});

test('t64/F17: 尾随/前导空白变体仍被排除（但 reason 是结构规则兜底，如实记录）', () => {
  const CASES = ['.env ', ' .env', '  .env  '];
  for (const f of CASES) {
    const v = classifyFile(f, RULES, {});
    assert.equal(v.decision, 'excluded', `${JSON.stringify(f)} 必须仍被排除（安全判定未放宽）`);
    // 如实断言：这类形态当前走的是**扩展名白名单兜底**，不是名规则。
    // 实测理由：Windows **不**剥尾随空格（见下一条用例），所以 `.env ` 与 `.env` 是两个不同文件，
    // 把它们当同一个名字判反而引入事实错误。这里锁定现状，不假装它是名规则命中。
    assert.match(String(v.reason), /^unsupported_extension:/, `${JSON.stringify(f)} 当前由结构规则兜底`);
  }
});

test('t64/F17: 实测证据 —— Windows 不剥尾随空格（故刻意不 trim）', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 't64-ws-'));
  try {
    fs.writeFileSync(path.join(d, '.env '), 'x');
    const entries = fs.readdirSync(d);
    assert.deepEqual(entries, ['.env '], '尾随空格必须被保留（readdir 返回原名）');
    assert.equal(fs.existsSync(path.join(d, '.env')), false, '`.env ` 与 `.env` 不是同一个文件');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('t64/F17: 8.3 短名（CREDEN~1.JSON）在本环境无法可靠判定 —— 已知边界', () => {
  // verifier 实测 `fsutil 8dot3name query` ⇒ Access denied（需权限，本层也不得依赖外部命令）。
  // 本次独立复核（不依赖 fsutil）得到**决定性**事实：
  //   在本环境的 C: 卷上，`credentials.json` 的 8.3 别名是 `CREDEN~1.JSO`（存在），
  //   而 `CREDEN~1.JSON` **不存在**；且**创建** `CREDEN~1.JSON` 后 `credentials.json` 内容不变
  //   ⇒ `CREDEN~1.JSON` 是一个**独立的字面文件**，不是别名。
  // 因此本层对它「按字面文件名处理」是**正确**行为，不是漏判；同时本层**无法**枚举别名映射
  // （Node 无相关 API，别名取决于卷是否启用 8.3 与创建顺序），故不猜测。
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 't64-83-'));
  try {
    fs.writeFileSync(path.join(d, 'credentials.json'), 'x');
    const aliasExists = fs.existsSync(path.join(d, 'CREDEN~1.JSO'));
    const jsonNameExists = fs.existsSync(path.join(d, 'CREDEN~1.JSON'));
    // 环境相关：若该卷未启用 8.3，别名不存在也正常 —— 两种情况都如实接受，但**必须**二选一为真
    assert.ok(
      aliasExists || !jsonNameExists,
      '要么 8.3 别名存在（则别名是 ~1.JSO 形态），要么 8.3 未启用；~1.JSON 不应被解析为别名',
    );
    // 关键断言（环境无关）：`CREDEN~1.JSON` 不指向 credentials.json
    fs.writeFileSync(path.join(d, 'CREDEN~1.JSON'), 'ZZZZ');
    assert.equal(fs.readFileSync(path.join(d, 'credentials.json'), 'utf8'), 'x',
      'CREDEN~1.JSON 不得是 credentials.json 的别名（写它不应改动基础文件）');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
  // 本层对短名不猜：名规则不会命中它（它不含敏感词），但同一文件的**真名**必须被排除
  assert.equal(isSensitivePath('CREDEN~1.JSON'), false, '不含敏感词 ⇒ 名规则不得猜测性命中');
  assert.equal(classifyFile('credentials.json', RULES, {}).reason, 'sensitive_path_never_included',
    '真名必须由名规则排除（这是本层能给出的保证）');
});

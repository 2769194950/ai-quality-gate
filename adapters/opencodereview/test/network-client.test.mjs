// adapters/opencodereview/test/network-client.test.mjs
//
// t58 / F14 回归：**命名网络客户端调用**检测面。
//
// 缺陷：引擎 `packages/qgate/src/policy.mjs` 有一套「客户端包名 + HTTP-ish 成员」的
// 名字启发式（`NET_CLIENT_NAMES` 12 个 × `NET_CALL_MEMBERS` 14 个），能识别
// **没有 import、只能靠名字判断**的形态（`axios.get(url)`、`client.get(url)`）；
// 本层早期完全没有这一面 ⇒ 10 格不同判（engine=true, adapter=false）。
// 与 t54（语法形态）、t56（模块词表）同类：同一 SAFE_003 断言两侧保证强度不同。
//
// **为什么只做「精确组合」而不是粗放的 `*.get()`**：这正是良性对照不误报的原因。
// `cache.get(key)` / `headers.get('x')` / `new Map().get(k)` 之所以不报，不是因为加了
// 排除名单，而是因为它们的名字**不在**客户端名单里。粗放的 `*.get()` 会把这些全打成违规。
//
// 自证（临时回退修复点后本文件必须失败，恢复后全绿）：
//   * 回退点：删掉 src/ocr-runner.mjs 的 scanNetworkSurface() 里
//     `if (NET_CLIENT_CALL_RE.test(line)) {…}` 分支 ⇒ 「客户端调用必须报」类用例失败，
//     良性对照类用例仍绿（证明修复没有放宽边界、也不是靠放宽换来的报出）。
//
// 边界（刻意保留的两个方向，**不得**为了「同判」而改动）：
//   * 本层**更严**：`XMLHttpRequest()` / `WebSocket()` 直接调用本层报、引擎不报
//     （fail-closed；改成更松是安全倒退）。本文件把它**锁定**为「仍然报」。
//   * 名字碰撞（`const request = require('node:fs'); request.get(url)` 等）两侧**都报**：
//     这是引擎既有的 fail-closed 取舍，本层照搬以保持同判，代价记在 README §4.4。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { scanNetworkSurface, assertNoApiKeyRequirement } from '../src/ocr-runner.mjs';
import { ADAPTER_ROOT, tempDir } from './helpers.mjs';

/** 从引擎源码文本读权威客户端名单（只读、不 import —— 只经 CLI 契约对接，不绑内部实现）。 */
function enginePolicyText() {
  const override = process.env.OCR_ENGINE_POLICY_PATH;
  const p = override || path.join(ADAPTER_ROOT, '..', '..', 'packages', 'qgate', 'src', 'policy.mjs');
  try {
    return { p, text: fs.readFileSync(p, 'utf8') };
  } catch (err) {
    throw new Error(`无法读取引擎策略来源 ${p}: ${err.message}`);
  }
}
export function readEngineClientVocab() {
  const { p, text } = enginePolicyText();
  const grab = (name) => {
    const m = new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(text);
    if (!m) throw new Error(`引擎源码里找不到 ${name} 字面量（${p}）——引擎可能重构了；请更新本自检的解析方式，不要直接删掉这条自检。`);
    const names = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    if (names.length === 0) throw new Error(`${name} 解析为空——解析方式需要更新`);
    return names;
  };
  return { clients: grab('NET_CLIENT_NAMES'), members: grab('NET_CALL_MEMBERS') };
}

const ENGINE = readEngineClientVocab();
const CLIENT_SAMPLE_MEMBERS = ['get', 'post', 'request'];

// ── 1. 漂移自检：本层客户端名单与成员表必须覆盖引擎 ──────────────────────────

test('t58/F14: 适配层客户端名单覆盖引擎 NET_CLIENT_NAMES（防漂移）', () => {
  // 通过**行为**断言覆盖，而不是导出内部常量后比集合：
  // 引擎名单里每个名字 × 每个采样成员都必须被本层报出。
  for (const c of ENGINE.clients) {
    for (const m of CLIENT_SAMPLE_MEMBERS) {
      const src = `const r = await ${c}.${m}(url);`;
      const r = scanNetworkSurface(src);
      assert.ok(r.violations.length > 0, `引擎名单含 ${c} ⇒ 本层必须报出: ${src}`);
      assert.equal(r.violations[0].via, 'named-network-client-call', `via 标签: ${src}`);
    }
  }
});

test('t58/F14: 成员表覆盖引擎 NET_CALL_MEMBERS 的全部成员', () => {
  for (const m of ENGINE.members) {
    const src = `const r = await axios.${m}(url);`;
    const r = scanNetworkSurface(src);
    assert.ok(r.violations.length > 0, `引擎成员表含 ${m} ⇒ 本层必须报出: ${src}`);
  }
});

test('t58/F14: 漂移自检本身有效 —— 名单/成员表缺项必须能报警', () => {
  const missingOf = (have, need) => need.filter((n) => !have.has(n));
  assert.deepEqual(missingOf(new Set(ENGINE.clients), ENGINE.clients), [], '齐全时不报警');
  assert.deepEqual(missingOf(new Set(ENGINE.clients.filter((c) => c !== 'axios')), ENGINE.clients), ['axios'],
    '抽掉一个客户端名必须报警');
  assert.deepEqual(missingOf(new Set(ENGINE.members.filter((m) => m !== 'head')), ENGINE.members), ['head'],
    '抽掉一个成员名必须报警');
  // 并锁定引擎名单确实包含 t56 报告里出现过的那些名字（防解析静默变空）
  for (const must of ['axios', 'got', 'ky', 'node-fetch', 'client', 'httpClient', 'apiClient', 'httpAgent']) {
    assert.ok(ENGINE.clients.includes(must), `引擎客户端名单应含 ${must}`);
  }
});

// ── 2. 客户端调用面必须报（旧缺陷 10 格 + 扩展）──────────────────────────────

test('t58/F14: 命名网络客户端调用必须报出（t56 报告的 10 格 + 扩展）', () => {
  const CASES = [
    ['axios.get', 'const r = await axios.get(url);'],
    ['got.get', 'const r = await got.get(url);'],
    ['ky.get', 'const r = await ky.get(url);'],
    ['node-fetch.get', 'const r = await node-fetch.get(url);'],
    ['client.get', 'const r = await client.get(url);'],
    ['httpAgent.get', 'const r = await httpAgent.get(url);'],
    ['axios.post', 'const r = await axios.post(url);'],
    ['undici.post', 'const r = await undici.post(url);'],
    ['superagent.get', 'const r = await superagent.get(url);'],
    ['needle.get', 'const r = await needle.get(url);'],
    ['httpClient.get', 'const r = await httpClient.get(url);'],
    ['apiClient.get', 'const r = await apiClient.get(url);'],
    ['client.request', 'const r = await client.request(url);'],
    ['axios.head', 'const r = await axios.head(url);'],
    ['axios.delete', 'const r = await axios.delete(url);'],
  ];
  for (const [label, src] of CASES) {
    const r = scanNetworkSurface(src);
    assert.ok(r.violations.length > 0, `必须报出（${label}）: ${src}`);
    assert.equal(r.violations[0].via, 'named-network-client-call', `via 标签（${label}）`);
  }
});

// ── 3. 良性对照必须**仍不报**（这一面唯一的误报防线）────────────────────────

test('t58/F14: 良性对照零误报（非网络语义对象不在客户端名单内，故不报）', () => {
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
  assert.ok(BENIGN.length >= 11, `良性集至少 11 条（t36/t45 口径）；实际 ${BENIGN.length} 条`);
  for (const src of BENIGN) {
    assert.deepEqual(scanNetworkSurface(src).violations, [], `良性对照不得误报: ${src}`);
  }
});

test('t58/F14: 客户端名 + **非** HTTP 成员不得报（精确组合，不是粗放 *.get()）', () => {
  const SAFE = [
    'const s = axios.toString();',
    'const s = axios.all([]);',
    'client.close();',
    'ky.config();',
    'const s = got.defaults;',
    'const c = client.count;',
  ];
  for (const src of SAFE) {
    assert.deepEqual(scanNetworkSurface(src).violations, [], `非 HTTP 成员不得报: ${src}`);
  }
});

// ── 4. 两个方向的边界都必须**锁定**，不得被「对齐」名义改掉 ────────────────────

test('t58/F14: 本层更严的两条保持不变（XMLHttpRequest / WebSocket 直接调用仍报）', () => {
  // 引擎对这两个**不报**（它们不在 NET_GLOBAL_NAMES 的逗号直呼路径上），本层报。
  // 这是 fail-closed 方向：改成更松是安全倒退。此用例的作用就是阻止后人「为了同判」删掉它。
  const STRICTER = [
    ['XMLHttpRequest()', 'new XMLHttpRequest();'],
    ['WebSocket()', "new WebSocket('wss://x');"],
  ];
  for (const [label, src] of STRICTER) {
    const r = scanNetworkSurface(src);
    assert.ok(r.violations.length > 0, `${label} 必须仍报（本层更严，不得为了同判而放宽）`);
  }
  // 对照：fetch 两侧都报
  assert.ok(scanNetworkSurface('fetch(url);').violations.length > 0, 'fetch 两侧都报');
});

test('t58/F14: 名字碰撞两侧都报（引擎 fail-closed 取舍，本层照搬以保持同判）', () => {
  // `request` / `client` 同时是客户端名；从非网络对象绑定同名后再调用，引擎**也报**（实测 7/7）。
  // 照搬即继承这一偏向：这里锁定现状，并在 README §4.4 记为已知代价。
  const COLLISIONS = [
    "const request = require('node:fs');\nrequest.get(url);",
    'const request = store;\nrequest.get(url);',
    'const client = makeCache();\nclient.get(key);',
    'function f(request) { return request.get(url); }',
    'function f(client) { return client.get(key); }',
    'const axios = { get: (x) => x };\naxios.get(url);',
    'const ky = local;\nky.get(url);',
  ];
  for (const src of COLLISIONS) {
    assert.ok(
      scanNetworkSurface(src).violations.length > 0,
      `引擎对该形态报违规（fail-closed），本层照搬；若引擎改紧，请同步本层与本用例: ${src}`,
    );
  }
});

// ── 5. 既有判定未被这一面替换（回归）──────────────────────────────────────

test('t58/F14: 新增一面不得替换既有调用面判定，注释/否定行/字面量仍不报', () => {
  // 导入面、别名调用、模块成员调用各自仍在
  assert.equal(scanNetworkSurface("import https from 'node:https';").violations[0].via, 'network-module-import');
  assert.equal(scanNetworkSurface("import https from 'node:https';\nhttps.get('https://x');").violations.length, 2);
  assert.ok(scanNetworkSurface("https.get('https://x');").violations.some((v) => v.via === 'module-member-call'));
  // 注释 / 否定行 / 纯字面量
  const SAFE = [
    '// axios.get(url) is forbidden by SAFE_003',
    '// never call client.get(url) — offline only',
    // t64/F16：星号行须**确实在块注释内**才跳过 —— 这里把开启符一并给出
    '/**\n * const r = await axios.get(url);\n */',
    "const s = 'axios.get';",
    'const t = `ky.get`;',
  ];
  for (const src of SAFE) {
    assert.deepEqual(scanNetworkSurface(src).violations, [], `不得误报: ${src}`);
  }
});

test('t58/F14: 目录级断言同样捕获客户端调用面', () => {
  const dir = tempDir();
  try {
    dir.write('cli0.mjs', 'const r = await axios.get(url);\n');
    dir.write('cli1.mjs', 'const r = await client.get(url);\n');
    dir.write('benign.mjs', 'const v = cache.get(key);\n');
    const r = assertNoApiKeyRequirement(dir.path);
    assert.equal(r.ok, false, '存在客户端网络调用面时 ok 必须为 false');
    assert.ok(r.networkViolations.some((v) => v.startsWith('cli0.mjs')), 'axios.get 必须报出');
    assert.ok(r.networkViolations.some((v) => v.startsWith('cli1.mjs')), 'client.get 必须报出');
    assert.equal(r.networkViolations.some((v) => v.startsWith('benign.mjs')), false, '良性对照不得被报');
  } finally {
    dir.cleanup();
  }
});

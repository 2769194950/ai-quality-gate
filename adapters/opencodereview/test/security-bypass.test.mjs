// adapters/opencodereview/test/security-bypass.test.mjs
// t33 三类安全绕过的回归测试（1 blocker + 2 high）：
//   B1 大小写绕过        —— `Credentials.json` / `Secrets/db.txt` / `.ENV` 曾被 INCLUDED
//   H2 硬链接别名绕过    —— `docs.txt` 硬链接到 `.env` 曾被 INCLUDED（内容即密钥）
//   H3 SAFE_001/003 写法 —— env 名大小写变体与网络调用（含静态 import 别名）曾 BYPASS
//
// 本文件同时锁定「不误报」：普通标签文本、占位符文件、无害硬链接不得被判为密钥材料，
// 否则修复会变成新的可用性缺陷。
//
// 自证方式（每个用例都可用「临时回退修复点」复核，详见各处注释）：
//   * B1 回退点：src/filters.mjs 的 isSensitivePath / isInDefaultExcludedDir 去掉 toLowerCase()
//   * H2 回退点：src/filters.mjs 的 classifyFile 里删掉 step 2b（hardlink 分支）
//   * H3 回退点：src/ocr-runner.mjs 的 KEY_READ_PATTERNS 去掉 'i' 标志 / 删掉 scanNetworkSurface
//   回退后对应用例必须失败，恢复后全绿。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  isSensitivePath,
  isInDefaultExcludedDir,
  isBinaryFile,
  isSupportedExtension,
  isSensitiveExtension,
  looksLikeSecretMaterial,
  detectHardlinkSecret,
  classifyFile,
} from '../src/filters.mjs';
import { assertNoApiKeyRequirement, scanNetworkSurface, extractNetworkAliases } from '../src/ocr-runner.mjs';
import { assertNoSensitiveSelected } from '../src/selection.mjs';
import { createPreview } from '../src/ocr-pipeline.mjs';
import { DEMO_DIFF, DEMO_RULE, ADAPTER_ROOT, runPreview, tempDir, writeDiff } from './helpers.mjs';

// ── B1：大小写绕过（blocker）────────────────────────────────────────────────

test('B1: 敏感路径匹配大小写不敏感（路径级）', () => {
  const variants = [
    'credentials.json', 'Credentials.json', 'CREDENTIALS.JSON', 'Credentials',
    'secrets/db.txt', 'Secrets/db.txt', 'SECRETS/DB.TXT', 'a/Secrets/b/x.txt',
    '.env', '.ENV', '.Env', '.eNv',
    '.env.production', '.Env.Production', '.ENV.PRODUCTION',
    'id_rsa', 'ID_RSA', 'Id_Rsa', 'id_RSA.pub',
    'config/tls/server.pem', 'CONFIG/TLS/SERVER.PEM', 'Config/Tls/Server.Pem',
    'service-account.json', 'Service-Account.json',
  ];
  for (const p of variants) assert.equal(isSensitivePath(p), true, `大小写变体必须被判为敏感: ${p}`);
  // 反向：普通文件不得误判
  for (const p of ['src/app.mjs', 'README.md', 'docs/00-requirements.md', 'environments/prod.yaml']) {
    assert.equal(isSensitivePath(p), false, `不得误判为敏感: ${p}`);
  }
});

test('B1: 默认排除目录与密钥扩展名同样大小写不敏感', () => {
  // 默认排除目录（`.GIT/`、`NODE_MODULES/` 在大小写不敏感文件系统上是同一目录）
  assert.equal(isInDefaultExcludedDir('NODE_MODULES/x.js'), 'node_modules');
  assert.equal(isInDefaultExcludedDir('.GIT/config'), '.git');
  assert.equal(isInDefaultExcludedDir('Dist/a.js'), 'dist');
  assert.equal(isInDefaultExcludedDir('SRC/APP.MJS'), null, '普通目录不得误判');
  // 二进制扩展名大小写不敏感（`.PNG` 也是二进制）
  assert.equal(isBinaryFile('assets/logo.PNG').binary, true);
  assert.equal(isBinaryFile('a/B.LOGO.png').binary, true);
  // 密钥扩展名（`.PEM`/`.KEY`）按二进制处理，双保险
  assert.equal(isSensitiveExtension('CONFIG/TLS/SERVER.PEM'), true);
  assert.equal(isSensitiveExtension('a/b.key'), true);
  assert.equal(isBinaryFile('CONFIG/TLS/SERVER.PEM').binary, true);
  // 支持扩展名判定不因大写而失效（白名单按小写归一化）
  assert.equal(isSupportedExtension('SRC/APP.MJS'), true);
  assert.equal(isSupportedExtension('App.MJS'), true);
});

test('B1: diff 模式下大小写变体被排除，且安全断言与事实一致（端到端）', () => {
  const dir = tempDir();
  try {
    const diff = writeDiff(dir.path, 'diff.json', [
      { path: 'Credentials.json' }, { path: 'Secrets/db.txt' }, { path: '.ENV' }, { path: '.Env.production' },
      { path: 'ID_RSA' }, { path: 'CONFIG/TLS/SERVER.PEM' },
      { path: 'src/app.mjs' },
    ]);
    const p = runPreview(['--diff', diff, '--json', '--home', path.join(dir.path, 'nohome')]).payload;
    assert.deepEqual(p.selectedPaths, ['src/app.mjs'], `只有普通源码可被纳入，实际: ${JSON.stringify(p.selectedPaths)}`);
    for (const bad of ['Credentials.json', 'Secrets/db.txt', '.ENV', '.Env.production', 'ID_RSA', 'CONFIG/TLS/SERVER.PEM']) {
      assert.equal(p.excludedPaths.includes(bad), true, `${bad} 必须被排除`);
      assert.equal(p.selectedPaths.includes(bad), false, `${bad} 不得被纳入`);
    }
    // safety 断言必须与事实一致：没有敏感路径落入 selected
    assert.equal(p.safety.no_sensitive_selected, true);
    assert.deepEqual(p.safety.violations, []);
    const stillSensitive = p.selectedPaths.filter((f) => isSensitivePath(f));
    assert.deepEqual(stillSensitive, [], `selected 中不得含敏感路径: ${stillSensitive.join(', ')}`);
  } finally {
    dir.cleanup();
  }
});

test('B1: safety 断言不再给出假保证（伪断言与真实断言一致）', () => {
  const dir = tempDir();
  try {
    // 关键：用「只看 isSensitivePath 的伪断言」与「classifyFile 的真实判定」对照，
    // 修复前前者会给 true（假保证）而后者发现敏感文件其实被纳入。
    const diff = writeDiff(dir.path, 'diff.json', [{ path: 'Credentials.json' }, { path: 'src/app.mjs' }]);
    const p = runPreview(['--diff', diff, '--json', '--home', path.join(dir.path, 'nohome')]).payload;
    const includedSensitive = p.selectedPaths.filter((f) => isSensitivePath(f));
    assert.deepEqual(includedSensitive, [], '被纳入的敏感文件必须为空（否则 safety 是假保证）');
    // 逐文件复核：'../Credentials.json' 的判定必须是 excluded + 敏感原因
    const verdict = classifyFile('Credentials.json', { layers: [{ source: 'cli:flags', include: ['**/*'], exclude: [] }] }, {});
    assert.equal(verdict.decision, 'excluded');
    assert.equal(verdict.reason, 'sensitive_path_never_included');
    assert.equal(verdict.severity, 'blocker');
    // 即使最宽泛 include 也救不回大小写变体
    const widest = classifyFile('Secrets/db.txt', { layers: [{ source: 'cli:flags', include: ['**/*', '**/Secrets/**'], exclude: [] }] }, {});
    assert.equal(widest.decision, 'excluded', 'include 不得救回大小写变体');
  } finally {
    dir.cleanup();
  }
});

// ── H2：硬链接别名绕过（high）──────────────────────────────────────────────

test('H2: 硬链接到密钥内容 ⇒ 被排除并给出机器可读原因（不再静默纳入）', () => {
  const dir = tempDir();
  try {
    const root = path.join(dir.path, 'repo');
    fs.mkdirSync(root, { recursive: true });
    // 真实密钥形态的内容（非占位符）
    fs.writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=sk-ant-api03-REALLOOKINGKEY1234567890abcdef\n');
    fs.writeFileSync(path.join(root, 'docs.txt'), 'harmless title\n');
    // 用 docs.txt 覆盖成 .env 的硬链接（reviewer 的等价复现：本机 symlink 无权限）
    fs.rmSync(path.join(root, 'docs.txt'));
    let linked = true;
    try {
      fs.linkSync(path.join(root, '.env'), path.join(root, 'docs.txt'));
    } catch (e) {
      linked = false;
      assert.ok(true, `本环境不支持硬链接，跳过该子断言: ${e.message}`);
    }
    if (!linked) return;

    const p = runPreview(['--root', root, '--home', path.join(dir.path, 'nohome'), '--json']).payload;
    assert.equal(p.selectedPaths.includes('docs.txt'), false, '硬链接别名不得被静默纳入');
    assert.equal(p.excludedPaths.includes('docs.txt'), true, '硬链接别名必须出现在 excluded');
    const entry = p.excluded.find((e) => e.path === 'docs.txt');
    assert.match(entry.reason, /^hardlink_secret_alias:/, `原因必须机器可读且指明硬链接别名，实际 ${entry.reason}`);
    assert.equal(entry.rule_id, 'SAFETY-005-HARDLINK-ALIAS');
    // 安全断言与事实一致
    assert.equal(p.safety.no_sensitive_selected, true);
    assert.deepEqual(p.safety.violations, []);
  } finally {
    dir.cleanup();
  }
});

test('H2: 密钥形态内容扫描的精确性（真密钥命中、占位符与文档不误报）', () => {
  // 真密钥形态 ⇒ 命中
  for (const s of [
    'ANTHROPIC_API_KEY=sk-ant-api03-abc123DEF456ghi789JKL012mno\n',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----\n',
    'api_key = "a1b2c3d4e5f6g7h8i9j0"\n',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789\n',
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n',
  ]) {
    assert.equal(looksLikeSecretMaterial(s).secret, true, `应判为密钥材料: ${s.slice(0, 40)}`);
  }
  // 占位符 / 文档 / 普通文本 ⇒ 不命中（避免修复引入误报）
  for (const s of [
    'ANTHROPIC_API_KEY=PLACEHOLDER-NOT-A-REAL-KEY\n',
    'ANTHROPIC_API_KEY=placeholder-not-a-real-key\n',
    'API_KEY=your-api-key-here\n',
    'API_KEY=${ANTHROPIC_API_KEY}\n',
    'DATABASE_URL=postgres://demo:DEMO_ONLY_PLACEHOLDER@localhost:5432/demo\n',
    '// see docs/01-architecture.md for api_key handling\n',
    '{"type":"service_account","private_key":"PLACEHOLDER-NOT-A-REAL-KEY"}\n',
    'export const API_KEY = process.env.X;\n',
    '# just a heading\n',
  ]) {
    assert.equal(looksLikeSecretMaterial(s).secret, false, `不得误报为密钥材料: ${s.slice(0, 46)}`);
  }
});

test('H2: 单链接普通文件零影响（不做内容扫描、不误排除）', () => {
  const dir = tempDir();
  try {
    // 普通单链接文件，即使内容里出现密钥样式字符串，也不因「硬链接」被排除
    const f = dir.write('src/app.mjs', 'export const a = 1;\n');
    const verdict = detectHardlinkSecret('src/app.mjs', f, {});
    assert.equal(verdict.alias, false, 'nlink=1 的文件不得被判为硬链接别名');
    assert.equal(verdict.nlink, 1);
  } finally {
    dir.cleanup();
  }
});

// ── H3：SAFE_001 用户环境变量名写法矩阵（8 种）────────────────────────────

test('H3: SAFE_001 覆盖 8 种 env 名写法（含大小写变体与 bracket 形式）', () => {
  const dir = tempDir();
  try {
    const CASES = [
      'const k = process.env.ANTHROPIC_API_KEY;',
      'const k = process.env.anthropic_api_key;',
      'const k = process.env.Anthropic_Api_Key;',
      "const k = process.env['ANTHROPIC_API_KEY'];",
      "const k = process.env['anthropic_api_key'];",
      "const k = process.env['openai_api_key'];",
      'const k = process.env.OPENAI_API_KEY;',
      'const k = process.env.MY_SECRET;',
    ];
    CASES.forEach((src, i) => dir.write(`f${i}.mjs`, `${src}\n`));
    const r = assertNoApiKeyRequirement(dir.path);
    CASES.forEach((src, i) => {
      const hit = r.violations.some((v) => v.startsWith(`f${i}.mjs`));
      assert.equal(hit, true, `必须检出（大小写不敏感）: ${src}`);
    });
  } finally {
    dir.cleanup();
  }
});

test('H3: SAFE_001 额外覆盖解构 / getenv / vault，且不误报普通文本', () => {
  const dir = tempDir();
  try {
    dir.write('d.mjs', 'const { ANTHROPIC_API_KEY } = process.env;\n');
    dir.write('e.mjs', "const k = getenv('OPENAI_API_KEY');\n");
    dir.write('f.mjs', 'const k = vault.GITHUB_TOKEN;\n');
    // 不误报：注释、普通标识符、说明性英文
    dir.write('ok1.mjs', '// process.env.ANTHROPIC_API_KEY is never read (never used)\n');
    dir.write('ok2.mjs', 'export const apiKeyName = "ANTHROPIC_API_KEY";\n');
    dir.write('ok3.mjs', 'export function health() { return { status: "ok" }; }\n');
    const r = assertNoApiKeyRequirement(dir.path);
    for (const f of ['d.mjs', 'e.mjs', 'f.mjs']) {
      assert.equal(r.violations.some((v) => v.startsWith(f)), true, `${f} 必须被检出`);
    }
    for (const f of ['ok1.mjs', 'ok2.mjs', 'ok3.mjs']) {
      assert.equal(r.violations.some((v) => v.startsWith(f)), false, `${f} 不得误报（仅名字或注释）`);
    }
  } finally {
    dir.cleanup();
  }
});

// ── H3：SAFE_003 网络调用面（4 种写法，含静态 import 别名）────────────────

test('H3: SAFE_003 检出 4 种网络写法（含静态命名空间 import 别名与动态 import）', () => {
  const CASES = [
    ['默认导入', "import https from 'node:https';\nhttps.request('https://x');"],
    ['动态 import', "const h = await import('node:http');\nh.request('http://x');"],
    ['静态命名空间别名', "import * as h from 'node:http';\nh.request('http://x');"],
    ['全局 fetch', "fetch('https://x');"],
  ];
  const dir = tempDir();
  try {
    CASES.forEach(([label, src], i) => dir.write(`n${i}.mjs`, `${src}\n`));
    const r = assertNoApiKeyRequirement(dir.path);
    CASES.forEach(([label, src], i) => {
      const hit = r.networkViolations.some((v) => v.startsWith(`n${i}.mjs`));
      assert.equal(hit, true, `必须检出网络写法（${label}）: ${src}`);
    });
  } finally {
    dir.cleanup();
  }
});

test('H3: SAFE_003 别名解析与不误报（解构成员、require 形态、普通文本）', () => {
  // 别名解析
  assert.ok(extractNetworkAliases("import * as h from 'node:http';").aliases.has('h'));
  assert.ok(extractNetworkAliases("import https from 'node:https';").aliases.has('https'));
  assert.ok(extractNetworkAliases("const h = require('node:http');").aliases.has('h'));
  assert.ok(extractNetworkAliases("const { request } = await import('node:http');").bareFuncs.has('request'));
  // 不误报
  for (const safe of [
    'export function request() { return 1; }\n',
    'const handler = (req, res) => res.end("ok");\n',
    '// fetch(...) is forbidden by SAFE_003\n',
    'import fs from "node:fs";\nfs.readFileSync("x");\n',
  ]) {
    assert.deepEqual(scanNetworkSurface(safe).violations, [], `不得误报网络调用: ${safe.trim()}`);
  }
});

test('H3: 适配层自身源码通过两个扫描器（self-scan，防误报回归）', () => {
  for (const d of ['src', 'bin']) {
    const r = assertNoApiKeyRequirement(path.join(ADAPTER_ROOT, d));
    assert.deepEqual(r.violations, [], `${d}/ 出现密钥读取（或扫描器误报）`);
    assert.deepEqual(r.networkViolations, [], `${d}/ 出现网络调用面（或扫描器误报）`);
    assert.equal(r.ok, true);
  }
});

test('H2: safety 断言可独立捕获硬链接偷渡（不依赖路径过滤的正确性）', () => {
  const dir = tempDir();
  try {
    const root = path.join(dir.path, 'repo');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6\n');
    let linked = true;
    try {
      fs.linkSync(path.join(root, '.env'), path.join(root, 'notes.txt'));
    } catch {
      linked = false;
    }
    if (!linked) return; // 本环境不支持硬链接
    const { selection, payload } = createPreview({ root, homeDir: path.join(dir.path, 'nohome') });
    // 修复后的选择确实排除了它，且 payload 给出机器可读告警字段
    assert.equal(selection.included.some((i) => i.path === 'notes.txt'), false);
    assert.deepEqual(payload.safety.hardlink_aliases, [], '未偷渡时该字段应为空数组');
    // 断言本身不依赖 isSensitivePath：构造一个「路径无害但内容即密钥」的入选项，
    // 模拟路径过滤被回归破坏的场景 —— 断言仍必须失败（否则它只是复述路径判定）。
    const fakeSelection = { included: [{ path: 'notes.txt' }, { path: '.env' }], sizeRoot: root };
    const r = assertNoSensitiveSelected(fakeSelection);
    assert.equal(r.ok, false, '断言必须在内容层独立发现硬链接密钥（否则是假保证）');
    assert.equal(r.hardlinkAliases.length >= 1, true, '应记录机器可读的硬链接别名条目');
    assert.match(r.hardlinkAliases[0].via, /secret-content|same-inode/);
  } finally {
    dir.cleanup();
  }
});

// ── 理由串语义：D06 与 D04 必须可区分（t51） ────────────────────────────────
test('D06: `.lock` 与二进制扩展名的排除理由串不重叠（各自语义独立，且都仍排除）', () => {
  const rules = { layers: [{ source: 'cli:flags', include: ['**/*'], exclude: [] }] };
  // `.lock` 属「不支持扩展名」（SAFETY-004），`.PNG` 属「二进制扩展名」（SAFETY-003）。
  // 早期 `.lock` 被放在 BINARY_EXTENSIONS 里，两者理由串都是 `binary_file:extension`，
  // 掩盖了 `.lock` 的真实类别（t51 / D06）。现在必须分开，且**两者都仍被排除**（安全不放宽）。
  const lock = classifyFile('yarn.lock', rules, {});
  const lockUpper = classifyFile('Yarn.Lock', rules, {});
  const png = classifyFile('assets/logo.png', rules, {});
  const pngUpper = classifyFile('assets/logo.PNG', rules, {});
  for (const v of [lock, lockUpper, png, pngUpper]) {
    assert.equal(v.decision, 'excluded', '仍必须排除（不得因理由串调整而放宽）');
  }
  assert.equal(lock.reason, 'unsupported_extension:.lock', `实际 ${lock.reason}`);
  assert.equal(lockUpper.reason, 'unsupported_extension:.lock', '大小写变体同样按不支持扩展名处理');
  assert.equal(lock.ruleId, 'SAFETY-004-EXTENSION');
  assert.equal(png.reason, 'binary_file:extension', `实际 ${png.reason}`);
  assert.equal(pngUpper.reason, 'binary_file:extension');
  assert.equal(png.ruleId, 'SAFETY-003-BINARY');
  assert.notEqual(lock.reason, png.reason, '两者理由串必须不同（D06 核心断言）');
  assert.equal(classifyFile('weird/file.bak', rules, {}).reason, 'unsupported_extension:.bak');
});

// ── 组合：修复不得破坏既有安全语义与演示夹具 ────────────────────────────────
test('回归: demo 夹具仍按预期工作（占位符密钥文件不因新扫描器而误判）', () => {
  const p = runPreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json']).payload;
  assert.equal(p.counts.selected, 14, '夹具选中数不得变化');
  assert.equal(p.counts.excluded, 9, '夹具排除数不得变化');
  assert.deepEqual(p.safety.violations, []);
  assert.equal(p.selectedPaths.includes('.env.production'), false);
  // 夹具里真实存在的密钥类文件必须仍被路径规则排除（而不是靠内容扫描）
  for (const f of ['.env.production', 'config/tls/server.pem', 'src/chain/id_rsa']) {
    const entry = p.excluded.find((e) => e.path === f);
    assert.ok(entry, `${f} 必须被排除`);
    assert.match(entry.reason, /sensitive_path_never_included|binary_file/, `${f} 的排除原因应来自安全层`);
  }
});

test('回归: 最宽泛 include 仍救不回敏感路径（大小写变体亦然）', () => {
  const dir = tempDir();
  try {
    const diff = writeDiff(dir.path, 'diff.json', [
      { path: 'Credentials.json' }, { path: 'SECRETS/x.txt' }, { path: '.ENV' }, { path: 'src/app.mjs' },
    ]);
    const p = runPreview([
      '--diff', diff, '--json', '--home', path.join(dir.path, 'nohome'),
      '--include', '**/*', '--include', '**/S*', '--include', '*.JSON',
    ]).payload;
    assert.deepEqual(p.selectedPaths, ['src/app.mjs']);
    assert.equal(p.safety.no_sensitive_selected, true);
    assert.deepEqual(p.safety.violations, []);
  } finally {
    dir.cleanup();
  }
});

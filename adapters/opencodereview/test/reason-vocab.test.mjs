// adapters/opencodereview/test/reason-vocab.test.mjs
//
// t56 / F11（low）回归：排除**理由串**的语义必须互不重叠 ——
// 「不支持扩展名」(D06) 与「二进制扩展名」(D04) 不得共用同一个理由串。
//
// 历史：t45 的 B1-note 指出 `.lock`（属不支持扩展名）与 `.PNG`（属二进制）的理由串
// 都是 `binary_file:extension`，掩盖了两类判定；t51 的根因修复把 `.lock` 移出
// `BINARY_EXTENSIONS`，改为 `unsupported_extension:.lock` + `SAFETY-004-EXTENSION`。
// verifier 在 t55/report-v7 仍把 F11 列为残余项。
//
// **本文件的作用就是终止「这条到底修没修」的反复**：把四类输入的理由串 × ruleId
// 逐条锁死，并把「跨族共用理由串数 = 0」写成断言。以后任何一处把两类判定混回同一个
// 理由串，这里会直接失败。
//
// 自证（临时回退修复点后本文件必须失败）：
//   * 回退点 A：src/filters.mjs 的 BINARY_EXTENSIONS 里加回 `'.lock'`
//     ⇒ `.lock` 的理由串变回 `binary_file:extension`，「两类不重叠」用例失败。
//   * 回退点 B：src/filters.mjs step 3 的 reason 从
//     `unsupported_extension:${ext}` 改回共用的 `binary_file:extension` ⇒ 同上失败。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFile,
  BINARY_EXTENSIONS,
  SENSITIVE_EXTENSIONS,
  SUPPORTED_EXTENSIONS,
} from '../src/filters.mjs';
import { runPreview, tempDir } from './helpers.mjs';

const RULES = { layers: [{ source: 'cli:flags', include: ['**/*'], exclude: [] }] };

/** 理由串 → 语义族。族群按**前缀**划分，正是 `selection` 计数口径的依据。 */
function familyOf(reason) {
  const s = String(reason);
  if (s.startsWith('unsupported_extension')) return 'unsupported_extension';
  if (s.startsWith('binary_file')) return 'binary_file';
  if (s.startsWith('sensitive_path')) return 'sensitive_path';
  if (s.startsWith('default_excluded_dir')) return 'default_excluded_dir';
  if (s.startsWith('hardlink_secret_alias')) return 'hardlink_secret_alias';
  return 'other';
}

// F11 验收要求的那四类 + 相关对照（含未支持扩展名的其它取值、二进制其它取值、敏感材料）
const INPUTS = [
  'yarn.lock', 'Yarn.Lock', 'poetry.lock',           // D06：不支持扩展名
  'weird/file.bak', 'weird/file.BAK', 'x.old',        // D06：其它不支持扩展名
  'assets/logo.png', 'assets/logo.PNG', 'assets/logo.jpg', 'assets/logo.svgz', 'bin/tool.exe', // D04
  'config/tls/server.pem', 'config/tls/SERVER.PEM', 'a.key', 'secrets/id_rsa',               // S1
  'src/app.mjs', 'README.md', 'Dockerfile',           // 应被纳入
];

test('t56/F11: 四类输入的理由串 × ruleId 对照（`unsupported_extension` 与 `binary_file` 语义不重叠）', () => {
  const table = [
    ['yarn.lock', 'unsupported_extension:.lock', 'SAFETY-004-EXTENSION', 'excluded'],
    ['weird/file.bak', 'unsupported_extension:.bak', 'SAFETY-004-EXTENSION', 'excluded'],
    ['assets/logo.PNG', 'binary_file:extension', 'SAFETY-003-BINARY', 'excluded'],
    ['assets/logo.png', 'binary_file:extension', 'SAFETY-003-BINARY', 'excluded'],
  ];
  for (const [file, reason, ruleId, decision] of table) {
    const v = classifyFile(file, RULES, {});
    assert.equal(v.reason, reason, `${file} 的 reason`);
    assert.equal(v.ruleId, ruleId, `${file} 的 ruleId`);
    assert.equal(v.decision, decision, `${file} 仍必须被排除（理由串调整不得放宽安全判定）`);
  }
  // F11 的核心断言：两类判定不得共用同一个理由串
  const lock = classifyFile('yarn.lock', RULES, {});
  const png = classifyFile('assets/logo.PNG', RULES, {});
  assert.notEqual(lock.reason, png.reason, 'D06 与 D04 的理由串必须不同');
  assert.notEqual(lock.ruleId, png.ruleId, 'D06 与 D04 的 ruleId 必须不同');
  assert.equal(familyOf(lock.reason), 'unsupported_extension');
  assert.equal(familyOf(png.reason), 'binary_file');
});

test('t56/F11: 跨族共用理由串数为 0（穷举本层全部理由串取值）', () => {
  const seen = new Map(); // family -> Set(reason)
  const shared = [];
  for (const f of INPUTS) {
    const v = classifyFile(f, RULES, {});
    if (v.decision !== 'excluded') continue;
    const fam = familyOf(v.reason);
    if (!seen.has(fam)) seen.set(fam, new Set());
    seen.get(fam).add(v.reason);
  }
  for (const [fam, set] of seen) {
    for (const [otherFam, otherSet] of seen) {
      if (otherFam === fam) continue;
      for (const r of set) if (otherSet.has(r)) shared.push(`${r} (${fam} / ${otherFam})`);
    }
  }
  assert.deepEqual(shared, [], `理由串被两个语义族共用: ${shared.join(', ')}`);
  // 至少要覆盖到 F11 关心的两族，否则这条用例是空转
  assert.ok(seen.has('unsupported_extension'), '必须覆盖到不支持扩展名族');
  assert.ok(seen.has('binary_file'), '必须覆盖到二进制族');
});

test('t56/F11: 三个扩展名词表两两不相交（结构层保证理由串不会互相污染）', () => {
  const norm = (arr) => new Set(arr.map((e) => String(e).toLowerCase()));
  const bin = norm(BINARY_EXTENSIONS);
  const sen = norm(SENSITIVE_EXTENSIONS);
  const sup = norm(SUPPORTED_EXTENSIONS);
  const inter = (a, b) => [...a].filter((x) => b.has(x));
  assert.deepEqual(inter(bin, sen), [], 'BINARY ∩ SENSITIVE 必须为空');
  assert.deepEqual(inter(bin, sup), [], 'BINARY ∩ SUPPORTED 必须为空');
  assert.deepEqual(inter(sen, sup), [], 'SENSITIVE ∩ SUPPORTED 必须为空');
  // t51 的根因：`.lock` 必须**不在**二进制词表里，否则理由串会退回 binary_file:*
  assert.equal(bin.has('.lock'), false, '`.lock` 不得重新进入 BINARY_EXTENSIONS（否则 F11 复发）');
  assert.equal(sup.has('.lock'), false, '`.lock` 也不在支持白名单里（仍排除）');
});

test('t56/F11: 大小写变体与原名的理由串/ruleId 完全一致（S5，且不改变分族）', () => {
  for (const [a, b] of [
    ['yarn.lock', 'Yarn.Lock'],
    ['weird/file.bak', 'weird/file.BAK'],
    ['assets/logo.png', 'assets/logo.PNG'],
    ['config/tls/server.pem', 'config/tls/SERVER.PEM'],
  ]) {
    const va = classifyFile(a, RULES, {});
    const vb = classifyFile(b, RULES, {});
    assert.equal(va.reason, vb.reason, `${a} 与 ${b} 的 reason 必须一致`);
    assert.equal(va.ruleId, vb.ruleId, `${a} 与 ${b} 的 ruleId 必须一致`);
    assert.equal(va.decision, 'excluded', `${b} 仍必须排除`);
  }
});

test('t56/F11: 前缀计数口径与理由串族一致（excludedBinary 只数 binary_file*，不含 unsupported*）', () => {
  const dir = tempDir();
  try {
    // 二进制扩展名一个、不支持扩展名一个；两者都必须被排除
    dir.write('assets/logo.png', 'PNG');
    dir.write('notes.lock', 'lockfile');
    dir.write('src/app.mjs', 'export const a = 1;\n');
    const p = runPreview(['--root', dir.path, '--json']).payload;
    // 字段位置以实测为准：计数在 payload.counts（snake_case），不在 selection 下。
    const counts = p.counts || {};
    assert.equal(counts.excluded_binary, 1, `excluded_binary 应只数 binary_file*（实际 ${counts.excluded_binary}）`);
    assert.equal(counts.excluded_extension, 1, `excluded_extension 应只数 unsupported_extension*（实际 ${counts.excluded_extension}）`);
    // 两类理由串在有产物层面也不得混用
    const reasons = (p.selection.excluded || []).map((e) => String(e.reason));
    const binR = reasons.filter((r) => familyOf(r) === 'binary_file');
    const unsupR = reasons.filter((r) => familyOf(r) === 'unsupported_extension');
    assert.deepEqual(binR, ['binary_file:extension'], `二进制族理由串: ${JSON.stringify(binR)}`);
    assert.deepEqual(unsupR, ['unsupported_extension:.lock'], `不支持扩展名族理由串: ${JSON.stringify(unsupR)}`);
    // 纳入集不含被排除项（安全判定未放宽）
    assert.equal(p.selection.included.includes('notes.lock'), false);
    assert.equal(p.selection.included.includes('assets/logo.png'), false);
  } finally {
    dir.cleanup();
  }
});

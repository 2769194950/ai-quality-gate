// adapters/opencodereview/test/hardlink-diff.test.mjs
// t42 / blocker F1 回归：硬链接别名的身份链必须在 **--diff 与 --root 两条路径**都生效。
//
// 缺陷背景：t33 只覆盖了 `--root` 枚举路径。`--diff` 是主用模式，且 CI 里 diff 常作为制品
// 单独落地（例如 `<base>/diff.json` + `<base>/repo/…`，**diff 与被检仓库并列**）。
// 该布局下早期 `inferDiffRoots` 只在「diff 目录 / cwd 及其祖先」里找根 ⇒ 找不到 `repo/`
// ⇒ `sizeRoot=null` ⇒ `sensitiveInodes` 为空 ⇒ 身份链退化为内容形态启发式，
// 而「内容不可判形态」的密钥文件因此被静默纳入（verifier 用 hardlink-probe 复现 3/3 绕过）。
//
// 修复：`inferDiffRoots` 增加「diff 所在目录的直接子目录」候选，并在命中率低时仍返回根
// （根对身份链是必需的；只读锚点，不做破坏性操作）。`--diff` 与 `--root` 因此走同一条身份链。
//
// 自证方式（复核用）：把 `src/selection.mjs` 的 `inferDiffRoots` 里
//   `for (const entry of fs.readdirSync(dir, ...)) if (entry.isDirectory()) roots.push(...)`
// 这两行注释掉（即回到「只找 diff 目录与祖先」），本文件应失败（别名被纳入）。
// 恢复后全绿。实测已按此步骤验证。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createPreview } from '../src/ocr-pipeline.mjs';
import { tempDir } from './helpers.mjs';

/**
 * 构造一组夹具：仓库在 `<base>/repo`，diff 默认放在 `<base>/diff.json`（**并列布局**）。
 * 三个别名分别指向 `.env`（内容不可判形态）、`.env`（形似密钥）、`Credentials.json`。
 */
function buildFixture(dir, { diffOutsideRepo = true } = {}) {
  const base = dir.path;
  const root = path.join(base, 'repo');
  const nohome = path.join(base, 'nohome');
  const W = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  W('src/app.mjs', 'export const a = 1;\n');
  W('.env', 'OPAQUE_SECRET_MATERIAL_0123456789abcdef\n'); // 刻意无可识别形态 ⇒ 只能靠身份链
  W('Credentials.json', '{"access_key":"AKIAIOSFODNN7EXAMPLE"}\n');
  W('notes-raw.txt', 'ANTHROPIC_API_KEY=sk-ant-api03-EXAMPLEKEYVALUE0123456789\n');

  // 三个别名：docs.txt→.env；notes.txt→.env（目标内容为形似密钥的那份另存）；handbook.txt→Credentials.json
  fs.linkSync(path.join(root, '.env'), path.join(root, 'docs.txt'));
  fs.linkSync(path.join(root, '.env'), path.join(root, 'notes.txt'));
  fs.linkSync(path.join(root, 'Credentials.json'), path.join(root, 'handbook.txt'));

  const files = ['src/app.mjs', '.env', 'Credentials.json', 'notes-raw.txt', 'docs.txt', 'notes.txt', 'handbook.txt'];
  const diffPath = diffOutsideRepo ? path.join(base, 'diff.json') : path.join(root, 'in-repo-diff.json');
  fs.writeFileSync(diffPath, JSON.stringify({ version: '1.0', files }, null, 2));

  const rulePath = path.join(base, 'rule.json');
  fs.writeFileSync(rulePath, JSON.stringify({
    version: '1.0',
    include: [{ id: 'all', pattern: '**/*', reason: 'hardlink alias regression' }],
    exclude: [],
    includeExtensions: ['.mjs', '.json', '.txt', '.env', ''],
  }, null, 2));

  return { root, nohome, diffPath, rulePath, files };
}

const ALIASES = ['docs.txt', 'notes.txt', 'handbook.txt'];

// ── 双模式 × 三类变体 ───────────────────────────────────────────────────────

test('F1: --diff（diff 与仓库并列）下三类硬链接别名全部排除', () => {
  const dir = tempDir();
  try {
    const fx = buildFixture(dir, { diffOutsideRepo: true });
    const p = createPreview({ diff: fx.diffPath, rule: undefined, cliRulePath: fx.rulePath, homeDir: fx.nohome }).payload;
    for (const a of ALIASES) {
      assert.equal(p.selectedPaths.includes(a), false, `${a} 不得进入 selected（--diff 并列布局）`);
      assert.equal(p.excludedPaths.includes(a), true, `${a} 必须出现在 excluded`);
      const entry = p.excluded.find((e) => e.path === a);
      assert.match(entry.reason, /^hardlink_secret_alias:/, `${a} 的排除原因必须指明硬链接别名，实际 ${entry.reason}`);
      assert.equal(entry.rule_id, 'SAFETY-005-HARDLINK-ALIAS');
    }
    assert.equal(p.safety.no_sensitive_selected, true);
    assert.deepEqual(p.safety.violations, []);
    assert.deepEqual(p.safety.hardlink_aliases, [], '没有任何别名进入 selected ⇒ 该告警列表应为空');
  } finally {
    dir.cleanup();
  }
});

test('F1: --diff（diff 放在仓库内）下三类别名同样全部排除', () => {
  const dir = tempDir();
  try {
    const fx = buildFixture(dir, { diffOutsideRepo: false });
    const p = createPreview({ diff: fx.diffPath, cliRulePath: fx.rulePath, homeDir: fx.nohome }).payload;
    for (const a of ALIASES) {
      assert.equal(p.selectedPaths.includes(a), false, `${a} 不得进入 selected（--diff 仓库内布局）`);
      assert.equal(p.excludedPaths.includes(a), true, `${a} 必须被排除`);
    }
    assert.equal(p.safety.no_sensitive_selected, true);
    assert.deepEqual(p.safety.violations, []);
  } finally {
    dir.cleanup();
  }
});

test('F1: --root 枚举路径下三类别名同样全部排除（t33 既有行为不得回归）', () => {
  const dir = tempDir();
  try {
    const fx = buildFixture(dir);
    const p = createPreview({ root: fx.root, homeDir: fx.nohome }).payload;
    for (const a of ALIASES) {
      assert.equal(p.selectedPaths.includes(a), false, `${a} 不得进入 selected（--root）`);
      assert.equal(p.excludedPaths.includes(a), true, `${a} 必须被排除`);
    }
    assert.equal(p.safety.no_sensitive_selected, true);
    assert.deepEqual(p.safety.violations, []);
  } finally {
    dir.cleanup();
  }
});

// ── 身份链而非内容启发式：这是 F1 的核心 ────────────────────────────────────

test('F1: --diff 下排除依据是「同源 inode」（身份链），不是内容形态启发式', () => {
  const dir = tempDir();
  try {
    const fx = buildFixture(dir);
    const p = createPreview({ diff: fx.diffPath, cliRulePath: fx.rulePath, homeDir: fx.nohome }).payload;
    // docs.txt 指向的 .env 内容刻意不可判形态；若走内容启发式就不可能排除它。
    const docs = p.excluded.find((e) => e.path === 'docs.txt');
    assert.equal(docs.reason, 'hardlink_secret_alias:same-inode-as-sensitive-path',
      `必须由身份链判定（同源 inode），实际 ${docs.reason}`);
    // 反向证明该内容确实无法靠形态判定
    assert.equal(/secret-content/.test(docs.reason), false);
  } finally {
    dir.cleanup();
  }
});

test('F1: 身份链为空时（无敏感文件存在于盘上）不得误排除普通硬链接', () => {
  const dir = tempDir();
  try {
    const base = dir.path;
    const root = path.join(base, 'repo');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'src.mjs'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'plain.txt'), 'just documentation text, no secrets\n');
    // 一个无害硬链接（内容不含密钥形态）——不应被排除
    fs.linkSync(path.join(root, 'src.mjs'), path.join(root, 'copy.mjs'));
    const diffPath = path.join(base, 'diff.json');
    fs.writeFileSync(diffPath, JSON.stringify({ version: '1.0', files: ['src.mjs', 'plain.txt', 'copy.mjs'] }, null, 2));
    const p = createPreview({ diff: diffPath, homeDir: path.join(base, 'nohome') }).payload;
    assert.equal(p.selectedPaths.includes('copy.mjs'), true, '无害硬链接不得被误排除');
    assert.equal(p.selectedPaths.includes('plain.txt'), true, '普通文档不得被误排除');
    assert.equal(p.safety.no_sensitive_selected, true);
  } finally {
    dir.cleanup();
  }
});

// ── 低命中率 diff：不得因此丢弃根（否则身份链失效） ─────────────────────────

test('F1: diff 含大量不存在路径（命中率<50%）时仍必须锚定根并排除别名', () => {
  const dir = tempDir();
  try {
    const base = dir.path;
    const root = path.join(base, 'repo');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.mjs'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, '.env'), 'OPAQUE_SECRET_MATERIAL_0123456789abcdef\n');
    fs.linkSync(path.join(root, '.env'), path.join(root, 'docs.txt'));
    // 真实 diff 常含已被删除/未物化的路径（CI 里尤其常见）⇒ 命中率会被拉低到 50% 以下。
    // 早期实现「命中率<50% 就丢弃根」正是 F1 的第二个成因：根一丢，敏感文件身份集为空，
    // 身份链失效，只剩内容形态启发式 —— 而这里的内容刻意不可判形态。
    const files = ['src/app.mjs', '.env', 'docs.txt',
      'deleted/a.mjs', 'deleted/b.mjs', 'deleted/c.mjs', 'deleted/d.mjs', 'deleted/e.mjs', 'deleted/f.mjs'];
    const diffPath = path.join(base, 'diff.json');
    fs.writeFileSync(diffPath, JSON.stringify({ version: '1.0', files }, null, 2));
    const p = createPreview({ diff: diffPath, homeDir: path.join(base, 'nohome') }).payload;
    assert.equal(p.selectedPaths.includes('docs.txt'), false, '命中率低也必须拦住别名（根不得被丢弃）');
    const entry = p.excluded.find((e) => e.path === 'docs.txt');
    assert.equal(entry.reason, 'hardlink_secret_alias:same-inode-as-sensitive-path',
      `低命中率下仍应由身份链判定，实际 ${entry.reason}`);
    assert.equal(p.safety.no_sensitive_selected, true);
  } finally {
    dir.cleanup();
  }
});

// ── 布局鲁棒性：diff 位置变化不得改变安全判定 ───────────────────────────────

test('F1: diff 位于不同布局时安全判定结果一致（并列 / 仓库内 / 上级目录）', () => {
  const dir = tempDir();
  try {
    const base = dir.path;
    const root = path.join(base, 'repo');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.mjs'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, '.env'), 'OPAQUE_SECRET_MATERIAL_0123456789abcdef\n');
    fs.linkSync(path.join(root, '.env'), path.join(root, 'docs.txt'));
    const files = ['src/app.mjs', '.env', 'docs.txt'];
    const nohome = path.join(base, 'nohome');
    const layouts = {
      sibling: path.join(base, 'diff.json'),
      inside: path.join(root, 'diff.json'),
      nested: path.join(base, 'artifacts', 'diff.json'),
    };
    for (const [label, p] of Object.entries(layouts)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ version: '1.0', files }, null, 2));
      const payload = createPreview({ diff: p, homeDir: nohome }).payload;
      assert.equal(payload.selectedPaths.includes('docs.txt'), false, `布局 ${label}: 别名不得被纳入`);
      assert.equal(payload.selectedPaths.includes('.env'), false, `布局 ${label}: 敏感路径不得被纳入`);
      assert.equal(payload.safety.no_sensitive_selected, true, `布局 ${label}: safety 必须与事实一致`);
      assert.notEqual(payload.excluded.find((e) => e.path === 'docs.txt'), undefined, `布局 ${label}: 别名应被排除`);
    }
  } finally {
    dir.cleanup();
  }
});

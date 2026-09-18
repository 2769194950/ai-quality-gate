// adapters/opencodereview/test/selection.test.mjs
// T-QG-012：OCR 适配层确定性选择 / 安全不变量 / 分组 / 规则优先级 / 降级 / 确定性。
// 运行： node --test adapters/opencodereview/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEMO_DIFF,
  DEMO_RULE,
  DEMO_DIR,
  ADAPTER_ROOT,
  REPO_ROOT,
  runPreview,
  tempDir,
  writeRule,
  writeDiff,
  stableJson,
  pathsOf,
} from './helpers.mjs';
import { isSensitivePath, isBinaryFile, isSupportedExtension, isInDefaultExcludedDir, SENSITIVE_PATH_PATTERNS } from '../src/filters.mjs';
import { MAX_FILES_PER_GROUP, groupFiles, assertGroupingInvariants } from '../src/grouping.mjs';
import { resolveRules, RULE_SOURCES } from '../src/rules.mjs';
import { probeOcr, buildChildEnv, DEGRADE_REASONS, assertNoApiKeyRequirement } from '../src/ocr-runner.mjs';
import { globToRegExp, normalizeRel } from '../src/util.mjs';

const jsonArgs = (extra = []) => ['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json', ...extra];

// ── 1. CLI 基本契约 ─────────────────────────────────────────────────────────

test('CLI: --diff --rule --json 输出合法 JSON，mode=preview 且 llm_called=false', () => {
  const { exitCode, payload, stdout } = runPreview(jsonArgs());
  assert.equal(exitCode, 0, 'exit code must be 0');
  assert.ok(payload, 'stdout must be valid JSON');
  assert.doesNotThrow(() => JSON.parse(stdout));
  assert.equal(payload.mode, 'preview');
  assert.equal(payload.llm_called, false);
  assert.equal(payload.provider.llm_called, false);
  assert.ok(Array.isArray(payload.selected) && Array.isArray(payload.excluded) && Array.isArray(payload.groups));
  assert.ok(payload.counts.selected > 0 && payload.counts.excluded > 0);
});

test('CLI: --json 与 --md 互斥 ⇒ 退出码 2 + CONFIG_INVALID', () => {
  const both = runPreview(['--diff', DEMO_DIFF, '--json', '--md']);
  assert.equal(both.exitCode, 2);
  assert.equal(both.payload.error.code, 'CONFIG_INVALID');
  const none = runPreview([]);
  assert.equal(none.exitCode, 2);
  assert.equal(none.payload.error.code, 'CONFIG_INVALID');
  const unknown = runPreview(['--diff', DEMO_DIFF, '--json', '--definitely-unknown']);
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.payload.error.code, 'CONFIG_INVALID');
});

test('CLI: --md 输出 selection.md 风格「文件/决策/原因」三列表格', () => {
  const { exitCode, markdown } = runPreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--md']);
  assert.equal(exitCode, 0);
  assert.ok(markdown, 'must print markdown');
  assert.match(markdown, /\|\s*文件\s*\|\s*决策\s*\|\s*原因\s*\|/);
  assert.match(markdown, /\|\s*`\.env\.production`\s*\|\s*excluded\s*\|/);
  assert.match(markdown, /敏感路径进入 selected = 0 条违规/);
});

// ── 2. 安全不变量：密钥路径优先于 include ───────────────────────────────────

test('安全: 敏感路径清单覆盖 .env* / *.pem / *.key / id_rsa* / credentials* / secrets/**', () => {
  const sensitive = [
    '.env', '.env.production', '.env.local', 'config/tls/server.pem', 'a/b/c.key',
    'id_rsa', 'deploy/id_rsa.pub', 'credentials.json', 'src/credentials-prod.yaml',
    'secrets/db.txt', '.opencodereview/secrets/db-password.txt', 'config/service-account.json',
  ];
  for (const p of sensitive) assert.equal(isSensitivePath(p), true, `${p} must be sensitive`);
  for (const p of ['src/index.mjs', 'README.md', 'docs/00-requirements.md', 'environ.mjs']) {
    assert.equal(isSensitivePath(p), false, `${p} must not be sensitive`);
  }
  assert.ok(SENSITIVE_PATH_PATTERNS.length >= 10);
});

test('安全: .env.production 只出现在 excluded，selected 中永不出现密钥路径', () => {
  const { payload } = runPreview(jsonArgs());
  assert.equal(payload.excludedPaths.includes('.env.production'), true);
  assert.equal(payload.selectedPaths.includes('.env.production'), false);
  assert.equal(payload.safety.no_sensitive_selected, true);
  assert.deepEqual(payload.safety.violations, []);
  const sensitiveSelected = payload.selectedPaths.filter((p) => isSensitivePath(p));
  assert.deepEqual(sensitiveSelected, [], `safety violation: ${sensitiveSelected.join(', ')}`);
  const entry = payload.excluded.find((e) => e.path === '.env.production');
  assert.equal(entry.reason, 'sensitive_path_never_included');
  assert.equal(entry.rule_source, 'SAFETY_INVARIANT');
});

test('安全: 最宽泛 include（**/*、**/.*、secrets/**）也无法把敏感路径重新纳入', () => {
  const dir = tempDir();
  try {
    const diff = writeDiff(dir.path, 'diff.json', [
      { path: '.env.production', status: 'added' },
      { path: 'config/tls/server.pem', status: 'added' },
      { path: 'secrets/db-password.txt', status: 'added' },
      { path: 'id_rsa', status: 'added' },
      { path: 'src/app.mjs', status: 'modified' },
    ]);
    const rule = writeRule(dir.path, 'rule.json', {
      version: '1.0',
      include: ['**/*', '**/.*', '**/*.pem', '**/*.key', 'secrets/**', '.env*', 'id_rsa*', 'credentials*'],
    });
    const { exitCode, payload } = runPreview(['--diff', diff, '--rule', rule, '--json']);
    assert.equal(exitCode, 0);
    assert.deepEqual(payload.selectedPaths, ['src/app.mjs'], '只有普通源码可被纳入');
    for (const p of ['secrets/db-password.txt', '.env.production', 'config/tls/server.pem', 'id_rsa']) {
      assert.equal(payload.excludedPaths.includes(p), true, `${p} 必须被排除`);
      assert.equal(payload.selectedPaths.includes(p), false, `${p} 不得被 include 救回`);
    }
    assert.equal(payload.safety.no_sensitive_selected, true);
    // 反向用例：即使通过 CLI 最顶层 --include 显式要求，也必须仍然排除。
    const cli = runPreview(['--diff', diff, '--json', '--include', '**/*', '--include', '.env*', '--include', 'secrets/**']);
    assert.equal(cli.exitCode, 0);
    assert.equal(cli.payload.selectedPaths.includes('.env.production'), false);
    assert.equal(cli.payload.selectedPaths.includes('secrets/db-password.txt'), false);
    assert.deepEqual(cli.payload.selectedPaths, ['src/app.mjs']);
  } finally {
    dir.cleanup();
  }
});

// ── 3. 二进制 / 默认目录 / 扩展名过滤 ───────────────────────────────────────

test('过滤: 二进制文件始终排除（扩展名 + 魔数）', () => {
  const { payload } = runPreview(jsonArgs());
  const png = payload.excluded.find((e) => e.path === 'assets/logo.png');
  assert.ok(png, 'logo.png 必须被排除');
  assert.match(png.reason, /^binary_file:/);
  assert.equal(payload.selectedPaths.includes('assets/logo.png'), false);
  assert.ok(isBinaryFile('a/b/logo.png').binary);
  assert.ok(isBinaryFile('x/archive.tar.gz').binary);
  assert.equal(isBinaryFile('src/app.mjs').binary, false);
  assert.equal(isBinaryFile('src/app.mjs', path.join(ADAPTER_ROOT, 'src', 'app.mjs')).binary, false);
});

test('过滤: 默认排除目录（.git/、node_modules/、dist/）始终排除', () => {
  const { payload } = runPreview(jsonArgs());
  for (const p of ['node_modules/left-pad/index.js', 'dist/bundle.js']) {
    const entry = payload.excluded.find((e) => e.path === p);
    assert.ok(entry, `${p} 必须被排除`);
    assert.match(entry.reason, /^default_excluded_dir:/);
    assert.equal(payload.selectedPaths.includes(p), false);
  }
  assert.equal(isInDefaultExcludedDir('node_modules/a/b.js'), 'node_modules');
  assert.equal(isInDefaultExcludedDir('.git/objects/x'), '.git');
  assert.equal(isInDefaultExcludedDir('src/app.mjs'), null);
});

test('过滤: 不支持的扩展名始终排除', () => {
  const { payload } = runPreview(jsonArgs());
  const bak = payload.excluded.find((e) => e.path === 'src/chain/user-handler.mjs.bak');
  assert.ok(bak, '.bak 必须被排除');
  assert.match(bak.reason, /^unsupported_extension:/);
  assert.equal(isSupportedExtension('src/app.mjs'), true);
  assert.equal(isSupportedExtension('src/App.java'), true);
  assert.equal(isSupportedExtension('assets/thing.exe'), false);
  assert.equal(isSupportedExtension('data/thing.bak'), false);
});

// ── 4. 规则四层优先级 ───────────────────────────────────────────────────────

test('规则: 四层优先级顺序为 --rule > 项目 > 用户 > 内置', () => {
  const dir = tempDir();
  try {
    const root = path.join(dir.path, 'proj');
    fs.mkdirSync(root, { recursive: true });
    const cliRule = writeRule(dir.path, 'cli-rule.json', { version: '1.0', include: ['**/*.mjs'] });
    const projectRule = writeRule(root, '.opencodereview/rule.json', { version: '1.0', include: ['**/*.ts'] });
    const userRule = writeRule(dir.path, 'user-rule.json', { version: '1.0', include: ['**/*.py'] });
    const ctx = resolveRules({
      root,
      cliRulePath: cliRule,
      userRulePath: userRule,
      homeDir: dir.path,
    });
    const loaded = ctx.trace.filter((t) => t.loaded).map((t) => t.source);
    assert.deepEqual(loaded, [RULE_SOURCES.CLI, RULE_SOURCES.PROJECT, RULE_SOURCES.USER, RULE_SOURCES.BUILTIN]);
    const priorities = ctx.trace.filter((t) => t.loaded).map((t) => t.priority);
    assert.deepEqual(priorities, [1, 2, 3, 4]);

    // 第一个匹配生效：cli 层 include **/*.mjs 命中，不再往下看
    const diff = writeDiff(dir.path, 'diff.json', [{ path: 'src/app.mjs' }, { path: 'src/legacy.ts' }, { path: 'tools/x.py' }]);
    const { payload } = runPreview(['--diff', diff, '--root', root, '--rule', cliRule, '--user-rule', userRule, '--json']);
    const mjs = payload.ruleMatch.find((r) => r.file === 'src/app.mjs');
    assert.equal(mjs.ruleSource, RULE_SOURCES.CLI);
    assert.equal(mjs.priority, 1);
    assert.equal(mjs.decision, 'included');
    assert.equal(mjs.pattern, '**/*.mjs');
  } finally {
    dir.cleanup();
  }
});

test('规则: 每一层单独生效（--rule / 项目 / 用户 / 内置）', () => {
  const dir = tempDir();
  try {
    const root = path.join(dir.path, 'proj');
    fs.mkdirSync(root, { recursive: true });
    const diff = writeDiff(dir.path, 'diff.json', [{ path: 'src/app.mjs' }, { path: 'notes/readme.md' }]);

    // L1：仅 --rule
    const l1 = writeRule(dir.path, 'l1.json', { version: '1.0', exclude: ['**/*.md'] });
    const r1 = runPreview(['--diff', diff, '--root', root, '--rule', l1, '--home', path.join(dir.path, 'nohome'), '--json']);
    const md1 = r1.payload.excluded.find((e) => e.path === 'notes/readme.md');
    assert.equal(md1.rule_source, RULE_SOURCES.CLI);
    assert.equal(md1.pattern, '**/*.md');

    // L2：仅项目级 .opencodereview/rule.json
    writeRule(root, '.opencodereview/rule.json', { version: '1.0', exclude: ['**/*.md'] });
    const r2 = runPreview(['--diff', diff, '--root', root, '--home', path.join(dir.path, 'nohome'), '--json']);
    const md2 = r2.payload.excluded.find((e) => e.path === 'notes/readme.md');
    assert.equal(md2.rule_source, RULE_SOURCES.PROJECT);
    assert.equal(md2.pattern, '**/*.md');

    // L3：仅用户级 ~/.opencodereview/rule.json
    const home = path.join(dir.path, 'home');
    writeRule(home, '.opencodereview/rule.json', { version: '1.0', exclude: ['**/*.md'] });
    const rootNoProject = path.join(dir.path, 'proj2');
    fs.mkdirSync(path.join(rootNoProject, 'src'), { recursive: true });
    const r3 = runPreview(['--diff', diff, '--root', rootNoProject, '--home', home, '--json']);
    const md3 = r3.payload.excluded.find((e) => e.path === 'notes/readme.md');
    assert.equal(md3.rule_source, RULE_SOURCES.USER);
    assert.equal(md3.pattern, '**/*.md');

    // L4：内置（无任何用户规则 ⇒ 走内置 default_include）
    const r4 = runPreview(['--diff', diff, '--root', rootNoProject, '--home', path.join(dir.path, 'empty'), '--json']);
    const md4 = r4.payload.selected.find((s) => s.path === 'notes/readme.md');
    assert.equal(md4.rule_source, RULE_SOURCES.BUILTIN);
    assert.equal(md4.reason, 'default_include');
    assert.equal(md4.decided_by, 'builtin');
    assert.equal(r4.payload.rules.layer_trace.filter((l) => l.loaded).length, 1);

    // explain 通道：--explain 能把「最终命中来源 + pattern + 优先级」解释清楚
    const explained = runPreview([
      '--diff', diff, '--root', root, '--rule', l1, '--home', path.join(dir.path, 'empty'),
      '--explain', 'notes/readme.md', '--json',
    ]);
    assert.equal(explained.exitCode, 0);
    assert.deepEqual(explained.payload.ruleMatch, [
      {
        file: 'notes/readme.md',
        ruleSource: RULE_SOURCES.CLI,
        priority: 1,
        pattern: '**/*.md',
        ruleId: null,
        decision: 'excluded',
        reason: 'excluded_by_rule',
      },
    ]);
  } finally {
    dir.cleanup();
  }
});

test('规则: glob 语义（**、*、?、{a,b}、basename 模式）确定且可解释', () => {
  assert.equal(globToRegExp('**/*.mjs').test('a/b/c.mjs'), true);
  assert.equal(globToRegExp('**/*.mjs').test('c.mjs'), true);
  assert.equal(globToRegExp('*.pem').test('deep/dir/server.pem'), true);
  assert.equal(globToRegExp('src/*/*.mjs').test('src/a/b.mjs'), true);
  assert.equal(globToRegExp('src/*/*.mjs').test('src/a/b/c.mjs'), false);
  assert.equal(globToRegExp('demo/file-?.mjs').test('demo/file-1.mjs'), true);
  assert.equal(globToRegExp('**/*.{mjs,ts}').test('x/y.ts'), true);
  assert.equal(globToRegExp('**/*.{mjs,ts}').test('x/y.py'), false);
  assert.equal(normalizeRel('./a/./b/../c.mjs'), 'a/c.mjs');
});

// ── 5. 分组上限与 token 预算降级 ────────────────────────────────────────────

test('分组: MAX_FILES_PER_GROUP 字面量为 10（测试按源码字面量断言）', () => {
  assert.equal(MAX_FILES_PER_GROUP, 10);
  const src = fs.readFileSync(path.join(ADAPTER_ROOT, 'src', 'grouping.mjs'), 'utf8');
  assert.match(src, /MAX_FILES_PER_GROUP\s*=\s*10/, '源码必须出现 MAX_FILES_PER_GROUP = 10');
});

test('分组: 单组文件数超过 10 时确定性切块，且每组 ≤ 10', () => {
  const files = Array.from({ length: 23 }, (_, i) => ({ path: `src/file-${String(i).padStart(2, '0')}.mjs`, size: 40, tokens: 10 }));
  const g = groupFiles(files, { mode: 'single', tokenBudget: 1000000 });
  assert.equal(g.invariantCheck, true);
  assert.ok(g.groups.every((x) => x.fileCount <= MAX_FILES_PER_GROUP));
  assert.deepEqual(g.groups.map((x) => x.fileCount), [10, 10, 3]);
  assert.equal(assertGroupingInvariants(g).ok, true);
  const same = groupFiles(files, { mode: 'single', tokenBudget: 1000000 });
  assert.deepEqual(same, g, '同输入必须同输出');
});

test('分组: 超过 token 预算时降级为单文件桶（含真实文件大小路径）', () => {
  const { payload } = runPreview(jsonArgs(['--token-budget', '300']));
  const downgraded = payload.groups.filter((g) => g.downgraded);
  assert.ok(downgraded.length > 0, '必须出现降级组');
  assert.ok(downgraded.every((g) => g.file_count === 1), '降级组必须是单文件桶');
  assert.ok(downgraded.every((g) => g.downgrade_reason === 'token_budget_exceeded'));
  assert.equal(payload.grouping.invariant_ok, true);
  assert.equal(payload.safety.grouping_invariants_ok, true);
  assert.ok(payload.grouping.notes.some((n) => n.startsWith('token_budget_downgrade:')));
  // 默认预算下不应降级（夹具规模远小于预算）
  const normal = runPreview(jsonArgs());
  assert.equal(normal.payload.counts.downgraded_groups, 0);
});

test('分组: 跨文件注入链路（handler→service→repository→mapper）被放进同一组', () => {
  const { payload } = runPreview(jsonArgs());
  const chainGroup = payload.groups.find((g) => g.id === 'bucket:injection-chain');
  assert.ok(chainGroup, '必须存在 injection-chain 分组');
  for (const p of [
    'src/chain/user-handler.mjs',
    'src/chain/user-service.mjs',
    'src/chain/user-repository.mjs',
    'src/chain/user-mapper.mjs',
  ]) {
    assert.ok(chainGroup.files.includes(p), `${p} 必须在同一组（保上下文）`);
  }
  const groupOf = (p) => payload.groups.find((g) => g.files.includes(p)).id;
  const ids = new Set([
    groupOf('src/chain/user-handler.mjs'),
    groupOf('src/chain/user-service.mjs'),
    groupOf('src/chain/user-repository.mjs'),
    groupOf('src/chain/user-mapper.mjs'),
  ]);
  assert.equal(ids.size, 1, '调用链四个文件必须落在同一组');
});

// ── 6. ocr 缺失降级 ─────────────────────────────────────────────────────────

test('降级: ocr 不存在时退出 0 且标注 degraded:true（含真实原因）', () => {
  const { exitCode, payload } = runPreview(jsonArgs(['--ocr-bin', path.join(ADAPTER_ROOT, 'demo', 'no-such-ocr-binary.exe')]));
  assert.equal(exitCode, 0, 'ocr 缺失不得导致失败退出');
  assert.equal(payload.mode, 'preview');
  assert.equal(payload.degraded, true);
  assert.equal(payload.provider.degraded, true);
  assert.equal(payload.provider.name, 'local');
  assert.equal(payload.llm_called, false);
  assert.equal(payload.degraded_reason, DEGRADE_REASONS.NOT_FOUND);
  assert.ok(payload.selected.length > 0, '降级后仍然产出确定性选择结果');
});

test('降级: probeOcr 返回结构化原因；子进程环境不含任何 API Key', () => {
  const probe = probeOcr({ ocrBin: path.join(ADAPTER_ROOT, 'demo', 'no-such-ocr-binary.exe') });
  assert.equal(probe.available, false);
  assert.equal(probe.reason, DEGRADE_REASONS.NOT_FOUND);
  const skipped = probeOcr({ noOcr: true });
  assert.equal(skipped.available, false);
  assert.equal(skipped.reason, DEGRADE_REASONS.SKIPPED);

  const env = buildChildEnv({
    PATH: '/usr/bin',
    SystemRoot: 'C:\\Windows',
    ANTHROPIC_API_KEY: 'sk-should-never-be-forwarded',
    OPENAI_API_KEY: 'also-never',
    AWS_SECRET_ACCESS_KEY: 'never',
    GITHUB_TOKEN: 'never',
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.OCR_OFFLINE, '1');
  assert.equal(env.OCR_NO_API_KEY, '1');
  const scanned = assertNoApiKeyRequirement(path.join(ADAPTER_ROOT, 'src'));
  assert.deepEqual(scanned.violations, [], '适配层源码不得读取/要求任何 API Key');
});

test('零密钥: 设置哨兵 API Key 后输出与无 Key 时字节级一致', () => {
  const before = runPreview(jsonArgs());
  const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY, OCR_API_KEY: process.env.OCR_API_KEY };
  process.env.ANTHROPIC_API_KEY = 'sk-sentinel-do-not-use';
  process.env.OPENAI_API_KEY = 'sk-sentinel-do-not-use';
  process.env.OCR_API_KEY = 'sk-sentinel-do-not-use';
  try {
    const after = runPreview(jsonArgs());
    assert.equal(before.exitCode, after.exitCode);
    assert.equal(stableJson(before.payload), stableJson(after.payload), 'API Key 环境变量不得影响任何输出');
    assert.equal(after.payload.llm_called, false);
    assert.equal(/sk-sentinel-do-not-use/.test(JSON.stringify(after.payload)), false, '输出不得含任何密钥值');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ── 7. 确定性重复运行 ───────────────────────────────────────────────────────

test('确定性: 同输入两次运行 JSON（含选择与分组）字节级一致', () => {
  const a = runPreview(jsonArgs());
  const b = runPreview(jsonArgs());
  assert.equal(a.exitCode, 0);
  assert.equal(b.exitCode, 0);
  assert.equal(a.stdout, b.stdout, 'stdout 必须字节级一致');
  assert.deepEqual(a.payload.selectedPaths, b.payload.selectedPaths);
  assert.deepEqual(a.payload.excludedPaths, b.payload.excludedPaths);
  assert.deepEqual(a.payload.groups, b.payload.groups);
});

test('确定性: 输入顺序打乱后选择与分组结果不变', () => {
  const dir = tempDir();
  try {
    const diffA = writeDiff(dir.path, 'a.json', [
      { path: 'src/b.mjs' }, { path: 'src/a.mjs' }, { path: 'src/c.mjs' }, { path: '.env' },
    ]);
    const diffB = writeDiff(dir.path, 'b.json', [
      { path: '.env' }, { path: 'src/c.mjs' }, { path: 'src/a.mjs' }, { path: 'src/b.mjs' },
    ]);
    const a = runPreview(['--diff', diffA, '--json']);
    const b = runPreview(['--diff', diffB, '--json']);
    assert.deepEqual(a.payload.selectedPaths, b.payload.selectedPaths);
    assert.deepEqual(a.payload.excludedPaths, b.payload.excludedPaths);
    assert.deepEqual(a.payload.groups, b.payload.groups);
    assert.deepEqual(a.payload.selectedPaths, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs']);
    assert.deepEqual(a.payload.excludedPaths, ['.env']);
  } finally {
    dir.cleanup();
  }
});

// ── 8. --root 扫描模式 + 文档一致性 ─────────────────────────────────────────

test('--root 扫描模式：与 --diff 走同一选择代码（同源）且确定', () => {
  const dir = tempDir();
  try {
    const root = path.join(dir.path, 'repo');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.mjs'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'readme.md'), '# hi\n');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=demo\n');
    fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), 'module.exports=1;\n');
    const a = runPreview(['--root', root, '--json', '--home', path.join(dir.path, 'nohome')]);
    const b = runPreview(['--root', root, '--json', '--home', path.join(dir.path, 'nohome')]);
    assert.equal(a.exitCode, 0);
    assert.deepEqual(a.payload.selectedPaths, ['src/app.mjs', 'src/readme.md']);
    assert.deepEqual(a.payload.excludedPaths, ['.env', '.git/config', 'node_modules/x/index.js']);
    assert.equal(a.stdout, b.stdout);
    assert.equal(a.payload.source.kind, 'root');
  } finally {
    dir.cleanup();
  }
});

test('夹具路径真实存在：diff.json 引用的每个路径都对应夹具根下真实文件', () => {
  const diff = JSON.parse(fs.readFileSync(DEMO_DIFF, 'utf8'));
  assert.equal(diff.fixture, true, 'diff.json 必须显式标注为夹具');
  assert.match(JSON.stringify(diff.note), /夹具/);
  // 夹具根 = adapters/opencodereview/demo，同时也是 `--root adapters/opencodereview/demo`
  // 的扫描根 ⇒ `--diff` 与 `--root` 两种模式对同一份夹具给出完全相同的相对路径。
  //
  // 路径解析**只以夹具自身位置为锚**（DEMO_DIR 由 import.meta.url 推出）⇒ 与 cwd、与仓库
  // 绝对路径无关。这一点由「在 ≥3 个不同 cwd（含盘根）与 ≥2 个不同仓库路径下均
  // 145/145/0」实测锁定（t67）。
  const fixtureRoot = DEMO_DIR;

  // t67 / F-65-1：**夹具声明了但盘上不存在**是一个合法状态，不是错误。
  // `node_modules/left-pad/index.js` 与 `dist/bundle.js` 正是「默认排除目录」「二进制」
  // 两条过滤器要验证的输入 —— 它们存在时用于证明过滤生效，不存在时（例如按惯例排除
  // `node_modules/` 的干净复制/CI checkout）也不该让用例失败。
  // 口径与 t48 的 `materialized` 概念一致（`selected[].materialized=false`、
  // `counts.unmaterialized`）：**未物化**不等于错误。断言据此改为两段：
  //   (a) 凡是**物化**的声明路径都必须真实存在；
  //   (b) 未物化的声明路径必须是**本层自己的规则**能够解释的（默认排除目录 / 二进制 /
  //       不支持扩展名），而不是"随便缺了就放过"；
  //   (c) 断言必须**带分母**（≥ 阈值），避免"全部未物化 ⇒ 空转通过"的假绿。
  const all = diff.files;
  assert.ok(all.length >= 23, `夹具声明路径数不得少于 23（实际 ${all.length}）`);

  const materialized = [];
  const unmaterialized = [];
  for (const f of all) {
    const abs = path.join(fixtureRoot, f.path);
    if (fs.existsSync(abs)) materialized.push(f.path);
    else unmaterialized.push(f.path);
  }
  for (const p of materialized) {
    const abs = path.join(fixtureRoot, p);
    assert.equal(fs.existsSync(abs), true, `已物化的夹具路径必须真实存在: ${p} → ${abs}`);
  }
  for (const p of unmaterialized) {
    assert.equal(
      isInDefaultExcludedDir(p) !== null || isBinaryFile(p).binary || !isSupportedExtension(p),
      true,
      `未物化的夹具路径必须能由本层规则解释（默认排除目录/二进制/不支持扩展名）: ${p}`,
    );
  }
  // 分母断言：至少 21/23 必须物化。它同时挡住「把所有声明都当成未物化」的空转，
  // 并在夹具被整体误删时立刻变红。
  assert.ok(
    materialized.length >= all.length - 2,
    `夹具必须基本物化：实际 ${materialized.length}/${all.length}（未物化: ${JSON.stringify(unmaterialized)}）`,
  );
  // 且**必须**包含若干关键路径 —— 否则夹具变得无意义却仍"通过"。
  for (const must of ['src/chain/user-handler.mjs', 'config/tls/server.pem', '.env.production']) {
    assert.ok(materialized.includes(must), `关键夹具路径必须物化: ${must}`);
  }

  // 每个 diff 路径都必须能在 --root 扫描结果里被同样地枚举出来（同源断言的前提）。
  const scanned = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['.git', 'node_modules', 'dist', 'build'].includes(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        scanned.add(path.relative(fixtureRoot, abs).replace(/\\/g, '/'));
      }
    }
  };
  walk(fixtureRoot);
  for (const f of diff.files) {
    if (f.path === 'node_modules/left-pad/index.js' || f.path === 'dist/bundle.js') continue;
    assert.equal(scanned.has(f.path), true, `--root 扫描应能枚举出 ${f.path}`);
  }

  // t67：上面 `continue` 掉的两条（`node_modules/…`、`dist/…`）**不再被静默放过** ——
  // 它们此前只靠"记得跳过"来回避，正是 F-65-1 的另一半成因。这里改为**按规则断言它们的归宿**：
  //   * 若已物化 ⇒ 必须被「默认排除目录 / 二进制」规则排除（既不进 selected，也在 excluded 里）；
  //   * 若未物化 ⇒ 必须能由同一条规则解释。
  // 两种情形都不允许"既不物化、又不被规则解释"的静默状态。
  const prunable = ['node_modules/left-pad/index.js', 'dist/bundle.js'];
  const previewRoot = runPreview(['--root', DEMO_DIR, '--json', '--home', path.join(DEMO_DIR, 'no-such-home')]);
  assert.equal(previewRoot.exitCode, 0, `--root 夹具扫描应正常退出（stderr: ${previewRoot.stderr || ''}）`);
  const sel = new Set(previewRoot.payload.selectedPaths);
  const exc = new Set(previewRoot.payload.excludedPaths);
  for (const p of prunable) {
    const abs = path.join(fixtureRoot, p);
    if (fs.existsSync(abs)) {
      assert.equal(sel.has(p), false, `${p} 已物化时**必须被排除**（默认排除目录/二进制），不得进入 selected`);
      assert.equal(exc.has(p), true, `${p} 已物化时必须在 excluded 中给出可审计的理由`);
    } else {
      assert.equal(
        isInDefaultExcludedDir(p) !== null || isBinaryFile(p).binary || !isSupportedExtension(p),
        true,
        `${p} 未物化时也必须能由本层规则解释（不得静默放过）`,
      );
    }
  }
  // 分母断言：夹具扫描面非空（防"空转通过"）
  assert.ok(previewRoot.payload.selectedPaths.length >= 10,
    `夹具 --root 扫描应纳入选定集（实际 ${previewRoot.payload.selectedPaths.length}）`);

  const rule = JSON.parse(fs.readFileSync(DEMO_RULE, 'utf8'));
  assert.ok(Array.isArray(rule.grouping.buckets));
  const sample = JSON.parse(fs.readFileSync(path.join(ADAPTER_ROOT, 'demo', 'ocr-review.sample.json'), 'utf8'));
  assert.equal(sample._fixture, true, 'ocr JSON 样例必须标注为 fixture（非真实调用结果）');
  assert.match(JSON.stringify(sample._note), /夹具/);
});

test('不改动 packages/qgate：适配层不引用、不写入 core-engineer 目录', () => {
  const ownFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(mjs|js|json|md|yml|yaml)$/.test(entry.name)) ownFiles.push(abs);
    }
  };
  walk(ADAPTER_ROOT);
  for (const file of ownFiles) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(/\.\.\/\.\.\/packages\/qgate/.test(text), false, `${path.relative(REPO_ROOT, file)} 不得写入 packages/qgate`);
  }
  // 若 qgate 已存在，仅允许通过公开 CLI 调用（本适配层不做任何 import）。
  const qgate = path.join(REPO_ROOT, 'packages', 'qgate');
  if (fs.existsSync(qgate)) {
    const importers = ownFiles.filter((f) => /from\s+['"][^'"]*packages\/qgate/.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(importers, [], '适配层不得 import packages/qgate 内部模块（只允许 CLI 契约调用）');
  }
});

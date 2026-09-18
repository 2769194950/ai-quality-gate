// adapters/opencodereview/test/ci-workflow.test.mjs
// CI 契约（REQ-QUALITY-GATE-015 / docs/01-architecture.md §8.2）静态断言：
//   * 恰好 5 个 job，阶段顺序 requirements → design → build → review → verify
//   * 每个 job 调用对应阶段的 qgate 命令；verify 为三段式（预热 → trace → 权威判定）
//   * 所有 action 固定 40 位 commit SHA；permissions 不超过 contents:read + pull-requests:write
//   * 不出现任何仓库密钥引用
//   * **workflow 引用的每个文件都真实存在于仓库中**（无「运行时生成再引用」的跨步骤依赖）
// 仓库零依赖（不安装 YAML 解析器），因此用等价的确定性检查（缩进/结构/正则）覆盖契约要求，
// 并真实执行 workflow 内嵌的 node -e 脚本。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, ADAPTER_ROOT, tempDir } from './helpers.mjs';

const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'quality-gate.yml');
const TEMPLATE = path.join(ADAPTER_ROOT, 'ci', 'github-actions.yml');
const SHA_RE = /@[0-9a-f]{40}\b/;
const STAGES = ['requirements', 'design', 'build', 'review', 'verify'];

const read = (p) => fs.readFileSync(p, 'utf8');
const lines = (p) => read(p).split(/\r?\n/);
const block = (text, key) => {
  const start = text.indexOf(`\n${key}:`);
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const idx = rest.search(/\n[a-z-]+:/);
  return idx < 0 ? rest : rest.slice(0, idx);
};

class ScriptExit extends Error {}

/**
 * 真实执行 workflow 内嵌的 node -e 脚本。
 * 首选子进程（与 CI 完全一致）；受限沙箱禁止带管道的子进程（EPERM）时，
 * 回退为在同进程内执行同一段脚本文本，并捕获其 stdout/stderr/退出码 ——
 * 两种方式执行的都是刚从 workflow 里抽出来的同一份代码。
 *
 * `env` 用于注入 workflow 声明的变量（这些脚本依赖它们；不注入会读到 undefined
 * 而失败，那是宿主没给环境，不是脚本缺陷）。
 */
async function runEmbeddedScript(source, cwd, argv = [], env = {}) {
  const childEnv = { ...process.env, ...env };
  const spawned = spawnSync(process.execPath, ['-e', source, ...argv], { cwd, encoding: 'utf8', env: childEnv });
  if (!spawned.error) {
    return { status: spawned.status, stdout: spawned.stdout || '', stderr: spawned.stderr || '', mode: 'spawn' };
  }
  const require = createRequire(pathToFileURL(path.join(cwd, 'placeholder.cjs')));
  const realCwd = process.cwd();
  const realArgv = process.argv;
  const realExit = process.exit;
  const realOutWrite = process.stdout.write.bind(process.stdout);
  const realErrWrite = process.stderr.write.bind(process.stderr);
  const out = [];
  const err = [];
  let exitCode = 0;
  const injected = [];
  for (const [k, v] of Object.entries(env)) {
    injected.push([k, process.env[k]]);
    process.env[k] = v;
  }
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    err.push(String(chunk));
    return true;
  };
  process.exit = (code) => {
    exitCode = Number.isFinite(code) ? code : 0;
    throw new ScriptExit('script-exit');
  };
  try {
    process.chdir(cwd);
    process.argv = ['node', '-e', source, ...argv];
    // eslint-disable-next-line no-new-func
    new Function('require', 'process', 'console', '__filename', '__dirname', source)(
      require, process, console, path.join(cwd, 'workflow-step.cjs'), cwd,
    );
  } catch (e) {
    if (!(e instanceof ScriptExit)) throw e;
  } finally {
    process.stdout.write = realOutWrite;
    process.stderr.write = realErrWrite;
    process.exit = realExit;
    process.argv = realArgv;
    process.chdir(realCwd);
    for (const [k, prev] of injected) {
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
  return { status: exitCode, stdout: out.join(''), stderr: err.join(''), mode: 'in-process' };
}

/** 抽取块形式的 `node -e '<body>'` 脚本体（行首单引号作结束锚点）。 */
const blockScripts = (text) => [...text.matchAll(/node -e '\n([\s\S]*?)\n *'/g)].map((m) => m[1]);

test('CI: 恰好 5 个 job，与五阶段一一对应且顺序正确', () => {
  const text = read(WORKFLOW);
  const jobs = block(text, 'jobs');
  const names = [...jobs.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
  assert.deepEqual(names, STAGES, `workflow job 必须恰好是五阶段，实际: ${names.join(', ')}`);
  const deps = { design: 'requirements', build: 'design', review: 'build', verify: 'review' };
  for (const [job, need] of Object.entries(deps)) {
    const start = jobs.indexOf(`\n  ${job}:`);
    assert.ok(start >= 0, `缺少 job ${job}`);
    const rest = jobs.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z]/);
    const own = next < 0 ? rest : rest.slice(0, next + 2);
    assert.match(own, new RegExp(`needs:\\s*${need}\\b`), `${job} 必须 needs: ${need}`);
  }
});

test('CI: 每个 stage job 调用对应阶段的 qgate 命令，verify 跑完整流水线（三段式）', () => {
  const text = read(WORKFLOW);
  for (const stage of ['requirements', 'design', 'build', 'review']) {
    assert.match(text, new RegExp(`check --stage ${stage} --config "\\$QGATE_CONFIG" --json`), `${stage} job 命令不符合 §8.2`);
  }
  assert.match(text, /QGATE_ENTRY: packages\/qgate\/bin\/qgate\.mjs/, '引擎入口必须是 CLI 契约入口');
  // verify 三段式：预热（吞掉预期失败）→ trace --write → 权威 check，且顺序不可颠倒
  const verifyBlock = text.slice(text.indexOf('\n  verify:'));
  const iWarm = verifyBlock.indexOf('|| true');
  const iTrace = verifyBlock.indexOf('trace --config "$QGATE_CONFIG" --write');
  const iFinal = verifyBlock.lastIndexOf('check --config "$QGATE_CONFIG" --json');
  assert.ok(iWarm > 0, 'verify 必须有预热步骤（吞掉 trace 缺失导致的预期失败）');
  assert.ok(iTrace > iWarm, 'trace --write 必须在预热之后（账本要先写满）');
  assert.ok(iFinal > iTrace, '权威 check 必须在 trace --write 之后');
  assert.match(verifyBlock.slice(iFinal - 200, iFinal + 120), /check --config "\$QGATE_CONFIG" --json\n/, '第 3 步不得带 || true');
  assert.equal(/continue-on-error:\s*true/.test(text), false, '不得用 continue-on-error 吞掉门禁失败');
  assert.match(text, /退出码契约：0=通过 1=门禁失败 2=配置错误 3=内部错误/);
});

test('CI: 引用的每个文件都存在于仓库中（无运行时生成再引用的跨步骤依赖）', () => {
  const text = read(WORKFLOW);
  // 1) env 里声明的配置路径必须真实存在
  const cfg = /QGATE_CONFIG:\s*(\S+)/.exec(text);
  assert.ok(cfg, 'workflow 必须声明 QGATE_CONFIG');
  assert.equal(fs.existsSync(path.join(REPO_ROOT, cfg[1])), true, `QGATE_CONFIG 指向的文件必须存在: ${cfg[1]}`);
  assert.equal(cfg[1], 'qgate.config.json', '应复用仓库根已提交的 qgate.config.json（唯一配置）');
  // 2) 不得出现「运行时生成配置再引用」的模式
  assert.equal(/writeFileSync\(process\.env\.QGATE_CONFIG/.test(text), false, '不得在 CI 里生成被引用的配置文件');
  assert.equal(/Generate CI config/.test(text), false, '不得有生成 CI 配置的步骤');
  assert.equal(/QGATE_CONFIG_SOURCE/.test(text), false, '不得引入第二份配置来源');
  // 3) 不得再引用已删除的 demo 配置 / adapters 下的配置
  assert.equal(/demo\/qgate\.config\.json/.test(text), false, '不得引用 demo/qgate.config.json');
  assert.equal(/adapters\/opencodereview\/ci\/qgate\.ci\.config\.json/.test(text), false, '不得引用适配层下的配置');
  // 4) 所有注释外的 --config 取值：字面量路径必须存在；变量引用（$VAR）由上面 1) 覆盖
  const active = lines(WORKFLOW).filter((l) => !/^\s*#/.test(l));
  const literalConfigs = new Set();
  for (const line of active) {
    for (const m of line.matchAll(/--config\s+("([^"$]+)"|\$([A-Za-z_][A-Za-z0-9_]*)|'([^'$]+)')/g)) {
      const literal = m[2] ?? m[4];
      if (literal) literalConfigs.add(literal);
    }
  }
  for (const ref of literalConfigs) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, ref)), true, `--config 字面量路径必须存在: ${ref}`);
  }
});

test('CI: 所有 uses 固定 40 位 SHA，且只使用白名单 action', () => {
  const text = read(WORKFLOW);
  const uses = [...text.matchAll(/^\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 5, '至少应 checkout/setup-node/upload-artifact 各一次');
  for (const u of uses) assert.match(u, SHA_RE, `action 未固定到 40 位 SHA: ${u}`);
  const allowed = new Set(['actions/checkout', 'actions/setup-node', 'actions/upload-artifact']);
  for (const u of uses) {
    const [repo] = u.split('@');
    assert.equal(allowed.has(repo), true, `未在离线白名单内的 action: ${repo}`);
  }
  const matched = lines(WORKFLOW).filter((l) => /uses:\s*\S+@[0-9a-f]{40}/.test(l));
  assert.equal(matched.length, uses.length);
});

test('CI: permissions 不超过 contents:read + pull-requests:write', () => {
  const text = read(WORKFLOW);
  const perm = block(text, 'permissions');
  assert.match(perm, /^ {2}contents: read$/m);
  assert.match(perm, /^ {2}pull-requests: write$/m);
  const granted = [...perm.matchAll(/^ {2}([a-z-]+):\s*(\S+)$/gm)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(granted.sort(), ['contents:read', 'pull-requests:write']);
  assert.equal(/write-all/.test(text), false);
  assert.equal(/contents:\s*write/.test(text), false);
});

test('CI: 不出现任何仓库密钥引用', () => {
  const text = read(WORKFLOW);
  const active = lines(WORKFLOW).filter((l) => !/^\s*#/.test(l));
  for (const line of active) {
    assert.equal(/secrets\./.test(line), false, `不得引用仓库密钥: ${line.trim()}`);
    assert.equal(/\$\{\{\s*secrets\./.test(line), false);
  }
  assert.equal(/API_KEY/.test(active.join('\n')), false, '不得注入任何 API Key 环境变量');
  assert.match(text, /QGATE_PROVIDER: deterministic/, '必须显式声明确定性 provider（离线）');
  assert.match(text, /OCR_OFFLINE: '1'/);
  // 内嵌脚本一律用 node -e；本仓库不含 python 内嵌脚本（避免非 UTF-8 locale 下的解码问题）
  assert.equal(/python/i.test(text), false, 'workflow 不得内嵌 python 脚本');
});

test('CI: 复用了 adapters/opencodereview/ci/github-actions.yml 模板并声明输入参数', () => {
  assert.equal(fs.existsSync(TEMPLATE), true, '模板文件必须存在');
  const tpl = read(TEMPLATE);
  assert.match(tpl, /workflow_call:/);
  for (const input of ['config-path', 'node-version', 'qgate-entry', 'ocr-preview', 'ocr-adapter-root', 'artifact-name', 'retention-days']) {
    assert.match(tpl, new RegExp(`\\n {6}${input}:`), `模板必须声明输入 ${input}`);
  }
  assert.match(tpl, /outputs:\s*\n\s+overall-outcome/);
  const tplNames = [...block(tpl, 'jobs').matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
  assert.deepEqual(tplNames, STAGES);
  for (const u of [...tpl.matchAll(/^\s*uses:\s*(\S+)/gm)].map((m) => m[1])) {
    assert.match(u, SHA_RE, `模板 action 未固定 SHA: ${u}`);
  }
  const tplActive = tpl.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  for (const line of tplActive) assert.equal(/secrets\./.test(line), false, `模板不得引用仓库密钥: ${line.trim()}`);
  // 模板同样不得依赖运行时生成的配置
  assert.equal(/Generate CI config/.test(tpl), false, '模板不得生成配置文件');
  const tplConfigInput = /\n {6}config-path:\n {8}type: string\n {8}default: (\S+)/.exec(tpl);
  assert.ok(tplConfigInput, '模板必须声明 config-path 输入且有默认值');
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, tplConfigInput[1])),
    true,
    `模板 config-path 默认值必须指向仓库中真实存在的配置: ${tplConfigInput[1]}`,
  );
  for (const [i, line] of tplActive.entries()) {
    for (const m of line.matchAll(/--config\s+("([^"$]+)"|\$([A-Za-z_][A-Za-z0-9_]*)|'([^'$]+)')/g)) {
      const literal = m[2] ?? m[4];
      if (!literal) continue; // $VAR 由 config-path 输入断言覆盖
      assert.equal(fs.existsSync(path.join(REPO_ROOT, literal)), true, `模板 --config 字面量必须存在: ${literal} (line ${i + 1})`);
    }
  }
});

test('CI: workflow 内嵌的 node -e 脚本可独立执行（无前序产物依赖）', async () => {
  const text = read(WORKFLOW);
  // requirements job 的 contract 自检是单行形式，其余块形式脚本按用途筛选
  const scripts = blockScripts(text);
  const humanGate = scripts.find((s) => /const gates = \[/.test(s) && /approval\.json/.test(s));
  const safetyAssert = scripts.find((s) => /ocr-selection-preview\.json/.test(s));
  assert.ok(humanGate, '必须存在人类门禁校验脚本');
  assert.ok(safetyAssert, '必须存在 selection 安全断言脚本');
  assert.equal(scripts.length, 2, `应恰好有两段块形式内嵌脚本（门禁校验/安全断言），实际 ${scripts.length}`);

  const dir = tempDir();
  try {
    // 脚本 1：人类门禁审批制品校验 —— 缺件时只报告、仍退出 0（不阻塞 job）
    const r1 = await runEmbeddedScript(humanGate, dir.path);
    assert.equal(r1.status, 0, `脚本 1 必须退出 0（人类门禁缺失只报告不崩）: ${r1.stderr}`);
    assert.match(r1.stdout, /MISSING req-to-design \(product\)/);
    assert.match(r1.stdout, /MISSING design-to-build \(architect\)/);
    assert.match(r1.stdout, /MISSING review-to-verify \(reviewer\)/);
    assert.match(r1.stdout, /HUMAN_GATE_NOT_APPROVED: 3 record\(s\) missing or mismatched/);

    // 审批齐备 ⇒ OK，且不得再报缺失
    for (const [id, role] of [['req-to-design', 'product'], ['design-to-build', 'architect'], ['review-to-verify', 'reviewer']]) {
      const abs = path.join(dir.path, 'verification', 'approvals', id, 'approval.json');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, JSON.stringify({ schemaVersion: '1.0', gateId: id, role, decision: 'approved', approvedBy: role, approvedAt: '2026-05-04T09:00:00Z', claims: [] }));
    }
    const r1b = await runEmbeddedScript(humanGate, dir.path);
    assert.equal(r1b.status, 0);
    assert.match(r1b.stdout, /OK req-to-design role=product decision=approved/);
    assert.equal(/HUMAN_GATE_NOT_APPROVED/.test(r1b.stdout), false, '审批齐备后不得再报缺失');

    // 脚本 2：安全断言 —— 通过 QGATE_EVIDENCE_DIR 定位产物（按 workflow 的 env 注入）
    const ciEnv = { QGATE_EVIDENCE_DIR: 'verification/evidence' };
    const evDir = path.join(dir.path, 'verification', 'evidence');
    fs.mkdirSync(evDir, { recursive: true });
    const evidence = path.join(evDir, 'ocr-selection-preview.json');

    fs.writeFileSync(evidence, JSON.stringify({ selectedPaths: ['src/app.mjs'], excludedPaths: ['.env.production'] }));
    const ok = await runEmbeddedScript(safetyAssert, dir.path, [], ciEnv);
    assert.equal(ok.status, 0, `合规 selection 必须退出 0: ${ok.stderr}`);
    assert.match(ok.stdout, /SAFETY_OK selected=1 excluded=1/);

    // 密钥路径进入 selected ⇒ 退出 3
    fs.writeFileSync(evidence, JSON.stringify({ selectedPaths: ['.env.production', 'a/secrets/b.txt'], excludedPaths: [] }));
    const bad = await runEmbeddedScript(safetyAssert, dir.path, [], ciEnv);
    assert.equal(bad.status, 3, '密钥路径进入 selected 必须退出 3');
    assert.match(bad.stderr, /SAFETY_VIOLATION/);

    // .env.production 未出现在 excluded ⇒ 退出 3
    fs.writeFileSync(evidence, JSON.stringify({ selectedPaths: ['src/app.mjs'], excludedPaths: ['other.txt'] }));
    const noExcluded = await runEmbeddedScript(safetyAssert, dir.path, [], ciEnv);
    assert.equal(noExcluded.status, 3, '缺少 .env.production 的 excludedPaths 必须退出 3');
    assert.match(noExcluded.stderr, /must appear in excludedPaths/);
  } finally {
    dir.cleanup();
  }
});

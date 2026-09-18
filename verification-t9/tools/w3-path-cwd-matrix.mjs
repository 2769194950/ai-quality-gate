#!/usr/bin/env node
// verification-t9/tools/w3-path-cwd-matrix.mjs — t68/W3: independently re-verify t67's two cwd/path fixes.
//
// Part 1 (matrix): run the adapter suite in >=6 cells that vary BOTH the repository path (the real
// repository, a copy without node_modules, a deeply nested copy) and the working directory (repository
// root, a drive root, demo/mini-service). Every cell must be 145/145/0.
//
// Part 2 (counter-examples): prove the fixed assertions were NOT loosened. Each counter-example is
// applied to a COPY (the real repository is never touched) and must still FAIL:
//   C1 unmaterialised AND unexplainable by the layer's rules  -> clause (b) must fire
//   C2 too many unmaterialised declarations                   -> the denominator clause must fire
//   C3 a path that IS materialised but would not be excluded  -> the disposition clause must fire
//
// Usage: node verification-t9/tools/w3-path-cwd-matrix.mjs [--json] [--keep]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WORK = process.argv.includes('--keep') ? 'E:\\Desktop\\t68-matrix' : path.join(os.tmpdir(), `t68-matrix-${Date.now()}`);
const SUITE_REL = path.join('adapters', 'opencodereview', 'tools', 'run-tests.mjs');

function copyRepo(target, { keepNodeModules }) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const entry of ['packages', 'adapters', 'schemas', 'docs', '.github', 'demo', 'package.json', 'qgate.config.json']) {
    const from = path.join(ROOT, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(target, entry), {
      recursive: true,
      filter: (src) => keepNodeModules || !/[\\/]node_modules([\\/]|$)/.test(src),
    });
  }
  return target;
}

function runSuite(root, cwd) {
  const out = path.join(os.tmpdir(), `t68-suite-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const fdOut = fs.openSync(out, 'w');
  let res;
  try {
    res = spawnSync(process.execPath, [path.join(root, SUITE_REL)], { cwd, stdio: ['ignore', fdOut, fdOut] });
  } finally {
    fs.closeSync(fdOut);
  }
  const text = fs.readFileSync(out, 'utf8');
  fs.rmSync(out, { force: true });
  const num = (label) => {
    const m = new RegExp(`\\u2139 ${label} (\\d+)`).exec(text);
    return m ? Number(m[1]) : null;
  };
  const failingBlock = /\u2716 failing tests:([\s\S]*)$/.exec(text);
  const failedTestNames = failingBlock
    ? [...failingBlock[1].matchAll(/\u2716 ([^\n(]+)/g)].map((m) => m[1].trim())
    : [];
  const messages = [...text.matchAll(/(?:\u2716 )?(已物化的夹具路径必须真实存在|未物化的夹具路径必须能由本层规则解释[^\n]*|夹具必须基本物化[^\n]*|关键夹具路径必须物化[^\n]*|夹具声明路径数不得少于[^\n]*|[^\n]*已物化时\*\*必须被排除\*\*[^\n]*|夹具 --root 扫描应纳入选定集[^\n]*)/g)].map((m) => m[1].trim());
  return { exit: res.status, testFiles: /共 (\d+) 个测试文件/.exec(text)?.[1] ? Number(/共 (\d+) 个测试文件/.exec(text)[1]) : null, tests: num('tests'), pass: num('pass'), fail: num('fail'), failedTestNames, messages: [...new Set(messages)], textLength: text.length };
}

function patchJson(target, rel, mutate) {
  const p = path.join(target, rel);
  const value = JSON.parse(fs.readFileSync(p, 'utf8'));
  mutate(value);
  fs.writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`);
}

const cells = [];
const results = [];
const envRoots = {};

// ── Part 1: matrix ────────────────────────────────────────────────────────────
const repo = ROOT;
envRoots.repo = repo;
const copyB = copyRepo(path.join(WORK, 'copyB-no-node-modules'), { keepNodeModules: false });
envRoots.copyB = copyB;
const deep = copyRepo(path.join(WORK, 'deep', 'l1', 'l2', 'copyE-no-node-modules'), { keepNodeModules: false });
envRoots.copyE = deep;

const matrix = [
  ['repo @cwd=repo', repo, repo],
  ['repo @cwd=C:\\', repo, 'C:\\'],
  ['repo @cwd=demo/mini-service', repo, path.join(repo, 'demo', 'mini-service')],
  ['copyB(no node_modules) @cwd=copyB', copyB, copyB],
  ['copyB @cwd=demo/mini-service', copyB, path.join(copyB, 'demo', 'mini-service')],
  ['copyB @cwd=C:\\', copyB, 'C:\\'],
  ['copyB @cwd=E:\\Desktop', copyB, 'E:\\Desktop'],
  ['copyE(deep, no node_modules) @cwd=copyE', deep, deep],
];
for (const [label, root, cwd] of matrix) {
  const r = runSuite(root, cwd);
  results.push({ label, root, cwd, ...r });
}
const matrixGreen = results.every((r) => r.exit === 0 && r.tests === 145 && r.pass === 145 && r.fail === 0);

// ── Part 2: counter-examples (each must still FAIL) ───────────────────────────
const counterExamples = [];
// C1: a declaration that is unmaterialised AND cannot be explained by any layer rule.
const c1 = copyRepo(path.join(WORK, 'c1-ghost-unexplainable'), { keepNodeModules: false });
patchJson(c1, path.join('adapters', 'opencodereview', 'demo', 'diff.json'), (d) => d.files.push({ path: 'src/ghost-module.mjs' }));
counterExamples.push({ id: 'C1 unmaterialised + unexplainable (src/ghost-module.mjs)', expect: 'clause (b): 未物化的夹具路径必须能由本层规则解释', ...runSuite(c1, c1) });
// C2: many declarations that are rule-explainable but unmaterialised ⇒ the denominator must bite.
const c2 = copyRepo(path.join(WORK, 'c2-denominator'), { keepNodeModules: false });
patchJson(c2, path.join('adapters', 'opencodereview', 'demo', 'diff.json'), (d) => {
  for (const p of ['node_modules/ghost/a.js', 'node_modules/ghost/b.js', 'node_modules/ghost/c.js', 'node_modules/ghost/d.js']) d.files.push({ path: p });
});
counterExamples.push({ id: 'C2 denominator (4 rule-explainable ghosts)', expect: 'clause (c): 夹具必须基本物化', ...runSuite(c2, c2) });
// C3: materialised but NOT excluded ⇒ the disposition clause must bite. Requires a copy that keeps
// node_modules AND a patched default-exclusion list, so the file would enter `selected`.
const c3 = copyRepo(path.join(WORK, 'c3-materialized-but-selected'), { keepNodeModules: true });
{
  const filters = path.join(c3, 'adapters', 'opencodereview', 'src', 'filters.mjs');
  const original = fs.readFileSync(filters, 'utf8');
  const patched = original.replace(/'node_modules',\n/, '');
  if (patched === original) throw new Error('C3 patch failed: could not remove node_modules from DEFAULT_EXCLUDE_DIRS');
  fs.writeFileSync(filters, patched);
}
counterExamples.push({ id: 'C3 materialised but node_modules no longer a default-excluded dir', expect: 'disposition clause: 已物化时必须被排除', ...runSuite(c3, c3) });

// C4: the second defect t67 fixed lives in the TEST itself (process.cwd() used as both root and
// homeDir). Reverting that in a copy must reproduce "passes from the repository root, fails from
// demo/mini-service" — i.e. the fix is load-bearing, not cosmetic.
const c4 = copyRepo(path.join(WORK, 'c4-grouping-reverted'), { keepNodeModules: false });
{
  const gf = path.join(c4, 'adapters', 'opencodereview', 'test', 'grouping-rules.test.mjs');
  const original = fs.readFileSync(gf, 'utf8');
  const patched = original
    .split('root: isolated.path,').join('root: process.cwd(),')
    .split("homeDir: path.join(isolated.path, 'no-such-home'),").join('homeDir: process.cwd(),');
  if (patched === original) throw new Error('C4 patch failed: the isolated root/homeDir form was not found');
  fs.writeFileSync(gf, patched);
}
const c4FromRoot = runSuite(c4, c4);
const c4FromMini = runSuite(c4, path.join(c4, 'demo', 'mini-service'));
// C4 is a pair: the SAME reverted code must PASS from the recorded path (defect hidden) and FAIL from
// demo/mini-service (defect exposed). The first half is a control, not a counter-example.
const hiddenControls = [{ id: 'C4 grouping-rules reverted to process.cwd(); run from copy root (defect hidden)', expect: 'must still pass 145/145/0', ...c4FromRoot }];
counterExamples.push({ id: 'C4 grouping-rules reverted to process.cwd(); run from demo/mini-service (defect exposed)', expect: 'must fail (the fix is load-bearing)', ...c4FromMini });
const allCounterExamplesFail = counterExamples.every((c) => c.exit !== 0 && c.fail >= 1);
const hiddenControlsHold = hiddenControls.every((c) => c.exit === 0 && c.tests === 145 && c.fail === 0);

const report = {
  cwd: process.cwd(),
  workdir: WORK,
  matrix,
  cells: results.map((r) => ({ label: r.label, cwd: r.cwd, exit: r.exit, testFiles: r.testFiles, tests: r.tests, pass: r.pass, fail: r.fail, failedTestNames: r.failedTestNames })),
  counterExamples: counterExamples.map((c) => ({ id: c.id, expect: c.expect, exit: c.exit, tests: c.tests, pass: c.pass, fail: c.fail, failedTestNames: c.failedTestNames, observedMessages: c.messages })),
  hiddenControls: hiddenControls.map((c) => ({ id: c.id, expect: c.expect, exit: c.exit, tests: c.tests, pass: c.pass, fail: c.fail })),
  summary: {
    cells: results.length,
    allCellsGreen: matrixGreen,
    counterExamples: counterExamples.length,
    allCounterExamplesStillFail: allCounterExamplesFail,
    hiddenControlsHold,
    c1ClauseBFired: counterExamples[0].fail >= 1 && counterExamples[0].messages.some((m) => /未物化的夹具路径必须能由本层规则解释/.test(m)),
    c2DenominatorFired: counterExamples[1].fail >= 1 && counterExamples[1].messages.some((m) => /夹具必须基本物化/.test(m)),
    c3DispositionFired: counterExamples[2].fail >= 1 && counterExamples[2].messages.some((m) => /必须被排除/.test(m)),
    c4ExposedOffRecordedPath: counterExamples[3].fail >= 1 && counterExamples[3].failedTestNames.some((n) => /内置层永远存在/.test(n)),
    c4HiddenOnRecordedPath: hiddenControls[0].fail === 0,
  },
};
if (!process.argv.includes('--keep')) for (const dir of [WORK]) fs.rmSync(dir, { recursive: true, force: true });
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  for (const c of results) console.log(`${String(c.exit).padEnd(3)} ${String(c.testFiles).padStart(2)} files ${String(c.tests).padStart(3)} tests pass=${c.pass} fail=${c.fail} :: ${c.label}  (cwd=${c.cwd})`);
  console.log(`matrix all green: ${matrixGreen}`);
  for (const c of counterExamples) console.log(`${String(c.exit).padEnd(3)} fail=${c.fail} :: ${c.id} — first messages: ${JSON.stringify(c.messages.slice(0, 2))} failedTests=${JSON.stringify(c.failedTestNames.slice(0, 3))}`);
  for (const c of hiddenControls) console.log(`${String(c.exit).padEnd(3)} fail=${c.fail} :: ${c.id}`);
  console.log(`summary=${JSON.stringify(report.summary)}`);
}
process.exitCode = matrixGreen && allCounterExamplesFail && hiddenControlsHold ? 0 : 1;

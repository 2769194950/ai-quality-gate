#!/usr/bin/env node
// verification-t9/tools/v3-cases.mjs — independent reproduction of the t40 negative/security cases.
// Every case builds its own throwaway tree under os.tmpdir() and drives the real CLI through the
// repository's own in-process harness (sandbox forbids piped child stdio). The shipped repository
// is only ever READ.  Usage: node verification-t9/tools/v3-cases.mjs [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDemoRepo, resetCopiedLedgerState, runCli, runCliJson, tmpDir, writeJson, writeText, readJson, cleanup } from '../../packages/qgate/test/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const results = [];

const record = (id, data) => results.push({ id, ...data });
const blockersOf = (json) => (json?.gates ?? []).flatMap((g) => (g.blockers ?? []).map((b) => ({ gate: g.id, checkId: b.checkId, message: b.message })));

/** demo tree copied to <tmp>/repo plus a config at <tmp>/qgate.config.json that anchors projectRoot */
function demoTree({ mutateConfig, mutateRepo, keepHistory = false } = {}) {
  const base = tmpDir('v3-demo-');
  const root = path.join(base, 'repo');
  fs.mkdirSync(base, { recursive: true });
  fs.cpSync(path.join(REPO, 'demo', 'mini-service'), root, { recursive: true });
  if (!keepHistory) {
    // reset the copied ledger state to the shipped baseline: this clears runIds/ledgers while the
    // index stays self-consistent, so a leftover dangling reference cannot masquerade as a defect
    // (t28's verifyLedgerChain() correctly rejects an index that points at deleted ledger files).
    resetCopiedLedgerState(root);
  }
  const config = JSON.parse(fs.readFileSync(path.join(REPO, 'demo', 'qgate.config.json'), 'utf8'));
  config.projectRoot = 'repo';
  if (mutateConfig) mutateConfig(config);
  writeJson(path.join(base, 'qgate.config.json'), config);
  if (mutateRepo) mutateRepo(root);
  return { base, root, configPath: path.join(base, 'qgate.config.json') };
}

async function runCase(id, args, expect) {
  const r = await runCliJson(args, { strict: false });
  record(id, {
    args: args.join(' '),
    status: r.status,
    code: r.json?.error?.code ?? null,
    overall_passed: r.json?.overall_passed ?? null,
    blockers: blockersOf(r.json),
    expect,
    ok: typeof expect === 'function' ? expect(r) : undefined,
    note: r.json ? null : `stdout not JSON: ${String(r.stdout).slice(0, 120)}`,
  });
}

// ---------------------------------------------------------------- 5/6: negative cases A and B
{
  const t = demoTree({ mutateRepo: (root) => fs.rmSync(path.join(root, '.qgate', 'evidence', 'test-results.json')) });
  await runCase('negA_missing_evidence_file', ['check', '--config', t.configPath, '--json'], (r) => r.status === 1 && JSON.stringify(blockersOf(r.json)).includes('.qgate/evidence/test-results.json'));
  cleanup(t.base);
}
{
  const t = demoTree();
  await runCase('negA_control_intact', ['check', '--config', t.configPath, '--json'], (r) => r.status === 0 && r.json?.overall_passed === true);
  cleanup(t.base);
}
{
  const t = demoTree({ mutateConfig: (c) => { delete c.version; } });
  await runCase('negB1_missing_version', ['check', '--config', t.configPath, '--json'], (r) => r.status === 2 && r.json?.error?.code === 'CONFIG_INVALID');
  cleanup(t.base);
}
{
  const t = demoTree({ mutateConfig: (c) => { c.gates[0].checks[0].type = 'file_exist'; } });
  await runCase('negB2_bad_check_type', ['check', '--config', t.configPath, '--json'], (r) => r.status === 2 && r.json?.error?.code === 'CONFIG_INVALID');
  cleanup(t.base);
}
{
  const t = demoTree();
  await runCase('negB3_config_not_found', ['check', '--config', path.join(t.base, 'nope.json'), '--json'], (r) => r.status === 2 && r.json?.error?.code === 'CONFIG_NOT_FOUND');
  cleanup(t.base);
}

// ---------------------------------------------------------------- 16: BOM tolerance
{
  const t = demoTree();
  const raw = fs.readFileSync(t.configPath, 'utf8');
  const bomPath = path.join(t.base, 'bom.config.json');
  fs.writeFileSync(bomPath, `\uFEFF${raw}`);
  await runCase('bom_valid', ['check', '--config', bomPath, '--json'], (r) => r.status === 0 && r.json?.overall_passed === true);
  const badPath = path.join(t.base, 'bom-bad.config.json');
  fs.writeFileSync(badPath, `\uFEFF${raw.slice(0, Math.floor(raw.length / 2))}`);
  await runCase('bom_then_invalid_json', ['check', '--config', badPath, '--json'], (r) => r.status === 2 && r.json?.error?.code === 'CONFIG_INVALID');
  cleanup(t.base);
}

// ---------------------------------------------------------------- A5: unknown keys at 4 levels
for (const level of ['provider', 'policy', 'selection', 'grouping']) {
  const t = demoTree({ mutateConfig: (c) => { c[level] = { ...(c[level] ?? {}), __v3_unknown_key: 1 }; } });
  await runCase(`unknown_key_in_${level}`, ['check', '--config', t.configPath, '--json'], (r) => r.status === 2 && r.json?.error?.code === 'CONFIG_INVALID');
  cleanup(t.base);
}

// ---------------------------------------------------------------- A2: R1 fail-closed + controls
function emptyBasis(root) {
  const idxPath = path.join(root, '.qgate', 'evidence', 'ledger-index.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  idx.runIds = [];
  idx.ledgers = [];
  idx.testIds = [];
  fs.writeFileSync(idxPath, `${JSON.stringify(idx, null, 2)}\n`);
  for (const n of fs.readdirSync(path.dirname(idxPath))) if (n.startsWith('ledger-') && n !== 'ledger-index.json') fs.rmSync(path.join(path.dirname(idxPath), n));
}
{
  const t = demoTree({ mutateRepo: emptyBasis });
  await runCase('A2_R1_missing_ledger_basis', ['check', '--config', t.configPath, '--json'], (r) => r.status === 1 && JSON.stringify(blockersOf(r.json)).includes('coverage basis missing'));
  cleanup(t.base);
}
{
  const t = demoTree();
  await runCase('A2_control_A_intact_basis', ['check', '--config', t.configPath, '--json'], (r) => r.status === 0 && r.json?.overall_passed === true);
  cleanup(t.base);
}
{
  const t = demoTree({
    mutateRepo: emptyBasis,
    mutateConfig: (c) => { c.gates.find((g) => g.id === 'verify-coverage').checks.find((x) => x.type === 'trace_matrix').testIdSource = 'trace-only'; },
  });
  await runCase('A2_control_B_explicit_trace_only', ['check', '--config', t.configPath, '--json'], (r) => {
    const text = JSON.stringify(r.json);
    return r.status === 0 && r.json?.overall_passed === true && /testIdSource=trace-only/.test(text);
  });
  cleanup(t.base);
}

// ---------------------------------------------------------------- A4: H8 deleted carrying check vs append-only history
{
  const t = demoTree({ keepHistory: true });
  // first run: populate the append-only history with the full check set
  await runCase('A4_control_history_intact_carrier', ['check', '--config', t.configPath, '--json'], (r) => r.status === 0);
  // second: delete the check that carries T-QG-003 (`req-index-valid` per src/contract.mjs:196)
  const cfg = JSON.parse(fs.readFileSync(t.configPath, 'utf8'));
  const gate = cfg.gates.find((g) => g.checks.some((c) => c.id === 'req-index-valid'));
  gate.checks = gate.checks.filter((c) => c.id !== 'req-index-valid');
  writeJson(t.configPath, cfg);
  await runCase('A4_H8_deleted_carrying_check', ['check', '--config', t.configPath, '--json'], (r) => r.status === 1 && JSON.stringify(blockersOf(r.json)).includes('T-QG-003') && JSON.stringify(blockersOf(r.json)).includes('req-index-valid'));
  cleanup(t.base);
}

// ---------------------------------------------------------------- A6: SAFE_001 comment / code / string-literal boundary
function policyTree(files, extra) {
  const base = tmpDir('v3-policy-');
  const root = path.join(base, 'repo');
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, text] of Object.entries(files)) writeText(path.join(root, rel), text);
  writeJson(path.join(base, 'qgate.config.json'), {
    version: '1.0',
    provider: { type: 'deterministic' },
    projectRoot: 'repo',
    policy: { evidenceDir: '.qgate/evidence', reportDir: '.qgate/reports', scanRoots: ['src'] },
    gates: [{ id: 'sec-gate', stage: 'build', required: true, checks: [{ id: 'policy-safe-001', type: 'policy', policyId: 'SAFE_001', required: true, ...(extra ?? {}) }] }],
  });
  return { base, root, configPath: path.join(base, 'qgate.config.json') };
}
{
  const t = policyTree({ 'src/comment-only.mjs': '// docs example: process.env.ANTHROPIC_API_KEY would be read here\n/* secrets.ANTHROPIC_API_KEY */\nexport const ok = 1;\n' });
  await runCase('A6_comment_only_is_prose', ['check', '--config', t.configPath, '--json'], (r) => r.status === 0 && r.json?.overall_passed === true);
  cleanup(t.base);
}
{
  const t = policyTree({ 'src/real-read.mjs': 'export function f(){ return process.env.ANTHROPIC_API_KEY; }\n' });
  await runCase('A6_real_code_env_read_detected', ['check', '--config', t.configPath, '--json'], (r) => r.status === 1 && JSON.stringify(blockersOf(r.json)).includes('POLICY_VIOLATION_SAFE_001'));
  cleanup(t.base);
}
{
  const t = policyTree({ 'src/bracket-read.mjs': "export const a = process.env['ANTHROPIC_API_KEY'];\nexport const b = process.env.OPENAI_API_KEY;\n" });
  await runCase('A6_other_env_spellings_detected', ['check', '--config', t.configPath, '--json'], (r) => r.status === 1 && JSON.stringify(blockersOf(r.json)).includes('POLICY_VIOLATION_SAFE_001'));
  cleanup(t.base);
}
{
  const t = policyTree({ 'src/string-literal.mjs': 'export const s = "process.env.X_API_KEY";\n' });
  await runCase('A6_string_literal_detected', ['check', '--config', t.configPath, '--json'], (r) => r.status === 1 && JSON.stringify(blockersOf(r.json)).includes('POLICY_VIOLATION_SAFE_001'));
  cleanup(t.base);
}
{
  const t = policyTree({ 'docs/notes.md': 'The reader uses process.env.MY_SECRET_TOKEN at runtime.\n' }, { expectedFiles: ['docs/notes.md'] });
  await runCase('A6_expectedFiles_reincludes_markdown', ['check', '--config', t.configPath, '--json'], (r) => r.status === 1 && JSON.stringify(blockersOf(r.json)).includes('POLICY_VIOLATION_SAFE_001'));
  cleanup(t.base);
}
{
  const base = tmpDir('v3-empty-');
  fs.mkdirSync(path.join(base, 'repo', 'empty'), { recursive: true });
  writeJson(path.join(base, 'qgate.config.json'), {
    version: '1.0',
    provider: { type: 'deterministic' },
    projectRoot: 'repo',
    policy: { evidenceDir: '.qgate/evidence', reportDir: '.qgate/reports', scanRoots: ['empty'] },
    gates: [{ id: 'sec-gate', stage: 'build', required: true, checks: [{ id: 'policy-safe-001', type: 'policy', policyId: 'SAFE_001', required: true }] }],
  });
  await runCase('A6_empty_scan_set_must_fail', ['check', '--config', path.join(base, 'qgate.config.json'), '--json'], (r) => r.status === 1);
  cleanup(base);
}

// ---------------------------------------------------------------- 21: provider cannot be evaluated
{
  const t = demoTree({ mutateConfig: (c) => { c.provider = { type: 'deterministic', fixture: 'fixtures/does-not-exist.json' }; } });
  const r = await runCliJson(['check', '--config', t.configPath, '--json'], { strict: false });
  record('provider_fixture_missing', {
    args: 'check --config <tmp, provider.fixture=fixtures/does-not-exist.json> --json',
    status: r.status,
    code: r.json?.error?.code ?? null,
    provider: r.json?.provider ?? null,
    overall_passed: r.json?.overall_passed ?? null,
    expect: 'no silent pass: either exit 3 PROVIDER_FAILED, or exit 0 only with an explicit degraded flag',
    ok: r.status === 3 ? r.json?.error?.code === 'PROVIDER_FAILED' : r.status === 0 && r.json?.provider?.degraded === true,
  });
  cleanup(t.base);
}
{
  const t = demoTree({ mutateConfig: (c) => { c.provider = { type: 'scripted', script: 'fixtures/absent-provider.mjs' }; } });
  await runCase('provider_scripted_missing_module', ['check', '--config', t.configPath, '--json'], (r) => r.status === 3 && r.json?.error?.code === 'PROVIDER_FAILED');
  cleanup(t.base);
}

// ---------------------------------------------------------------- 21: QGATE_REPO_ROOT must not silently bypass
{
  const t = demoTree();
  const plain = await runCliJson(['check', '--config', t.configPath, '--json'], { strict: false });
  const withEnv = await runCliJson(['check', '--config', t.configPath, '--json'], { strict: false, env: { QGATE_REPO_ROOT: path.join(t.base, 'not-the-root') } });
  const strip = (o) => { if (!o) return null; const c = JSON.parse(JSON.stringify(o)); for (const k of ['run_id', 'started_at', 'finished_at', 'duration_ms']) delete c[k]; return JSON.stringify(c); };
  record('qgate_repo_root_probe', {
    args: 'check --config <tmp> --json  (with and without env QGATE_REPO_ROOT=<bogus>)',
    statusWithout: plain.status,
    statusWith: withEnv.status,
    sameNormalizedResult: strip(plain.json) === strip(withEnv.json),
    expect: 'the env var must not silently re-anchor the repository',
    ok: plain.status === withEnv.status && strip(plain.json) === strip(withEnv.json),
  });
  cleanup(t.base);
}

// ---------------------------------------------------------------- A3-①: structural self-certification (ids from the static map)
{
  const t = demoTree();
  const r = await runCliJson(['check', '--config', t.configPath, '--json'], { strict: false });
  const idx = readJson(path.join(t.root, '.qgate', 'evidence', 'ledger-index.json'));
  const cfg = readJson(t.configPath);
  const ranChecks = (r.json?.gates ?? []).flatMap((g) => g.checks.map((c) => c.id));
  record('A3_1_structural_self_certification', {
    args: 'check --config <tmp demo copy> --json then read .qgate/evidence/ledger-index.json',
    status: r.status,
    stdoutHead: String(r.stdout ?? '').slice(0, 80),
    stderrHead: String(r.stderr ?? '').slice(0, 200),
    ledgerTestIds: idx.testIds,
    ranCheckIds: ranChecks,
    requirementIdsDeclaredCovered: (readJson(path.join(t.root, '.qgate', 'requirements-index.json')).requirements ?? []).map((x) => `${x.id}:${x.covered}`),
    note: 'coverage basis = ledger testIds, which are derived from the engine static map src/contract.mjs checkTestIds; no root-side test file was executed by this run',
  });
  cleanup(t.base);
}

// ---------------------------------------------------------------- A3-②: is a declared-but-untested id still covered?
{
  const t = demoTree({
    mutateRepo: (root) => {
      const idx = readJson(path.join(root, '.qgate', 'requirements-index.json'));
      idx.requirements[0].covered = true; // declared by the owner, no test backing it
      writeJson(path.join(root, '.qgate', 'requirements-index.json'), idx);
    },
  });
  const r = await runCliJson(['check', '--config', t.configPath, '--json'], { strict: false });
  const tr = await runCliJson(['trace', '--config', t.configPath, '--json'], { strict: false });
  record('A3_2_declared_covered_without_test', {
    args: 'check --config <tmp> --json ; trace --config <tmp> --json',
    checkStatus: r.status,
    traceStatus: tr.status,
    traceCovered: (tr.json?.requirements ?? []).map((x) => `${x.requirementId}:${x.covered}:${(x.testIds ?? []).length}`),
    traceSummary: tr.json?.summary ?? null,
    note: 'index declares covered=true for the first requirement; the run must not certify it by declaration alone',
  });
  cleanup(t.base);
}

// ---------------------------------------------------------------- 21: required + default severity must block
{
  const base = tmpDir('v3-sev-');
  const root = path.join(base, 'repo');
  writeText(path.join(root, 'REQ.md'), '# requirements\nREQ-DEMO-001\n');
  writeJson(path.join(base, 'qgate.config.json'), {
    version: '1.0',
    provider: { type: 'deterministic' },
    projectRoot: 'repo',
    gates: [{ id: 'g1', stage: 'requirements', required: true, checks: [{ id: 'pattern-check', type: 'regex', required: true, files: ['REQ.md'], pattern: 'NO_SUCH_TOKEN_XYZ', mode: 'count', minMatches: 1 }] }],
  });
  await runCase('required_failing_check_default_severity', ['check', '--config', path.join(base, 'qgate.config.json'), '--json'], (r) => r.status === 1 && r.json?.overall_passed === false);
  cleanup(base);
}

// ---------------------------------------------------------------- 21: ledger tampering must be exit 3
for (const mode of ['content', 'index_sha256', 'index_runIds', 'unregistered_ledger']) {
  const t = demoTree({ keepHistory: true });
  const cfgPath = t.configPath;
  await runCliJson(['check', '--config', cfgPath, '--json'], { strict: false }); // produce current-run ledgers
  const ev = path.join(t.root, '.qgate', 'evidence');
  const ledgerFiles = fs.readdirSync(ev).filter((n) => n.startsWith('ledger-'));
  const indexPath = path.join(ev, 'ledger-index.json');
  if (mode === 'content') {
    const f = path.join(ev, ledgerFiles[0]);
    fs.appendFileSync(f, '\n');
  } else if (mode === 'index_sha256') {
    const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    idx.ledgers[0].sha256 = 'f'.repeat(64);
    fs.writeFileSync(indexPath, `${JSON.stringify(idx, null, 2)}\n`);
  } else if (mode === 'index_runIds') {
    const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    idx.runIds.push('2020-01-01T00-00-00.000Z-deadbeef');
    fs.writeFileSync(indexPath, `${JSON.stringify(idx, null, 2)}\n`);
  } else {
    fs.writeFileSync(path.join(ev, 'ledger-2020-01-01T00-00-00.000Z-deadbeef.json'), '{}\n');
  }
  await runCase(`ledger_tamper_${mode}`, ['check', '--config', cfgPath, '--json'], (r) => r.status === 3 && r.json?.error?.code === 'EVIDENCE_UNRESOLVED');
  cleanup(t.base);
}

// ---------------------------------------------------------------- adapter: case-variant + hardlink bypass attempt (new)
{
  const { runPreview } = await import('../../adapters/opencodereview/test/helpers.mjs');
  const base = tmpDir('v3-bypass-');
  const root = path.join(base, 'repo');
  writeText(path.join(root, 'src', 'app.mjs'), 'export const a = 1;\n');
  writeText(path.join(root, '.env'), 'DB_PASSWORD=hunter2\n');
  writeText(path.join(root, 'Credentials.json'), '{"access_key":"AKIA..."}\n');
  writeText(path.join(root, 'Secrets', 'db.txt'), 'password=hunter2\n');
  fs.linkSync(path.join(root, '.env'), path.join(root, 'docs.txt')); // hardlink alias
  const diffPath = path.join(base, 'diff.json');
  writeJson(diffPath, {
    version: '1.0',
    files: ['src/app.mjs', '.env', 'Credentials.json', 'Secrets/db.txt', 'docs.txt'],
  });
  const rulePath = path.join(base, 'rule.json');
  writeJson(rulePath, { version: '1.0', include: [{ id: 'all', pattern: '**/*', reason: 'case-variant + hardlink attempt' }], exclude: [], includeExtensions: ['.mjs', '.json', '.txt', '.env', ''] });
  const out = runPreview(['--diff', diffPath, '--rule', rulePath, '--json']);
  const SEC = /(^|\/)\.env|\.pem$|\.key$|(^|\/)id_rsa|(^|\/)credentials|(^|\/)secrets\//i;
  const included = out.payload?.selection?.included ?? [];
  record('adapter_case_and_hardlink_bypass', {
    args: 'ocr-preview --diff <tmp> --rule <tmp, include **/*> --json',
    status: out.exitCode,
    included,
    leaked: included.filter((p) => SEC.test(p)),
    excluded: (out.payload?.excluded ?? []).map((e) => `${e.path}|${e.reason}`),
    expect: 'case-variant Credentials.json / Secrets/db.txt and the docs.txt hardlink alias must not be selected',
    ok: out.exitCode === 0 && included.filter((p) => SEC.test(p)).length === 0,
  });
  cleanup(base);
}

if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ cwd: process.cwd(), cases: results }, null, 2)}\n`);
else for (const r of results) {
  const verdict = r.ok === undefined ? 'INFO' : r.ok ? 'OK  ' : 'FAIL';
  console.log(`${verdict} ${r.id}  status=${r.status} code=${r.code} overall=${r.overall_passed}`);
  if (r.blockers?.length) console.log(`      blockers=${JSON.stringify(r.blockers.map((b) => b.message.slice(0, 150)))}`);
  if (r.note && r.ok === undefined) console.log(`      note=${r.note}`);
}
process.exitCode = results.every((r) => r.ok === undefined || r.ok) ? 0 : 1;

#!/usr/bin/env node
// verification-t9/tools/w12-engine-case.mjs — t55 W1/W2: engine-side path-name case-insensitivity
// (R3-B1) and the uppercase hardlink target (R3-H1).
//
// W1 builds two ISOMORPHIC trees whose only difference is the on-disk case of path names, then
// checks BOTH engine paths (`preview` and `check`/SAFE_002) and asserts that every sensitive entry
// is excluded because of the sensitive-name rule (`reason=secret_path`, `rule=secret-*`) and NOT
// because the extension whitelist happened to drop it (`reason=extension`).
// W2 builds an uppercase sensitive target (`Credentials.json`) with a lower-case hard link
// (`notes.txt`) and asserts the frozen shape `reason=secret_path` + `rule=alias:secret-credentials:…`.
// Plus one verifier-constructed bypass attempt: a case-variant alias name to a case-variant target.
// Usage: node verification-t9/tools/w12-engine-case.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { runCliJson, tmpDir, writeJson, writeText, cleanup } from '../../packages/qgate/test/helpers.mjs';

const results = { w1: null, w2: null, bypass: null };

function makeTree(dir, entries) {
  for (const [rel, value] of Object.entries(entries)) writeText(path.join(dir, rel), typeof value === 'string' ? value : value.text);
}
function saf002Config(base, rootName = 'repo') {
  const p = path.join(base, 'qgate.config.json');
  writeJson(p, {
    version: '1.0',
    provider: { type: 'deterministic' },
    projectRoot: rootName,
    policy: { evidenceDir: '.qgate/evidence', reportDir: '.qgate/reports' },
    gates: [{ id: 'verify-coverage', stage: 'verify', required: true, checks: [{ id: 'no-secret-paths', type: 'policy', policyId: 'SAFE_002', required: true }] }],
  });
  return p;
}
const met = (evidence) => {
  const text = JSON.stringify(evidence ?? []);
  const m = /secretPathsExcluded\\?":(\d+)/.exec(text);
  return m ? Number(m[1]) : null;
};
const byPath = (excluded) => Object.fromEntries((excluded ?? []).map((e) => [e.path, { reason: e.reason, rule: e.rule ?? null, stage: e.stage ?? null }]));

// ---------------------------------------------------------------- W1: isomorphic UPPER / lower trees
const PAIRS = [
  ['.ENV', 'ANTHROPIC_API_KEY=sk-ant-shouldnotleak\n', '.env'],
  ['Credentials.json', '{"access_key":"AKIAIOSFODNN7EXAMPLE"}\n', 'credentials.json'],
  ['Secrets/Db.Txt', 'password=hunter2\n', 'secrets/db.txt'],
  ['CONFIG/TLS/SERVER.PEM', '-----BEGIN PRIVATE KEY-----\n', 'config/tls/server.pem'],
  ['NODE_MODULES/dep.mjs', 'export const d = 1;\n', 'node_modules/dep.mjs', 'default_dir'],
  ['.Env.Production', 'ANTHROPIC_API_KEY=sk-ant-shouldnotleak\n', '.env.production'],
  // NOTE: the second variant deliberately reuses the SAME directory casing already present in the
  // tree (`Secrets/…`), because a case-insensitive filesystem cannot hold both `Secrets/` and
  // `SECRETS/` — writing `SECRETS/API.KEY` first would silently resolve into the existing `Secrets/`
  // directory (observed), which would make the fixture non-isomorphic rather than exposing a defect.
  ['Secrets/API.KEY', 'k = 1\n', 'secrets/api.key', 'sensitive'],
];
const COMMON = { 'src/app.mjs': 'export const a = 1;\n' };

async function runTree({ id, entries }) {
  const base = tmpDir(`t55-${id}-`);
  const root = path.join(base, 'repo');
  makeTree(root, { ...COMMON, ...entries });
  const configPath = saf002Config(base);
  const preview = await runCliJson(['preview', '--root', root, '--json'], { strict: false });
  const check = await runCliJson(['check', '--config', configPath, '--json'], { strict: false });
  const included = preview.json?.selection?.included ?? [];
  const ex = byPath(preview.json?.selection?.excluded);
  const sensitive = Object.keys(entries);
  const safeSelected = Object.keys(preview.json?.invariants?.secretPathsSelected ?? []);
  const saf002 = (check.json?.gates ?? []).flatMap((g) => g.checks ?? []).find((c) => c.id === 'no-secret-paths') ?? null;
  const out = {
    id,
    previewExit: preview.status,
    checkExit: check.status,
    included,
    sensitiveEntries: sensitive.map((p) => ({ path: p, kind: entries[p].kind, ...(ex[p] ?? { reason: null, rule: null }) })),
    excludedReasonCounts: Object.values(ex).reduce((acc, v) => { acc[v.reason] = (acc[v.reason] ?? 0) + 1; return acc; }, {}),
    secretPathsSelected: safeSelected,
    saf002Passed: saf002?.passed ?? null,
    secretPathsExcluded: met(saf002?.evidence),
  };
  cleanup(base);
  return out;
}

const upperEntries = Object.fromEntries(PAIRS.map(([u, text, , kind]) => [u, { text, kind }]));
const lowerEntries = Object.fromEntries(PAIRS.map(([, text, l, kind]) => [l, { text, kind }]));
const upper = await runTree({ id: 'upper', entries: upperEntries });
const lower = await runTree({ id: 'lower', entries: lowerEntries });

const norm = (s) => String(s).toLowerCase();
const reasonChecks = (t) => t.sensitiveEntries.map((e) => ({
  path: e.path,
  kind: e.kind,
  reason: e.reason,
  rule: e.rule,
  // sensitive names must be excluded by the sensitive-name rule, never by the extension whitelist
  reasonIsSensitiveNotExtension: e.kind === 'default_dir'
    ? e.reason === 'default_excluded_path'
    : typeof e.reason === 'string' && e.reason !== 'extension' && (e.reason.startsWith('secret') || String(e.rule ?? '').startsWith('secret')),
}));
results.w1 = {
  upper: { ...upper, reasonChecks: reasonChecks(upper) },
  lower: { ...lower, reasonChecks: reasonChecks(lower) },
  verdict: {
    upperIncludedClean: !upper.included.some((p) => /\.env|\.pem$|\.key$|credentials|secrets\//i.test(p)),
    lowerIncludedClean: !lower.included.some((p) => /\.env|\.pem$|\.key$|credentials|secrets\//i.test(p)),
    includedSetsIsomorphic: JSON.stringify(upper.included.map(norm).sort()) === JSON.stringify(lower.included.map(norm).sort()),
    secretCountsEqual: upper.secretPathsExcluded === lower.secretPathsExcluded,
    saf002PassedBoth: upper.saf002Passed === true && lower.saf002Passed === true,
    everySensitiveReasonIsSensitiveNotExtension: [...reasonChecks(upper), ...reasonChecks(lower)].every((r) => r.reasonIsSensitiveNotExtension),
    invariantsCleanBoth: upper.secretPathsSelected.length === 0 && lower.secretPathsSelected.length === 0,
  },
};

// ---------------------------------------------------------------- W2: uppercase hardlink target
{
  const base = tmpDir('t55-alias-upper-');
  const root = path.join(base, 'repo');
  makeTree(root, { ...COMMON, 'Credentials.json': '{"access_key":"AKIAIOSFODNN7EXAMPLE"}\n' });
  fs.linkSync(path.join(root, 'Credentials.json'), path.join(root, 'notes.txt'));
  const configPath = saf002Config(base);
  const preview = await runCliJson(['preview', '--root', root, '--json'], { strict: false });
  const check = await runCliJson(['check', '--config', configPath, '--json'], { strict: false });
  const ex = byPath(preview.json?.selection?.excluded);
  const saf002 = (check.json?.gates ?? []).flatMap((g) => g.checks ?? []).find((c) => c.id === 'no-secret-paths') ?? null;
  const alias = ex['notes.txt'] ?? null;
  results.w2 = {
    previewExit: preview.status,
    checkExit: check.status,
    included: preview.json?.selection?.included ?? [],
    aliasEntry: alias,
    targetEntry: ex['Credentials.json'] ?? null,
    secretPathsExcluded: met(saf002?.evidence),
    saf002Passed: saf002?.passed ?? null,
    verdict: {
      aliasExcluded: alias !== null && !(preview.json?.selection?.included ?? []).includes('notes.txt'),
      reasonIsFrozenSecretPath: alias?.reason === 'secret_path',
      ruleIsAliasOfCredentials: typeof alias?.rule === 'string' && alias.rule.startsWith('alias:secret-credentials:'),
      reasonIsNotAdapterVocabulary: alias?.reason !== 'hardlink_secret_alias',
      countIsTwo: met(saf002?.evidence) === 2,
    },
  };
  cleanup(base);
}

// ---------------------------------------------------------------- verifier-constructed bypass attempt
{
  const base = tmpDir('t55-bypass-');
  const root = path.join(base, 'repo');
  makeTree(root, { ...COMMON, 'CREDENTIALS.JSON': '{"access_key":"AKIAIOSFODNN7EXAMPLE"}\n' });
  fs.linkSync(path.join(root, 'CREDENTIALS.JSON'), path.join(root, 'Handbook.txt')); // case-variant alias -> case-variant target
  fs.linkSync(path.join(root, 'CREDENTIALS.JSON'), path.join(root, 'MANUAL.TXT')); // second case-variant alias
  // NOTE: on Windows a case-insensitive filesystem cannot hold both `Handbook.txt` and `HANDBOOK.TXT`,
  // so the second alias uses a different (upper-case) name instead of a case variant of the first.
  const configPath = saf002Config(base);
  const preview = await runCliJson(['preview', '--root', root, '--json'], { strict: false });
  const check = await runCliJson(['check', '--config', configPath, '--json'], { strict: false });
  const ex = byPath(preview.json?.selection?.excluded);
  const saf002 = (check.json?.gates ?? []).flatMap((g) => g.checks ?? []).find((c) => c.id === 'no-secret-paths') ?? null;
  const included = preview.json?.selection?.included ?? [];
  results.bypass = {
    attempt: 'case-variant hard links of a case-variant sensitive target (CREDENTIALS.JSON -> Handbook.txt / MANUAL.TXT), no lower-case sensitive name anywhere',
    included,
    aliasEntries: { 'Handbook.txt': ex['Handbook.txt'] ?? null, 'MANUAL.TXT': ex['MANUAL.TXT'] ?? null },
    targetEntry: ex['CREDENTIALS.JSON'] ?? null,
    secretPathsExcluded: met(saf002?.evidence),
    saf002Passed: saf002?.passed ?? null,
    verdict: {
      noAliasSelected: !included.some((p) => /handbook|manual/i.test(p)),
      bothAliasesExcluded: ex['Handbook.txt'] !== undefined && ex['MANUAL.TXT'] !== undefined,
      aliasesUseIdentityChain: /alias:secret-credentials:/.test(String(ex['Handbook.txt']?.rule ?? '')) && /alias:secret-credentials:/.test(String(ex['MANUAL.TXT']?.rule ?? '')),
    },
  };
  cleanup(base);
}

if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ cwd: process.cwd(), ...results }, null, 2)}\n`);
else {
  console.log('--- W1 UPPER vs lower ---');
  for (const t of [results.w1.upper, results.w1.lower]) {
    console.log(`${t.id}: preview=${t.previewExit} check=${t.checkExit} included=${JSON.stringify(t.included)} secretPathsExcluded=${t.secretPathsExcluded} saf002Passed=${t.saf002Passed}`);
    for (const s of t.sensitiveEntries) console.log(`   ${s.path} -> reason=${s.reason} rule=${s.rule}`);
  }
  console.log(`W1 verdict=${JSON.stringify(results.w1.verdict)}`);
  console.log('--- W2 uppercase alias ---');
  console.log(`included=${JSON.stringify(results.w2.included)} alias=${JSON.stringify(results.w2.aliasEntry)} secretPathsExcluded=${results.w2.secretPathsExcluded}`);
  console.log(`W2 verdict=${JSON.stringify(results.w2.verdict)}`);
  console.log('--- verifier-constructed bypass attempt ---');
  console.log(`included=${JSON.stringify(results.bypass.included)} aliases=${JSON.stringify(results.bypass.aliasEntries)} secretPathsExcluded=${results.bypass.secretPathsExcluded}`);
  console.log(`bypass verdict=${JSON.stringify(results.bypass.verdict)}`);
}
const ok = Object.values(results.w1.verdict).every(Boolean) && Object.values(results.w2.verdict).every(Boolean) && Object.values(results.bypass.verdict).every(Boolean);
process.exitCode = ok ? 0 : 1;

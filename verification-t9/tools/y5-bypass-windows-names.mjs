#!/usr/bin/env node
// verification-t9/tools/y5-bypass-windows-names.mjs — t60/Y5: a NEWLY constructed bypass attempt.
//
// Target: can a sensitive file be pulled back into the review selection by abusing *how the path is
// spelled* rather than the rule set? Classic Windows/Linux mismatch families, all self-built here:
//   * case variants                  (.ENV, Secrets/DB.TXT, CONFIG/TLS/SERVER.PEM)
//   * trailing dot / trailing space  (".env." — Win32 strips it at create time)
//   * `./` and `.\` prefixes, `..` traversal, doubled separators
//   * NTFS alternate data stream     (".env::$DATA")
//   * 8.3 short name                 ("CREDEN~1.JSON")
// Both layers are asked: the engine's SAFE_002 predicate and the adapter's authoritative selector
// (selectFiles) with the most permissive rules possible (`include:['**/*']`), which is the strongest
// form of the "user include cannot rescue a secret path" invariant.
//
// Usage: node verification-t9/tools/y5-bypass-windows-names.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, writeText, writeJson, cleanup } from '../../packages/qgate/test/helpers.mjs';
import { policySafe002 } from '../../packages/qgate/src/policy.mjs';
import { isSensitivePath } from '../../adapters/opencodereview/src/filters.mjs';
import { selectFiles } from '../../adapters/opencodereview/src/selection.mjs';

const SENSITIVE = [
  ['.env', 'API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz012345'],
  ['Credentials.json', '{"client_secret":"ghp_abcdefghijklmnopqrstuvwxyz0123456789"}'],
  ['secrets/db.txt', 'password=PLACEHOLDER-NOT-A-REAL-KEY'],
  ['config/tls/server.pem', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n'],
  ['src/chain/id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n'],
  ['src/app.mjs', 'export const value = 1;\n'],
];

// Variants that a hostile (or merely Windows-generated) diff could name for `.env`:
const ENV_VARIANTS = ['.env', '.ENV', '.Env', '.env.', '.env ', ' .env', './.env', '.\\.env', 'src/../.env', '.env::$DATA', '.env::stream', 'secrets/../.env'];
const OTHER_VARIANTS = ['Credentials.json', 'credentials.json', 'CREDENTIALS.JSON', 'CREDEN~1.JSON', 'config/tls/server.pem', 'config\\tls\\server.pem', 'config/tls/SERVER.PEM', 'secrets/db.txt', 'Secrets/DB.TXT', 'secrets\\db.txt', 'src/chain/id_rsa', 'src/chain/ID_RSA', 'src/chain/id_rsa.', './src/chain/id_rsa'];

const base = tmpDir('t60-y5-');
const root = path.join(base, 'repo');
for (const [rel, text] of SENSITIVE) writeText(path.join(root, rel), text);

// 1. What does the filesystem actually store for the Win32-normalising variants?
const onDiskProbe = [];
for (const name of ['.env.', '.env ', ' .env', '.env::$DATA', 'CREDEN~1.JSON']) {
  const target = path.join(root, name);
  let created = null;
  let error = null;
  try {
    fs.writeFileSync(target, 'API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz012345');
    created = true;
  } catch (err) {
    error = `${err.code || ''} ${err.message}`.trim();
  }
  let readdirNames = [];
  try {
    readdirNames = fs.readdirSync(path.dirname(target)).filter((n) => /env|CREDEN|credential/i.test(n));
  } catch {
    /* ignore */
  }
  onDiskProbe.push({ declared: name, writeSucceeded: created, error, directoryEntries: readdirNames });
}

// 2. Name-rule level (no filesystem): does the layer call the spelling sensitive?
const nameRule = [...ENV_VARIANTS, ...OTHER_VARIANTS].map((rel) => ({ path: rel, adapterIsSensitivePath: isSensitivePath(rel) }));

// 3. Selection level (adapter): the most permissive include there is, on a diff that names the variants.
const diffFiles = [...ENV_VARIANTS, ...OTHER_VARIANTS].map((p) => ({ path: p }));
const diffPath = path.join(base, 'diff.json');
writeJson(diffPath, { files: diffFiles });
const selection = selectFiles({
  diffPath,
  sizeRoot: root,
  rules: { layers: [{ source: 'cli:--rule', include: ['**/*'], exclude: [] }], effective: { defaultExcludeDirs: null } },
});
const includedPaths = (selection.included || []).map((f) => (typeof f === 'string' ? f : f.path));
const excludedPaths = (selection.excluded || []).map((f) => (typeof f === 'string' ? f : f.path));
const exclusionReasons = Object.fromEntries(
  (selection.excluded || []).map((e) => [typeof e === 'string' ? e : e.path, typeof e === 'string' ? null : { reason: e.reason ?? null, ruleId: e.ruleId ?? e.decided_by ?? null }]),
);
const sec = selection.safety || null;

// 4. Engine side (SAFE_002 with its own widest include `**/*`): does an engine-side scan of a root
// full of variant spellings admit any of them? A plain `.env` root is measured as the control.
const variantRoot = path.join(base, 'engine-variants');
for (const rel of [...ENV_VARIANTS, ...OTHER_VARIANTS]) {
  if (/::$|::$DATA|::stream/.test(rel)) continue; // NTFS ADS spellings have no portable on-disk form
  try {
    writeText(path.join(variantRoot, rel), 'API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz012345');
  } catch {
    /* an unusable spelling is itself a result; the on-disk probe above records it */
  }
}
const controlRoot = path.join(base, 'engine-control');
writeText(path.join(controlRoot, '.env'), 'API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz012345');
writeText(path.join(controlRoot, 'src/app.mjs'), 'export const value = 1;\n');
const engineVariants = policySafe002(variantRoot);
const engineControl = policySafe002(controlRoot);

// Which sensitive material actually made it into the selection? Compare by realpath/inode, so a
// variant that resolves to a sensitive file on disk counts as a bypass even if the spelling differs.
const sensitiveReal = new Set();
for (const [rel] of SENSITIVE) {
  if (!isSensitivePath(rel)) continue;
  try {
    const st = fs.statSync(path.join(root, rel));
    sensitiveReal.add(`${st.dev}:${st.ino}`);
  } catch {
    /* ignore */
  }
}
const admittedSensitive = [];
for (const rel of includedPaths) {
  let st = null;
  try {
    st = fs.statSync(path.join(root, rel));
  } catch {
    continue;
  }
  const sameInode = sensitiveReal.has(`${st.dev}:${st.ino}`);
  if (sameInode || isSensitivePath(rel)) admittedSensitive.push({ path: rel, sensitiveByName: isSensitivePath(rel), sameInodeAsSensitiveFile: sameInode });
}

const report = {
  cwd: process.cwd(),
  layerNotes: {
    adapter: 'adapters/opencodereview/src/selection.mjs selectFiles() with include:["**/*"] as the widest possible include',
    engine: 'packages/qgate/src/policy.mjs policySafe002(root) (its own widest include `**/*`)',
    nameRule: 'adapters/opencodereview/src/filters.mjs isSensitivePath()',
  },
  onDiskProbe,
  nameRule,
  selection: {
    declared: diffFiles.length,
    included: includedPaths,
    excluded: excludedPaths,
    unmaterialized: (selection.unmaterialized || []).map((f) => (typeof f === 'string' ? f : f.path)),
    safetyNoSensitiveSelected: sec ? sec.no_sensitive_selected : null,
    safetyNeverReincludable: sec ? sec.sensitive_paths_never_reincludable : null,
    hardlinkAliases: (sec && sec.hardlink_aliases) || [],
  },
  admittedSensitive,
  exclusionReasons,
  eliminatedByOtherRules: Object.fromEntries(Object.entries(exclusionReasons).filter(([, v]) => v && v.reason && v.reason !== 'secret_path')),
  nameRuleMissesButStillExcluded: nameRule.filter((r) => !r.adapterIsSensitivePath && exclusionReasons[r.path] && exclusionReasons[r.path].reason !== 'secret_path').map((r) => ({ path: r.path, reason: exclusionReasons[r.path].reason })),
  engine: { variants: { passed: engineVariants.passed, metrics: engineVariants.metrics }, control: { passed: engineControl.passed, metrics: engineControl.metrics } },
  summary: {
    bypassFound: admittedSensitive.length > 0,
    admittedSensitive,
    nameRuleMisses: nameRule.filter((r) => !r.adapterIsSensitivePath).map((r) => r.path),
    engineDidNotAdmitVariants: engineVariants.passed === true,
    engineControlExcludesPlainEnv: engineControl.metrics.secretPathsExcluded >= 1,
    variantDriftVsControl: engineVariants.metrics.secretPathsExcluded - engineControl.metrics.secretPathsExcluded,
    unmaterializedVariants: (selection.unmaterialized || []).length,
  },
};
cleanup(base);
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  console.log('on-disk behaviour of Win32-normalising names:');
  for (const p of onDiskProbe) console.log(`  ${p.declared.padEnd(14)} write=${p.writeSucceeded} error=${p.error} entries=${JSON.stringify(p.directoryEntries)}`);
  console.log(`name-rule misses (not called sensitive): ${JSON.stringify(report.summary.nameRuleMisses)}`);
  console.log(`  ...of those, excluded only by another rule: ${JSON.stringify(report.nameRuleMissesButStillExcluded)}`);
  console.log(`selection included=${JSON.stringify(includedPaths)}`);
  console.log(`selection excluded=${JSON.stringify(excludedPaths)}`);
  console.log(`admittedSensitive=${JSON.stringify(admittedSensitive)}`);
  console.log(`engine SAFE_002 variants passed=${engineVariants.passed} metrics=${JSON.stringify(engineVariants.metrics)}`);
  console.log(`engine SAFE_002 control  passed=${engineControl.passed} metrics=${JSON.stringify(engineControl.metrics)}`);
  console.log(`summary=${JSON.stringify(report.summary)}`);
}
process.exitCode = report.summary.bypassFound ? 1 : 0;

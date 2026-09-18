#!/usr/bin/env node
// verification-t9/tools/t42-verify.mjs — independent re-check of the t42 fix (F1) plus a spot-check of
// three entries from the adapter's "10 safety decisions x 3 paths" coverage table.
// All cases build throwaway trees under os.tmpdir(); the shipped repository is only READ.
// Usage: node verification-t9/tools/t42-verify.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { runPreview } from '../../adapters/opencodereview/test/helpers.mjs';
import { tmpDir, writeJson, writeText, cleanup } from '../../packages/qgate/test/helpers.mjs';

const out = [];
const rec = (id, data) => out.push({ id, ...data });

function tree(files, diffFiles, extraRule = {}) {
  const base = tmpDir('v42-');
  const root = path.join(base, 'repo');
  for (const [rel, text] of Object.entries(files)) writeText(path.join(root, rel), text);
  const diffPath = path.join(base, 'diff.json');
  writeJson(diffPath, { version: '1.0', files: diffFiles });
  const rulePath = path.join(base, 'rule.json');
  writeJson(rulePath, {
    version: '1.0',
    include: [{ id: 'all', pattern: '**/*', reason: 'coverage probe' }],
    exclude: [],
    includeExtensions: ['.mjs', '.json', '.txt', '.env', '.pem', '.key', ''],
    ...extraRule,
  });
  return { base, root, diffPath, rulePath };
}

// 1) F1 regression: three hardlink-alias variants (previously 3/3 leaked)
const hardlinkVariants = [
  { id: 'h1_alias_of_env_plain', secret: '.env', alias: 'docs.txt', content: 'DB_PASSWORD=hunter2\n' },
  { id: 'h2_alias_of_env_key_shaped', secret: '.env', alias: 'notes.txt', content: 'ANTHROPIC_API_KEY=sk-ant-shouldnotleak\n' },
  { id: 'h3_alias_of_credentials_json', secret: 'Credentials.json', alias: 'handbook.txt', content: '{"access_key":"AKIAIOSFODNN7EXAMPLE"}\n' },
];
for (const v of hardlinkVariants) {
  const t = tree({ 'src/app.mjs': 'export const a = 1;\n', [v.secret]: v.content }, ['src/app.mjs', v.secret, v.alias]);
  fs.linkSync(path.join(t.root, v.secret), path.join(t.root, v.alias));
  const r = runPreview(['--diff', t.diffPath, '--rule', t.rulePath, '--json']);
  const included = r.payload?.selection?.included ?? [];
  const excluded = (r.payload?.excluded ?? []).map((e) => `${e.path}|${e.reason}`);
  rec(v.id, {
    exit: r.exitCode, included, excluded,
    aliasSelected: included.includes(v.alias),
    aliasExclusionReason: excluded.find((x) => x.startsWith(`${v.alias}|`)) ?? null,
    ok: r.exitCode === 0 && !included.includes(v.alias) && excluded.some((x) => x.startsWith(`${v.alias}|`)),
  });
  cleanup(t.base);
}

// 2) cause #2 of the t42 root cause: a diff with a low hit rate (many deleted/unmaterialised paths)
{
  const files = { 'src/app.mjs': 'export const a = 1;\n', '.env': 'ANTHROPIC_API_KEY=sk-ant-shouldnotleak\n' };
  const diffFiles = ['src/app.mjs', '.env', 'gone/one.js', 'gone/two.js', 'gone/three.js', 'gone/four.js', 'gone/five.js', 'gone/six.js'];
  const t = tree(files, diffFiles);
  fs.linkSync(path.join(t.root, '.env'), path.join(t.root, 'lowhit.txt'));
  diffFiles.push('lowhit.txt');
  writeJson(t.diffPath, { version: '1.0', files: diffFiles });
  const r = runPreview(['--diff', t.diffPath, '--rule', t.rulePath, '--json']);
  const included = r.payload?.selection?.included ?? [];
  rec('low_hit_rate_diff_still_excludes_alias', {
    exit: r.exitCode, included,
    aliasSelected: included.includes('lowhit.txt'),
    ok: r.exitCode === 0 && !included.includes('lowhit.txt'),
  });
  cleanup(t.base);
}

// 3) spot-check from the coverage table: case variants in --diff mode
{
  const t = tree(
    { 'src/app.mjs': 'export const a = 1;\n', 'Credentials.json': '{"a":1}\n', 'Secrets/db.txt': 'password=x\n' },
    ['src/app.mjs', 'Credentials.json', 'Secrets/db.txt'],
  );
  const r = runPreview(['--diff', t.diffPath, '--rule', t.rulePath, '--json']);
  const included = r.payload?.selection?.included ?? [];
  const excluded = (r.payload?.excluded ?? []).map((e) => `${e.path}|${e.reason}`);
  rec('coverage_case_variants_diff_mode', {
    exit: r.exitCode, included, excluded,
    ok: r.exitCode === 0 && !included.includes('Credentials.json') && !included.includes('Secrets/db.txt'),
  });
  cleanup(t.base);
}

// 4) spot-check: default-excluded directory in --diff mode
{
  const t = tree(
    { 'src/app.mjs': 'export const a = 1;\n', 'node_modules/pkg/index.mjs': 'export const x = 1;\n', 'dist/bundle.mjs': 'export const y = 2;\n' },
    ['src/app.mjs', 'node_modules/pkg/index.mjs', 'dist/bundle.mjs'],
  );
  const r = runPreview(['--diff', t.diffPath, '--rule', t.rulePath, '--json']);
  const included = r.payload?.selection?.included ?? [];
  const excluded = (r.payload?.excluded ?? []).map((e) => `${e.path}|${e.reason}`);
  rec('coverage_default_excluded_dirs_diff_mode', {
    exit: r.exitCode, included, excluded,
    ok: r.exitCode === 0 && !included.some((p) => p.startsWith('node_modules/') || p.startsWith('dist/')),
  });
  cleanup(t.base);
}

// 5) the documented "looks inconsistent, is correct" difference: in --root mode a diff file
//    that lives inside the repository is itself an ordinary repository file
{
  const base = tmpDir('v42-root-');
  const root = path.join(base, 'repo');
  writeText(path.join(root, 'src', 'app.mjs'), 'export const a = 1;\n');
  writeText(path.join(root, '.env'), 'ANTHROPIC_API_KEY=sk-ant-shouldnotleak\n');
  writeJson(path.join(root, 'diff.json'), { version: '1.0', files: ['src/app.mjs', '.env'] });
  const rulePath = path.join(base, 'rule.json');
  writeJson(rulePath, { version: '1.0', include: [{ id: 'all', pattern: '**/*', reason: 'probe' }], exclude: [], includeExtensions: ['.mjs', '.json', '.txt', '.env', ''] });
  const r = runPreview(['--root', root, '--rule', rulePath, '--json']);
  const included = r.payload?.selection?.included ?? [];
  rec('coverage_root_mode_includes_inrepo_diff_file', {
    exit: r.exitCode, included,
    diffFileIncluded: included.includes('diff.json'),
    envExcluded: !included.includes('.env'),
    ok: r.exitCode === 0 && included.includes('diff.json') && !included.includes('.env'),
  });
  cleanup(base);
}

if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ cwd: process.cwd(), cases: out }, null, 2)}\n`);
else for (const r of out) {
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.id} exit=${r.exit}`);
  console.log(`      included=${JSON.stringify(r.included)}`);
  if (r.aliasExclusionReason) console.log(`      aliasExclusion=${r.aliasExclusionReason}`);
  if (r.excluded) console.log(`      excluded=${JSON.stringify(r.excluded)}`);
}
process.exitCode = out.every((r) => r.ok) ? 0 : 1;

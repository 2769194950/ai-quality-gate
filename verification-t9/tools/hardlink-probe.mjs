#!/usr/bin/env node
// verification-t9/tools/hardlink-probe.mjs — characterise the hardlink-alias boundary of SAFE_002.
// Three variants isolate whether the alias is excluded by identity (same inode as a sensitive path)
// or only by a content-shape heuristic.  Usage: node verification-t9/tools/hardlink-probe.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { runPreview } from '../../adapters/opencodereview/test/helpers.mjs';
import { tmpDir, writeJson, writeText, cleanup } from '../../packages/qgate/test/helpers.mjs';

const SEC = /(^|\/)\.env|\.pem$|\.key$|(^|\/)id_rsa|(^|\/)credentials|(^|\/)secrets\//i;
const variants = [
  { id: 'alias_of_env_plain_content', secretFile: '.env', aliasFile: 'docs.txt', content: 'DB_PASSWORD=hunter2\n' },
  { id: 'alias_of_env_key_shaped_content', secretFile: '.env', aliasFile: 'notes.txt', content: 'ANTHROPIC_API_KEY=sk-ant-api03-EXAMPLEKEYVALUE0123456789\n' },
  { id: 'alias_of_credentials_json', secretFile: 'Credentials.json', aliasFile: 'handbook.txt', content: '{"access_key":"AKIAIOSFODNN7EXAMPLE"}\n' },
];

const out = [];
for (const v of variants) {
  const base = tmpDir('v3-hardlink-');
  const root = path.join(base, 'repo');
  writeText(path.join(root, 'src', 'app.mjs'), 'export const a = 1;\n');
  writeText(path.join(root, v.secretFile), v.content);
  fs.linkSync(path.join(root, v.secretFile), path.join(root, v.aliasFile));
  const diffPath = path.join(base, 'diff.json');
  writeJson(diffPath, { version: '1.0', files: ['src/app.mjs', v.secretFile, v.aliasFile] });
  const rulePath = path.join(base, 'rule.json');
  writeJson(rulePath, { version: '1.0', include: [{ id: 'all', pattern: '**/*', reason: 'hardlink alias probe' }], exclude: [], includeExtensions: ['.mjs', '.json', '.txt', '.env', ''] });
  const r = runPreview(['--diff', diffPath, '--rule', rulePath, '--json']);
  const included = r.payload?.selection?.included ?? [];
  out.push({
    id: v.id,
    secretFile: v.secretFile,
    aliasFile: v.aliasFile,
    exit: r.exitCode,
    included,
    aliasSelected: included.includes(v.aliasFile),
    sensitiveLeakByPattern: included.filter((p) => SEC.test(p)),
    excluded: (r.payload?.excluded ?? []).map((e) => `${e.path}|${e.reason}`),
    hardlinkAliases: r.payload?.safety?.hardlink_aliases ?? r.payload?.safety?.hardlinkAliases ?? null,
  });
  cleanup(base);
}
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ cwd: process.cwd(), variants: out }, null, 2)}\n`);
else for (const v of out) console.log(`${v.aliasSelected ? 'ALIAS-SELECTED' : 'alias-excluded'} ${v.id} exit=${v.exit} included=${JSON.stringify(v.included)} excluded=${JSON.stringify(v.excluded)}`);
process.exitCode = out.some((v) => v.aliasSelected) ? 1 : 0;

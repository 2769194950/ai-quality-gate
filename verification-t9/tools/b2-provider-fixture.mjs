#!/usr/bin/env node
// verification-t9/tools/b2-provider-fixture.mjs — t45 B2: independently re-check the t43 F2 fix.
// An explicitly configured provider.fixture that is missing / unparsable / empty must NOT silently
// fall back to the built-in fixture (no exit 0 with detail "offline-fixture").
// Usage: node verification-t9/tools/b2-provider-fixture.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { runCliJson, tmpDir, writeJson, writeText, cleanup } from '../../packages/qgate/test/helpers.mjs';

const results = [];
const base = tmpDir('b2-provider-');
const repo = path.join(base, 'repo');
writeText(path.join(repo, 'REQ.md'), '# req\nREQ-DEMO-001\n');

writeJson(path.join(repo, 'fixtures', 'bad.json'), { nonsense: true });
writeText(path.join(repo, 'fixtures', 'broken.json'), '{ not json');
writeJson(path.join(repo, 'fixtures', 'empty.json'), { version: '1.0', recordings: [] });
writeJson(path.join(repo, 'fixtures', 'ok.json'), {
  version: '1.0',
  recordings: [
    { request: { gateId: 'g1', checkId: 'c1', stage: 'requirements' }, response: { findings: [] } },
    { request: { gateId: 'g1', checkId: 'c1', stage: 'requirements' }, response: { findings: [] } },
  ],
});

function writeConfig(name, provider) {
  const p = path.join(base, `${name}.json`);
  writeJson(p, {
    version: '1.0',
    provider,
    projectRoot: 'repo',
    gates: [{ id: 'g1', stage: 'requirements', required: true, checks: [{ id: 'req-doc-exists', type: 'file_exists', file: 'REQ.md', required: true }] }],
  });
  return p;
}

const CASES = [
  { id: 'missing_fixture', provider: { type: 'deterministic', fixture: 'fixtures/missing.json' }, expectFail: true },
  { id: 'unparsable_fixture', provider: { type: 'deterministic', fixture: 'fixtures/broken.json' }, expectFail: true },
  { id: 'empty_recordings_fixture', provider: { type: 'deterministic', fixture: 'fixtures/empty.json' }, expectFail: true },
  { id: 'no_recordings_key_fixture', provider: { type: 'deterministic', fixture: 'fixtures/bad.json' }, expectFail: true },
  { id: 'scripted_missing_fixture', provider: { type: 'scripted', script: 'fixtures/absent.mjs', fixture: 'fixtures/missing.json' }, expectFail: true },
  { id: 'llm_missing_fixture', provider: { type: 'llm', fixture: 'fixtures/missing.json' }, expectFail: true },
  { id: 'usable_fixture_control', provider: { type: 'deterministic', fixture: 'fixtures/ok.json' }, expectFail: false },
  { id: 'no_fixture_key_control', provider: { type: 'deterministic' }, expectFail: false },
];

for (const c of CASES) {
  const cfg = writeConfig(c.id, c.provider);
  const r = await runCliJson(['check', '--config', cfg, '--json'], { strict: false });
  const provider = r.json?.provider ?? null;
  const code = r.json?.error?.code ?? null;
  const detail = provider?.detail ?? null;
  const silentFallback = c.expectFail && r.status === 0 && detail === 'offline-fixture';
  results.push({
    id: c.id,
    exit: r.status,
    errorCode: code,
    provider,
    expectFail: c.expectFail,
    // pass when: expected failures really fail with PROVIDER_FAILED (never a silent fallback),
    // and the controls still succeed without an explicit failure code
    ok: c.expectFail
      ? r.status === 3 && code === 'PROVIDER_FAILED' && !silentFallback
      : r.status === 0 && code === null,
    silentFallback,
    errorMessage: r.json?.error?.message ?? null,
  });
}

if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ cwd: process.cwd(), cases: results }, null, 2)}\n`);
else for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.id} exit=${r.exit} code=${r.errorCode} provider=${JSON.stringify(r.provider)}${r.errorMessage ? ` msg=${r.errorMessage}` : ''}`);
cleanup(base);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;

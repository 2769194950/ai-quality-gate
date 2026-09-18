#!/usr/bin/env node
// verification/tools/fixture-diff.mjs — locate the first difference between the adapter's stored
// fixtures and a fresh in-process run, so the report can cite concrete drift instead of "fixtures fail".
//
// t53 (verifier self-repair): the normalisation now comes from the adapter's own authoritative
// scrubber (`adapters/opencodereview/test/portable.mjs`, introduced by t51) instead of a hand-rolled
// copy. The old copy only scrubbed `…/adapters/opencodereview` paths, so it reported false diffs
// against the t51 fixtures which legitimately store `<HOME>` / `<REPO_ROOT>` placeholders — the same
// "second authority surface" failure the t52 tool fix removed. Importing the real scrubber keeps a
// single source of truth.
// Usage: node verification/tools/fixture-diff.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_ROOT, DEMO_DIFF, DEMO_RULE, runPreview, stableJson } from '../../adapters/opencodereview/test/helpers.mjs';
import { portableize, portableizeText } from '../../adapters/opencodereview/test/portable.mjs';

const FIXTURES = path.join(ADAPTER_ROOT, 'test', 'fixtures');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

const normalize = (payload) => portableize(payload);
const scrubText = (text) => portableizeText(text);

function firstDiff(a, b, ptr = '') {
  if (a === b) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return { path: ptr, reason: `array length ${a.length} != ${b.length}` };
    for (let i = 0; i < a.length; i += 1) {
      const d = firstDiff(a[i], b[i], `${ptr}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (JSON.stringify(ka) !== JSON.stringify(kb)) return { path: ptr, reason: 'key sets differ', storedKeys: ka, rerunKeys: kb };
    for (const key of ka) {
      const d = firstDiff(a[key], b[key], ptr ? `${ptr}.${key}` : key);
      if (d) return d;
    }
    return null;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i += 1;
    return { path: ptr || '<root>', reason: 'string differs', firstDiffIndex: i, storedLength: a.length, rerunLength: b.length, storedContext: JSON.stringify(a.slice(Math.max(0, i - 40), i + 40)), rerunContext: JSON.stringify(b.slice(Math.max(0, i - 40), i + 40)) };
  }
  return { path: ptr || '<root>', stored: a, rerun: b };
}

const cases = [];
{
  const stored = normalize(readJson('preview.default.json'));
  const now = normalize(runPreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--json']).payload);
  cases.push({ fixture: 'preview.default.json', equal: stableJson(now) === stableJson(stored), firstDifference: firstDiff(stored, now) });
}
{
  const stored = normalize(readJson('preview.token-budget-300.json'));
  const now = normalize(runPreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--token-budget', '300', '--json']).payload);
  cases.push({ fixture: 'preview.token-budget-300.json', equal: stableJson(now) === stableJson(stored), firstDifference: firstDiff(stored, now) });
}
{
  const stored = fs.readFileSync(path.join(FIXTURES, 'selection.default.md'), 'utf8');
  const now = runPreview(['--diff', DEMO_DIFF, '--rule', DEMO_RULE, '--md']).markdown;
  const a = scrubText(stored).split('\n');
  const b = scrubText(now).split('\n');
  let firstLine = null;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      const sa = a[i] ?? '';
      const sb = b[i] ?? '';
      let j = 0;
      while (j < Math.min(sa.length, sb.length) && sa[j] === sb[j]) j += 1;
      firstLine = { line: i + 1, firstDiffIndex: j, storedContext: JSON.stringify(sa.slice(Math.max(0, j - 40), j + 40)), rerunContext: JSON.stringify(sb.slice(Math.max(0, j - 40), j + 40)) };
      break;
    }
  }
  cases.push({ fixture: 'selection.default.md', equal: scrubText(now) === scrubText(stored), firstDifference: firstLine, storedLines: a.length, rerunLines: b.length });
}

if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ cwd: process.cwd(), adapterRoot: ADAPTER_ROOT, cases }, null, 2)}\n`);
else {
  for (const c of cases) {
    console.log(`${c.equal ? 'OK  ' : 'DIFF'} ${c.fixture}`);
    if (!c.equal) console.log(`     first difference: ${JSON.stringify(c.firstDifference)}`);
  }
}
process.exitCode = cases.every((c) => c.equal) ? 0 : 1;

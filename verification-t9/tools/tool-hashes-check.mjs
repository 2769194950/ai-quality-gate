#!/usr/bin/env node
// verification-t9/tools/tool-hashes-check.mjs — t60/X3 companion: freshness of VERIFIER TOOLING.
//
// `tree_fingerprint` deliberately excludes `verification-t9/**`, so a tool edit cannot change the
// revision identity. That is correct for the revision but leaves a hole in auditability: a claim can
// cite a tool that was changed after the claim was made. This check closes it the same way the data
// baselines are closed — pinned hashes plus one machine-decidable comparison.
//
// Usage: node verification-t9/tools/tool-hashes-check.mjs [--json]
// Exit:  0 all pinned tools/artifacts match · 1 drift (a pinned file changed) · 2 a pinned file is missing
//        3 the manifest is unreadable/malformed
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { computeFingerprint } from './tree-fingerprint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AREA = path.resolve(HERE, '..');
const MANIFEST = path.join(AREA, 'artifacts-v8', 'verifier-tool-hashes.json');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8').replace(/^\uFEFF/, ''));
} catch (err) {
  console.error(`UNPARSABLE: cannot read ${path.relative(AREA, MANIFEST)} (${err.message})`);
  process.exit(3);
}

const entries = [
  ...Object.entries(manifest.tools || {}).map(([name, hash]) => ({ kind: 'tool', rel: `tools/${name}`, expected: hash })),
  ...Object.entries(manifest.artifact_sets || manifest.artifacts_v8 || {})
    .flatMap(([dir, files]) => Object.entries(files || {}).map(([name, hash]) => ({ kind: 'artifact', rel: `${dir}/${name}`, expected: hash }))),
];
const rows = entries.map((e) => {
  const abs = path.join(AREA, e.rel);
  if (!fs.existsSync(abs)) return { ...e, actual: null, status: 'MISSING' };
  const actual = sha(abs);
  return { ...e, actual, status: actual === e.expected ? 'MATCH' : 'DRIFT' };
});
const tally = (s) => rows.filter((r) => r.status === s).length;
const summary = {
  manifest: path.relative(AREA, MANIFEST),
  pinned_tree_fingerprint: manifest.tree_fingerprint,
  current_tree_fingerprint: computeFingerprint().fingerprint,
  entries: rows.length,
  match: tally('MATCH'),
  drift: tally('DRIFT'),
  missing: tally('MISSING'),
  driftFiles: rows.filter((r) => r.status !== 'MATCH').map((r) => `${r.rel}(${r.status})`),
};
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ ...summary, rows }, null, 2)}\n`);
else {
  for (const r of rows.filter((x) => x.status !== 'MATCH')) process.stdout.write(`  ${r.status} ${r.rel}\n`);
  process.stdout.write(`TOOL-HASHES pinned_fingerprint=${String(summary.pinned_tree_fingerprint).slice(0, 12)} current=${summary.current_tree_fingerprint.slice(0, 12)} entries=${summary.entries} match=${summary.match} drift=${summary.drift} missing=${summary.missing}\n`);
}
process.exitCode = summary.missing > 0 ? 2 : summary.drift > 0 ? 1 : 0;

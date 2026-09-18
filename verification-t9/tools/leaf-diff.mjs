#!/usr/bin/env node
// verification/tools/leaf-diff.mjs — count and list every differing JSON leaf between two documents.
// Used for §6.2.3 GAP-5 ("adapters cross-cwd difference is exactly one leaf") and to pin the
// engine-side cross-cwd difference in `qgate check --json`.
// Usage: node verification/tools/leaf-diff.mjs <a.json> <b.json>
import fs from 'node:fs';

const [a, b] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/^[^{[]*/, ''));
const A = read(a);
const B = read(b);

const leaves = (value, ptr, out) => {
  if (value === null || typeof value !== 'object') {
    out.set(ptr, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaves(v, `${ptr}/${i}`, out));
    return;
  }
  for (const k of Object.keys(value)) leaves(value[k], `${ptr}/${k}`, out);
};
const la = new Map();
const lb = new Map();
leaves(A, '', la);
leaves(B, '', lb);

const keys = [...new Set([...la.keys(), ...lb.keys()])].sort();
const differing = keys.filter((k) => JSON.stringify(la.get(k)) !== JSON.stringify(lb.get(k)));
console.log(`leaves: a=${la.size} b=${lb.size} union=${keys.length} differing=${differing.length}`);
for (const k of differing) {
  console.log(`  DIFF ${k}`);
  console.log(`    a = ${JSON.stringify(la.get(k))}`);
  console.log(`    b = ${JSON.stringify(lb.get(k))}`);
}
process.exitCode = differing.length === 0 ? 0 : 1;

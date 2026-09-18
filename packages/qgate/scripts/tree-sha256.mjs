#!/usr/bin/env node
// Tree fingerprint (read-only): prints the file count and an aggregate SHA256 per
// directory tree, so a report can evidence that a tree was not modified.
//
//   node packages/qgate/scripts/tree-sha256.mjs [dir ...]
//
// The aggregate is sha256 over the sorted `<sha256(file)>  <posix-relative-path>`
// lines, which is stable across machines and independent of file mtimes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/util/hash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

const targets = process.argv.slice(2);
const roots = targets.length > 0 ? targets : ['adapters', 'schemas', 'docs', 'verification', 'verification-t9'];

function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, base, out);
    else if (entry.isFile()) {
      out.push({
        rel: path.relative(base, abs).split(path.sep).join('/'),
        digest: sha256(fs.readFileSync(abs)),
      });
    }
  }
  return out;
}

for (const root of roots) {
  const abs = path.isAbsolute(root) ? root : path.join(REPO_ROOT, root);
  const files = walk(abs).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const lines = files.map((file) => `${file.digest}  ${file.rel}`);
  process.stdout.write(`${root}: files=${files.length} treeSha256=${files.length === 0 ? '(empty)' : sha256(lines.join('\n'))}\n`);
  if (files.length === 0) process.stdout.write(`  (no such directory, or it contains no files)\n`);
}

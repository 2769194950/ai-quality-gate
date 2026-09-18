#!/usr/bin/env node
// verification/tools/normalize-runresult.mjs — assertions #3/#4 evidence.
// Two consecutive `qgate check --json` runs must differ only in runtime fields. This workspace has
// no git, so the sanctioned substitute for "same commit, re-run, diff" is: re-run the exact command
// in the same workspace, then compare canonicalised output hashes.
// Canonicalisation: tolerate a leaked child-process line, drop runtime keys, rewrite embedded run
// ids / RFC3339 timestamps inside strings, sort object keys, sha256.
// Usage: node verification/tools/normalize-runresult.mjs <file1> [<file2> ...]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNTIME_KEYS = new Set(['run_id', 'started_at', 'finished_at', 'duration_ms', 'ledgerId', 'updated_at', 'generated_at']);
const RUN_ID_RE = /\d{4}-\d{2}-\d{2}T\d{2}[:-]\d{2}[:-]\d{2}[.:-]\d{3}Z-[0-9a-f]{8}/g;
const RFC3339_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

function canonicalise(value, stats) {
  if (Array.isArray(value)) return value.map((v) => canonicalise(v, stats));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (RUNTIME_KEYS.has(key)) {
        stats.droppedKeys.push(key);
        continue;
      }
      out[key] = canonicalise(value[key], stats);
    }
    return out;
  }
  if (typeof value === 'string') {
    const after = value.replace(RUN_ID_RE, '<RUN_ID>').replace(RFC3339_RE, '<TIMESTAMP>');
    if (after !== value) stats.rewrittenStrings += 1;
    return after;
  }
  return value;
}

const results = [];
for (const rel of process.argv.slice(2)) {
  const file = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const start = raw.indexOf('{');
  const value = JSON.parse(start > 0 ? raw.slice(start) : raw);
  const stats = { droppedKeys: [], rewrittenStrings: 0 };
  const canonical = canonicalise(value, stats);
  results.push({
    file: rel,
    leakedPrefix: start > 0 ? raw.slice(0, start).trim() : null,
    normalizedSha256: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    droppedKeys: [...new Set(stats.droppedKeys)],
    rewrittenStringCount: stats.rewrittenStrings,
    canonical,
  });
}

for (const r of results) console.log(`${r.normalizedSha256}  ${r.file}  droppedKeys=${JSON.stringify(r.droppedKeys)} rewritten=${r.rewrittenStringCount} leakedPrefix=${JSON.stringify(r.leakedPrefix)}`);

if (results.length >= 2) {
  const allEqual = results.every((r) => r.normalizedSha256 === results[0].normalizedSha256);
  console.log(`normalized-equal=${allEqual}`);
  if (!allEqual) {
    const walk = (a, b, ptr) => {
      if (JSON.stringify(a) === JSON.stringify(b)) return null;
      if (Array.isArray(a) && Array.isArray(b)) {
        for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
          const found = walk(a[i], b[i], `${ptr}/${i}`);
          if (found) return found;
        }
        return `${ptr} (array length ${a.length} vs ${b.length})`;
      }
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
          const found = walk(a[key], b[key], `${ptr}/${key}`);
          if (found) return found;
        }
        return ptr;
      }
      return `${ptr}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
    };
    console.log(`first-difference=${walk(results[0].canonical, results[1].canonical, '')}`);
  }
  process.exitCode = allEqual ? 0 : 1;
}

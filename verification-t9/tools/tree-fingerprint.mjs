#!/usr/bin/env node
// verification-t9/tools/tree-fingerprint.mjs
// This workspace is NOT a git repository, so a sha256 manifest over the measured surface is the
// substitute for a commit hash: any implementer write changes it and proves whether a set of
// observations still describes the same tree.
//
// t60/X4: this file is the SINGLE AUTHORITY for "what the revision fingerprint covers". The report's
// `fingerprint_scope_and_algorithm` is generated from `--scope-json` output of THIS file, never
// hand-copied, so a scope change cannot silently drift away from the text that describes it.
//
// Usage:
//   node verification-t9/tools/tree-fingerprint.mjs [--json] [--code-only] [--product-only] [--scope-json]
//   import { computeFingerprint, SCOPE } from './tree-fingerprint.mjs'
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');

export const TARGETS = [
  'packages/qgate',
  'adapters/opencodereview',
  'schemas',
  'docs',
  '.github',
  'demo/qgate.config.json',
  'demo/mini-service',
  'package.json',
  'qgate.config.json',
];
export const SKIP_DIRS = ['node_modules', '.git'];
// Runtime-generated artefacts must not enter the revision fingerprint: the engine appends a
// ledger on every run, so they record the act of verifying, not the revision under verification.
export const SKIP_PREFIXES = ['demo/mini-service/.qgate/evidence', 'demo/mini-service/.qgate/reports'];
// packages/qgate/scripts/** holds ad-hoc debugging helpers (not in the published files list);
// they are excluded only in --code-only mode.
export const CODE_ONLY_SKIP_PREFIXES = ['packages/qgate/scripts/'];
// t60/X4: `--product-only` is a SUPPLEMENTARY signal (test trees excluded), never the authority.
export const PRODUCT_ONLY_SKIP_SEGMENTS = ['test', 'tests', '__tests__'];

export const SCOPE = {
  authority: 'verification-t9/tools/tree-fingerprint.mjs',
  targets: TARGETS,
  skipDirs: SKIP_DIRS,
  skipPrefixes: SKIP_PREFIXES,
  excludesVerifierArea: true,
  excludesVerifierAreaNote:
    'verification/** and verification-t9/** are NOT targets, so verifier-side tool/artefact edits cannot change the fingerprint.',
  algorithm:
    "per-file sha256 over the sorted absolute tree of `targets` -> manifest lines `<sha256>  <posix-relative-path>` sorted by path -> sha256 of that manifest string (join '\\n')",
  modes: {
    default: 'all targets',
    '--code-only': `additionally skips ${CODE_ONLY_SKIP_PREFIXES.join(', ')} and packages/qgate/test/_probe-*.mjs`,
    '--product-only': `SUPPLEMENTARY only: additionally skips any path segment in ${PRODUCT_ONLY_SKIP_SEGMENTS.join('/')} — used to show that a revision differs only in test trees; never used as the revision identity`,
  },
  x4_decision:
    'option (b): the authoritative fingerprint KEEPS adapters/opencodereview/test/** (and every other test tree) in scope. Consequence, written into the process as a hard rule: fingerprint changes => every `adapter-suite` evidence pointer is STALE and MUST be re-recorded (node verification-t9/tools/evidence-pointer.mjs check <file> exits 1). Option (a) (excluding test trees) was rejected because it would make the baseline-freshness check blind precisely to the event it must catch (a test file being added/renamed changes the recorded testFile/test counts without changing a test-blind fingerprint).',
};

export function computeFingerprint({ codeOnly = false, productOnly = false } = {}) {
  const files = [];
  const walk = (abs) => {
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        if (SKIP_DIRS.includes(name)) continue;
        walk(path.join(abs, name));
      }
      return;
    }
    if (!st.isFile()) return;
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (SKIP_PREFIXES.some((p) => rel === p || rel.startsWith(`${p}/`))) return;
    if (codeOnly && CODE_ONLY_SKIP_PREFIXES.some((p) => rel === p || rel.startsWith(p))) return;
    if (codeOnly && /^packages\/qgate\/test\/_probe-/.test(rel)) return;
    if (productOnly && rel.split('/').some((seg) => PRODUCT_ONLY_SKIP_SEGMENTS.includes(seg))) return;
    const bytes = fs.readFileSync(abs);
    files.push({
      path: rel,
      sizeBytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      mtime: st.mtime.toISOString(),
    });
  };
  for (const target of TARGETS) walk(path.join(ROOT, target));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = files.map((f) => `${f.sha256}  ${f.path}`).join('\n');
  const fingerprint = crypto.createHash('sha256').update(manifest).digest('hex');
  const newest = files.reduce((acc, f) => (acc === null || f.mtime > acc.mtime ? f : acc), null);
  return { fingerprint, fileCount: files.length, newest, files, codeOnly, productOnly };
}

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const codeOnly = process.argv.includes('--code-only');
  const productOnly = process.argv.includes('--product-only');
  if (process.argv.includes('--scope-json')) {
    process.stdout.write(`${JSON.stringify({ ...SCOPE, requestedMode: { codeOnly, productOnly } }, null, 2)}\n`);
  } else {
    const r = computeFingerprint({ codeOnly, productOnly });
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ ...r, mode: productOnly ? 'product-only' : codeOnly ? 'code-only' : 'default' }, null, 2)}\n`);
    } else {
      process.stdout.write(
        `fingerprint=${r.fingerprint}\nfiles=${r.fileCount}\nmode=${productOnly ? 'product-only' : codeOnly ? 'code-only' : 'default'}\nnewest=${r.newest?.mtime} ${r.newest?.path}\n`,
      );
    }
  }
}

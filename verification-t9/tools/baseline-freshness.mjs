#!/usr/bin/env node
// verification-t9/tools/baseline-freshness.mjs — t60/X3: "baseline freshness" as ONE machine-checkable
// line, so a snapshot that was hand-cleaned but is content-wise stale cannot pass silently.
//
// It discovers every evidence file that carries the pointer+hash header (evidence-pointer.mjs FORMAT),
// re-derives the CURRENT tree fingerprint once, then reports each file's verdict and — with --deep —
// re-runs the authoritative (# status: RECORDED) pointer's own record command and compares its counts.
//
// Usage: node verification-t9/tools/baseline-freshness.mjs [--deep] [--json] [--quiet]
// Exit:  0 all non-superseded pointers FRESH (and, under --deep, counts reproduce)
//        1 at least one STALE / COUNT-DRIFT
//        2 at least one TAMPERED (payload hash mismatch => hand-edited)
//        3 discovery found no pointer file at all (fail-closed: a missing check is not a pass)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEvidence, FORMAT } from './evidence-pointer.mjs';
import { computeFingerprint, ROOT } from './tree-fingerprint.mjs';

const MARKER = '# --- payload (content_sha256 covers the bytes after this line) ---';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const AREA = path.resolve(HERE, '..');

function discover(dir, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === 'tmp' || name === 'pointer-negatives' || name === 'node_modules') continue;
      discover(abs, out);
      continue;
    }
    if (!st.isFile() || !/\.(txt)$/.test(name)) continue;
    const head = fs.readFileSync(abs, 'utf8').slice(0, 4096);
    if (head.includes(MARKER) && head.includes(`# format: ${FORMAT}`)) out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
  }
  return out;
}

const deep = process.argv.includes('--deep');
const files = discover(AREA, []).sort();
if (files.length === 0) {
  console.error('NO-POINTER-FILES: found no pointer+hash evidence file — a missing freshness check is not a pass');
  process.exit(3);
}

const current = computeFingerprint();
const rows = files.map((rel) => checkEvidence(rel));
// --deep, on the authoritative pointers only (superseded copies are never re-run): replace the row with
// the deep verdict, so COUNT-DRIFT shows up as a status and not merely as a printed pair of numbers.
for (let i = 0; i < rows.length; i += 1) {
  if (rows[i].declared_status !== 'SUPERSEDED' && deep) rows[i] = checkEvidence(rows[i].evidence, { deep: true });
}

const tally = (s) => rows.filter((r) => r.status === s).length;
// t66 self-repair (found by the Z4 matrix): "some pointer file exists" was the only fail-closed
// condition, so REMOVING the authoritative pointer while the historical SUPERSEDED copies remained
// produced `fresh=0 superseded=5` and exit 0 — a disarmed gate that read as green. A revision with no
// authoritative (non-superseded) baseline is NOT fresh.
const authoritative = rows.filter((r) => String(r.declared_status || '').toUpperCase() !== 'SUPERSEDED');
if (authoritative.length === 0) {
  process.stderr.write(
    `NO-AUTHORITATIVE-POINTER: only superseded copies were found (${rows.length} file(s), 0 carrying a RECORDED baseline) — a revision with no recorded baseline is not fresh\n`,
  );
  process.exit(3);
}
const summary = {
  current_tree_fingerprint: current.fingerprint,
  current_file_count: current.fileCount,
  pointer_files: rows.length,
  authoritative_pointers: authoritative.length,
  fresh: tally('FRESH'),
  superseded: tally('SUPERSEDED'),
  stale: tally('STALE'),
  tampered: tally('TAMPERED'),
  count_drift: tally('COUNT-DRIFT'),
  stale_files: rows.filter((r) => r.status === 'STALE').map((r) => r.evidence),
  tampered_files: rows.filter((r) => r.status === 'TAMPERED').map((r) => r.evidence),
  count_drift_files: rows.filter((r) => r.status === 'COUNT-DRIFT').map((r) => r.evidence),
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ ...summary, rows }, null, 2)}\n`);
} else {
  if (!process.argv.includes('--quiet')) {
    for (const r of rows) {
      process.stdout.write(
        `  ${r.status.padEnd(11)} ${r.evidence}${r.counts ? ` deep_counts=${JSON.stringify(r.counts.actual)} expected=${JSON.stringify(r.counts.expected)}` : ''}\n`,
      );
    }
  } else {
    // Keep quiet mode compact, but retain enough detail to diagnose a platform-specific
    // deep-count drift from the single qgate evidence excerpt.
    for (const r of rows.filter((item) => !['FRESH', 'SUPERSEDED'].includes(item.status))) {
      process.stdout.write(
        `BASELINE-FRESHNESS-DETAIL status=${r.status} evidence=${r.evidence}` +
          (r.counts ? ` actual=${JSON.stringify(r.counts.actual)} expected=${JSON.stringify(r.counts.expected)}` : '') +
          '\n',
      );
    }
  }
  process.stdout.write(
    `BASELINE-FRESHNESS current=${current.fingerprint.slice(0, 12)} files=${rows.length} fresh=${summary.fresh} superseded=${summary.superseded} stale=${summary.stale} tampered=${summary.tampered} count_drift=${summary.count_drift}\n`,
  );
}
process.exitCode = summary.tampered > 0 ? 2 : summary.stale + summary.count_drift > 0 ? 1 : 0;

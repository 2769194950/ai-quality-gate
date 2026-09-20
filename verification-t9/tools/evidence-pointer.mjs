#!/usr/bin/env node
// verification-t9/tools/evidence-pointer.mjs  — t60/X1 root fix for "baselines keep expiring".
//
// PROBLEM (diagnosed by adapter-engineer in t58, accepted by the captain):
//   `artifacts*/adapter-suite.txt` is a snapshot of LIVE data (the adapter test suite), but it lives
//   in a directory only the verifier may write. So every time any implementer adds a test file, the
//   snapshot silently becomes wrong, and the one person who could refresh it is the least likely to
//   notice. Expiry was structural, not accidental (the baseline went 57 -> 87 -> 94 -> 102 -> 109 ->
//   121 -> 131 across seven re-records).
//
// FIX: demote the snapshot to a POINTER + CONTENT HASH. The file carries, in machine-readable form:
//     * the re-record command (and its cwd),
//     * the `tree_fingerprint` of the tree at record time,
//     * the sha256 of the recorded payload,
// so freshness is ONE machine-decidable comparison instead of a human's memory:
//     current tree_fingerprint == recorded tree_fingerprint   => FRESH
//     current tree_fingerprint != recorded tree_fingerprint   => STALE (re-record with the command)
//     payload sha256 mismatch                                 => TAMPERED / hand-edited
//
// Usage:
//   node verification-t9/tools/evidence-pointer.mjs check <file> [--deep] [--json]
//   node verification-t9/tools/evidence-pointer.mjs record <file> --name <n> --argv '<json array>'
//        [--cmd "<display command>"] [--cwd <dir>] [--expected "k=v;k=v"] [--status RECORDED|SUPERSEDED]
//        [--note "<text>"]
// Exit codes: 0 FRESH · 1 STALE (fingerprint or counts moved) · 2 TAMPERED (payload hash mismatch)
//             3 UNPARSABLE (no pointer header / bad argv JSON)
//
// Implementation note: this sandbox forbids piped child stdio (`spawn` with stdio:'pipe' => EPERM),
// so the recorded command is executed with FILE-DESCRIPTOR redirection, never a pipe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeFingerprint, ROOT } from './tree-fingerprint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARKER = '# --- payload (content_sha256 covers the bytes after this line) ---';
export const FORMAT = 'pointer+hash v1';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Canonical form of a payload: no BOM, LF endings, exactly one trailing newline. */
export function canonical(text) {
  return `${text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\n*$/, '')}\n`;
}

export function parsePointer(text) {
  const canon = text.replace(/\r\n/g, '\n');
  const idx = canon.indexOf(MARKER);
  if (idx < 0) return { ok: false, reason: `marker line not found: ${MARKER}` };
  const header = canon.slice(0, idx);
  const payload = canonical(canon.slice(idx + MARKER.length));
  const fields = {};
  for (const line of header.split('\n')) {
    const m = /^#\s*([a-z_0-9]+):\s?(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  if (!fields.tree_fingerprint || !fields.content_sha256) {
    return { ok: false, reason: 'header is missing tree_fingerprint and/or content_sha256', fields };
  }
  return { ok: true, fields, payload, payloadSha256: sha256(payload) };
}

export function expectedMap(field) {
  const out = {};
  for (const part of String(field || '').split(';')) {
    const m = /^\s*([\w.-]+)\s*=\s*(\d+)\s*$/.exec(part);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function runCommand(argv, cwd) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evptr-'));
  const outPath = path.join(dir, 'stdout.txt');
  const errPath = path.join(dir, 'stderr.txt');
  const o = fs.openSync(outPath, 'w');
  const e = fs.openSync(errPath, 'w');
  let res;
  try {
    res = spawnSync(argv[0], argv.slice(1), { cwd, stdio: ['ignore', o, e] });
  } finally {
    fs.closeSync(o);
    fs.closeSync(e);
  }
  const stdout = fs.readFileSync(outPath, 'utf8');
  const stderr = fs.readFileSync(errPath, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  if (res.error) throw new Error(`spawn failed: ${res.error.code || res.error.message}`);
  return { status: res.status, stdout, stderr };
}

function flag(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

/** Single authority for the freshness verdict of one pointer file (used by the CLI and by baseline-freshness.mjs). */
export function checkEvidence(absOrRel, { deep = false, cwd = ROOT } = {}) {
  const abs = path.resolve(ROOT, absOrRel);
  let parsed;
  try {
    parsed = parsePointer(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    return { evidence: absOrRel, status: 'UNPARSABLE', reason: `cannot read (${err.message})` };
  }
  if (!parsed.ok) return { evidence: absOrRel, status: 'UNPARSABLE', reason: parsed.reason };
  const f = parsed.fields;
  const current = computeFingerprint().fingerprint;
  const recorded = f.tree_fingerprint;
  const payloadIntact = parsed.payloadSha256 === f.content_sha256;
  const fingerprintFresh = current === recorded;

  // --deep: additionally re-run the recorded command and compare the declared counts.
  let counts = null;
  let countsMatch = null;
  if (deep) {
    const argv = JSON.parse(f.argv_json || 'null');
    if (!argv) return { evidence: absOrRel, status: 'UNPARSABLE', reason: '--deep needs argv_json in the header' };
    const r = runCommand(argv, cwd);
    const expected = expectedMap(f.expected);
    const actual = {};
    for (const k of Object.keys(expected)) {
      // The adapter runner prints its file count as `run-tests: 共 <n> 个测试文件` and the case
      // counts as node:test's `\u2139 <name> <n>` block; every pattern is anchored to a line start.
      const re =
        k === 'testFiles'
          ? /(?:^|\n)(?:[^\n]*?)(?:共|total)\s*(\d+)\s*个测试文件/
          : k === 'exit_code'
            ? null
            : new RegExp(`(?:^|\\n)(?:# |\u2139 )?${k}\\s+(\\d+)`);
      if (!re) continue;
      const m = re.exec(r.stdout);
      actual[k] = m ? Number(m[1]) : null;
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'exit_code')) actual.exit_code = r.status;
    const failureLines = r.stdout
      .split(/\r?\n/)
      .filter((line) => /(?:✖|not ok|fail(?:ed|ure)?)/i.test(line))
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 8);
    counts = { expected, actual, ...(failureLines.length > 0 ? { failureLines } : {}) };
    countsMatch = Object.keys(expected).every((k) => actual[k] === expected[k]);
  }

  const superseded = String(f.status || '').toUpperCase() === 'SUPERSEDED';
  const status = !payloadIntact
    ? 'TAMPERED'
    : superseded
      ? 'SUPERSEDED'
      : !fingerprintFresh
        ? 'STALE'
        : countsMatch === false
          ? 'COUNT-DRIFT'
          : 'FRESH';
  return {
    evidence: absOrRel,
    name: f.evidence,
    declared_status: f.status,
    status,
    recorded_tree_fingerprint: recorded,
    current_tree_fingerprint: current,
    fingerprint_fresh: fingerprintFresh,
    content_sha256_ok: payloadIntact,
    counts,
    countsMatch,
    record_command: f.record_command,
    record_at_utc: f.record_at_utc,
    supersedes_note: f.note,
  };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
const mode = isMain ? process.argv[2] : null;
const target = isMain ? process.argv[3] : null;

if (!isMain) {
  // imported as a library (baseline-freshness.mjs): no CLI side effects.
} else if (mode === 'check') {
  if (!target) {
    console.error('usage: evidence-pointer.mjs check <file> [--deep] [--json]');
    process.exit(3);
  }
  const res = checkEvidence(target, { deep: process.argv.includes('--deep'), cwd: flag('--cwd', ROOT) });
  if (res.status === 'UNPARSABLE') {
    console.error(`UNPARSABLE ${target}: ${res.reason}`);
    process.exit(3);
  }
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${res.status} ${target} recorded=${res.recorded_tree_fingerprint.slice(0, 12)} current=${res.current_tree_fingerprint.slice(0, 12)} payload_sha256_ok=${res.content_sha256_ok}` +
        `${res.counts ? ` counts=${JSON.stringify(res.counts.actual)} expected=${JSON.stringify(res.counts.expected)}` : ''}\n`,
    );
  }
  // A SUPERSEDED copy is expected to reference an older revision: only its integrity is asserted.
  process.exitCode = res.status === 'TAMPERED' ? 2 : res.status === 'FRESH' || res.status === 'SUPERSEDED' ? 0 : 1;
} else if (mode === 'record') {
  if (!target) {
    console.error('usage: evidence-pointer.mjs record <file> --name <n> --argv \'<json array>\' [...]');
    process.exit(3);
  }
  const argvJson = flag('--argv');
  const argvFile = flag('--argv-file');
  let argv;
  try {
    argv = JSON.parse(
      argvFile ? fs.readFileSync(path.resolve(ROOT, argvFile), 'utf8').replace(/^\uFEFF/, '') : argvJson || 'null',
    );
  } catch {
    argv = null;
  }
  if (!Array.isArray(argv) || argv.length === 0) {
    console.error('UNPARSABLE: --argv (JSON array) or --argv-file (path to a JSON array) is required');
    process.exit(3);
  }
  const cwd = flag('--cwd', ROOT);
  // Two payload sources: run the command now (normal re-record), or ADOPT an existing snapshot
  // (used once, to convert the historical SUPERSEDED copies into pointer+hash form without
  // pretending they were re-run).
  const payloadPath = flag('--payload');
  const r = payloadPath ? { status: Number(flag('--exit-code', '0')), stdout: fs.readFileSync(path.resolve(ROOT, payloadPath), 'utf8'), stderr: '' } : runCommand(argv, cwd);
  const payload = canonical(r.stderr.trim() ? `${r.stdout}\n# --- stderr ---\n${r.stderr}` : r.stdout);
  const fp = computeFingerprint();
  const recordedFp = flag('--tree-fingerprint', fp.fingerprint);
  const recordedAt = flag('--recorded-at', new Date().toISOString());
  const header = [
    `# evidence: ${flag('--name', path.basename(target))}`,
    `# format: ${FORMAT}`,
    `# status: ${flag('--status', 'RECORDED')}`,
    `# record_command: ${flag('--cmd', argv.join(' '))}`,
    `# record_cwd: ${cwd}`,
    `# record_at_utc: ${recordedAt}`,
    `# tree_fingerprint: ${recordedFp}`,
    `# tree_fingerprint_files: ${recordedFp === fp.fingerprint ? fp.fileCount : 'n/a (historical)'}`,
    `# fingerprint_tool: node verification-t9/tools/tree-fingerprint.mjs`,
    `# expected: ${flag('--expected', `exit_code=${r.status}`)}`,
    `# exit_code: ${r.status}`,
    `# argv_json: ${JSON.stringify(argv)}`,
    `# content_sha256: ${sha256(payload)}`,
    `# freshness_rule: FRESH iff recomputed tree_fingerprint == tree_fingerprint above AND content_sha256 matches the payload;`,
    `#   check with: node verification-t9/tools/evidence-pointer.mjs check ${target} [--deep]   (0 FRESH / 1 STALE / 2 TAMPERED)`,
    ...(flag('--note') ? [`# note: ${flag('--note')}`] : []),
    MARKER,
  ].join('\n');
  fs.mkdirSync(path.dirname(path.resolve(ROOT, target)), { recursive: true });
  fs.writeFileSync(path.resolve(ROOT, target), `${header}${payload}`, 'utf8');
  process.stdout.write(
    `RECORDED ${target} source=${payloadPath ? `adopted:${payloadPath}` : 'live-run'} command_exit=${r.status} tree_fingerprint=${recordedFp} payload_sha256=${sha256(payload)}\n`,
  );
} else {
  console.error('usage: evidence-pointer.mjs <check|record> <file> [...]');
  process.exit(3);
}

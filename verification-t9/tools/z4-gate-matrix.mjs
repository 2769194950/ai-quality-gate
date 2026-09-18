#!/usr/bin/env node
// verification-t9/tools/z4-gate-matrix.mjs — t66/Z4: does the newly registered `baseline-freshness`
// gate check actually behave as a gate? Five self-built scenarios, all inside a throwaway copy:
//   A stale pointer            -> red (exit 1) with the baseline-freshness blocker named
//   B re-record                -> green (exit 0, 5/5, no failing check)
//   C in-scope write           -> red again (the pointer is stale by construction)
//   D re-record                -> green again  (the "restore half" the verifier owns)
//   E verifier tool deleted    -> red (fail-closed: a check that cannot run is not a pass)
//   F no pointer file at all   -> red (fail-closed discovery)
//
// The copy keeps `demo/` intact (including its fixture node_modules) so the adapter suite, which the
// check runs with --deep, reproduces the same 15 files / 145 cases as the real tree.
//
// Usage: node verification-t9/tools/z4-gate-matrix.mjs [--copy <dir>] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const opt = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const copy = path.resolve(opt('--copy', path.join(os.tmpdir(), `t66-z4-${Date.now()}`)));
const POINTER = 'verification-t9/artifacts-v8/adapter-suite.txt';
const TOOL = 'verification-t9/tools/baseline-freshness.mjs';

// ── build the copy (full tree; only the engine's runtime outputs are dropped) ──
fs.rmSync(copy, { recursive: true, force: true });
fs.mkdirSync(copy, { recursive: true });
for (const entry of ['packages', 'adapters', 'schemas', 'docs', '.github', 'demo', 'package.json', 'qgate.config.json', 'verification', 'verification-t9']) {
  const from = path.join(ROOT, entry);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(copy, entry), { recursive: true });
}
// A copy is not the measured revision: drop the authoritative pointer's claim so scenario A is honest.
fs.rmSync(path.join(copy, 'verification-t9', 'artifacts-v9'), { recursive: true, force: true });

function runCheck(label) {
  const outPath = path.join(os.tmpdir(), `t66-z4-out-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const errPath = `${outPath}.err`;
  const o = fs.openSync(outPath, 'w');
  const e = fs.openSync(errPath, 'w');
  let res;
  try {
    res = spawnSync(process.execPath, [path.join(copy, 'packages', 'qgate', 'bin', 'qgate.mjs'), 'check', '--config', 'qgate.config.json', '--json'], {
      cwd: copy,
      stdio: ['ignore', o, e],
    });
  } finally {
    fs.closeSync(o);
    fs.closeSync(e);
  }
  const stdout = fs.readFileSync(outPath, 'utf8').replace(/^\uFEFF/, '');
  fs.rmSync(outPath, { force: true });
  fs.rmSync(errPath, { force: true });
  let json = null;
  try {
    json = JSON.parse(stdout.slice(stdout.indexOf('{')));
  } catch {
    json = null;
  }
  const failing = (json?.gates ?? []).flatMap((g) => (g.checks ?? []).filter((c) => !c.passed).map((c) => ({ gate: g.id, check: c.id, type: c.type, message: c.message ?? null, evidence: (c.evidence ?? []).map((x) => x.excerpt).filter(Boolean).slice(-2) })));
  return {
    label,
    exit: res.status,
    overall_passed: json?.overall_passed ?? null,
    gates: json?.gates?.length ?? null,
    gatesPassed: (json?.gates ?? []).filter((g) => g.passed).length,
    failing,
    failingIds: failing.map((f) => `${f.gate}:${f.check}`),
    blockerText: failing.flatMap((f) => [f.message, ...f.evidence]).filter(Boolean).slice(0, 3).map((s) => String(s).slice(0, 400)),
  };
}

function recordPointer() {
  const res = spawnSync(process.execPath, [
    path.join(copy, 'verification-t9', 'tools', 'evidence-pointer.mjs'),
    'record',
    POINTER,
    '--name',
    'adapter-suite-baseline',
    '--argv',
    JSON.stringify(['node', 'adapters/opencodereview/tools/run-tests.mjs']),
    '--cwd',
    copy,
    '--expected',
    'testFiles=15;tests=145;pass=145;fail=0;exit_code=0',
  ], { cwd: copy, stdio: ['ignore', 'ignore', 'ignore'] });
  return res.status;
}

const results = [];
// A: stale — a pointer recorded at an older revision (its recorded fingerprint no longer matches).
// The copy is byte-identical to the real tree for every fingerprint target, so the staleness has to be
// injected explicitly rather than assumed.
const pointerAbs0 = path.join(copy, POINTER);
const pointerText = fs.readFileSync(pointerAbs0, 'utf8');
fs.writeFileSync(pointerAbs0, pointerText.replace(/# tree_fingerprint: [0-9a-f]{64}/, `# tree_fingerprint: ${'0'.repeat(64)}`));
results.push(runCheck('A pointer recorded at an older revision (stale)'));
// B: re-record ⇒ green.
const recB = recordPointer();
results.push({ ...runCheck('B re-record in the copy'), recordExit: recB });
// C: an in-scope write makes the recorded pointer stale again.
fs.writeFileSync(path.join(copy, 'docs', 't66-probe.md'), 'in-scope write to invalidate the pointer\n');
results.push(runCheck('C in-scope write after recording'));
// D: re-record ⇒ green again (the restore half the verifier owns).
fs.rmSync(path.join(copy, 'docs', 't66-probe.md'), { force: true });
const recD = recordPointer();
results.push({ ...runCheck('D re-record after the write'), recordExit: recD });
// E: the verifier tool disappears ⇒ fail-closed.
const toolAbs = path.join(copy, TOOL);
fs.renameSync(toolAbs, `${toolAbs}.gone`);
results.push(runCheck('E verifier tool deleted (fail-closed)'));
fs.renameSync(`${toolAbs}.gone`, toolAbs);
// F: the authoritative pointer is removed while the historical SUPERSEDED copies remain ⇒ must be red
// (t66 finding F21: this used to read as green).
const pointerAbs = path.join(copy, POINTER);
fs.renameSync(pointerAbs, `${pointerAbs}.bak`);
results.push(runCheck('F authoritative pointer removed, superseded copies remain (fail-closed)'));
fs.renameSync(`${pointerAbs}.bak`, pointerAbs);
// G: no pointer file at all ⇒ fail-closed discovery.
const moved = [];
for (const rel of ['verification-t9/artifacts-v8/adapter-suite.txt', 'verification-t9/artifacts/adapter-suite.txt', 'verification-t9/artifacts-v3/adapter-suite.txt', 'verification-t9/artifacts-v4/adapter-suite.txt', 'verification-t9/artifacts-v6/adapter-suite.txt', 'verification-t9/artifacts-v7/adapter-suite.txt']) {
  const abs = path.join(copy, rel);
  if (!fs.existsSync(abs)) continue;
  fs.renameSync(abs, `${abs}.gone`);
  moved.push([abs, `${abs}.gone`]);
}
results.push(runCheck('G no pointer file at all (fail-closed discovery)'));
for (const [a, b] of moved.reverse()) fs.renameSync(b, a);

const byLabel = Object.fromEntries(results.map((r) => [r.label, r]));
const redOn = (label) => byLabel[label]?.exit === 1 && byLabel[label].failingIds.includes('verify-coverage:baseline-freshness');
const green = (label) => byLabel[label]?.exit === 0 && byLabel[label].overall_passed === true && byLabel[label].failingIds.length === 0;
const report = {
  copy,
  scenarios: results,
  summary: {
    staleIsRed: redOn('A pointer recorded at an older revision (stale)'),
    recordTurnsItGreen: green('B re-record in the copy'),
    inScopeWriteTurnsItRed: redOn('C in-scope write after recording'),
    restoreTurnsItGreenAgain: green('D re-record after the write'),
    missingToolFailsClosed: redOn('E verifier tool deleted (fail-closed)'),
    noAuthoritativePointerFailsClosed: redOn('F authoritative pointer removed, superseded copies remain (fail-closed)'),
    noPointerAtAllFailsClosed: redOn('G no pointer file at all (fail-closed discovery)'),
  },
};
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  for (const r of results) console.log(`${String(r.exit).padEnd(3)} ${r.label} :: overall=${r.overall_passed} gates=${r.gatesPassed}/${r.gates} failing=${JSON.stringify(r.failingIds)}${r.recordExit !== undefined ? ` recordExit=${r.recordExit}` : ''}`);
  console.log(`summary=${JSON.stringify(report.summary)}`);
  for (const r of results) if (r.blockerText?.length) console.log(`  [${r.label}] ${r.blockerText[0].slice(0, 220)}`);
}

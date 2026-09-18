#!/usr/bin/env node
// verification-t9/check-report-v9.mjs — validates report-v9.json against the t66 acceptance criteria.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFingerprint } from './tools/tree-fingerprint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const r = JSON.parse(fs.readFileSync(path.join(HERE, 'report-v9.json'), 'utf8'));
const z1 = r.z1_baseline_rerecord;
const z2 = r.z2_gate_state;
const checks = [];
const chk = (name, ok, evidence) => checks.push({ name, ok: Boolean(ok), evidence });
const ids = r.assertions.map((x) => x.id);
const A = 'verification-t9/artifacts-v9';

chk('legal JSON + assertions array', Array.isArray(r.assertions) && r.assertions.length >= 12, `assertions=${r.assertions.length}`);
chk('Z1-Z5 and X1-X4 and Y1-Y5 present', ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'X1', 'X2', 'X3', 'X4', 'Y1', 'Y2', 'Y3', 'Y4', 'Y5'].every((k) => ids.includes(k)), `missing=${['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'X1', 'X2', 'X3', 'X4', 'Y1', 'Y2', 'Y3', 'Y4', 'Y5'].filter((k) => !ids.includes(k))}`);
chk('every assertion has command/cwd/expected/actual/status', r.assertions.every((x) => x.command && x.cwd && x.actual && x.expected && x.status), `fielded=${r.assertions.filter((x) => x.command && x.cwd && x.actual).length}/${r.assertions.length}`);
chk('summary counts equal the assertions array', r.summary.pass + r.summary.fail + r.summary.blocked === r.assertions.length && r.summary.pass === r.assertions.filter((x) => x.status === 'pass').length && r.summary.fail === r.assertions.filter((x) => x.status === 'fail').length && r.summary.blocked === r.assertions.filter((x) => x.status === 'blocked').length, JSON.stringify(r.summary));
chk('supersedes report-v8', r.supersedes === 'verification-t9/report-v8.json', r.supersedes);
chk('tree_fingerprint matches the recomputed value', r.tree_fingerprint === computeFingerprint().fingerprint, `${r.tree_fingerprint.slice(0, 12)} vs ${computeFingerprint().fingerprint.slice(0, 12)}`);
chk('Z1: pointer re-recorded in pointer+hash format with current fingerprint and 15/145', z1.after.tree_fingerprint === r.tree_fingerprint && z1.after.expected === 'testFiles=15;tests=145;pass=145;fail=0;exit_code=0' && /pointer\+hash/.test(fs.readFileSync(path.join(ROOT, 'verification-t9/artifacts-v8/adapter-suite.txt'), 'utf8').split('\n')[1]), JSON.stringify({ fp: z1.after.tree_fingerprint.slice(0, 12), expected: z1.after.expected }));
chk('Z1: before -> after recorded', z1.before.expected === 'testFiles=14;tests=131;pass=131;fail=0;exit_code=0' && z1.before.tree_fingerprint !== z1.after.tree_fingerprint, `before=${z1.before.expected} after=${z1.after.expected}`);
chk('Z2: root gate exit 0 / overall_passed / 5 of 5 / failingChecks=[]', z2.exit === 0 && z2.overall_passed === true && z2.gates === 5 && z2.gates_passed === 5 && z2.failingChecks.length === 0, JSON.stringify(z2));
chk('Z2: two same-revision runs normalise to one hash', z2.normalized_equal === true && z2.normalized_hash_run1 === z2.normalized_hash_run2 && /^[0-9a-f]{64}$/.test(z2.normalized_hash_run1), z2.normalized_hash_run1);
chk('Z3: four sub-results (perturbation / preview audit-tree 0 / SAFE_002 unchanged / both paths move together)', r.z3_f19.on_fixed_tree.previewExcludesAuditTrees === true && r.z3_f19.on_fixed_tree.safe002NotRegressed === true && r.z3_f19.fixed_numbers.check_selected === 143 && r.z3_f19.revert_summary.bothPathsMovedTogether === true && r.z3_f19.revert_experiment.preview_audit_tree_entries > 0, JSON.stringify({ fixed: r.z3_f19.fixed_numbers, delta: r.z3_f19.revert_experiment }));
chk('Z4: seven scenarios all as designed', Object.values(r.z4_r5_matrix).every(Boolean) && Object.keys(r.z4_r5_matrix).length === 7, JSON.stringify(r.z4_r5_matrix));
chk('F20 (copy-path false failure) recorded as a finding with a repro', r.findings.some((f) => f.id === 'F20' && f.status === 'confirmed (reproduced)' && /node_modules\/left-pad/.test(f.problem)), 'F20');
chk('F21 (gate fail-closed hole) recorded as fixed', r.findings.some((f) => f.id === 'F21' && f.status === 'fixed'), 'F21');
chk('X4 decision still (b) in the scope block', /option \(b\)/.test(r.fingerprint_scope_and_algorithm.x4_decision), 'x4');
chk('fingerprint_history extends v8', r.fingerprint_history.length >= 18, `len=${r.fingerprint_history.length}`);
chk('residual items carry owners', (r.residual_items || []).length > 0 && r.residual_items.every((x) => x.owner), JSON.stringify(r.residual_items.map((x) => `${x.id}:${x.owner}`)));
chk('release recommendation present', Boolean(r.release_recommendation?.verdict), r.release_recommendation?.verdict);
chk('evidence artifacts referenced actually exist', fs.existsSync(path.join(ROOT, `${A}/run1.json`)) && fs.existsSync(path.join(ROOT, `${A}/z4-gate-matrix.json`)) && fs.existsSync(path.join(ROOT, `${A}/z3-revert-experiment-mirror.json`)) && fs.existsSync(path.join(ROOT, `${A}/y1-named-client-parity.json`)), A);

for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name} — ${c.evidence}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(`report-v9 acceptance: ${checks.length - failed}/${checks.length} checks pass`);
process.exitCode = failed === 0 ? 0 : 1;

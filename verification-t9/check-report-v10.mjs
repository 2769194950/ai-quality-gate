#!/usr/bin/env node
// verification-t9/check-report-v10.mjs — validates report-v10.json against the t68 acceptance criteria.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { computeFingerprint } from './tools/tree-fingerprint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const r = JSON.parse(fs.readFileSync(path.join(HERE, 'report-v10.json'), 'utf8'));
const w1 = r.w1_baseline_rerecord;
const w2 = r.w2_gate_state;
const w3 = r.w3_t67_reverification;
const w4 = r.w4_copy_path;
const l = r.lookup;
const checks = [];
const chk = (name, ok, evidence) => checks.push({ name, ok: Boolean(ok), evidence });
const ids = r.assertions.map((x) => x.id);
const pointerText = fs.readFileSync(path.join(ROOT, 'verification-t9/artifacts-v8/adapter-suite.txt'), 'utf8');
const toolText = fs.readFileSync(path.join(ROOT, 'verification-t9/tools/baseline-freshness.mjs'), 'utf8');

chk('legal JSON + assertions array', Array.isArray(r.assertions) && r.assertions.length >= 12, `assertions=${r.assertions.length}`);
chk('W1-W5 present and W1-W5 of v9 carried under suffixed ids', ['W1', 'W2', 'W3', 'W4', 'W5'].every((k) => ids.includes(k)) && ['W1-t55', 'W2-t55', 'W3-t55', 'W4-t55', 'W5-t55'].every((k) => ids.includes(k)), `missing=${[...['W1', 'W2', 'W3', 'W4', 'W5', 'W1-t55', 'W2-t55', 'W3-t55', 'W4-t55', 'W5-t55']].filter((k) => !ids.includes(k))}`);
chk('every assertion has command/cwd/expected/actual/status', r.assertions.every((x) => x.command && x.cwd && x.actual && x.expected && x.status), `fielded=${r.assertions.filter((x) => x.command && x.cwd && x.actual).length}/${r.assertions.length}`);
chk('summary counts equal the assertions array', r.summary.pass + r.summary.fail + r.summary.blocked === r.assertions.length && r.summary.pass === r.assertions.filter((x) => x.status === 'pass').length && r.summary.fail === r.assertions.filter((x) => x.status === 'fail').length && r.summary.blocked === r.assertions.filter((x) => x.status === 'blocked').length, JSON.stringify(r.summary));
chk('supersedes report-v9', r.supersedes === 'verification-t9/report-v9.json', r.supersedes);
chk('tree_fingerprint matches the recomputed value', r.tree_fingerprint === computeFingerprint().fingerprint, `${r.tree_fingerprint.slice(0, 12)} vs ${computeFingerprint().fingerprint.slice(0, 12)}`);
chk('W1: pointer in pointer+hash format, current fingerprint, 15/145 counts', pointerText.includes('# format: pointer+hash v1') && pointerText.includes(`# tree_fingerprint: ${r.tree_fingerprint}`) && pointerText.includes('# expected: testFiles=15;tests=145;pass=145;fail=0;exit_code=0'), 'pointer header');
chk('W1: before -> after recorded', w1.before.tree_fingerprint === '92d56be67c93d24f942c07ad9ac2f797d5aa0eb306e25057c4c774ec748f0c22' && w1.after.tree_fingerprint === r.tree_fingerprint && w1.before.content_sha256 !== w1.after.content_sha256, `before=${w1.before.file_sha256.slice(0, 8)} after=${w1.after.file_sha256.slice(0, 8)}`);
chk('W1: FRESH + countsMatch, no COUNT-DRIFT (aggregator output)', r.lookup.pointer_negatives.join(',') !== '' && /FRESH/.test('FRESH') && (() => { const f = JSON.parse(fs.readFileSync(path.join(ROOT, 'verification-t9/artifacts-v10/baseline-freshness.json'), 'utf8')); return f.stale === 0 && f.count_drift === 0 && f.fresh === 1 && f.authoritative_pointers === 1; })(), `aggregator artifact`);
chk('W1: F21 hardening still in force (tool + report record)', /NO-AUTHORITATIVE-POINTER/.test(toolText) && /authoritative_pointers/.test(toolText) && w1.f21_hardening_present.length === 2, 'baseline-freshness.mjs L68/L76');
chk('W2: root gate exit 0 / overall_passed / 5 of 5 / failingChecks=[]', w2.exit === 0 && w2.overall_passed === true && w2.gates === 5 && w2.gates_passed === 5 && w2.failingChecks.length === 0, JSON.stringify(w2.failingChecks));
chk('W2: two same-revision runs normalise to one 64-hex hash', w2.normalized_equal === true && w2.normalized_hash_run1 === w2.normalized_hash_run2 && /^[0-9a-f]{64}$/.test(w2.normalized_hash_run1), w2.normalized_hash_run1);
chk('W3: >=6 matrix cells, all green with 145/145/0', w3.matrixCells >= 6 && w3.allCellsGreen === true && w3.cells.every((c) => c.exit === 0 && c.tests === 145 && c.pass === 145 && c.fail === 0 && c.testFiles === 15), `cells=${w3.matrixCells}`);
chk('W3: matrix covers a node_modules-excluded copy and two non-repo-root cwds', w3.cells.some((c) => /copyB/.test(c.label)) && w3.cells.some((c) => c.cwd === 'C:\\') && w3.cells.some((c) => /mini-service$/.test(c.cwd)), w3.cells.map((c) => `${c.label.split(' ')[0]}@${c.cwd}`).join(' | '));
chk('W3: all counter-examples still fail (clauses b, denominator, disposition, grouping)', w3.summary.allCounterExamplesStillFail === true && w3.summary.c1ClauseBFired && w3.summary.c2DenominatorFired && w3.summary.c3DispositionFired && w3.summary.c4ExposedOffRecordedPath, JSON.stringify(w3.summary));
chk('W3: the hidden control holds (reverted grouping passes from the recorded path)', w3.summary.hiddenControlsHold === true && w3.hiddenControls[0].fail === 0, JSON.stringify(w3.hiddenControls));
chk('W3: counter-example messages quote the exact assertions', /未物化的夹具路径必须能由本层规则解释/.test(w3.counterExamples[0].firstMessage || '') && /夹具必须基本物化/.test(w3.counterExamples[1].firstMessage || '') && /必须被排除/.test(w3.counterExamples[2].firstMessage || ''), 'messages');
chk('W4: non-recording-path copy counts + gate', w4.record_command_from_copy.testFiles === 15 && w4.record_command_from_copy.fail === 0 && w4.record_command_from_c_drive.fail === 0 && w4.gate_in_copy.exit === 0 && w4.gate_in_copy.failingChecks.length === 0 && /CLOSED/.test(w4.f20), JSON.stringify(w4.gate_in_copy));
chk('W5: regression numbers recorded', l.w5_engine.test === '110/110/0' && l.w5_engine.test_all === '110/110/0' && l.w5_engine.test_contract === '25/25/0' && l.w5_preview_four_cwd_distinct === 1 && l.w5_assertion12.verdict === 'aligned' && /11\/11/.test(l.w5_root_scripts), JSON.stringify(l.w5_engine));
chk('W5: root README.md hash explicitly checked and unchanged', /^DD57637F/.test(l.root_readme_sha256) && /dd57637f/i.test(l.root_readme_expected) && crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'README.md'))).digest('hex').toUpperCase() === l.root_readme_sha256, l.root_readme_sha256);
chk('F-65-1 and F20 recorded as closed', r.findings.some((f) => f.id === 'F-65-1' && /closed/.test(f.status)) && r.findings.some((f) => f.id === 'F20' && /closed/.test(f.status)), 'findings');
chk('residual items carry owners', (r.residual_items || []).length > 0 && r.residual_items.every((x) => x.owner), JSON.stringify(r.residual_items.map((x) => `${x.id}:${x.owner}`)));
chk('release recommendation present', Boolean(r.release_recommendation?.verdict), r.release_recommendation?.verdict);
chk('fingerprint_history extends v9', r.fingerprint_history.length >= 19, `len=${r.fingerprint_history.length}`);
chk('evidence artifacts referenced exist', ['run1.json', 'w3-path-cwd-matrix.json', 'w4-copy-rootcheck.json', 'preview-crosscheck.json', 'ci-three-step.json', 'tool-hashes-check.json'].every((f) => fs.existsSync(path.join(ROOT, 'verification-t9/artifacts-v10', f))), 'artifacts-v10');

for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name} — ${c.evidence}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(`report-v10 acceptance: ${checks.length - failed}/${checks.length} checks pass`);
process.exitCode = failed === 0 ? 0 : 1;

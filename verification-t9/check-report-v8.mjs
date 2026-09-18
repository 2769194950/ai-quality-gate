#!/usr/bin/env node
// verification-t9/check-report-v8.mjs — validates report-v8.json against the t60 acceptance criteria.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFingerprint } from './tools/tree-fingerprint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const r = JSON.parse(fs.readFileSync(path.join(HERE, 'report-v8.json'), 'utf8'));
const checks = [];
const chk = (name, ok, evidence) => checks.push({ name, ok: Boolean(ok), evidence });

chk('legal JSON + assertions array', Array.isArray(r.assertions) && r.assertions.length >= 12, `assertions=${r.assertions.length}`);
const ids = r.assertions.map((x) => x.id);
const required = ['X1', 'X2', 'X3', 'X4', 'Y1', 'Y2', 'Y3', 'Y4', 'Y5'];
chk('X1-X4 and Y1-Y5 all present', required.every((k) => ids.includes(k)), `missing=${required.filter((k) => !ids.includes(k))}`);
const fielded = r.assertions.filter((x) => x.command && x.cwd && x.actual && x.expected && x.status);
chk('every assertion has command/cwd/expected/actual/status', fielded.length === r.assertions.length, `fielded=${fielded.length}/${r.assertions.length}`);
const s = r.summary;
chk('summary counts equal the assertions array', s.pass + s.fail + s.blocked === r.assertions.length && s.pass === r.assertions.filter((x) => x.status === 'pass').length && s.fail === r.assertions.filter((x) => x.status === 'fail').length && s.blocked === r.assertions.filter((x) => x.status === 'blocked').length, JSON.stringify(s));
chk('supersedes report-v7', r.supersedes === 'verification-t9/report-v7.json', r.supersedes);
chk('tree_fingerprint present + matches the recomputed value', r.tree_fingerprint === computeFingerprint().fingerprint, `${r.tree_fingerprint} vs ${computeFingerprint().fingerprint}`);
chk('fingerprint_history present and extends v7', Array.isArray(r.fingerprint_history) && r.fingerprint_history.length >= 17, `len=${r.fingerprint_history.length}`);
chk('fingerprint_scope_and_algorithm present (X4 decision inside)', Boolean(r.fingerprint_scope_and_algorithm && r.fingerprint_scope_and_algorithm.x4_decision), 'scope+x4');
chk('X1 pointer format sample present', typeof r.x1_pointer_format_sample === 'string' && r.x1_pointer_format_sample.includes('content_sha256'), 'sample');
chk('X1 machine check with four negatives', (r.x1_machine_check?.negatives || []).length === 4, JSON.stringify((r.x1_machine_check?.negatives || []).map((n) => n.observed)));
chk('X2 before -> after recorded (14/131)', r.assertions.find((x) => x.id === 'X2').actual.includes('14 文件 / 131 用例') && r.assertions.find((x) => x.id === 'X2').actual.includes('11 文件 / 109 用例'), 'X2 text');
chk('Y1 confirms zero false positives and the two stricter cells still report', /良性对照 20\/20 零误报/.test(r.assertions.find((x) => x.id === 'Y1').actual) && /仍报/.test(r.assertions.find((x) => x.id === 'Y1').actual), 'Y1 text');
chk('Y1/Y5 built their own cells (not copied)', /自建/.test(r.assertions.find((x) => x.id === 'Y1').actual) && /自建/.test(r.assertions.find((x) => x.id === 'Y5').actual), 'self-built');
chk('Y2 marked pass with both doc tasks terminal', r.assertions.find((x) => x.id === 'Y2').status === 'pass' && /t59 completed、t61 completed/.test(r.assertions.find((x) => x.id === 'Y2').actual), 'Y2');
chk('blocked items have concrete reasons', /fsutil 8dot3name query/.test(r.assertions.find((x) => x.id === '10').actual) && /wsl -l -v/.test(r.assertions.find((x) => x.id === '10').actual), 'blocked reasons');
chk('fail/blocked have reproducible commands', r.assertions.filter((x) => x.status !== 'pass').every((x) => x.command && x.command !== '(record)') || r.assertions.find((x) => x.id === '10').command === '(record)', 'commands');
chk('residual items carry owners', (r.residual_items || []).length > 0 && r.residual_items.every((x) => x.owner), JSON.stringify(r.residual_items.map((x) => `${x.id}:${x.owner}`)));
chk('release recommendation present', Boolean(r.release_recommendation?.verdict), r.release_recommendation?.verdict);

for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name} — ${c.evidence}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(`report-v8 acceptance: ${checks.length - failed}/${checks.length} checks pass`);
process.exitCode = failed === 0 ? 0 : 1;

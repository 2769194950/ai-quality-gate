#!/usr/bin/env node
// verification-t9/tools/v2-engine-identity.mjs — t49 V2 (R3-H1): the engine-side hardlink identity
// chain must exclude aliases on BOTH paths (`preview` and `check`/SAFE_002), including two variants
// this verifier constructs: an alias of a file under secrets/** and a third name for the same inode.
// Negative control: a neutral-content hardlink pair must stay selected (same semantics as the
// adapter's D09).
// Usage: node verification-t9/tools/v2-engine-identity.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { runCliJson, tmpDir, writeJson, writeText, cleanup } from '../../packages/qgate/test/helpers.mjs';

const base = tmpDir('v2-identity-');
const root = path.join(base, 'repo');
const files = {
  'src/app.mjs': 'export const a = 1;\n',
  '.env': 'ANTHROPIC_API_KEY=sk-ant-shouldnotleak\n',
  'credentials.json': '{"access_key":"AKIAIOSFODNN7EXAMPLE"}\n',
  'secrets/db.txt': 'password=hunter2\n',
  'plain.txt': 'hello neutral content\n',
};
for (const [rel, text] of Object.entries(files)) writeText(path.join(root, rel), text);
// aliases: three class targets + two new variants (alias under secrets/**, second name for same inode)
fs.linkSync(path.join(root, '.env'), path.join(root, 'notes.txt'));
fs.linkSync(path.join(root, 'credentials.json'), path.join(root, 'handbook.txt'));
fs.linkSync(path.join(root, 'secrets', 'db.txt'), path.join(root, 'guide.txt'));
fs.linkSync(path.join(root, '.env'), path.join(root, 'notes2.txt')); // same inode, third name
fs.linkSync(path.join(root, 'secrets', 'db.txt'), path.join(root, 'secrets', 'db-copy.txt')); // alias inside secrets/**
fs.linkSync(path.join(root, 'plain.txt'), path.join(root, 'copy.txt')); // neutral pair (must stay selected)

const ALIASES = ['notes.txt', 'handbook.txt', 'guide.txt', 'notes2.txt', 'secrets/db-copy.txt'];
const SENSITIVE_BY_NAME = ['.env', 'credentials.json', 'secrets/db.txt'];
const NEUTRAL = ['plain.txt', 'copy.txt'];

const configPath = path.join(base, 'qgate.config.json');
writeJson(configPath, {
  version: '1.0',
  provider: { type: 'deterministic' },
  projectRoot: 'repo',
  policy: { evidenceDir: '.qgate/evidence', reportDir: '.qgate/reports' },
  gates: [{ id: 'verify-coverage', stage: 'verify', required: true, checks: [{ id: 'no-secret-paths', type: 'policy', policyId: 'SAFE_002', required: true }] }],
});

const preview = await runCliJson(['preview', '--root', root, '--json'], { strict: false });
const check = await runCliJson(['check', '--config', configPath, '--json'], { strict: false });

const pIncluded = preview.json?.selection?.included ?? [];
const pExcluded = (preview.json?.selection?.excluded ?? []).map((e) => `${e.path}|${e.reason}|${e.rule ?? ''}`);
const invariants = preview.json?.invariants ?? null;
const cChecks = (check.json?.gates ?? []).flatMap((g) => g.checks ?? []);
const safe002 = cChecks.find((c) => c.id === 'no-secret-paths') ?? null;
const evidenceText = JSON.stringify(safe002?.evidence ?? []);

const report = {
  cwd: process.cwd(),
  aliases: ALIASES,
  sensitiveByName: SENSITIVE_BY_NAME,
  neutral: NEUTRAL,
  preview: {
    exit: preview.status,
    included: pIncluded,
    aliasesSelected: ALIASES.filter((a) => pIncluded.includes(a)),
    sensitiveSelected: SENSITIVE_BY_NAME.filter((s) => pIncluded.includes(s)),
    aliasExclusions: pExcluded.filter((x) => ALIASES.some((a) => x.startsWith(`${a}|`))),
    neutralSelected: NEUTRAL.filter((n) => pIncluded.includes(n)),
    invariants,
  },
  check: {
    exit: check.status,
    overall_passed: check.json?.overall_passed ?? null,
    safe002Passed: safe002?.passed ?? null,
    secretPathsExcluded: (() => {
      // the metric lives inside a JSON-escaped excerpt string, e.g. `secretPathsExcluded\":8`
      const m = /secretPathsExcluded\\?":(\d+)/.exec(evidenceText);
      return m ? Number(m[1]) : null;
    })(),
    evidence: safe002?.evidence ?? null,
  },
};
report.verdict = {
  previewCoversAliases: report.preview.aliasesSelected.length === 0 && report.preview.sensitiveSelected.length === 0 && report.preview.aliasExclusions.length === ALIASES.length,
  invariantsClean: JSON.stringify(invariants?.secretPathsSelected ?? []) === '[]',
  checkCoversAliases: report.check.exit === 0 && report.check.safe002Passed === true && report.check.secretPathsExcluded === SENSITIVE_BY_NAME.length + ALIASES.length,
  neutralStillSelected: NEUTRAL.every((n) => pIncluded.includes(n)),
};
report.ok = Object.values(report.verdict).every(Boolean);

if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  console.log(`preview exit=${report.preview.exit} included=${JSON.stringify(report.preview.included)}`);
  console.log(`  aliasesSelected=${JSON.stringify(report.preview.aliasesSelected)} sensitiveSelected=${JSON.stringify(report.preview.sensitiveSelected)}`);
  console.log(`  aliasExclusions=${JSON.stringify(report.preview.aliasExclusions)}`);
  console.log(`  invariants=${JSON.stringify(report.preview.invariants)}`);
  console.log(`check exit=${report.check.exit} overall_passed=${report.check.overall_passed} safe002Passed=${report.check.safe002Passed} secretPathsExcluded=${report.check.secretPathsExcluded}`);
  console.log(`verdict=${JSON.stringify(report.verdict)} ok=${report.ok}`);
}
cleanup(base);
process.exitCode = report.ok ? 0 : 1;

#!/usr/bin/env node
// verification-t9/make-tool-hashes.mjs — one-off generator for artifacts-v8/verifier-tool-hashes.json.
// Rationale: `verification-t9/**` is deliberately OUTSIDE the revision fingerprint, so verifier tool
// edits are invisible to `tree_fingerprint`. This manifest pins the tools used by report-v8 to a
// revision so a later reader can tell whether the tools that produced a claim still exist unchanged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { computeFingerprint } from './tools/tree-fingerprint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const TOOLS = fs
  .readdirSync(path.join(HERE, 'tools'))
  .filter((n) => n.endsWith('.mjs'))
  .sort();

const out = {
  tree_fingerprint: computeFingerprint().fingerprint,
  note: 'verification-t9/** is not in the revision fingerprint, so this manifest is the paired-hash record for verifier tooling.',
  check_command: 'node verification-t9/tools/tool-hashes-check.mjs',
  repaired_this_round: {
    'contract-fields.mjs': 'default --runresult pointed at a non-existent artifacts-v7 file and the whole runtime comparison was wrapped in `if (fs.existsSync(...))`, so a missing input reported `mismatches: 0` (silent skip read as a pass). Now: --runresult required, missing file exits 3.',
    'trace-check.mjs': 'trace file hardcoded to artifacts-v7 (a superseded revision) AND the report echoed that same hardcoded path while checking it. Now: --trace required, missing file exits 3, `traceFile` reports the actual input.',
    'preview-crosscheck.mjs': 'default --artifacts pointed at the superseded artifacts-v5. Now: --artifacts required, missing dir exits 3.',
  },
  before_hashes_available: false,
  before_hashes_note:
    'The three repaired tools were edited in place this round without a pre-repair snapshot, so their before-hashes cannot be produced from this workspace. That is itself the defect class this round is about (a tool that is not pinned to a revision); the manifest below pins the AFTER state, and X1/X3 apply the same fix to data baselines.',
  tools: Object.fromEntries(TOOLS.map((n) => [n, sha(path.join(HERE, 'tools', n))])),
  // t66: pin every evidence set (`artifacts*`), not just artifacts-v8, so a later round does not have to
  // remember that a new directory exists — the same reasoning as X1's pointer files.
  artifact_sets: Object.fromEntries(
    fs
      .readdirSync(HERE)
      .filter((n) => /^artifacts/.test(n) && fs.statSync(path.join(HERE, n)).isDirectory())
      .sort()
      .map((dir) => [
        dir,
        Object.fromEntries(
          fs
            .readdirSync(path.join(HERE, dir))
            .filter((n) => fs.statSync(path.join(HERE, dir, n)).isFile())
            .filter((n) => n !== 'verifier-tool-hashes.json') // never list its own hash
            .sort()
            .map((n) => [n, sha(path.join(HERE, dir, n))]),
        ),
      ]),
  ),
};
fs.writeFileSync(path.join(HERE, 'artifacts-v8', 'verifier-tool-hashes.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(
  `wrote verifier-tool-hashes.json: ${TOOLS.length} tools, ${Object.keys(out.artifact_sets).length} artifact set(s) / ${Object.values(out.artifact_sets).reduce((n, s) => n + Object.keys(s).length, 0)} files, fingerprint=${out.tree_fingerprint}`,
);

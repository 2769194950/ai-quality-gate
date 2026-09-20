#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const stages = ['requirements', 'design', 'build', 'review', 'verify'];
const files = new Set();

function addDiff(args) {
  try {
    const output = execFileSync('git', ['diff', '--name-only', ...args], { encoding: 'utf8' });
    for (const file of output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) files.add(file.replace(/\\/g, '/'));
  } catch {
    // A shallow or non-git checkout is treated as a full change set.
    files.add('*');
  }
}

const base = process.env.GITHUB_BASE_SHA;
const before = process.env.GITHUB_EVENT_BEFORE;
const sha = process.env.GITHUB_SHA;
if (base && sha) addDiff([base, sha]);
else if (before && sha && !/^0+$/.test(before)) addDiff([before, sha]);
else addDiff(['HEAD^', 'HEAD']);

if (files.has('*') || files.size === 0) {
  process.stdout.write(`stages=${stages.join(',')}\nmax_stage=verify\n`);
  process.exit(0);
}

const selected = new Set();
for (const file of files) {
  if (file === 'docs/00-requirements.md' || file === 'docs/requirements-index.json') selected.add('requirements');
  if (file === 'docs/01-architecture.md' || file.startsWith('schemas/')) selected.add('design');
  if (file === 'package.json' || file.endsWith('package.json') || file.startsWith('packages/') || file.startsWith('adapters/')) selected.add('build');
  if (/\.(mjs|js|cjs|ts|tsx|jsx)$/.test(file) || file.startsWith('.opencodereview/')) selected.add('review');
  if (file.startsWith('verification/') || /(^|\/)(test|tests|__tests__)\//.test(file)) selected.add('verify');
}
if (selected.size === 0) selected.add('review');
const ordered = stages.filter((stage) => selected.has(stage));
const maxStage = ordered.reduce((last, stage) => stages.indexOf(stage) > stages.indexOf(last) ? stage : last, ordered[0]);
const required = stages.slice(0, stages.indexOf(maxStage) + 1);
process.stdout.write(`stages=${required.join(',')}\nmax_stage=${maxStage}\n`);

#!/usr/bin/env node
// Explicit live boundary for OpenCodeReview.
// This command is intentionally outside packages/qgate: the caller owns the
// OCR credentials and qgate only receives the resulting JSON through ingest.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildOcrInvocation, resolveOcrExecutable } from '../src/ocr-runner.mjs';

const EXIT = { OK: 0, CONFIG: 2, INTERNAL: 3 };
const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { stage: null, root: process.cwd(), output: null, diff: null, from: null, to: null, commit: null, rule: null, backgroundFile: null, ocrBin: 'ocr' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--stage') out.stage = next();
    else if (arg === '--root') out.root = next();
    else if (arg === '--out') out.output = next();
    else if (arg === '--diff') out.diff = next();
    else if (arg === '--from') out.from = next();
    else if (arg === '--to') out.to = next();
    else if (arg === '--commit') out.commit = next();
    else if (arg === '--rule') out.rule = next();
    else if (arg === '--background-file') out.backgroundFile = next();
    else if (arg === '--ocr-bin') out.ocrBin = next();
    else if (arg === '--help') out.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!out.help && (!out.stage || !['requirements', 'design', 'build', 'review', 'verify'].includes(out.stage))) throw new Error('--stage must be one of requirements|design|build|review|verify');
  if (!out.help && !out.output) throw new Error('--out is required');
  if (!out.help && out.from && !out.to) throw new Error('--from requires --to');
  if (!out.help && out.to && !out.from) throw new Error('--to requires --from');
  const modes = [out.diff, out.commit, out.from && out.to].filter(Boolean).length;
  if (!out.help && modes > 1) throw new Error('--diff, --commit, and --from/--to are mutually exclusive');
  return out;
}

function printHelp() {
  process.stdout.write(`ocr-stage-review\n\nUsage: node ${path.relative(process.cwd(), HERE)}/ocr-stage-review.mjs --stage <stage> --root <repo> --out <raw.json> [--from <ref> --to <ref> | --commit <sha> | --diff <diff.json>] [--rule <rule.json>] [--background-file <context.md>] [--ocr-bin <ocr>]\n`);
}

function readDiffPaths(root, diff) {
  const absolute = path.resolve(root, diff);
  const payload = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  const files = Array.isArray(payload) ? payload : payload && Array.isArray(payload.files) ? payload.files : null;
  if (!files) throw new Error('--diff must be a JSON array or an object with a files array');
  const paths = files.map((entry) => typeof entry === 'string' ? entry : entry?.path).filter((value) => typeof value === 'string' && value.length > 0);
  if (paths.length === 0) throw new Error('--diff contains no file paths');
  return [...new Set(paths)].join(',');
}

function buildOcrArgs(opts) {
  const args = ['--format', 'json', '--audience', 'agent', '--repo', path.resolve(opts.root)];
  if (opts.diff) {
    // OCR has no external JSON diff flag. Scan the declared files explicitly,
    // preserving the adapter's fixture interface without pretending it is a Git diff.
    return ['scan', ...args, '--path', readDiffPaths(opts.root, opts.diff)];
  }
  const review = ['review', ...args];
  if (opts.from) review.push('--from', opts.from, '--to', opts.to);
  if (opts.commit) review.push('--commit', opts.commit);
  if (opts.rule) review.push('--rule', path.resolve(opts.rule));
  if (opts.backgroundFile) review.push('--background-file', path.resolve(opts.backgroundFile));
  return review;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      printHelp();
      return EXIT.OK;
    }
  } catch (error) {
    process.stderr.write(`ocr-stage-review: ${error.message}\n`);
    return EXIT.CONFIG;
  }
  let args;
  try {
    args = buildOcrArgs(opts);
  } catch (error) {
    process.stderr.write(`ocr-stage-review: ${error.message}\n`);
    return EXIT.CONFIG;
  }
  const ocrBin = resolveOcrExecutable(opts.ocrBin);
  const invocation = buildOcrInvocation(ocrBin, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: path.resolve(opts.root),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(`ocr-stage-review: OCR failed for stage=${opts.stage} exit=${result.status ?? 'spawn-error'}\n`);
    return EXIT.INTERNAL;
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    process.stderr.write(`ocr-stage-review: OCR returned invalid JSON: ${error.message}\n`);
    return EXIT.INTERNAL;
  }
  parsed.stage = opts.stage;
  fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
  fs.writeFileSync(path.resolve(opts.output), `${JSON.stringify(parsed, null, 2)}\n`);
  process.stdout.write(`ocr-stage-review: stage=${opts.stage} output=${path.resolve(opts.output)}\n`);
  return EXIT.OK;
}

process.exitCode = main(process.argv.slice(2));

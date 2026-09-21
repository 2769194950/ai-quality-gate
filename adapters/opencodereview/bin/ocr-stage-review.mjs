#!/usr/bin/env node
// Explicit live boundary for OpenCodeReview.
// This command is intentionally outside packages/qgate: the caller owns the
// OCR credentials and qgate only receives the resulting JSON through ingest.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildOcrInvocation, resolveOcrExecutable } from '../src/ocr-runner.mjs';
import { buildLiveChildEnv, validateLiveCredentials } from '../tools/live-env.mjs';

const EXIT = { OK: 0, CONFIG: 2, INTERNAL: 3 };
const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { stage: null, root: process.cwd(), output: null, manifest: null, diff: null, from: null, to: null, commit: null, rule: null, backgroundFile: null, ocrBin: 'ocr', timeoutMs: 120000 };
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
    else if (arg === '--manifest') out.manifest = next();
    else if (arg === '--diff') out.diff = next();
    else if (arg === '--from') out.from = next();
    else if (arg === '--to') out.to = next();
    else if (arg === '--commit') out.commit = next();
    else if (arg === '--rule') out.rule = next();
    else if (arg === '--background-file') out.backgroundFile = next();
    else if (arg === '--ocr-bin') out.ocrBin = next();
    else if (arg === '--timeout-ms') out.timeoutMs = Number(next());
    else if (arg === '--help') out.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!out.help && (!out.stage || !['requirements', 'design', 'build', 'review', 'verify'].includes(out.stage))) throw new Error('--stage must be one of requirements|design|build|review|verify');
  if (!out.help && !out.output) throw new Error('--out is required');
  if (!out.help && !out.manifest) throw new Error('--manifest is required');
  if (!out.help && (!Number.isInteger(out.timeoutMs) || out.timeoutMs < 1000)) throw new Error('--timeout-ms must be an integer >= 1000');
  if (!out.help && out.from && !out.to) throw new Error('--from requires --to');
  if (!out.help && out.to && !out.from) throw new Error('--to requires --from');
  const modes = [out.diff, out.commit, out.from && out.to].filter(Boolean).length;
  if (!out.help && modes > 1) throw new Error('--diff, --commit, and --from/--to are mutually exclusive');
  return out;
}

function printHelp() {
  process.stdout.write(`ocr-stage-review\n\nUsage: node ${path.relative(process.cwd(), HERE)}/ocr-stage-review.mjs --stage <stage> --root <repo> --manifest <manifest.json> --out <raw.json> [--from <ref> --to <ref> | --commit <sha> | --diff <diff.json>] [--rule <rule.json>] [--background-file <context.md>] [--ocr-bin <ocr>] [--timeout-ms <ms>]\n`);
}

function readManifest(file, stage) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    throw new Error(`cannot read manifest: ${error.message}`);
  }
  if (manifest.kind !== 'qgate-stage-review-manifest' || manifest.stage !== stage || !/^sha256:[0-9a-f]{64}$/.test(manifest.inputFingerprint ?? '')) {
    throw new Error('manifest is invalid or does not match the requested stage');
  }
  return manifest;
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

function cliVersion(bin, env, cwd) {
  const invocation = buildOcrInvocation(bin, ['--version']);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 10000,
    env,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  const firstLine = String(result.stdout ?? '').trim().split(/\r?\n/)[0] || '';
  const match = /(?:^|\bv)(\d+\.\d+\.\d+)(?:\b|$)/i.exec(firstLine);
  return match ? match[1] : firstLine || null;
}

function scrubCliDiagnostic(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(?:sk|atr)_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\r?\n/g, ' ')
    .trim()
    .slice(0, 1200);
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
  let manifest;
  try {
    manifest = readManifest(opts.manifest, opts.stage);
  } catch (error) {
    process.stderr.write(`ocr-stage-review: ${error.message}\n`);
    return EXIT.CONFIG;
  }
  let liveEnv;
  let provider;
  try {
    liveEnv = buildLiveChildEnv(process.env);
    provider = validateLiveCredentials(liveEnv);
  } catch (error) {
    process.stderr.write(`ocr-stage-review: live configuration invalid: ${error.message}\n`);
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
    timeout: opts.timeoutMs,
    env: liveEnv,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    process.stderr.write(`ocr-stage-review: OCR timed out for stage=${opts.stage}\n`);
    return EXIT.INTERNAL;
  }
  if (result.error || result.status !== 0) {
    process.stderr.write(`ocr-stage-review: OCR failed for stage=${opts.stage} exit=${result.status ?? 'spawn-error'}\n`);
    const diagnostic = scrubCliDiagnostic(result.stderr);
    if (diagnostic) process.stderr.write(`ocr-stage-review: OCR diagnostic=${diagnostic}\n`);
    return EXIT.INTERNAL;
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    process.stderr.write(`ocr-stage-review: OCR returned invalid JSON: ${error.message}\n`);
    return EXIT.INTERNAL;
  }
  let endpointHost = null;
  try {
    endpointHost = new URL(provider.baseUrl).host;
  } catch {
    process.stderr.write('ocr-stage-review: live endpoint URL is invalid\n');
    return EXIT.CONFIG;
  }
  const actualCliVersion = cliVersion(ocrBin, liveEnv, path.resolve(opts.root));
  const expectedCliVersion = String(process.env.OCR_CLI_VERSION ?? '').trim();
  if (!actualCliVersion || (expectedCliVersion && actualCliVersion !== expectedCliVersion)) {
    process.stderr.write(`ocr-stage-review: OCR CLI version mismatch expected=${expectedCliVersion || 'declared'} actual=${actualCliVersion || 'unavailable'}\n`);
    return EXIT.CONFIG;
  }
  const envelope = {
    kind: 'qgate-ocr-raw-result',
    schemaVersion: '1.0',
    stage: opts.stage,
    inputFingerprint: manifest.inputFingerprint,
    executionMode: 'live',
    provider: 'opencodereview',
    cliVersion: actualCliVersion,
    model: provider.model,
    endpointHost,
    result: parsed,
  };
  fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
  fs.writeFileSync(path.resolve(opts.output), `${JSON.stringify(envelope, null, 2)}\n`);
  process.stdout.write(`ocr-stage-review: stage=${opts.stage} live result written\n`);
  return EXIT.OK;
}

process.exitCode = main(process.argv.slice(2));

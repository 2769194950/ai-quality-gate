// Shared test helpers: absolute paths derived from this module's own URL so every
// suite works from any cwd, plus a deterministic temporary-fixture copier.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runCli as runCliInProcess, collectIo } from '../src/cli.mjs';
import { checkTestIds } from '../src/contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PACKAGE_ROOT = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');export const QGATE_BIN = path.join(PACKAGE_ROOT, 'bin', 'qgate.mjs');
export const DEMO_CONFIG = path.join(REPO_ROOT, 'demo', 'qgate.config.json');
export const DEMO_ROOT = path.join(REPO_ROOT, 'demo', 'mini-service');
export const VALID_CONFIG = path.join(PACKAGE_ROOT, 'examples', 'valid', 'five-stage.json');
export const INVALID_DIR = path.join(PACKAGE_ROOT, 'examples', 'invalid');
export const FIXTURE_RECORDINGS = path.join(PACKAGE_ROOT, 'examples', 'fixtures', 'provider-recordings.json');
const DEMO_CONFIG_OBJECT = JSON.parse(fs.readFileSync(DEMO_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
const DEMO_TEST_IDS = [...new Set(
  DEMO_CONFIG_OBJECT.gates.flatMap((gate) => (gate.checks ?? []).map((check) => checkTestIds[check.id]).filter(Boolean)),
)].sort();

/** Set when the sandbox refuses piped child-process stdio (documented boundary). */
export const SPAWN_LIMITATION =
  'piped child-process stdio is denied by this sandbox (EPERM); the CLI is exercised in-process instead';

let subprocessUsable = null;

/** Probe once whether spawning the CLI with piped stdio is possible here. */
export function canSpawnSubprocess() {
  if (subprocessUsable !== null) return subprocessUsable;
  try {
    const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' });
    subprocessUsable = !probe.error && probe.stdout === 'ok';
  } catch {
    subprocessUsable = false;
  }
  return subprocessUsable;
}

/**
 * Run the CLI. Prefers a real child process (`bin/qgate.mjs`); when the sandbox
 * denies piped stdio it falls back to the identical in-process entry point, so
 * the assertion target (exit code + stdout/stderr) stays the same.
 * Returns `{ status, stdout, stderr, transport }`.
 */
export async function runCli(args, { cwd = REPO_ROOT, env = {} } = {}) {
  if (canSpawnSubprocess()) {
    const result = spawnSync(process.execPath, [QGATE_BIN, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!result.error) {
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: null,
        transport: 'subprocess',
      };
    }
    subprocessUsable = false;
  }

  const previous = process.cwd();
  const savedEnv = new Map();
  for (const [key, value] of Object.entries(env)) {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  const capture = collectIo();
  let status = null;
  try {
    if (cwd !== previous) process.chdir(cwd);
    status = await runCliInProcess(args, capture.io);
  } finally {
    if (process.cwd() !== previous) process.chdir(previous);
    for (const [key, value] of savedEnv.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { status, stdout: capture.out(), stderr: capture.err(), error: null, transport: 'in-process' };
}

export async function runCliJson(args, options = {}) {
  const { strict = true, ...spawnOptions } = options;
  const result = await runCli(args, spawnOptions);
  let json = null;
  let parseError = null;
  try {
    json = JSON.parse(result.stdout);
  } catch (error) {
    parseError = error;
    json = null;
  }
  if (strict && json === null) {
    throw new Error(`stdout is not JSON for: qgate ${args.join(' ')}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
  }
  return { ...result, json, parseError };
}

/** Copy the demo repository into a throwaway directory (never mutates the repo). */
export function copyDemoRepo({ skipApprovals = false, into = null } = {}) {
  const target = into ?? fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-demo-'));
  const source = DEMO_ROOT;
  fs.cpSync(source, target, {
    recursive: true,
    filter: (src) => {
      if (!skipApprovals) return true;
      const rel = path.relative(source, src).split(path.sep).join('/');
      return !rel.startsWith('.qgate/approvals');
    },
  });
  resetCopiedLedgerState(target);
  return { root: target, config: path.join(REPO_ROOT, 'demo', 'qgate.config.json') };
}

/**
 * Reset the ledger state of a *copy* of the demo repository so a test always starts
 * from the shipped baseline (no run ids, no ledgers, the frozen 16 test ids).
 * The real repository is never touched.
 */
export function resetCopiedLedgerState(root) {
  const evidenceDir = path.join(root, '.qgate', 'evidence');
  if (!fs.existsSync(evidenceDir)) return;
  for (const name of fs.readdirSync(evidenceDir)) {
    if (name.startsWith('ledger-') && name !== 'ledger-index.json') fs.rmSync(path.join(evidenceDir, name));
  }
  const indexPath = path.join(evidenceDir, 'ledger-index.json');
  const current = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : { schemaVersion: '1.0' };
  current.runIds = [];
  current.ledgers = [];
  // Seed a copied demo with the test ids that its current configuration can
  // actually carry. A clean clone has no generated ledger-index yet.
  current.testIds = DEMO_TEST_IDS;
  fs.writeFileSync(indexPath, `${JSON.stringify(current, null, 2)}\n`);
  const reports = path.join(root, '.qgate', 'reports');
  if (fs.existsSync(reports)) fs.rmSync(reports, { recursive: true, force: true });
}

/** Copy an arbitrary directory tree into a temporary directory. */
export function copyTree(source, target) {
  fs.cpSync(source, target, { recursive: true });
  if (path.resolve(source) === path.resolve(DEMO_ROOT)) resetCopiedLedgerState(target);
  return target;
}

export function tmpDir(prefix = 'qgate-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeJson(absPath, value) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(absPath, text) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, text);
}

export function readJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

/** Strip the runtime fields so two runs are comparable (REQ-010). */
export function stripRuntime(runResult) {
  const clone = JSON.parse(JSON.stringify(runResult));
  for (const field of ['run_id', 'started_at', 'finished_at', 'duration_ms']) delete clone[field];
  return clone;
}

export function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

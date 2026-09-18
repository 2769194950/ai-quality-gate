// `command` — run a deterministic local command (no shell parsing) and compare its
// exit code against `expectExitCode`, optionally requiring a stdout match.
//
// stdout capture transports, in order (§5.1: "stdoutRegex: 设置后额外要求 stdout 命中"):
//   1. pipe        — preferred; gives exact stdout/stderr separation.
//   2. file fd     — used when a sandbox denies pipe-based child stdio. Capturing via
//                    a file descriptor keeps the assertion *evaluable* instead of
//                    silently turning it into a pass.
//   3. none        — only when both transports are denied. A `stdoutRegex` that could
//                    not be evaluated is then an explicit failure, never a pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { toPosix } from '../util/glob.mjs';
import { redact } from '../util/text.mjs';
import { evidence } from '../evidence.mjs';
import { normalizeRel, absOf, result } from './_shared.mjs';

export function checkCommand(ctx, check) {
  const run = check.run;
  const expectExitCode = check.expectExitCode ?? 0;
  const timeoutMs = check.timeoutMs ?? 60000;
  const cwd = check.cwd ? absOf(ctx.root, check.cwd) : ctx.root;
  const source = ctx.configPath ?? 'qgate.config.json';
  const cwdRel = toPosix(path.relative(ctx.root, cwd)) || '.';
  const wantsCapture = check.captureStdout !== false;
  // With --json/--summary the CLI's stdout must stay machine-readable (§6.1), so a
  // spawned command's output is redirected to the runner's stderr (fd 2) instead of
  // stdout (fd 1). 'inherit' keeps both streams untouched in human mode.
  const passthroughStdio = ctx.machineReadableStdout ? ['ignore', 2, 2] : 'inherit';

  const spawnOptions = { cwd, timeout: timeoutMs, windowsHide: true, shell: false };
  let outcome;
  let transport = 'none';

  try {
    if (!wantsCapture) {
      outcome = spawnSync(run[0], run.slice(1), { ...spawnOptions, stdio: passthroughStdio });
      transport = 'passthrough';
    } else {
      // 1. pipe
      outcome = spawnSync(run[0], run.slice(1), {
        ...spawnOptions,
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 8 * 1024 * 1024,
      });
      if (outcome.error && isStdioDenied(outcome.error)) {
        // 2. file descriptor
        const captured = spawnWithFileStdout(run, spawnOptions, passthroughStdio);
        outcome = captured.outcome;
        transport = captured.transport;
      } else if (!outcome.error) {
        transport = 'pipe';
      }
    }
  } catch (error) {
    outcome = { error, status: null, stdout: null, stderr: null };
  }

  if (outcome.error) {
    // The executable could not be started at all (missing tool, denied spawn,
    // timeout). This is a deterministic failure state, never a crash: the verdict
    // follows `onFail` like any other check failure (REQ-010 / risk R-002).
    const detail = `${outcome.error.code ?? outcome.error.name ?? 'SPAWN_ERROR'}: ${outcome.error.message}`;
    return result(
      false,
      [
        evidence(source, 'stdout', `command=${run.join(' ')} cwd=${cwdRel} spawnError=${detail}`),
        evidence(source, 'stdout', 'stdout=<not captured: spawn failed> stderr=<not captured: spawn failed>'),
      ],
      `COMMAND_FAILED: ${run.join(' ')} could not be executed (${detail}); expected exit code ${expectExitCode}`,
    );
  }

  const exitCode = typeof outcome.status === 'number' ? outcome.status : -1;
  const stdoutCaptured = transport === 'pipe' || transport === 'file';
  const stdout = stdoutCaptured ? redact(String(outcome.stdout ?? '')) : '';
  // Why stdout is missing decides how readable the diagnostic can be: either the
  // configuration switched capture off, or the environment denied both transports.
  const notCapturedReason = !wantsCapture
    ? 'captureStdout=false disables stdout capture'
    : 'pipe and file-descriptor child stdio were both denied by this environment';

  let stdoutOk = true;
  let stdoutDetail = '';
  let unevaluableAssertion = false;
  if (check.stdoutRegex) {
    if (stdoutCaptured) {
      stdoutOk = new RegExp(check.stdoutRegex, 'm').test(stdout);
      stdoutDetail = stdoutOk ? '' : ` stdout did not match /${check.stdoutRegex}/`;
    } else {
      // The assertion could not be evaluated. Reporting `passed=true` here would be a
      // false pass, so the check fails with a readable reason instead. §5.2 has no
      // "unevaluated" state for check results, so a failed check is the contract-safe
      // expression of "the configured requirement was not met".
      unevaluableAssertion = true;
      stdoutOk = false;
      stdoutDetail = ` stdoutRegex /${check.stdoutRegex}/ could not be evaluated (${notCapturedReason})`;
    }
  }
  const passed = exitCode === expectExitCode && stdoutOk;

  // NOTE: elapsed time is deliberately NOT part of the evidence — it would make two
  // identical runs differ, and the contract requires RunResult to be a pure function
  // of inputs apart from the four runtime fields (REQ-010).
  const evidenceList = [
    evidence(source, 'stdout', `command=${run.join(' ')} cwd=${cwdRel} exitCode=${exitCode} expected=${expectExitCode}`),
  ];
  if (stdoutCaptured) {
    evidenceList.push(evidence(source, 'stdout', stdout.trim().length > 0 ? `stdout: ${stdout.trim()}` : 'stdout: <empty>'));
  } else if (unevaluableAssertion) {
    evidenceList.push(
      evidence(source, 'stdout', `stdout not captured (${notCapturedReason}); the configured stdout assertion /${check.stdoutRegex}/ was NOT evaluated`),
    );
  } else {
    evidenceList.push(evidence(source, 'stdout', `stdout not captured (${notCapturedReason}); no stdout assertion is configured`));
  }

  const message = passed
    ? null
    : `COMMAND_FAILED: ${run.join(' ')} exited ${exitCode}, expected ${expectExitCode}${stdoutDetail}`;
  return result(passed, evidenceList, message);
}

/**
 * Retry with the child's stdout redirected to a temporary file descriptor. Some
 * sandboxes deny pipe-based child stdio while allowing file descriptors, and this
 * keeps stdout available for `stdoutRegex` evaluation.
 */
function spawnWithFileStdout(run, spawnOptions, passthroughStdio) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-command-'));
  const outFile = path.join(tmpDir, 'stdout.txt');
  let fd = null;
  try {
    fd = fs.openSync(outFile, 'w');
    const stderrTarget = Array.isArray(passthroughStdio) ? passthroughStdio[2] : 2;
    const outcome = spawnSync(run[0], run.slice(1), {
      ...spawnOptions,
      stdio: ['ignore', fd, stderrTarget],
    });
    if (outcome.error) return { outcome, transport: 'none' };
    let captured = '';
    try {
      captured = fs.readFileSync(outFile, 'utf8');
    } catch {
      captured = '';
    }
    return { outcome: { ...outcome, stdout: captured, stderr: '' }, transport: 'file' };
  } catch (error) {
    return { outcome: { error, status: null, stdout: null, stderr: null }, transport: 'none' };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

function describeTransports() {
  return 'pipe and file-descriptor child stdio were both denied by this environment';
}

/** True when the failure is the sandbox refusing piped stdio for the child. */
function isStdioDenied(error) {  const code = String(error?.code ?? '');
  return code === 'EPERM' || code === 'EACCES';
}

export const type = 'command';
export const description = 'execute a local command and compare its exit code (no shell)';
export { normalizeRel };

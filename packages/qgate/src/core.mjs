// Core pipeline evaluation (§3, §5.2, §9.2). Deterministic: the same repository
// and configuration always produce the same RunResult apart from the runtime
// fields (run_id / started_at / finished_at / duration_ms).
import path from 'node:path';
import {
  runResultSchemaVersion,
  stageOrder,
  checkTypes,
  checkTestIds,
  runtimeFields,
} from './contract.mjs';
import { providerError, evidenceError } from './errors.mjs';
import { createProvider, providerDescriptor, PROBE_REQUEST, probeFingerprint } from './provider.mjs';
import { executeCheck } from './checks/index.mjs';
import { evaluateHumanGate, buildHumanGateBlocker, humanGateById } from './human-gate.mjs';
import { appendLedger, updateLedgerIndex, loadLedgerIndex, verifyLedgerChain, evidencedTestIds, ledgerRelPath as ledgerRelPathOf } from './ledger.mjs';
import { resolveRepoRoot } from './policy.mjs';
import { sha256, randomHex8 } from './util/hash.mjs';
import { rfc3339, makeRunId } from './util/fsx.mjs';

export { runtimeFields };

/** Resolve the repository root that policy scans should use. */
export function resolvePolicyRoot(configRoot) {
  return resolveRepoRoot(configRoot);
}

/** Resolve the repository-root-relative config path for evidence references. */
function configRelativePath(root, configAbsPath) {
  const rel = path.relative(root, configAbsPath);
  if (rel === '') return path.basename(configAbsPath);
  if (rel.startsWith('..')) return null;
  return rel.split(path.sep).join('/');
}

/** Strip runtime fields so two runs can be compared for determinism (REQ-010). */
export function stripRuntimeFields(runResult) {
  const clone = JSON.parse(JSON.stringify(runResult));
  for (const field of runtimeFields) delete clone[field];
  return clone;
}

function filterGates(gates, { stage = null, ids = null } = {}) {
  if (ids && ids.length > 0) {
    const wanted = new Set(ids);
    return { run: gates.filter((g) => wanted.has(g.id)), skipped: [] };
  }
  if (stage) {
    const limit = stageOrder.indexOf(stage);
    return {
      run: gates.filter((g) => stageOrder.indexOf(g.stage) <= limit),
      skipped: gates.filter((g) => stageOrder.indexOf(g.stage) > limit),
    };
  }
  return { run: gates, skipped: [] };
}

/**
 * Gates that were filtered out (--stage / --gate) or never reached (fail-fast).
 *
 * They are deliberately NOT serialized into `gates[]`: §5.2 freezes the gate key
 * set (`id`, `stage`, `required`, `passed`, `humanGate`, `blockers`, `checks`) and
 * its `overall_passed` definition is `gates.filter(g=>g.required).every(g=>g.passed)`,
 * which can only stay true for a filtered run if the un-run gates are absent rather
 * than reported as `passed:false`. The skip information is surfaced as metadata for
 * the human/`--summary` output instead (`meta.notRun`).
 */
function notRunEntry(gate, reason, extra = {}) {
  return { id: gate.id, stage: gate.stage, reason, ...extra };
}

/**
 * Run the configured pipeline and produce a RunResult.
 * `dryRun` skips all ledger writes (used by tests and by `--out`-only flows).
 */
export async function runPipeline(loaded, options = {}) {
  const { config, root, absPath } = loaded;
  const {
    stage = null,
    gateIds = null,
    failFast = config.policy.failFast,
    writeLedger = true,
    clock = () => new Date(),
    suffix = undefined,
    provider: injectedProvider = null,
  } = options;

  const startedDate = clock();
  const startedAt = rfc3339(startedDate);
  const startedMs = startedDate.getTime();
  const runId = makeRunId(startedAt, randomHex8(suffix));

  const provider = injectedProvider ?? createProvider(config.provider, {
    root,
    resolveScript: (script) => path.join(root, script.split('/').join(path.sep)),
  });
  // Exercise the provider once per run. Nothing else in the frozen check surface
  // consumes `provider.findings()`, so without this probe a fixture that can never
  // match would silently contribute nothing and the run would pass. A miss is an
  // explicit PROVIDER_FAILED (exit 3) instead of an implicit pass.
  const probe = await provider.findings(PROBE_REQUEST);
  if (!probe.ok) {
    throw providerError(`${probe.error?.message ?? 'provider probe did not match any recording'}`, {
      details: [
        {
          jsonPointer: '/provider/fixture',
          expected: `a recording for the provider probe (fingerprint ${probeFingerprint()})`,
          actual: `fingerprint ${probe.fingerprint}`,
          message: 'the configured provider could not be evaluated; regenerate the fixture with scripts/record-fixtures.mjs',
        },
      ],
    });
  }
  const repoSide = resolvePolicyRoot(root);
  const evidenceDir = config.policy.evidenceDir;
  const failFastEnabled = Boolean(failFast || config.policy.failFast);

  // §5.3.2 integrity: recompute the recorded sha256 of every ledger before doing
  // anything else. A tampered ledger or index is an unresolvable evidence chain
  // (§6.5 EVIDENCE_UNRESOLVED) — never a warning, never a silent pass.
  const chain = verifyLedgerChain(root, evidenceDir);
  if (!chain.ok) {
    throw evidenceError(`the evidence ledger chain failed verification (${chain.problems.length} problem(s))`, {
      details: chain.problems.map((problem) => ({
        jsonPointer: '/ledgers',
        expected: 'ledger files matching ledger-index.json (sha256 and runIds)',
        actual: problem.path ?? problem.kind,
        message: problem.detail,
      })),
    });
  }

  const checkCtx = {
    root,
    repoRoot: repoSide,
    configPath: configRelativePath(root, absPath) ?? path.basename(absPath),
    configAbsPath: absPath,
    // Every check id of the *current* configuration. The trace_matrix check uses this
    // to refuse coverage whose carrying check the current config no longer declares
    // (append-only ledger history must not certify a deleted check).
    configuredCheckIds: config.gates.flatMap((gate) => gate.checks.map((check) => check.id)),
    policyScanRoot: repoSide,
    policyScanRoots: config.policy.scanRoots ?? null,
    // §6.1: with --json/--summary stdout must carry the machine-readable document
    // only, so any child process a `command` check spawns inherits stderr instead.
    machineReadableStdout: Boolean(options.machineReadableStdout),
    frozen: {
      checkTypes: [...checkTypes],
      stages: [...stageOrder],
      humanGates: [...humanGateById.values()].map((g) => ({ gateId: g.gateId, role: g.role })),
      exitCodes: { 0: 'passed', 1: 'gate_failed', 2: 'config_error', 3: 'internal_error' },
      commands: ['contract', 'check', 'trace', 'preview', 'report', 'explain'],
      checkFields: {
        file_exists: ['file', 'minCount'],
        file_not_exists: ['file'],
        regex: ['files', 'pattern', 'flags', 'mode', 'minMatches', 'countMode', 'encoding'],
        command: ['run', 'expectExitCode', 'timeoutMs', 'cwd', 'captureStdout', 'stdoutRegex'],
        json_assert: ['file', 'assertions'],
        trace_matrix: ['requirementsFile', 'traceFile', 'enforce', 'testIdSource'],
        policy: ['policyId', 'expectedFiles'],
      },
    },
    loadLedgerIndex: () => loadLedgerIndex(root, evidenceDir),
    evidenceDir,
    ledgerIndexRel: `${evidenceDir}/ledger-index.json`.replace(/\/+/g, '/'),
    runId,
  };

  const { run: runnable, skipped } = filterGates(config.gates, { stage, ids: gateIds });
  const gateResults = [];
  const ledgerEntries = [];
  const notRun = [];
  let aborted = false;

  for (const gate of runnable) {
    if (aborted) {
      notRun.push(notRunEntry(gate, 'fail-fast: a previous required check blocked the run'));
      continue;
    }
    const checks = [];
    const blockers = [];
    for (const check of gate.checks) {
      let outcome;
      // Monotonic clock: wall-clock adjustments must not distort a check's cost.
      const checkStartedNs = process.hrtime.bigint();
      try {
        outcome = executeCheck(checkCtx, check);
      } catch (error) {
        if (error && error.code === 'PROVIDER_FAILED') {
          // A provider failure is an explicit, high-severity gate failure rather
          // than a crash: scripted providers must fail deterministically.
          outcome = {
            passed: false,
            message: `PROVIDER_FAILED: ${error.message}`,
            evidence: (error.details ?? []).length > 0
              ? error.details.map((d) => ({ path: checkCtx.configPath, kind: 'json_pointer', excerpt: `${d.jsonPointer} ${d.message}` }))
              : [{ path: checkCtx.configPath, kind: 'json_pointer', excerpt: `PROVIDER_FAILED: ${error.message}` }],
            detail: { providerFailure: true },
          };
        } else {
          throw error;
        }
      }
      const checkDurationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - checkStartedNs) / 1e6));
      const evidenceList = outcome.evidence;
      const checkResult = {
        id: check.id,
        type: check.type,
        passed: outcome.passed,
        severity: check.severity,
        evidence: evidenceList,
      };
      checks.push(checkResult);

      const required = check.required !== false;
      // required decides whether a failure blocks the gate; severity only decides how
      // the failure is presented/escalated. `onFail: "warn"` is the single explicit
      // opt-out channel. A failed required check must therefore always be reported as
      // a blocker — regardless of its severity — otherwise a `required: true` check
      // that omits `severity` (the default for `regex` is `medium`, §5.1) would be
      // silently passed.
      const blocked = outcome.passed === false && required && check.onFail !== 'warn';
      const blocking = blocked;
      if (blocking) {
        blockers.push({
          checkId: check.id,
          severity: check.severity,
          message: outcome.message ?? `${check.type} check failed`,
          evidence: evidenceList,
        });
      }
      ledgerEntries.push({
        gateId: gate.id,
        stage: gate.stage,
        checkId: check.id,
        type: check.type,
        required,
        passed: outcome.passed,
        severity: check.severity,
        durationMs: checkDurationMs,
        testId: checkTestIds[check.id] ?? null,
        evidence: evidenceList,
      });
      if (failFastEnabled && blocking) {
        aborted = true;
        break;
      }
    }

    let humanGate = null;
    if (gate.humanGate) {
      const evaluation = evaluateHumanGate(root, { ...gate, configPath: checkCtx.configPath });
      humanGate = {
        role: evaluation.role,
        approvalRecord: evaluation.approvalRecord,
        approvalState: evaluation.approvalState,
        approvedBy: evaluation.approvedBy,
        approvedAt: evaluation.approvedAt,
      };      if (evaluation.approvalState !== 'approved' && gate.required) {
        blockers.push(buildHumanGateBlocker({ ...gate, configPath: checkCtx.configPath }, evaluation));
      }
    }

    // Every entry in `blockers` is blocking by construction (see above), so the gate
    // verdict is simply "no blockers". severity is presentation/ordering only.
    const passed = blockers.length === 0;
    gateResults.push({
      id: gate.id,
      stage: gate.stage,
      required: gate.required,
      passed,
      humanGate,
      blockers,
      checks,
    });
  }

  for (const gate of skipped) notRun.push(notRunEntry(gate, 'excluded by the --stage/--gate filter'));

  gateResults.sort((a, b) => {
    const sa = stageOrder.indexOf(a.stage);
    const sb = stageOrder.indexOf(b.stage);
    if (sa !== sb) return sa - sb;
    return config.gates.findIndex((g) => g.id === a.id) - config.gates.findIndex((g) => g.id === b.id);
  });

  const finishedDate = clock();
  const finishedAt = rfc3339(finishedDate);
  const durationMs = Math.max(0, finishedDate.getTime() - startedMs);
  const overallPassed = gateResults.filter((g) => g.required).every((g) => g.passed);

  const runResult = {
    version: runResultSchemaVersion,
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    overall_passed: overallPassed,
    provider: providerDescriptor(provider),
    gates: gateResults,
  };

  const approvalsMissing = config.meta.approvalsMissing;
  const meta = {
    root,
    repoRoot: repoSide,
    configPath: checkCtx.configPath,
    configSha256: sha256(loaded.text),
    evidenceDir,
    ledgerRelPath: null,
    ledgerIndexRelPath: null,
    approvalsMissing,
    filtered: Boolean(stage || (gateIds && gateIds.length > 0)),
    stage,
    gateIds,
    notRun,
    skippedGateIds: notRun.map((entry) => entry.id),
    ledgerEntries,
  };

  if (writeLedger) {
    const ledger = {
      schemaVersion: '1.0',
      ledgerId: runId,
      runId,
      started_at: startedAt,
      finished_at: finishedAt,
      projectRoot: '.',
      configPath: checkCtx.configPath,
      configSha256: meta.configSha256.slice(0, 64),
      provider: runResult.provider,
      entries: ledgerEntries
        .slice()
        .sort((a, b) => (a.gateId < b.gateId ? -1 : a.gateId > b.gateId ? 1 : a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0)),
    };
    const written = appendLedger(root, evidenceDir, ledger, { runId });
    meta.ledgerRelPath = written.relPath;
    const index = updateLedgerIndex(root, evidenceDir, {
      runId,
      startedAt,
      overallPassed,
      ledgerRelPath: written.relPath,
      ledgerAbsPath: written.absPath,
      testIds: ledgerEntries.map((e) => e.testId).filter(Boolean),
      updatedAt: finishedAt,
    });
    meta.ledgerIndexRelPath = index.relPath;
  }

  return { runResult, meta };
}

export { ledgerRelPathOf };

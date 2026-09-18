// Provider abstraction (docs/01-architecture.md §5.1, §8.3, REQ-014).
//
// Four provider types are declared, but **no code path in this engine performs a
// network call**. `llm` and `external` degrade to the deterministic provider and
// set `provider.degraded = true`; the implementation never reads an API key.
//
// `scripted` providers replay recorded fixtures from a JSON file, matched by a
// normalised request fingerprint. A miss is a deterministic, explicit failure —
// never a network request (REQ-014).
import path from 'node:path';
import fs from 'node:fs';
import { providerError } from './errors.mjs';
import { sha256, fingerprint } from './util/hash.mjs';
import { severityRank } from './contract.mjs';

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
export const fixtureVersion = '1.0';
export const DEFAULT_FIXTURE_PATH = 'examples/fixtures/provider-recordings.json';

/**
 * The canonical request every `scripted` provider must be able to answer.
 *
 * `provider.findings()` is otherwise unreachable from the gate pipeline (the seven
 * frozen check types have no AI variant), which meant a fixture that could never
 * match anything still produced a green run. The engine now issues this one probe
 * per run, so "configured but not evaluable" is an explicit `PROVIDER_FAILED`
 * instead of silence.
 */
export const PROBE_REQUEST = Object.freeze({
  checkId: 'provider-probe',
  checkType: 'provider_probe',
  stage: 'verify',
  provider: 'scripted',
  files: [],
  prompt: 'qgate provider probe: confirm the recorded fixture is addressable offline.',
});

/** Fingerprint the probe request must be recorded under in the fixture. */
export function probeFingerprint() {
  return fingerprint(normalizeRequest(PROBE_REQUEST));
}

/** Keys stripped before fingerprinting so recorded fixtures survive noise changes. */
const NOISE_KEYS = Object.freeze(['run_id', 'runId', 'started_at', 'finished_at', 'duration_ms', 'timestamp', 'traceId']);

/** Normalise a request into the canonical, fingerprint-stable shape. */
export function normalizeRequest(request) {
  const stripped = {};
  for (const key of Object.keys(request ?? {}).sort()) {
    if (NOISE_KEYS.includes(key)) continue;
    stripped[key] = request[key];
  }
  return stripped;
}

/** Stable fingerprint of a request payload; fixtures are keyed by this value. */
export function requestFingerprint(request) {
  return fingerprint(normalizeRequest(request));
}

function loadFixtureFile(absPath) {
  let text;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw providerError(`provider fixture is not parseable JSON: ${absPath}`, {
      details: [{ jsonPointer: '', expected: 'valid JSON', actual: error.message, message: `fixture parse error: ${error.message}` }],
    });
  }
  const recordings = parsed.recordings ?? parsed.fixtures ?? parsed;
  if (!Array.isArray(recordings)) {
    throw providerError(`provider fixture must expose a "recordings" array: ${absPath}`, {
      details: [{ jsonPointer: '/recordings', expected: 'array<object>', actual: typeof recordings, message: 'fixture must contain recordings' }],
    });
  }
  const index = new Map();
  for (let i = 0; i < recordings.length; i += 1) {
    const rec = recordings[i];
    if (rec === null || typeof rec !== 'object') {
      throw providerError(`fixture recording[${i}] must be an object`, {
        details: [{ jsonPointer: `/recordings/${i}`, expected: 'object', actual: typeof rec, message: 'recording must be an object' }],
      });
    }
    const key = rec.fingerprint ?? rec.requestHash ?? (rec.request ? requestFingerprint(rec.request) : null);
    if (!key) {
      throw providerError(`fixture recording[${i}] has no fingerprint and no request to derive one from`, {
        details: [{ jsonPointer: `/recordings/${i}`, expected: 'fingerprint or request', actual: Object.keys(rec).join(','), message: 'recording cannot be addressed' }],
      });
    }
    index.set(key, rec);
  }
  return { recordings, index, path: absPath, sha256: sha256(text) };
}

/** Build a provider instance from the validated `provider` config block. */
export function createProvider(providerConfig, { root, resolveScript } = {}) {
  const type = providerConfig?.type ?? 'deterministic';
  const threshold = providerConfig?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const base = {
    type,
    requestedType: type,
    degraded: false,
    detail: 'offline-fixture',
    confidenceThreshold: threshold,
  };

  // An **explicitly configured** fixture must be addressable, whatever the provider
  // type. `provider.fixture` names the offline recording the run's evidence rests on;
  // silently ignoring an unreadable name would let a configuration claim a basis it
  // does not have (t43/F2: it used to exit 0 with `degraded:false`,
  // `detail:"offline-fixture"`). This mirrors the scripted provider's existing rule
  // ("a configured provider that cannot be evaluated must fail loudly") and is
  // deliberately independent of the type: the check runs before the type branches, so
  // an `llm`/`external` config that names a missing fixture also fails instead of
  // degrading quietly. Recorded findings still live in the fixture; this asserts
  // addressability, not a replay.
  const declaredFixtureRel = typeof providerConfig?.fixture === 'string' && providerConfig.fixture.length > 0
    ? providerConfig.fixture
    : null;
  const declaredFixture = declaredFixtureRel === null
    ? null
    : loadFixtureFile(path.join(root, declaredFixtureRel.split('/').join(path.sep)));
  if (declaredFixtureRel !== null && (declaredFixture === null || declaredFixture.recordings.length === 0)) {
    const notFound = declaredFixture === null;
    throw providerError(
      notFound
        ? `provider fixture not found or unreadable: ${declaredFixtureRel}`
        : `provider fixture contains no recordings: ${declaredFixtureRel}`,
      {
        details: [
          {
            jsonPointer: '/provider/fixture',
            expected: 'readable recording file with at least one recording',
            actual: notFound ? 'not found or unreadable' : 'recordings: []',
            message: notFound
              ? `the configured provider.fixture does not exist (or is unreadable): ${declaredFixtureRel}`
              : `the configured provider.fixture contains no recordings: ${declaredFixtureRel}`,
          },
        ],
      },
    );
  }

  if (type === 'scripted') {
    const scriptPath = providerConfig.script;
    const absScript = resolveScript ? resolveScript(scriptPath) : path.join(root, scriptPath.split('/').join(path.sep));
    if (!fs.existsSync(absScript)) {
      throw providerError(`provider script not found: ${scriptPath}`, {
        details: [{ jsonPointer: '/provider/script', expected: 'existing module', actual: scriptPath, message: `scripted provider module does not exist: ${scriptPath}` }],
      });
    }
    const fixtureRel = declaredFixtureRel ?? DEFAULT_FIXTURE_PATH;
    const fixture = declaredFixture ?? loadFixtureFile(path.join(root, fixtureRel.split('/').join(path.sep)));
    // A configured provider that cannot be evaluated must fail loudly instead of
    // silently contributing nothing: a missing/unreadable/empty fixture would
    // otherwise make every run pass with zero recorded findings.
    if (!fixture) {
      throw providerError(`provider fixture not found: ${fixtureRel}`, {
        details: [{ jsonPointer: '/provider/fixture', expected: 'readable recording file', actual: fixtureRel, message: `scripted provider fixture does not exist: ${fixtureRel}` }],
      });
    }
    if (fixture.recordings.length === 0) {
      throw providerError(`provider fixture contains no recordings: ${fixtureRel}`, {
        details: [{ jsonPointer: '/provider/fixture', expected: 'at least one recording', actual: 'recordings: []', message: `scripted provider fixture is empty: ${fixtureRel}` }],
      });
    }
    if (!fixture.index.has(probeFingerprint())) {
      throw providerError(`provider fixture has no recording for the qgate provider probe (${fixtureRel})`, {
        details: [
          {
            jsonPointer: '/provider/fixture',
            expected: `a recording whose fingerprint is ${probeFingerprint()}`,
            actual: `recordings=${fixture.recordings.length}`,
            message: 'the scripted provider cannot be exercised: regenerate the fixture with scripts/record-fixtures.mjs so it contains the provider probe recording',
          },
        ],
      });
    }
    return {
      ...base,
      type: 'scripted',
      detail: `scripted:${fixtureRel}`,
      scriptPath: absScript,
      scriptRel: scriptPath,
      fixture,
      fixturePath: fixtureRel,
      probeMatches: true,
      async findings(request) {
        const normalized = normalizeRequest(request);
        const key = fingerprint(normalized);
        const recorded = fixture.index.get(key) ?? null;
        if (!recorded) {
          return {
            ok: false,
            matched: false,
            fingerprint: key,
            findings: [],
            error: {
              code: 'PROVIDER_FAILED',
              message: `no recorded fixture matches request fingerprint ${key}`,
            },
          };
        }
        const recordedFindings = Array.isArray(recorded.findings) ? recorded.findings : [];
        const { pathToFileURL } = await import('node:url');
        let mod;
        try {
          mod = await import(pathToFileURL(absScript).href);
        } catch (error) {
          throw providerError(`provider script could not be imported: ${scriptPath} (${error.message})`, {
            details: [{ jsonPointer: '/provider/script', expected: 'importable module', actual: error.message, message: `module ${scriptPath} failed to load` }],
          });
        }
        if (typeof mod.run !== 'function') {
          throw providerError(`provider script must export run(context): ${scriptPath}`, {
            details: [{ jsonPointer: '/provider/script', expected: 'export function run(context)', actual: Object.keys(mod).join(',') || '<none>', message: `module ${scriptPath} does not export run()` }],
          });
        }
        let scripted;
        try {
          scripted = await mod.run({ ...normalized, recorded: recorded.response ?? null });
        } catch (error) {
          // A provider that throws is a provider failure (§6.5 PROVIDER_FAILED), not an
          // unclassified internal error.
          throw providerError(`provider script threw while handling request ${key}: ${error.message}`, {
            details: [{ jsonPointer: '/provider/script', expected: 'run(context) returns findings', actual: error.message, message: `module ${scriptPath} threw` }],
          });
        }
        // The recording is the source of truth for a matched request; a script that
        // returns its own findings is only used when the recording carries none.
        const merged = recordedFindings.length > 0
          ? recordedFindings
          : Array.isArray(scripted)
            ? scripted
            : [];
        return { ok: true, matched: true, fingerprint: key, findings: merged, recorded };
      },
    };
  }

  if (type === 'llm' || type === 'external') {
    const reason = type === 'llm'
      ? 'llm provider is not available offline; degraded to deterministic'
      : 'external CLI provider is not available offline; degraded to deterministic';
    return {
      ...base,
      type: 'deterministic',
      requestedType: type,
      degraded: true,
      detail: `${reason}`,
      async findings() {
        return { ok: true, matched: true, fingerprint: null, findings: [] };
      },
    };
  }

  // deterministic (default) and the degradation target of llm/external
  return {
    ...base,
    type: 'deterministic',
    detail: 'offline-fixture',
    async findings(request) {
      return { ok: true, matched: true, fingerprint: requestFingerprint(request), findings: [] };
    },
  };
}

/**
 * Severity/confidence gating (REQ-013): a finding may only become a blocker when
 * `confidence >= threshold` AND `severity in {high, blocker}`. Everything else is
 * downgraded to a finding with an explicit, machine-readable reason.
 */
export function classifyFindings(findings, { confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD } = {}) {
  const blockers = [];
  const downgraded = [];
  for (const finding of findings ?? []) {
    if (finding === null || typeof finding !== 'object') continue;
    const confidence = typeof finding.confidence === 'number' ? finding.confidence : 0;
    const severity = typeof finding.severity === 'string' ? finding.severity : 'low';
    const highEnough = severityRank[severity] >= severityRank.high;
    const confidentEnough = confidence >= confidenceThreshold;
    const entry = {
      id: finding.id ?? null,
      severity,
      confidence,
      message: finding.message ?? '',
      file: finding.file ?? null,
      line: typeof finding.line === 'number' ? finding.line : null,
      source: finding.source ?? 'provider',
    };
    if (highEnough && confidentEnough) {
      blockers.push({ ...entry, promoted: true });
    } else {
      downgraded.push({
        ...entry,
        promoted: false,
        downgradeReason: confidentEnough ? 'severity_below_high' : 'confidence_below_threshold',
      });
    }
  }
  return { blockers, findings: downgraded, threshold: confidenceThreshold };
}

export function providerDescriptor(provider) {
  return { type: provider.type, degraded: provider.degraded, detail: provider.detail };
}

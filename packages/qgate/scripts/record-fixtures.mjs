#!/usr/bin/env node
// Records the offline scripted-provider fixture for REQ-QUALITY-GATE-014.
//
// A "recording" is a normalised request fingerprint mapped to the findings the
// provider replayed for that request when the fixture was captured. The engine
// never calls a model or the network: a request without a matching recording is a
// deterministic failure.
//
// Usage (from the repository root):
//   node packages/qgate/scripts/record-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestFingerprint, normalizeRequest, fixtureVersion, DEFAULT_CONFIDENCE_THRESHOLD, PROBE_REQUEST, probeFingerprint } from '../src/provider.mjs';
import { stringifyJson } from '../src/util/fsx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'examples', 'fixtures', 'provider-recordings.json');

/** The two requests the fixture covers. Both are pure data — no model, no network. */
const REQUESTS = [
  {
    scenario: 'gate-review',
    request: {
      checkId: 'review-findings',
      checkType: 'ai_review',
      stage: 'review',
      provider: 'scripted',
      ruleSet: 'builtin:demo',
      files: ['packages/qgate/src/pipeline.mjs', 'packages/qgate/src/checks/regex.mjs'],
      prompt: 'List contract violations for the frozen RunResult schema.',
      threshold: DEFAULT_CONFIDENCE_THRESHOLD,
    },
    findings: [
      {
        id: 'F-REVIEW-1',
        severity: 'high',
        confidence: 0.86,
        source: 'scripted-fixture',
        file: 'packages/qgate/src/pipeline.mjs',
        line: 12,
        message: 'stage ordering relies on the configuration order; assert it against the frozen enum instead.',
      },
      {
        id: 'F-REVIEW-2',
        severity: 'medium',
        confidence: 0.92,
        source: 'scripted-fixture',
        file: 'packages/qgate/src/checks/regex.mjs',
        line: 60,
        message: 'the `all` mode could early-exit once a file fails to match.',
      },
      {
        id: 'F-REVIEW-3',
        severity: 'low',
        confidence: 0.41,
        source: 'scripted-fixture',
        file: 'packages/qgate/src/checks/regex.mjs',
        line: 1,
        message: 'header comment could name the frozen field table.',
      },
    ],
  },
  {
    scenario: 'gate-build-smell',
    request: {
      checkId: 'build-smell',
      checkType: 'ai_review',
      stage: 'build',
      provider: 'scripted',
      ruleSet: 'builtin:demo',
      files: ['packages/qgate/package.json'],
      prompt: 'Report anything that would break the zero-dependency guarantee.',
      threshold: DEFAULT_CONFIDENCE_THRESHOLD,
    },
    findings: [
      {
        id: 'F-BUILD-1',
        severity: 'blocker',
        confidence: 0.99,
        source: 'scripted-fixture',
        file: 'packages/qgate/package.json',
        line: 1,
        message: 'a runtime dependency was declared; the zero-dependency guarantee is broken.',
      },
    ],
  },
];

const recordings = REQUESTS.map((entry) => {
  const normalized = normalizeRequest(entry.request);
  return {
    scenario: entry.scenario,
    request: normalized,
    fingerprint: requestFingerprint(normalized),
    findings: entry.findings,
    response: {
      model: 'offline-recording',
      capturedAt: '2026-05-05T10:00:00Z',
      tokens: { prompt: 512, completion: 128 },
    },
  };
});

// The engine probes every scripted provider once per run (see PROBE_REQUEST), so a
// usable fixture must contain that recording. Recording it here keeps the shipped
// fixture complete without hand-editing.
recordings.push({
  scenario: 'engine-provider-probe',
  request: PROBE_REQUEST,
  fingerprint: probeFingerprint(),
  findings: [],
  response: {
    model: 'offline-recording',
    capturedAt: '2026-05-05T10:00:00Z',
    tokens: { prompt: 0, completion: 0 },
  },
});

const document = {
  schemaVersion: '1.0',
  fixtureVersion,
  recorded_by: 'qgate scripts/record-fixtures.mjs',
  recorded_at: '2026-05-05T10:00:00Z',
  note: 'Offline provider recordings. No model call, no network access, no API key is involved in replaying or matching these entries.',
  matching: {
    algorithm: 'sha256(canonicalJson(normalised request)).slice(0,16)',
    noiseKeysStripped: ['run_id', 'runId', 'started_at', 'finished_at', 'duration_ms', 'timestamp', 'traceId'],
    onMiss: 'deterministic failure: PROVIDER_FAILED, never a network request',
  },
  providerProbe: {
    fingerprint: probeFingerprint(),
    note: 'Every scripted fixture must contain this recording; the engine probes the provider once per run so that a non-evaluable provider fails explicitly instead of passing silently.',
  },
  confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
  recordings,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, stringifyJson(document));
process.stdout.write(`wrote ${path.relative(path.join(HERE, '..'), OUT)} with ${recordings.length} recording(s)\n`);

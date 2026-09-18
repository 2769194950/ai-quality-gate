// t34 hardening regressions:
//   1. H8 — coverage may no longer be certified by append-only ledger history once the
//      check that carries the testId is gone from the *current* configuration
//   2. R2-H4 — unknown keys inside provider/policy/selection/grouping are rejected
//   3. the comment/prose boundary — comment syntax is skipped, code (including a string
//      literal that spells a read) is not
//   4. SAFE_001 matches case variants of sensitive names (Windows env names are
//      case-insensitive, so the spellings read the same secret)
//   5. SAFE_003 detects the four bypass spellings reported in review-round2
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_CONFIG, DEMO_ROOT, REPO_ROOT, VALID_CONFIG, runCli, runCliJson, tmpDir, copyTree, writeJson, writeText, readJson, cleanup } from './helpers.mjs';
import { policySafe001, policySafe003, stripComments } from '../src/policy.mjs';
import { runResultKeys } from '../src/contract.mjs';
import { sensitiveNameRule } from '../src/selection.mjs';

/** Run one policy over a throwaway single-file "repository". */
function policyOn(fn, body) {
  const dir = tmpDir('qgate-policy-');
  try {
    writeText(path.join(dir, 'sample.mjs'), `${body}\n`);
    return fn(dir);
  } finally {
    cleanup(dir);
  }
}

test('T-QG-006 H8: a deleted carrying check cannot be certified by append-only history', async () => {
  // The shipped demo project is copied *with its evidence history*, so the ledger index
  // still records T-QG-003 after the check that produces it (`req-index-valid`) is
  // deleted from the configuration — the "delete a check to dodge the gate" scenario.
  //
  // Deliberate scope of rule 6 (captain ruling on t34 R3): it only fires for a testId
  // the frozen check→testId mapping can carry. A testId with no mapping entry belongs to
  // a project that names its own tests (e.g. `packages/qgate/examples/valid/five-stage.json`
  // declares T-DEMO-001/002); demanding a qgate check for it would turn every such
  // synthetic configuration red without closing anything — an unmapped testId can never
  // appear in the ledger either (the ledger's testIds come from that same mapping), so its
  // coverage consequences are already rule 4/5's job. Do not "tighten" this into an error:
  // it re-breaks legal configurations and buys no extra protection.
  const root = tmpDir('qgate-h8-');
  try {
    copyTree(DEMO_ROOT, path.join(root, 'mini-service'));
    const config = readJson(DEMO_CONFIG);
    writeJson(path.join(root, 'qgate.config.json'), config);

    const control = await runCliJson(['check', '--config', 'qgate.config.json', '--json'], { cwd: root });
    assert.equal(control.status, 0, `control (history + intact carrier) must stay green: ${control.stderr}`);

    const ledgerIndex = readJson(path.join(root, 'mini-service', '.qgate', 'evidence', 'ledger-index.json'));
    assert.ok(ledgerIndex.testIds.includes('T-QG-003'), 'the append-only history records the testId whose check is deleted next');

    const tampered = JSON.parse(JSON.stringify(config));
    for (const gate of tampered.gates) gate.checks = gate.checks.filter((check) => check.id !== 'req-index-valid');
    writeJson(path.join(root, 'qgate.config.json'), tampered);

    const result = await runCliJson(['check', '--config', 'qgate.config.json', '--json'], { cwd: root, strict: false });
    assert.equal(result.status, 1, 'deleting the carrying check must fail the gate even with history present');
    assert.equal(result.json.overall_passed, false);
    const blockers = result.json.gates.flatMap((gate) => gate.blockers ?? []);
    assert.ok(
      blockers.some((blocker) => blocker.checkId === 'trace-complete' && /historical evidence/.test(blocker.message) && /req-index-valid/.test(blocker.message)),
      `expected a TRACE_GAP naming the missing carrying check, got: ${JSON.stringify(blockers)}`,
    );
  } finally {
    cleanup(root);
  }
});

test('T-QG-002 R2-H4: unknown keys inside provider/policy/selection/grouping exit 2 CONFIG_INVALID', async () => {
  const root = tmpDir('qgate-unknown-');
  try {
    const base = readJson(VALID_CONFIG);
    const cases = [
      ['provider', 'unknownProviderKey'],
      ['policy', 'unknownPolicyKey'],
      ['selection', 'unknownSelectionKey'],
      ['grouping', 'unknownGroupingKey'],
    ];
    for (const [block, key] of cases) {
      const doc = JSON.parse(JSON.stringify(base));
      doc[block] = { ...(doc[block] ?? {}), [key]: 1 };
      const configPath = path.join(root, `${block}.json`);
      writeJson(configPath, doc);
      const result = await runCliJson(['check', '--config', configPath, '--json']);
      assert.equal(result.status, 2, `${block}: must exit 2 (${result.stderr})`);
      assert.equal(result.json.error.code, 'CONFIG_INVALID', block);
      const pointer = `/${block}/${key}`;
      assert.ok(
        result.json.error.details.some((detail) => detail.jsonPointer === pointer),
        `${block}: expected a detail at ${pointer}, got ${JSON.stringify(result.json.error.details)}`,
      );
    }
  } finally {
    cleanup(root);
  }
});

test('T-QG-012 comment syntax is prose: examples in comments are skipped, code is not', () => {
  // Offsets must survive blanking so a violation still reports the real source line.
  const text = 'a\n// comment\n/* multi\nline */\nb\n';
  const stripped = stripComments(text);
  assert.equal(stripped.length, text.length, 'comment blanking preserves byte offsets');
  assert.equal(stripped.split('\n').length, text.split('\n').length, 'comment blanking preserves line breaks');
  assert.ok(!stripped.includes('comment') && !stripped.includes('multi'), 'comment bodies are blanked');

  // Commented examples are no longer violations (the t34 ruling).
  assert.equal(policyOn(policySafe001, '// process.env.ANTHROPIC_API_KEY is never read here').passed, true);
  assert.equal(policyOn(policySafe001, '/* vault.API_KEY and process.env.X_API_KEY are forbidden */').passed, true);
  assert.equal(policyOn(policySafe003, '// fetch(url) is never called').passed, true);
  assert.equal(policyOn(policySafe003, '/* http.request and net.createServer are forbidden */').passed, true);

  // ...while non-comment code keeps exactly the previous strength: a string literal is
  // not a comment, so a read spelled inside one is still a violation.
  assert.equal(policyOn(policySafe001, 'const s = "process.env.X_API_KEY";').passed, false);
  assert.equal(policyOn(policySafe001, 'const k = process.env.SECRET_TOKEN; // documented').passed, false);
  assert.equal(policyOn(policySafe003, 'const r = await fetch(url);').passed, false);

  // A `//` inside a string is not a comment; a regex literal is not a comment either.
  assert.equal(policyOn(policySafe001, 'const u = "https://example.invalid";').passed, true);
  assert.equal(policyOn(policySafe003, 'const re = /https?|net|dgram/\\.test(line);').passed, true);
});

test('T-QG-012 SAFE_001 matches case variants of a sensitive name', () => {
  for (const body of [
    'const k = process.env.anthropic_api_key;',
    'const k = process.env.Anthropic_Api_Key;',
    "const k = process.env['openai_api_key'];",
    'const k = process.env.ANTHROPIC_API_KEY;',
    'const k = os.environ["my_secret"];',
  ]) {
    assert.equal(policyOn(policySafe001, body).passed, false, `must be detected: ${body}`);
  }
  for (const body of [
    'const p = process.env.PATH;',
    'const apiKey = 1;',
    'const c = { apiKey: 1 };',
    'const n = "ANTHROPIC_API_KEY";',
  ]) {
    assert.equal(policyOn(policySafe001, body).passed, true, `must stay clean: ${body}`);
  }
});

test('T-QG-003 SAFE_003 detects the four reported bypass spellings', () => {
  const mustDetect = [
    "const m = await import('node:https');",
    "import * as h from 'node:http';\nconst r = h.request(opts);",
    "const r = await globalThis['fe' + 'tch'](url);",
    'const r = await client.get(url);',
    'const r = await axios.get(url);',
    'const f = fetch;\nconst r = await f(url);',
    "const h = require('node:https');\nconst r = h.get(url);",
  ];
  for (const body of mustDetect) {
    const outcome = policyOn(policySafe003, body);
    assert.equal(outcome.passed, false, `must be detected: ${body.replace(/\n/g, ' ⏎ ')}`);
  }
  const mustStayClean = [
    'const v = cache.get(key);',
    "const v = headers.get('x');",
    'const m = new Map();',
  ];
  for (const body of mustStayClean) {
    assert.equal(policyOn(policySafe003, body).passed, true, `must stay clean: ${body}`);
  }
});

test('T-QG-012 the shipped matchers report nothing on this repository', () => {
  // The demo's SAFE_001/SAFE_003 checks scan the repository implementation surface, so
  // this is the invariant that keeps the demo green. A stray file that really reads a
  // key or opens a network surface fails here on purpose (not only in `check`).
  for (const [name, fn] of [['SAFE_001', policySafe001], ['SAFE_003', policySafe003]]) {
    const outcome = fn(REPO_ROOT, {});
    assert.ok(outcome.scannedFiles > 50, `${name} must scan the repository surface (scanned ${outcome.scannedFiles})`);
    assert.deepEqual(outcome.violations.map((v) => `${v.pointer} ${v.message}`), [], `${name} violations on the shipped tree`);
  }
});

/** The `trace-complete` check's coverage-basis evidence excerpts (machine-readable). */
function coverageBasis(document) {
  const check = document.gates.flatMap((gate) => gate.checks).find((candidate) => candidate.id === 'trace-complete');
  return (check?.evidence ?? [])
    .map((ref) => ref.excerpt ?? '')
    .filter((excerpt) => excerpt.includes('testIdSource='))
    .join(' | ');
}

test('T-QG-006 R1: a missing ledger basis is fail-closed, and trace-only must be explicit', async () => {
  const root = tmpDir('qgate-r1-');
  try {
    copyTree(DEMO_ROOT, path.join(root, 'mini-service'));
    const config = readJson(DEMO_CONFIG);
    writeJson(path.join(root, 'qgate.config.json'), config);
    const evidenceDir = path.join(root, 'mini-service', '.qgate', 'evidence');
    const indexPath = path.join(evidenceDir, 'ledger-index.json');
    const shippedIndex = fs.readFileSync(indexPath, 'utf8');

    // (A) ledger evidence complete + every check intact => green, basis named.
    const a = await runCliJson(['check', '--config', 'qgate.config.json', '--json'], { cwd: root });
    assert.equal(a.status, 0, a.stderr);
    assert.match(coverageBasis(a.json), /testIdSource=ledger-index/);

    // (R1) evidence emptied (runIds/ledgers/testIds = [], ledger-*.json gone) with every
    // check still intact: the basis is absent, which must never read as "nothing found".
    // Before t39 this fell back to the trace document and exited 0 (self-certification).
    writeJson(indexPath, {
      schemaVersion: '1.0',
      updated_at: '1970-01-01T00:00:00.000Z',
      runIds: [],
      ledgers: [],
      testIds: [],
    });
    for (const name of fs.readdirSync(evidenceDir)) {
      if (name.startsWith('ledger-') && name !== 'ledger-index.json') fs.rmSync(path.join(evidenceDir, name));
    }
    const r1 = await runCliJson(['check', '--config', 'qgate.config.json', '--json'], { cwd: root, strict: false });
    assert.equal(r1.status, 1, 'an empty coverage basis must not fall back to the trace document');
    assert.equal(r1.json.overall_passed, false);
    const blockers = r1.json.gates.flatMap((gate) => gate.blockers ?? []);
    assert.ok(
      blockers.some((blocker) => /coverage basis missing \/ not evaluated/.test(String(blocker.message))),
      `expected the fail-closed TRACE_GAP, got: ${JSON.stringify(blockers)}`,
    );
    assert.match(coverageBasis(r1.json), /coverage basis missing \/ not evaluated/);

    // (B) the same empty ledger is allowed when - and only when - the configuration opts
    // in explicitly, and the verdict then says so in machine-readable form.
    const traceOnly = JSON.parse(JSON.stringify(config));
    for (const gate of traceOnly.gates) {
      for (const check of gate.checks) if (check.type === 'trace_matrix') check.testIdSource = 'trace-only';
    }
    writeJson(path.join(root, 'qgate.config.json'), traceOnly);
    const b = await runCliJson(['check', '--config', 'qgate.config.json', '--json'], { cwd: root });
    assert.equal(b.status, 0, b.stderr);
    assert.equal(b.json.overall_passed, true);
    assert.match(coverageBasis(b.json), /testIdSource=trace-only/, 'the trace-only basis must be marked in the evidence');

    fs.writeFileSync(indexPath, shippedIndex);
  } finally {
    cleanup(root);
  }
});

test('T-QG-015 the `--summary` envelope carries not_run_gates and agrees with the human lines', async () => {
  // §5.2.1: un-run gates are listed as `not_run_gates: [{id, stage, reason}]` in the
  // `--summary` envelope and never in the RunResult. The structure is what lets CI tell
  // "this gate did not run" from "this gate ran and passed"; the human lines stay.
  const root = tmpDir('qgate-notrun-');
  try {
    copyTree(DEMO_ROOT, path.join(root, 'mini-service'));
    writeJson(path.join(root, 'qgate.config.json'), readJson(DEMO_CONFIG));
    const expected = {
      requirements: ['interface-frozen', 'build-deterministic', 'review-counterexample', 'verify-coverage'],
      design: ['build-deterministic', 'review-counterexample', 'verify-coverage'],
      build: ['review-counterexample', 'verify-coverage'],
      review: ['verify-coverage'],
    };
    for (const [stage, notRunIds] of Object.entries(expected)) {
      const base = ['check', '--config', 'qgate.config.json', '--stage', stage];
      const envelopePath = path.join(root, `envelope-${stage}.json`);
      const envelopeRun = await runCli([...base, '--summary', '--out', envelopePath], { cwd: root });
      assert.equal(envelopeRun.status, 0, envelopeRun.stderr);
      const envelope = readJson(envelopePath);
      assert.ok(Array.isArray(envelope.not_run_gates), `${stage}: not_run_gates must be an array`);
      assert.deepEqual(envelope.not_run_gates.map((entry) => entry.id), notRunIds, `${stage}: un-run gate ids`);
      for (const entry of envelope.not_run_gates) {
        assert.deepEqual(Object.keys(entry).sort(), ['id', 'reason', 'stage'], `${stage}: entry shape`);
        assert.ok(typeof entry.stage === 'string' && entry.stage.length > 0);
        assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0);
      }

      // The human-readable lines are kept and say exactly the same thing.
      const textRun = await runCli([...base, '--summary'], { cwd: root });
      assert.equal(textRun.status, 0, textRun.stderr);
      const humanLines = textRun.stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('not-run'));
      assert.deepEqual(
        humanLines,
        envelope.not_run_gates.map((entry) => `not-run ${entry.stage}/${entry.id}: ${entry.reason}`),
        `${stage}: the human lines and the structure must agree`,
      );

      // ...and the structure never leaks into the RunResult (§5.2 key set is frozen).
      const jsonRun = await runCliJson([...base, '--json'], { cwd: root });
      assert.deepEqual(Object.keys(jsonRun.json).sort(), [...runResultKeys].sort(), `${stage}: RunResult key set`);
      assert.ok(!Object.prototype.hasOwnProperty.call(jsonRun.json, 'not_run_gates'), `${stage}: not_run_gates belongs to --summary, not to RunResult`);
    }
  } finally {
    cleanup(root);
  }
});

test('T-QG-014 F2: an explicitly configured provider.fixture must be addressable', async () => {
  // Before t43 a `provider.fixture` naming a missing file was silently ignored: the run
  // exited 0 with `provider={degraded:false, detail:"offline-fixture"}`, i.e. a
  // configuration could claim an evidence basis it did not have. A configured provider
  // that cannot be evaluated is a provider failure — the same rule the scripted
  // provider already applied to a missing module/fixture.
  const root = tmpDir('qgate-fixture-');
  try {
    writeText(path.join(root, 'present.txt'), 'x\n');
    const configPath = path.join(root, 'qgate.config.json');
    const base = {
      version: '1.0',
      provider: { type: 'deterministic', fixture: 'fixtures/missing.json' },
      gates: [{ id: 'smoke', stage: 'build', required: true, checks: [{ id: 'present-file', type: 'file_exists', file: 'present.txt', required: true }] }],
    };
    writeJson(configPath, base);

    const missing = await runCliJson(['check', '--config', configPath, '--json'], { cwd: root, strict: false });
    assert.equal(missing.status, 3, 'a configured but missing fixture must fail the provider, not pass silently');
    assert.equal(missing.json.error.code, 'PROVIDER_FAILED');
    assert.match(String(missing.json.error.message), /fixture/);
    assert.ok(!Object.prototype.hasOwnProperty.call(missing.json, 'overall_passed'), 'no RunResult is produced');

    // An existing fixture with zero recordings fails the same way.
    writeJson(path.join(root, 'fixtures', 'empty.json'), { schemaVersion: '1.0', recordings: [] });
    writeJson(configPath, { ...base, provider: { type: 'deterministic', fixture: 'fixtures/empty.json' } });
    const empty = await runCliJson(['check', '--config', configPath, '--json'], { cwd: root, strict: false });
    assert.equal(empty.status, 3);
    assert.equal(empty.json.error.code, 'PROVIDER_FAILED');

    // Controls: a usable fixture, and no `fixture` key at all, still run normally.
    writeJson(path.join(root, 'fixtures', 'valid.json'), readJson(path.join(REPO_ROOT, 'packages/qgate/examples/fixtures/provider-recordings.json')));
    writeJson(configPath, { ...base, provider: { type: 'deterministic', fixture: 'fixtures/valid.json' } });
    const valid = await runCliJson(['check', '--config', configPath, '--json'], { cwd: root });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.json.provider.degraded, false);
    assert.equal(valid.json.overall_passed, true);

    writeJson(configPath, { ...base, provider: { type: 'deterministic' } });
    const none = await runCliJson(['check', '--config', configPath, '--json'], { cwd: root });
    assert.equal(none.status, 0, none.stderr);
  } finally {
    cleanup(root);
  }
});

test('T-QG-012 R3-H2: an unterminated /* must not blind the rest of the file', () => {
  // Before t46 an unterminated `/*` blanked everything after it, so a legitimate YAML
  // scalar (`path: /*/build`) silently disabled SAFE_001/003 for the whole file.
  assert.equal(policyOn(policySafe001, 'path: /*/build\nconst k = process.env.ANTHROPIC_API_KEY;\n').passed, false, 'key read after /*');
  assert.equal(policyOn(policySafe003, 'path: /*/build\nconst r = await fetch(url);\n').passed, false, 'network call after /*');
  assert.equal(policyOn(policySafe001, 'note: /* open\nconst c = vault.API_KEY;\n').passed, false, 'vault reference after /*');
  assert.equal(policyOn(policySafe001, '{"note": "/* open"}\nconst k = process.env.ANTHROPIC_API_KEY;\n').passed, false, 'unterminated /* inside JSON');

  // The t34 boundary still holds: a *closed* block comment is prose and stays clean.
  assert.equal(policyOn(policySafe001, '/* example process.env.ANTHROPIC_API_KEY */\n').passed, true, 'closed comment stays clean');
  assert.equal(policyOn(policySafe001, '/* line1\nprocess.env.SECRET_TOKEN\n*/\n').passed, true, 'multi-line closed comment stays clean');

  // Same-line sibling: `://` is data, not the start of a line comment.
  assert.equal(policyOn(policySafe001, 'url: https://example.invalid const k = process.env.ANTHROPIC_API_KEY;\n').passed, false, 'read after :// on the same line');

  // Blanking still preserves offsets and line breaks.
  const text = 'path: /*/build\nconst k = process.env.ANTHROPIC_API_KEY;\n';
  const stripped = stripComments(text);
  assert.equal(stripped.length, text.length, 'byte offsets preserved');
  assert.equal(stripped.split('\n').length, text.split('\n').length, 'line breaks preserved');
  assert.ok(stripped.includes('process.env.ANTHROPIC_API_KEY'), 'the read stays visible to the matchers');
});

test('T-QG-012 R3-H1: a hard link to a sensitive file is excluded in both engine paths', async () => {
  const root = tmpDir('qgate-hardlink-');
  try {
    writeText(path.join(root, '.env'), 'ANTHROPIC_API_KEY=sk-ant-ENGINE-ALIAS\n');
    writeText(path.join(root, 'credentials.json'), '{"token":"OPAQUE_SECRET_MATERIAL_A1B2C3"}\n');
    writeText(path.join(root, 'secrets', 'db.txt'), 'PASSWORD=OPAQUE_MATERIAL_D4E5F6\n');
    for (const [target, alias] of [['.env', 'notes.txt'], ['credentials.json', 'handbook.txt'], ['secrets/db.txt', 'guide.txt']]) {
      fs.linkSync(path.join(root, target.split('/').join(path.sep)), path.join(root, alias));
    }
    // negative control: a hard-linked pair of *neutral* files stays selected
    // (same semantics as the adapter's D09 case)
    writeText(path.join(root, 'plain.txt'), 'neutral everyday content\n');
    fs.linkSync(path.join(root, 'plain.txt'), path.join(root, 'copy.txt'));
    writeText(path.join(root, 'src', 'app.mjs'), 'export const x = 1;\n');

    const configPath = path.join(root, 'qgate.config.json');
    writeJson(configPath, {
      version: '1.0',
      provider: { type: 'deterministic' },
      selection: { include: ['**/*'], extensions: ['.mjs', '.txt', '.json', '.env', ''], defaultExcludedPaths: [] },
      gates: [
        { id: 'secret-invariant', stage: 'build', required: true, checks: [{ id: 'no-secret-paths', type: 'policy', policyId: 'SAFE_002', onFail: 'fail' }] },
      ],
    });
    const aliases = ['notes.txt', 'handbook.txt', 'guide.txt'];

    // path 1 — `preview` selection
    const preview = await runCliJson(['preview', '--config', configPath, '--json'], { cwd: root });
    assert.equal(preview.status, 0, preview.stderr);
    for (const alias of aliases) {
      assert.ok(!preview.json.selection.included.includes(alias), `${alias} must not be selected`);
      const entry = preview.json.selection.excluded.find((candidate) => candidate.path === alias);
      assert.ok(entry, `${alias} must be reported as excluded`);
      assert.equal(entry.reason, 'secret_path');
      assert.match(entry.rule, /^alias:secret-(env|credentials|dir):same-(inode|content)-as-sensitive-path$/, `${alias}: ${entry.rule}`);
    }
    assert.deepEqual(preview.json.invariants.secretPathsSelected, [], 'the safety invariant must be truthful');
    assert.ok(preview.json.selection.included.includes('plain.txt'), 'neutral hard link stays selected');
    assert.ok(preview.json.selection.included.includes('copy.txt'), 'its neutral partner stays selected');

    // path 2 — `check` (the SAFE_002 policy scan) must agree, and its metrics must show
    // that the aliases really were excluded (3 by name + 3 aliases).
    const check = await runCliJson(['check', '--config', configPath, '--json'], { cwd: root });
    assert.equal(check.status, 0, check.stderr);
    const safe002 = check.json.gates.flatMap((gate) => gate.checks).find((candidate) => candidate.id === 'no-secret-paths');
    assert.equal(safe002.passed, true);
    const metrics = (safe002.evidence ?? []).map((ref) => ref.excerpt ?? '').find((excerpt) => excerpt.includes('SAFE_002 metrics=')) ?? '';
    assert.match(metrics, /"secretPathsExcluded":6/, `3 by name + 3 aliases must be excluded: ${metrics.slice(0, 160)}`);
  } finally {
    cleanup(root);
  }
});

/** Build a case-variant tree; `files` are repo-relative POSIX paths. */
function buildCaseTree(files) {
  const root = tmpDir('qgate-case-');
  for (const rel of files) writeText(path.join(root, rel.split('/').join(path.sep)), 'ANTHROPIC_API_KEY=sk-ant-CASE\n');
  writeText(path.join(root, 'src', 'app.mjs'), 'export const x = 1;\n');
  writeJson(path.join(root, 'qgate.config.json'), {
    version: '1.0',
    provider: { type: 'deterministic' },
    selection: { include: ['**/*'], extensions: ['.mjs', '.json', '.txt', '.env', '.pem'] },
    gates: [
      { id: 'secret-invariant', stage: 'build', required: true, checks: [{ id: 'no-secret-paths', type: 'policy', policyId: 'SAFE_002', onFail: 'fail' }] },
    ],
  });
  return root;
}

/** Run both engine paths over a case tree and return what each reported. */
async function auditCaseTree(root) {
  const preview = await runCliJson(['preview', '--config', path.join(root, 'qgate.config.json'), '--json'], { cwd: root });
  assert.equal(preview.status, 0, preview.stderr);
  const check = await runCliJson(['check', '--config', path.join(root, 'qgate.config.json'), '--json'], { cwd: root });
  assert.equal(check.status, 0, check.stderr);
  const safe002 = check.json.gates.flatMap((gate) => gate.checks).find((candidate) => candidate.id === 'no-secret-paths');
  const metrics = (safe002.evidence ?? []).map((ref) => ref.excerpt ?? '').find((excerpt) => excerpt.includes('SAFE_002 metrics=')) ?? '';
  return {
    included: preview.json.selection.included,
    excluded: preview.json.selection.excluded,
    secretPathsSelected: preview.json.invariants.secretPathsSelected,
    safe002Passed: safe002.passed,
    secretPathsExcluded: Number(/"secretPathsExcluded":(\d+)/.exec(metrics)?.[1] ?? -1),
  };
}

test('T-QG-012 R3-B1: case-variant sensitive paths are excluded as `secret_path` in both engine paths', async () => {
  // The engine's name rules used to be case-sensitive, so a CI diff spelled
  // `Credentials.json` / `.ENV` / `Secrets/Db.Txt` slipped through: `.ENV`/`.PEM` were
  // only stopped by the *extension* allowlist by accident, and `Credentials.json` /
  // `Secrets/Db.Txt` were selected outright while SAFE_002 still said passed=true.
  const variants = ['.ENV', '.Env', '.Env.production', 'Credentials.json', 'CREDENTIALS.JSON', 'Secrets/Db.Txt', 'SECRETS/DB.TXT', 'CONFIG/TLS/SERVER.PEM'];
  for (const variant of variants) {
    assert.ok(sensitiveNameRule(variant), `${variant} must match a sensitive rule by name`);
  }
  for (const ordinary of ['src/app.mjs', 'README.md', 'docs/notes.txt', 'config/app.json']) {
    assert.equal(sensitiveNameRule(ordinary), null, `${ordinary} must not match a sensitive rule`);
  }

  // Case-colliding names cannot coexist in one directory on a case-insensitive
  // filesystem, so the end-to-end trees are split accordingly.
  const trees = [
    { label: 'mixed path/dir variants', files: ['.ENV', 'Credentials.json', 'Secrets/Db.Txt', 'CONFIG/TLS/SERVER.PEM'], secret: 4 },
    { label: 'colliding variants', files: ['.Env.production', 'CREDENTIALS.JSON', 'SECRETS/DB.TXT'], secret: 3 },
  ];
  for (const tree of trees) {
    const root = buildCaseTree(tree.files);
    try {
      const audit = await auditCaseTree(root);
      assert.deepEqual(audit.included, ['qgate.config.json', 'src/app.mjs'], `${tree.label}: nothing sensitive may be selected`);
      assert.deepEqual(audit.secretPathsSelected, [], `${tree.label}: the invariant must be truthful`);
      for (const rel of tree.files) {
        const entry = audit.excluded.find((candidate) => candidate.path === rel);
        assert.ok(entry, `${tree.label}: ${rel} must be excluded`);
        assert.equal(entry.reason, 'secret_path', `${tree.label}: ${rel} must be excluded as secret_path, not ${entry.reason}`);
      }
      assert.equal(audit.safe002Passed, true, `${tree.label}: SAFE_002`);
      assert.equal(audit.secretPathsExcluded, tree.secret, `${tree.label}: the count must match the facts`);
    } finally {
      cleanup(root);
    }
  }
});

test('T-QG-012 R3-B1 + R3-H1 retest: a hard link to a case-variant target, and case-variant default dirs', async () => {
  const root = buildCaseTree(['Credentials.json']);
  try {
    // R3-H1 retest: the alias's *target* is spelled with an upper-case C, which used to
    // mean the target was not recognised as sensitive and the alias stayed selected.
    fs.linkSync(path.join(root, 'Credentials.json'), path.join(root, 'notes.txt'));
    // case-variant built-in excluded directory + an ordinary file that must stay in
    fs.mkdirSync(path.join(root, 'NODE_MODULES'));
    writeText(path.join(root, 'NODE_MODULES', 'dep.mjs'), 'export const d = 1;\n');

    const audit = await auditCaseTree(root);
    assert.deepEqual(audit.included, ['qgate.config.json', 'src/app.mjs'], 'alias and NODE_MODULES must not be selected');
    const alias = audit.excluded.find((candidate) => candidate.path === 'notes.txt');
    assert.equal(alias?.reason, 'secret_path');
    assert.match(alias.rule, /^alias:secret-credentials:same-(inode|content)-as-sensitive-path$/);
    const dep = audit.excluded.find((candidate) => candidate.path === 'NODE_MODULES/dep.mjs');
    assert.equal(dep?.reason, 'default_excluded_path', 'a case-variant built-in excluded directory must still be excluded');
    // 1 by name (Credentials.json) + 1 alias (notes.txt); NODE_MODULES uses another reason
    assert.equal(audit.secretPathsExcluded, 2);
  } finally {
    cleanup(root);
  }
});

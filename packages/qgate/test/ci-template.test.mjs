// T-QG-015 — REQ-QUALITY-GATE-015: the offline CI template must map the five frozen
// stages 1:1 onto five jobs, must never touch a secret, must pin every action to a
// commit SHA, must stay inside the `contents:read` + `pull-requests:write` permission
// ceiling, and its `verify` job must keep the three-step order that makes the trace
// matrix agree with the evidence ledger.
//
// The workflow/template files are *inputs* here (read-only): this suite is the
// verification the requirement was missing, not a second copy of their content.
// `analyzeWorkflow` is a mutation-checked analyzer: `test('...non-vacuous...')` feeds it
// deliberately broken copies of both files and requires each defect to be reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './helpers.mjs';
import { humanGates, stageOrder } from '../src/contract.mjs';

const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'quality-gate.yml');
const TEMPLATE_PATH = path.join(REPO_ROOT, 'adapters', 'opencodereview', 'ci', 'github-actions.yml');
const ROOT_CONFIG_PATH = path.join(REPO_ROOT, 'qgate.config.json');

const read = (abs) => fs.readFileSync(abs, 'utf8');

/**
 * Minimal, strict reader for the shape these two files actually use
 * (`permissions`/`env` mappings, `jobs.<id>.steps[]` with `uses`/`run`/`id`).
 * Unrecognised structure throws instead of being skipped, so a future edit that
 * changes the shape is surfaced rather than silently ignored.
 */
function parseWorkflow(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const result = { permissions: new Map(), env: new Map(), jobs: [], uses: [], container: null };
  let mode = null;
  let index = 0;
  while (index < lines.length) {
    const raw = lines[index];
    const trimmed = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    if (trimmed === '' || trimmed.startsWith('#')) {
      index += 1;
      continue;
    }
    if (indent === 0) {
      mode = trimmed.endsWith(':') ? trimmed.slice(0, -1) : null;
      index += 1;
      continue;
    }
    if (mode === 'permissions' && indent === 2) {
      const match = /^([a-z-]+):\s*(read|write|none)$/.exec(trimmed);
      if (!match) throw new Error(`unexpected permissions line: ${raw}`);
      result.permissions.set(match[1], match[2]);
      index += 1;
      continue;
    }
    if (mode === 'env' && indent === 2) {
      const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(trimmed);
      if (!match) throw new Error(`unexpected env line: ${raw}`);
      result.env.set(match[1], match[2].replace(/^['"]|['"]$/g, ''));
      index += 1;
      continue;
    }
    if (mode === 'jobs' && indent === 2) {
      const match = /^([a-z0-9-]+):$/.exec(trimmed);
      if (!match) throw new Error(`unexpected job line: ${raw}`);
      const job = { id: match[1], needs: null, name: null, steps: [] };
      index += 1;
      let step = null;
      let runIndent = null;
      let mappingIndent = null;
      while (index < lines.length) {
        const bodyRaw = lines[index];
        const bodyTrim = bodyRaw.trim();
        const bodyIndent = bodyRaw.length - bodyRaw.trimStart().length;
        if (bodyTrim === '' || bodyTrim.startsWith('#')) {
          index += 1;
          continue;
        }
        if (bodyIndent <= 2) break;
        if (runIndent !== null && bodyIndent > runIndent) {
          step.run += `\n${bodyTrim}`;
          index += 1;
          continue;
        }
        runIndent = null;
        if (mappingIndent !== null && bodyIndent > mappingIndent) {
          index += 1;
          continue;
        }
        mappingIndent = null;
        if (/^-\s+name:/.test(bodyTrim) && bodyIndent === 6) {
          step = { name: /^-\s+name:\s*(.*)$/.exec(bodyTrim)[1], uses: null, run: null, id: null };
          job.steps.push(step);
          index += 1;
          continue;
        }
        const key = /^([a-z-]+):\s*(.*)$/.exec(bodyTrim);
        if (!key) throw new Error(`unexpected line in job "${job.id}": ${bodyRaw}`);
        const [, name, value] = key;
        if (step === null) {
          if (bodyIndent === 4 && name === 'needs') job.needs = value;
          else if (bodyIndent === 4 && name === 'name') job.name = value;
          else if (bodyIndent === 4) {
            if (!['runs-on', 'timeout-minutes', 'steps', 'outputs', 'permissions', 'env', 'if'].includes(name)) {
              throw new Error(`unexpected job field "${name}" in job "${job.id}"`);
            }
          }
          index += 1;
          continue;
        }
        if (name === 'uses') {
          step.uses = value.split('#')[0].trim();
          result.uses.push({ job: job.id, value: step.uses, raw: value, line: index + 1 });
        } else if (name === 'id') step.id = value;
        else if (name === 'run') {
          if (value === '|' || value === '>' || value === '') {
            step.run = '';
            runIndent = bodyIndent;
          } else step.run = value;
        } else if (name === 'with' || name === 'env') mappingIndent = bodyIndent;
        else if (!['name', 'if', 'continue-on-error'].includes(name)) {
          throw new Error(`unexpected step field "${name}" in job "${job.id}"`);
        }
        index += 1;
      }
      result.jobs.push(job);
      continue;
    }
    index += 1;
  }
  return result;
}

/** Deterministic verdict: an empty list means the file satisfies REQ-015. */
function analyzeWorkflow(text, { label }) {
  const findings = [];
  const add = (message) => findings.push(`${label}: ${message}`);
  const workflow = parseWorkflow(text);

  // 1. exactly five jobs, one per frozen stage, in stage order.
  const ids = workflow.jobs.map((job) => job.id);
  if (ids.join(',') !== stageOrder.join(',')) add(`jobs must be exactly [${stageOrder.join(', ')}]; found [${ids.join(', ')}]`);

  // 2. the stages form a dependency chain.
  for (let i = 0; i < stageOrder.length; i += 1) {
    const job = workflow.jobs.find((candidate) => candidate.id === stageOrder[i]);
    if (!job) continue;
    const expected = i === 0 ? null : stageOrder[i - 1];
    if (job.needs !== expected) add(`job "${job.id}" must declare needs: ${expected ?? '(none)'} (found ${job.needs})`);
  }

  // 3. each of the first four jobs runs its own stage through the CLI contract.
  for (const stage of stageOrder.slice(0, 4)) {
    const job = workflow.jobs.find((candidate) => candidate.id === stage);
    const runs = (job?.steps ?? []).filter((step) => step.run).map((step) => step.run);
    if (!runs.some((run) => new RegExp(`check\\s+--stage\\s+${stage}\\b`).test(run))) {
      add(`job "${stage}" must run \`check --stage ${stage}\``);
    }
  }

  // 4. offline: no secret may be referenced anywhere.
  if (/\$\{\{\s*secrets\./i.test(text)) add('no `secrets.*` expression may be referenced');
  if (/^[^#\n]*\bsecrets\s*\.\s*[A-Za-z_]/m.test(text)) add('no `secrets.*` lookup may be referenced');

  // 5. every action is pinned to a 40-hex commit SHA and documents its release.
  if (workflow.uses.length === 0) add('at least one action must be used');
  for (const use of workflow.uses) {
    if (/@(v\d|main|master|latest|HEAD)\b/i.test(use.value)) add(`action "${use.value}" floats on a tag/branch`);
    if (!/@[0-9a-f]{40}$/.test(use.value)) add(`action "${use.value}" must be pinned to a 40-hex commit SHA`);
    else if (!/#\s*v?\d+\.\d+/.test(use.raw)) add(`pin "${use.value}" must document its release in a trailing comment`);
  }

  // 6. permission ceiling: contents:read + pull-requests:write, nothing more.
  if (workflow.permissions.size === 0) add('a top-level `permissions` block is required');
  for (const [scope, level] of workflow.permissions) {
    if (!['contents', 'pull-requests'].includes(scope)) add(`permission "${scope}" is outside the ceiling`);
    if (scope === 'contents' && level !== 'read') add(`"contents: ${level}" exceeds the ceiling (read required)`);
    if (scope === 'pull-requests' && level !== 'write' && level !== 'read') add(`"pull-requests: ${level}" exceeds the ceiling`);
    if (level === 'write' && scope !== 'pull-requests') add(`"${scope}: write" exceeds the ceiling`);
    if (level === 'none') add(`"${scope}: none" is not the declared ceiling`);
  }
  if (/\b(write-all|read-all)\b/.test(text)) add('`write-all`/`read-all` shorthand exceeds the ceiling');

  // 7. explicit offline provider declaration.
  if (workflow.env.get('QGATE_PROVIDER') !== 'deterministic') add('QGATE_PROVIDER must be "deterministic" (offline)');
  if (workflow.env.get('OCR_OFFLINE') !== '1') add('OCR_OFFLINE must be "1"');

  // 8. verify: human-gate records, then warm-up -> trace --write -> authoritative check.
  const verify = workflow.jobs.find((job) => job.id === 'verify');
  const steps = verify?.steps ?? [];
  const indexOf = (predicate) => steps.findIndex(predicate);
  const warmUp = indexOf((step) => step.run && /check\s+--config/.test(step.run) && /\|\|\s*true/.test(step.run));
  const traceWrite = indexOf((step) => step.run && /\btrace\b/.test(step.run) && /--write\b/.test(step.run));
  const verdict = indexOf((step) => step.id === 'pipeline');
  const humanGate = indexOf((step) => step.run && /approvals\//.test(step.run));
  if (humanGate < 0) add('verify must check the human-gate approval records');
  if (warmUp < 0) add('verify must contain a warm-up step (`check … || true`) that fills the ledger');
  if (traceWrite < 0) add('verify must generate the trace matrix (`trace --write`)');
  if (verdict < 0) add('verify must mark the authoritative step with `id: pipeline`');
  if (warmUp >= 0 && traceWrite >= 0 && warmUp > traceWrite) add('the warm-up must run before `trace --write`');
  if (traceWrite >= 0 && verdict >= 0 && traceWrite > verdict) add('`trace --write` must run before the authoritative verdict');
  if (humanGate >= 0 && verdict >= 0 && humanGate > verdict) add('human-gate records must be checked before the verdict');
  if (warmUp >= 0) {
    if (!/ledger-index\.json/.test(steps[warmUp].run)) add('the warm-up must assert that the ledger index was produced');
    if (!/exit\s+3\b/.test(steps[warmUp].run)) add('the warm-up ledger assertion must fail with exit 3');
  }
  if (verdict >= 0) {
    const run = steps[verdict].run ?? '';
    if (/\|\|\s*true/.test(run)) add('the authoritative verdict must not swallow its exit code');
    if (!/check\s+--config/.test(run)) add('the authoritative verdict must run `check --config`');
    if (/(^|\s)--stage(\s|$)/.test(run)) add('the authoritative verdict must run the full pipeline (no --stage)');
  }

  return findings;
}

/** Paths the workflow reads as inputs, extracted from its own declarations. */
function referencedInputs(workflow) {
  const refs = new Set();
  const entry = workflow.env.get('QGATE_ENTRY');
  const config = workflow.env.get('QGATE_CONFIG');
  const adapter = workflow.env.get('OCR_ADAPTER_ROOT');
  if (entry) refs.add(entry);
  if (config) refs.add(config);
  if (adapter) {
    refs.add(`${adapter}/ci/github-actions.yml`);
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        for (const match of (step.run ?? '').matchAll(/--(?:diff|rule)\s+"?\$OCR_ADAPTER_ROOT\/([^"\s\\]+)"?/g)) {
          refs.add(`${adapter}/${match[1]}`);
        }
      }
    }
  }
  return [...refs].sort();
}

const workflowText = read(WORKFLOW_PATH);
const templateText = read(TEMPLATE_PATH);

test('T-QG-015 the shipped workflow and reusable template both satisfy the CI contract', () => {
  assert.deepEqual(analyzeWorkflow(workflowText, { label: 'quality-gate.yml' }), []);
  assert.deepEqual(analyzeWorkflow(templateText, { label: 'github-actions.yml' }), []);

  // The template is the reusable form of the same pipeline: same five jobs, same verdict.
  const jobsOf = (text) => parseWorkflow(text).jobs.map((job) => job.id);
  assert.deepEqual(jobsOf(templateText), jobsOf(workflowText));
  assert.deepEqual(jobsOf(workflowText), [...stageOrder]);

  // Both files inspect exactly the approval records the frozen contract names.
  for (const gate of humanGates) {
    for (const text of [workflowText, templateText]) {
      assert.match(text, new RegExp(`verification/approvals/${gate.gateId}/approval\\.json|\\$\\{gate\\.id\\}|\"${gate.gateId}\"`));
      assert.ok(text.includes(`"${gate.gateId}"`) && text.includes(`"${gate.role}"`), `${gate.gateId} / ${gate.role} must be checked`);
    }
  }
});

test('T-QG-015 every input the workflow reads exists in the repository', () => {
  const workflow = parseWorkflow(workflowText);
  const refs = referencedInputs(workflow);
  assert.ok(refs.length >= 4, `expected several referenced inputs, found ${refs.join(', ')}`);
  for (const rel of refs) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, rel.split('/').join(path.sep))), true, `referenced input is missing: ${rel}`);
  }

  // The reusable template's defaults must point at files that exist too.
  for (const match of templateText.matchAll(/^\s*default:\s*'?([\w./-]+\.(?:mjs|json|yml))'?\s*$/gm)) {
    const rel = match[1];
    assert.equal(fs.existsSync(path.join(REPO_ROOT, rel.split('/').join(path.sep))), true, `template default is missing: ${rel}`);
  }
  assert.match(templateText, /default: packages\/qgate\/bin\/qgate\.mjs/);
  assert.match(templateText, /default: qgate\.config\.json/);
});

test('T-QG-015 the uploaded audit chain matches the root configuration', () => {
  const config = JSON.parse(read(ROOT_CONFIG_PATH));
  const traceCheck = config.gates.flatMap((gate) => gate.checks).find((check) => check.type === 'trace_matrix');
  const expected = [config.policy.evidenceDir, config.policy.reportDir, traceCheck.traceFile];
  assert.deepEqual(expected, ['verification/evidence', 'verification/reports', 'verification/trace-matrix.json']);

  const workflow = parseWorkflow(workflowText);
  assert.equal(workflow.env.get('QGATE_EVIDENCE_DIR'), config.policy.evidenceDir);
  for (const rel of expected) {
    assert.ok(workflowText.includes(rel), `the workflow must handle the configured audit path ${rel}`);
  }
  // The workflow must not invent a second repository-level configuration.
  assert.equal(workflow.env.get('QGATE_CONFIG'), 'qgate.config.json');
  assert.ok(!/QGATE_CI_CONFIG/.test(workflowText), 'the concrete workflow must not introduce a second config');
});

test('T-QG-015 the analyzer is not vacuous: every contract defect is reported', () => {
  const checkoutSha = '11bd71901bbe5b1630ceea73d27597364c9af683';
  assert.ok(workflowText.includes(`actions/checkout@${checkoutSha}`), 'pin used by the mutations is present');

  const mutations = [
    {
      name: 'secret reference',
      text: workflowText.replace('  QGATE_PROVIDER: deterministic', '  QGATE_TOKEN: ${{ secrets.QGATE_TOKEN }}\n  QGATE_PROVIDER: deterministic'),
      expect: /secret/i,
    },
    { name: 'floating action tag', text: workflowText.replace(`actions/checkout@${checkoutSha}`, 'actions/checkout@v4'), expect: /floats|40-hex/ },
    { name: 'permission escalation', text: workflowText.replace('  contents: read', '  contents: write'), expect: /exceeds the ceiling|contents/ },
    { name: 'extra permission scope', text: workflowText.replace('  contents: read', '  actions: write\n  contents: read'), expect: /outside the ceiling|exceeds the ceiling/ },
    { name: 'missing stage job', text: workflowText.replace(/^  build:[\s\S]*?(?=^  review:)/m, ''), expect: /jobs must be exactly/ },
    { name: 'broken needs chain', text: workflowText.replace('  verify:\n    name: verify\n    needs: review', '  verify:\n    name: verify\n    needs: build'), expect: /must declare needs/ },
    { name: 'swallowed verdict', text: workflowText.replace('        run: node "$QGATE_ENTRY" check --config "$QGATE_CONFIG" --json\n', '        run: node "$QGATE_ENTRY" check --config "$QGATE_CONFIG" --json || true\n'), expect: /must not swallow/ },
    { name: 'stage-limited verdict', text: workflowText.replace('        run: node "$QGATE_ENTRY" check --config "$QGATE_CONFIG" --json\n', '        run: node "$QGATE_ENTRY" check --config "$QGATE_CONFIG" --json --stage verify\n'), expect: /full pipeline/ },
    { name: 'warm-up without exit-code tolerance', text: workflowText.replace('check --config "$QGATE_CONFIG" --json || true', 'check --config "$QGATE_CONFIG" --json'), expect: /warm-up/i },
    {
      name: 'warm-up without ledger assertion',
      text: workflowText.replace(
        / {10}test -f "\$QGATE_EVIDENCE_DIR\/ledger-index\.json" \\\n {12}\|\| \{ echo[^\n]*\n/,
        '          true\n',
      ),
      expect: /ledger index/,
    },
    { name: 'missing offline provider declaration', text: workflowText.replace('  QGATE_PROVIDER: deterministic', '  QGATE_PROVIDER: openai'), expect: /deterministic/ },
  ];

  for (const mutation of mutations) {
    assert.notEqual(mutation.text, workflowText, `mutation "${mutation.name}" changed nothing`);
    const findings = analyzeWorkflow(mutation.text, { label: mutation.name });
    assert.ok(findings.length > 0, `mutation "${mutation.name}" was not detected`);
    assert.ok(findings.some((finding) => mutation.expect.test(finding)), `mutation "${mutation.name}" reported unrelated findings: ${findings.join(' | ')}`);
  }

  // Reordering the verify steps must be caught (the order is a CI-side necessity).
  const swapped = workflowText.replace(
    /(      - name: Warm-up run[\s\S]*?)(      - name: Generate trace matrix[\s\S]*?)(      - name: Run full pipeline)/,
    '$2$1$3',
  );
  assert.notEqual(swapped, workflowText, 'the step swap applied');
  const swappedFindings = analyzeWorkflow(swapped, { label: 'swapped verify order' });
  assert.ok(swappedFindings.some((finding) => /warm-up must run before|must run before the authoritative/.test(finding)), swappedFindings.join(' | '));
});

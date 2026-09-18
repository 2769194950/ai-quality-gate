// Markdown report rendering from the evidence ledger (§6.2 `qgate report`).
import { stringifyJson, writeFileAtomic } from './util/fsx.mjs';
import { redact } from './util/text.mjs';

function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Render one ledger document as a Markdown report. */
export function renderLedgerReport(ledger, { runId, ledgerRelPath = null, ledgerIndexRelPath = null } = {}) {
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  const failing = entries.filter((entry) => entry.passed === false);
  const byGate = new Map();
  for (const entry of entries) {
    if (!byGate.has(entry.gateId)) byGate.set(entry.gateId, []);
    byGate.get(entry.gateId).push(entry);
  }
  const lines = [];
  lines.push(`# qgate report — ${runId}`);
  lines.push('');
  lines.push('| 字段 | 值 |');
  lines.push('|---|---|');
  lines.push(`| Run id | \`${cell(runId)}\` |`);
  lines.push(`| Ledger | \`${cell(ledgerRelPath ?? '-')}\` |`);
  lines.push(`| Ledger index | \`${cell(ledgerIndexRelPath ?? '-')}\` |`);
  lines.push(`| Provider | \`${cell(JSON.stringify(ledger.provider ?? {}))}\` |`);
  lines.push(`| Started | ${cell(ledger.started_at)} |`);
  lines.push(`| Finished | ${cell(ledger.finished_at)} |`);
  lines.push(`| Config | \`${cell(ledger.configPath)}\` |`);
  lines.push(`| Config sha256 | \`${cell(ledger.configSha256)}\` |`);
  lines.push(`| Checks | ${entries.length} |`);
  lines.push(`| Failed checks | ${failing.length} |`);
  lines.push('');
  lines.push('## Gate summary');
  lines.push('');
  lines.push('| gate | stage | required | failed checks |');
  lines.push('|---|---|---|---|');
  for (const [gateId, gateEntries] of byGate) {
    const stage = gateEntries[0]?.stage ?? '';
    const required = gateEntries.some((e) => e.required) ? 'true' : 'false';
    const failed = gateEntries.filter((e) => e.passed === false).map((e) => e.checkId).join(', ') || '-';
    lines.push(`| ${cell(gateId)} | ${cell(stage)} | ${required} | ${cell(failed)} |`);
  }
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  lines.push('| gate | stage | check | type | severity | required | passed | testId | evidence |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const entry of entries) {
    const evidence = (entry.evidence ?? [])
      .slice(0, 2)
      .map((ref) => `${ref.path}#${ref.kind}:${cell(redact(ref.excerpt)).slice(0, 80)}`)
      .join(' ; ');
    lines.push(
      `| ${cell(entry.gateId)} | ${cell(entry.stage)} | ${cell(entry.checkId)} | ${cell(entry.type)} | ${cell(entry.severity)} | ${entry.required} | ${entry.passed} | ${cell(entry.testId ?? '-')} | ${cell(evidence)} |`,
    );
  }
  lines.push('');
  lines.push('## Findings (failed checks only)');
  lines.push('');
  if (failing.length === 0) {
    lines.push('No failing check in this run.');
  } else {
    for (const entry of failing) {
      lines.push(`- **${entry.checkId}** (${entry.type}, severity=${entry.severity}, gate=${entry.gateId})`);
      for (const ref of entry.evidence ?? []) {
        lines.push(`  - evidence: \`${ref.path}\` (${ref.kind}) — ${redact(ref.excerpt)}`);
      }
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** Write a report next to the ledger and return its project-relative path. */
export function writeLedgerReport({ root, reportDir, runId, markdown, fsxPath }) {
  const rel = `${reportDir}/report-${runId}.md`.replace(/\/+/g, '/');
  writeFileAtomic(fsxPath, markdown);
  return rel;
}

export { stringifyJson };

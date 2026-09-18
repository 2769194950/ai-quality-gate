#!/usr/bin/env node
// Resets the demo fixture's ledger state to its shipped baseline: no run ledgers,
// an empty runIds list, and the frozen 16 test ids. Run before committing demo
// changes so the fixture starts from a clean, documented state.
//
//   node packages/qgate/scripts/reset-demo-evidence.mjs
//
// IMPORTANT (t41): this script only clears the ledger. The committed
// `demo/mini-service/.qgate/trace-matrix.json` is *judged against the ledger*, so
// **re-run the demo gate once right after resetting** to restore agreement:
//
//   node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json
//
// That single run re-appends a ledger for the baseline test ids (exit 0 / 5 of 5) and
// leaves the fixture consistent; skipping it leaves a reset ledger and a stale trace
// document that a later `trace`-based judgement will flag.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringifyJson } from '../src/util/fsx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO_EVIDENCE = path.resolve(HERE, '..', '..', '..', 'demo', 'mini-service', '.qgate', 'evidence');
/**
 * The test ids the demo's own configuration can actually evidence (one entry per
 * mapped check). A requirement may only claim ids from this set — the demo has no
 * `schemas-exist` or `unit-tests` check, so T-QG-005 / T-QG-011 are deliberately not
 * part of the fixture any more.
 */
const TEST_IDS = [
  'T-QG-001', 'T-QG-002', 'T-QG-003', 'T-QG-004', 'T-QG-006', 'T-QG-007', 'T-QG-008',
  'T-QG-009', 'T-QG-010', 'T-QG-012', 'T-QG-013', 'T-QG-014', 'T-QG-015', 'T-QG-016',
].sort();

if (!fs.existsSync(DEMO_EVIDENCE)) {
  process.stderr.write(`demo evidence directory not found: ${DEMO_EVIDENCE}\n`);
  process.exitCode = 1;
} else {
  let removed = 0;
  for (const name of fs.readdirSync(DEMO_EVIDENCE)) {
    if (name.startsWith('ledger-') && name !== 'ledger-index.json') {
      fs.rmSync(path.join(DEMO_EVIDENCE, name));
      removed += 1;
    }
  }
  fs.writeFileSync(
    path.join(DEMO_EVIDENCE, 'ledger-index.json'),
    stringifyJson({
      schemaVersion: '1.0',
      updated_at: '2026-05-05T10:00:00.000Z',
      runIds: [],
      ledgers: [],
      testIds: TEST_IDS,
    }),
  );
  process.stdout.write(`removed ${removed} ledger file(s); ledger-index reset with ${TEST_IDS.length} test ids\n`);
}

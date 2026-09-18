#!/usr/bin/env node
// verification-t9/tools/w45-net-parity.mjs — t55 W4/W5: bare network-module imports must be judged
// the SAME by the engine (SAFE_003) and the adapter (scanNetworkSurface), including
// "imported but never called"; and the t54 boundaries must not have been loosened.
//
// All samples are constructed here (the adapter-engineer's 12-sample matrix is not reused).
// Engine verdict = policySafe003(root).passed === false (the engine's own authoritative predicate);
// adapter verdict = scanNetworkSurface(text) reports at least one violation.
// Usage: node verification-t9/tools/w45-net-parity.mjs [--json]
import path from 'node:path';
import { tmpDir, writeText, cleanup } from '../../packages/qgate/test/helpers.mjs';
import { policySafe003 } from '../../packages/qgate/src/policy.mjs';
import { scanNetworkSurface } from '../../adapters/opencodereview/src/ocr-runner.mjs';

// Each sample: { id, kind: 'report' | 'clean', text }
const SAMPLES = [
  { id: 'W4-01_import_from_not_called', kind: 'report', text: "import https from 'node:https';\nexport const x = 1;\n" },
  { id: 'W4-02_dynamic_import_not_called', kind: 'report', text: "import('node:https');\nexport const x = 1;\n" },
  { id: 'W4-03_require_not_called', kind: 'report', text: "const h = require('node:https');\nexport const x = 1;\n" },
  { id: 'W4-04_import_then_call', kind: 'report', text: "import https from 'node:https';\nexport function f(u) { return https.get(u); }\n" },
  { id: 'W4-05_require_then_call', kind: 'report', text: "const http = require('node:http');\nhttp.request('x');\n" },
  { id: 'W4-06_member_call_on_alias', kind: 'report', text: "import * as net from 'node:net';\nnet.createServer();\n" },
  { id: 'W4-07_bare_namespace_import', kind: 'report', text: "import 'node:dns';\nexport const x = 1;\n" },
  { id: 'W5-01_non_network_fs', kind: 'clean', text: "import fs from 'node:fs';\nexport const x = fs.constants;\n" },
  { id: 'W5-02_non_network_os_path', kind: 'clean', text: "import os from 'os';\nimport p from 'node:path';\nexport const x = [os.type(), p.sep];\n" },
  { id: 'W5-03_comment_only', kind: 'clean', text: "// import https from 'node:https';\nexport const x = 1;\n" },
  { id: 'W5-04_pure_module_name_literal', kind: 'clean', text: "const s = 'node:https';\nexport { s };\n" },
  { id: 'W5-05_negation_line', kind: 'clean', text: "// this module does NOT require('node:https') at all\nexport const x = 1;\n" },
];

const rows = [];
for (const s of SAMPLES) {
  const base = tmpDir('t55-net-');
  const root = path.join(base, 'repo');
  writeText(path.join(root, 'src', 'sample.mjs'), s.text);
  const engine = policySafe003(root);
  const engineReports = engine.passed === false;
  const adapter = scanNetworkSurface(s.text);
  const adapterReports = Array.isArray(adapter) ? adapter.length > 0 : Boolean(adapter && (adapter.violations?.length || adapter.length));
  const adapterVia = Array.isArray(adapter) ? adapter.map((v) => v.via ?? v) : (adapter?.violations ?? []).map((v) => v.via ?? v);
  rows.push({
    id: s.id,
    kind: s.kind,
    engineReports,
    adapterReports,
    sameVerdict: engineReports === adapterReports,
    expectedReports: s.kind === 'report',
    matchesExpectation: engineReports === (s.kind === 'report') && adapterReports === (s.kind === 'report'),
    engineVerdict: engine.passed === false ? 'FAIL(policy violation)' : 'pass',
    adapterVia,
  });
  cleanup(base);
}

// ---------------------------------------------------------------- module-vocabulary sweep (t55 finding)
// The t54 fix aligned the *syntax* forms; this sweep checks the *module vocabulary* on both sides,
// because the two implementations keep separate module lists.
const SWEEP_MODULES = ['http', 'https', 'net', 'tls', 'dgram', 'dns', 'http2', 'undici', 'axios', 'node-fetch', 'got'];
const sweep = [];
for (const mod of SWEEP_MODULES) {
  for (const form of ['import_from', 'require']) {
    const text = form === 'import_from' ? `import x from '${mod}';\nexport const v = 1;\n` : `const x = require('${mod}');\nexport const v = 1;\n`;
    const base = tmpDir('t55-sweep-');
    const root = path.join(base, 'repo');
    writeText(path.join(root, 'src', 'sample.mjs'), text);
    const engineReports = policySafe003(root).passed === false;
    const adapter = scanNetworkSurface(text);
    const adapterReports = Array.isArray(adapter) ? adapter.length > 0 : Boolean(adapter && (adapter.violations?.length || adapter.length));
    sweep.push({ module: mod, form, engineReports, adapterReports, sameVerdict: engineReports === adapterReports });
    cleanup(base);
  }
}
const sweepDisagreements = sweep.filter((r) => !r.sameVerdict);

const report = {
  cwd: process.cwd(),
  layers: { engine: 'packages/qgate/src/policy.mjs policySafe003(root).passed === false', adapter: 'adapters/opencodereview/src/ocr-runner.mjs scanNetworkSurface(text) reports ≥1 violation' },
  rows,
  sweep,
  summary: {
    samples: rows.length,
    verdictsAgree: rows.every((r) => r.sameVerdict),
    allMatchExpectation: rows.every((r) => r.matchesExpectation),
    disagreements: rows.filter((r) => !r.sameVerdict).map((r) => r.id),
    boundaryLoosened: rows.filter((r) => r.kind === 'clean' && (r.engineReports || r.adapterReports)).map((r) => r.id),
    sweepSamples: sweep.length,
    sweepDisagreements: sweepDisagreements.map((r) => `${r.module}/${r.form}(engine=${r.engineReports},adapter=${r.adapterReports})`),
  },
};
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  for (const r of rows) console.log(`${r.sameVerdict && r.matchesExpectation ? 'OK  ' : 'FAIL'} ${r.id} [${r.kind}] engine=${r.engineReports} adapter=${r.adapterReports} via=${JSON.stringify(r.adapterVia)}`);
  console.log(`summary=${JSON.stringify(report.summary)}`);
}
process.exitCode = report.summary.verdictsAgree && report.summary.allMatchExpectation ? 0 : 1;

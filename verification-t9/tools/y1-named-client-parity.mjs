#!/usr/bin/env node
// verification-t9/tools/y1-named-client-parity.mjs — t60/Y1: independently re-check t58/F14, the
// "named network client call" surface (`axios.get(url)`, `client.get(url)`), on BOTH sides.
//
// NOTHING here is copied from adapters/opencodereview/test/network-client.test.mjs: every cell is
// constructed in this file, and both verdicts are produced by the authoritative predicates:
//   engine : packages/qgate/src/policy.mjs  policySafe003(root).passed === false   (SAFE_003)
//   adapter: adapters/opencodereview/src/ocr-runner.mjs  scanNetworkSurface(text) reports >=1 violation
//
// Asserted directions (a cell that "agrees" by being loose on both sides is NOT a pass):
//   * client_call  : BOTH report  (violations via 'named-network-client-call' on the adapter side)
//   * benign       : NEITHER reports (zero false positives — the whole point of the exact
//                    name x member combination instead of a coarse `*.get()`)
//   * collision    : both report (engine fail-closed trade-off, inherited on purpose)
//   * non_http_mem : neither reports
//   * stricter     : adapter reports AND engine does not => adapter-stricter; this is the direction
//                    that must NOT be "aligned away" (loosening it would be a safety regression)
// Usage: node verification-t9/tools/y1-named-client-parity.mjs [--json]
import path from 'node:path';
import { tmpDir, writeText, cleanup } from '../../packages/qgate/test/helpers.mjs';
import { policySafe003 } from '../../packages/qgate/src/policy.mjs';
import { scanNetworkSurface } from '../../adapters/opencodereview/src/ocr-runner.mjs';

const CLIENT_NAMES = ['axios', 'got', 'superagent', 'needle', 'undici', 'ky', 'node-fetch', 'request', 'client', 'httpClient', 'apiClient', 'httpAgent'];

// Expected verdict per group: how the two layers must behave (not merely "the same").
const EXPECT = {
  client_call: { engine: true, adapter: true },
  benign: { engine: false, adapter: false },
  collision: { engine: true, adapter: true },
  non_http_member: { engine: false, adapter: false },
  stricter: { engine: false, adapter: true },
  // Divergence groups are recorded with their DIRECTION, not asserted away. `adapter_looser`
  // means the engine reports the surface and the adapter does not (a fail-open gap on the adapter
  // side); `adapter_stricter` is the opposite and is the safe direction.
  //
  // t66: the two `adapter_looser` groups were RE-BASED after t64 fixed them (F15 line-split handling,
  // F16 block-comment state). They used to be 6 cells of adapter-looser divergence; the expectation is
  // now "both report", so a regression that makes the adapter blind again FAILS this tool instead of
  // being silently re-labelled as a known divergence.
  fixed_by_t64_line_split: { engine: true, adapter: true },
  fixed_by_t64_masking: { engine: true, adapter: true },
  // A surface NEITHER layer reports: not a divergence (same verdict), but still a bypass.
  symmetric_gap: { engine: false, adapter: false },
};

const CELLS = [];
// 1. client_call: every engine client name x a sampling of HTTP members (self-built, 12+ cells)
for (const n of CLIENT_NAMES) CELLS.push({ group: 'client_call', id: `client_call:${n}.get`, text: `const r = await ${n}.get(url);` });
CELLS.push({ group: 'client_call', id: 'client_call:axios.post', text: 'axios.post(url, body);' });
CELLS.push({ group: 'client_call', id: 'client_call:client.request', text: 'client.request(opts);' });
CELLS.push({ group: 'client_call', id: 'client_call:httpAgent.connect', text: 'httpAgent.connect(target);' });
CELLS.push({ group: 'fixed_by_t64_line_split', id: 'client_call:ky.head_whitespace', text: 'const r = ky .\n  head (url);' });
CELLS.push({ group: 'client_call', id: 'client_call:got.send_string_literal_empty', text: 'got.send();' });

// 2. benign: 12 non-network objects — must not be reported by either side
for (const [obj, label] of [['cache', 'cache.get'], ['headers', 'headers.get'], ['map', 'map.get'], ['config', 'config.get'], ['store', 'store.get'], ['session', 'session.get'], ['env', 'env.get'], ['params', 'params.get'], ['formData', 'formData.get'], ['urlSearchParams', 'urlSearchParams.get'], ['registry', 'registry.get'], ['pool', 'pool.get']]) {
  CELLS.push({ group: 'benign', id: `benign:${label}`, text: `const v = ${obj}.get(key);` });
}
CELLS.push({ group: 'benign', id: 'benign:new_Map().get', text: 'const v = new Map().get(k);' });
CELLS.push({ group: 'benign', id: 'benign:this.cache.get', text: 'const v = this.cache.get(k);' });
CELLS.push({ group: 'benign', id: 'benign:cache.set', text: 'cache.set(k, v);' });
CELLS.push({ group: 'benign', id: 'benign:response.headers.get', text: "const v = response.headers.get('x');" });

// 3. collision: `request` / `client` are both client names AND ordinary identifiers
CELLS.push({ group: 'collision', id: 'collision:fs_request', text: "const request = require('node:fs');\nrequest.get(url);" });
CELLS.push({ group: 'collision', id: 'collision:store_request', text: 'const request = store;\nrequest.get(url);' });
CELLS.push({ group: 'collision', id: 'collision:cache_client', text: 'const client = makeCache();\nclient.get(key);' });
CELLS.push({ group: 'collision', id: 'collision:param_request', text: 'function f(request) { return request.get(url); }' });
CELLS.push({ group: 'collision', id: 'collision:param_client', text: 'function f(client) { return client.get(key); }' });
CELLS.push({ group: 'collision', id: 'collision:local_axios_shim', text: 'const axios = { get: (x) => x };\naxios.get(url);' });

// 4. non_http_member: a client NAME with a member that is not an HTTP verb must not be reported
CELLS.push({ group: 'non_http_member', id: 'non_http:axios.toString', text: 'const s = axios.toString();' });
CELLS.push({ group: 'non_http_member', id: 'non_http:axios.all', text: 'const s = axios.all([]);' });
CELLS.push({ group: 'non_http_member', id: 'non_http:client.close', text: 'client.close();' });
CELLS.push({ group: 'non_http_member', id: 'non_http:got.defaults', text: 'const d = got.defaults;' });
CELLS.push({ group: 'non_http_member', id: 'non_http:ky.config', text: 'ky.config();' });

// 5. stricter: the two directions t58 declared deliberately stricter on the adapter side
CELLS.push({ group: 'stricter', id: 'stricter:XMLHttpRequest', text: 'new XMLHttpRequest();' });
CELLS.push({ group: 'stricter', id: 'stricter:WebSocket', text: "new WebSocket('wss://example.invalid');" });

// Control cells (must agree, both report): fetch is a global on both sides
CELLS.push({ group: 'client_call', id: 'client_call:fetch_global_control', text: 'fetch(url);' });

// masked/comment cells: a detector that scans raw text would produce false positives here
CELLS.push({ group: 'benign', id: 'benign:line_comment', text: '// axios.get(url) is forbidden by SAFE_003' });
CELLS.push({ group: 'benign', id: 'benign:closed_block_comment', text: '/*\n * const r = await axios.get(url);\n */\nconst x = 1;' });
CELLS.push({ group: 'benign', id: 'benign:string_literal', text: "const s = 'axios.get';" });
CELLS.push({ group: 'benign', id: 'benign:template_literal', text: 'const t = `ky.get`;' });

// 6. line_split: the adapter's named-CLIENT scan runs per line while the engine's regex is
// text-scoped, so a client call whose `.` sits on another line escapes the adapter. Prettier-style
// chained formatting makes this realistic, not contrived. Recorded with its direction, not asserted away.
CELLS.push({ group: 'fixed_by_t64_line_split', id: 'line_split:ky_newline_before_dot', text: 'const r = await ky\n  .get(url);' });
CELLS.push({ group: 'fixed_by_t64_line_split', id: 'line_split:client_chain_pretty', text: 'const r = await client\n  .request(opts);' });
CELLS.push({ group: 'fixed_by_t64_line_split', id: 'line_split:ky_newline_after_dot', text: 'const r = await ky.\n  get(url);' });
// Controls: the MODULE-member path is text-scoped on both sides, and a same-line client call is fine.
CELLS.push({ group: 'client_call', id: 'line_split:module_member_newline', text: "import https from 'node:https';\nhttps\n  .get(url);" });
CELLS.push({ group: 'client_call', id: 'line_split:namespace_member_newline', text: "import * as n from 'node:net';\nn\n  .createServer();" });
CELLS.push({ group: 'client_call', id: 'line_split:same_line_control', text: 'const r = await ky .get(url);' });
// A surface BOTH layers miss: same verdict, so not a divergence — but it is still a bypass.
CELLS.push({ group: 'symmetric_gap', id: 'gap:global_fetch_newline', text: 'fetch\n(url);' });

// 7. masking: a line that starts with '*' but has no `/*` opener in the same text. The adapter skips
// it as a JSDoc continuation (fail-open) while the engine treats it as code (fail-closed, t46).
CELLS.push({ group: 'fixed_by_t64_masking', id: 'masking:stray_star_line', text: ' * const r = await axios.get(url);' });
CELLS.push({ group: 'fixed_by_t64_masking', id: 'masking:unterminated_block', text: '/*\n * const r = await axios.get(url);' });

const rows = [];
for (const c of CELLS) {
  const base = tmpDir('t60-y1-');
  const root = path.join(base, 'repo');
  writeText(path.join(root, 'src', 'sample.mjs'), c.text);
  const engine = policySafe003(root);
  const engineReports = engine.passed === false;
  const adapter = scanNetworkSurface(c.text);
  const adapterReports = adapter.violations.length > 0;
  const via = adapter.violations.map((v) => v.via);
  cleanup(base);
  const exp = EXPECT[c.group];
  rows.push({
    id: c.id,
    group: c.group,
    text: c.text,
    engineReports,
    adapterReports,
    expected: exp,
    matchesExpected: engineReports === exp.engine && adapterReports === exp.adapter,
    sameVerdict: engineReports === adapterReports,
    adapterVia: via,
  });
}

const byGroup = {};
for (const g of Object.keys(EXPECT)) {
  const rs = rows.filter((r) => r.group === g);
  byGroup[g] = { cells: rs.length, sameVerdict: rs.filter((r) => r.sameVerdict).length, matchesExpected: rs.filter((r) => r.matchesExpected).length };
}
const divergenceGroups = Object.keys(EXPECT).filter((g) => EXPECT[g].direction);
const divergences = rows
  .filter((r) => divergenceGroups.includes(r.group))
  .map((r) => ({ id: r.id, group: r.group, engine: r.engineReports, adapter: r.adapterReports, direction: EXPECT[r.group].direction, asDeclared: r.matchesExpected }));
const report = {
  cwd: process.cwd(),
  predicates: { engine: 'policySafe003(root).passed === false', adapter: 'scanNetworkSurface(text).violations.length > 0' },
  cells: rows.length,
  rows,
  byGroup,
  divergences,
  summary: {
    cells: rows.length,
    matchesExpected: rows.filter((r) => r.matchesExpected).length,
    sameVerdict: rows.filter((r) => r.sameVerdict).length,
    falsePositives: rows.filter((r) => r.group === 'benign' && (r.engineReports || r.adapterReports)).map((r) => r.id),
    clientCallsReported: rows.filter((r) => r.group === 'client_call').every((r) => r.engineReports && r.adapterReports),
    stricterStillReported: rows.filter((r) => r.group === 'stricter').every((r) => r.adapterReports && !r.engineReports),
    stricterCells: rows.filter((r) => r.group === 'stricter').map((r) => r.id),
    collisionBothReport: rows.filter((r) => r.group === 'collision').every((r) => r.engineReports && r.adapterReports),
    benignCells: rows.filter((r) => r.group === 'benign').length,
    collisionCells: rows.filter((r) => r.group === 'collision').length,
    symmetricGapCells: rows.filter((r) => r.group === 'symmetric_gap').length,
    divergenceCells: divergences.length,
    divergencesAsDeclared: divergences.every((r) => r.asDeclared),
    divergenceDirection: [...new Set(divergences.map((r) => r.direction))],
  },
};
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  for (const r of rows) {
    console.log(`${r.matchesExpected ? 'OK  ' : 'FAIL'} [${r.group}] ${r.id} engine=${r.engineReports} adapter=${r.adapterReports} same=${r.sameVerdict} via=${JSON.stringify(r.adapterVia)}`);
  }
  console.log(`byGroup=${JSON.stringify(byGroup)}`);
  console.log(`divergences=${JSON.stringify(divergences)}`);
  console.log(`summary=${JSON.stringify(report.summary)}`);
}
// 0 = everything as declared AND nothing to report; 4 = expectations met but real divergences exist
// (they are findings for the report, not a tool failure); 1 = the observed behaviour contradicts the
// declared expectations (a regression or a wrong declaration).
process.exitCode = report.summary.matchesExpected === rows.length ? (report.summary.divergenceCells > 0 ? 4 : 0) : 1;

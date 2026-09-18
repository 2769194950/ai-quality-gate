#!/usr/bin/env node
// verification-t9/tools/preview-crosscheck.mjs
//
// Evidence for t49 assertions #7/#12 and t52's contract-source refactor:
//   (#7) adapter SAFE_002 invariant: secret paths never appear in any "selected" surface, even when
//        the highest-priority rule explicitly re-includes them;
//   (§6.2.1/§6.2.2) the frozen field-name mapping tables parsed FROM THE DOCUMENT vs the real
//        adapter/engine JSON;
//   (GAP-1) engine_priority = adapter_priority - 1, verified on one shared file tree.
//
// t52 change: the expected key sets are no longer a hand-copied `docClaim` literal. The tool now
// PARSES docs/01-architecture.md (§6.2.1 top-level + ruleMatch tables, §6.2.2.1-.5 mapping tables)
// and derives the expectations from the authoritative tables themselves, so a doc update can never
// leave a second, stale copy behind. Parsing is fail-closed: a missing section, an unparsable table
// or a key count below the structural floor is an ERROR (exit 3), never an empty expectation set
// that would silently pass.
//
// Exit codes (t52):
//   0 = every parsed expectation group matches the real artefacts
//   1 = at least one DIFF (contract statement vs real output mismatch)
//   3 = fail-closed parse/contract-read failure (document unreadable, section missing, table broken,
//       or a group parsed below its structural floor)
//
// Usage: node verification-t9/tools/preview-crosscheck.mjs [--json] [--doc <path>] [--artifacts <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DOC_PATH = path.resolve(ROOT, opt('--doc', 'docs/01-architecture.md'));
// t60 self-repair: the default used to point at a SUPERSEDED revision (artifacts-v5), so running this
// tool without flags silently compared the frozen tables against an old capture and could print
// "ALIGNED" about a revision that no longer exists. Which revision is being cross-checked is now an
// explicit, required input, and a missing capture directory fails closed.
const ARTIFACTS_ARG = opt('--artifacts', null);
if (!ARTIFACTS_ARG) {
  console.error('UNPARSABLE: --artifacts <dir> is required (say which revision capture is being cross-checked; a default from an older revision reads as a pass)');
  process.exit(3);
}
const ARTIFACTS = path.resolve(ROOT, ARTIFACTS_ARG);
if (!fs.existsSync(ARTIFACTS)) {
  console.error(`UNPARSABLE: artifacts dir not found: ${ARTIFACTS_ARG}`);
  process.exit(3);
}
const AS_JSON = argv.includes('--json');

const EXIT_OK = 0;
const EXIT_DIFF = 1;
const EXIT_PARSE_FAILURE = 3;

const loadArtifact = (name) => JSON.parse(fs.readFileSync(path.join(ARTIFACTS, name), 'utf8').replace(/^\uFEFF/, ''));

// ------------------------------------------------------------------ markdown table parsing
function fail(message) {
  process.stderr.write(`preview-crosscheck: PARSE FAILURE (fail-closed): ${message}\n`);
  process.exit(EXIT_PARSE_FAILURE);
}

const docText = (() => {
  try {
    return fs.readFileSync(DOC_PATH, 'utf8');
  } catch (err) {
    fail(`cannot read document ${DOC_PATH}: ${err.message}`);
  }
})();
const docLines = docText.split(/\r?\n/);

/** Rows of the FIRST markdown table inside the section whose heading matches `headingRe`. */
function sectionTable(headingRe) {
  const start = docLines.findIndex((l) => headingRe.test(l));
  if (start < 0) fail(`section heading ${headingRe} not found in ${path.relative(ROOT, DOC_PATH)}`);
  const rows = [];
  let seenHeader = false;
  for (let i = start + 1; i < docLines.length; i += 1) {
    const line = docLines[i].trim();
    const isRow = line.startsWith('|');
    // the first table ends at the first non-table, non-blank line after its rows started
    if (!isRow && seenHeader && rows.length > 0) break;
    if (!isRow) continue; // still before the table (prose between heading and table)
    if (/^\|[\s|:-]+\|$/.test(line)) continue; // separator
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (!seenHeader) {
      seenHeader = true; // header row: column titles
      continue;
    }
    rows.push({ cells, line: i + 1 });
  }
  if (rows.length === 0) fail(`section ${headingRe} contains no table rows`);
  return rows;
}

/** First backticked identifier of a cell, normalised to a bare key (drops `: type` and `[]`). */
function keyOf(cell) {
  const m = /`([^`]+)`/.exec(cell ?? '');
  if (!m) return null;
  const raw = m[1].trim();
  if (raw.startsWith('—') || raw === '-' || raw === '') return null;
  const key = raw.split(/[:\s([]/)[0].trim();
  if (!key || key === '—' || /^[0-9]+$/.test(key)) return null;
  return key;
}

// §6.2.1: top-level (| # | 输出键 | 类型 | 说明 |) and ruleMatch fields (| 字段 | 类型 | 说明 |)
const engineTopRows = sectionTable(/^#### 6\.2\.1 /);
const engineTopLevel = engineTopRows.map((r) => keyOf(r.cells[1])).filter(Boolean);
const engineTopLineRefs = engineTopRows.map((r) => r.line);
const engineRuleRows = sectionTable(/^\*\*`ruleMatch\[\]` 每项的字段表\*\*/);
const engineRuleMatch = engineRuleRows.map((r) => keyOf(r.cells[0])).filter(Boolean);
const engineRuleLineRefs = engineRuleRows.map((r) => r.line);

// §6.2.2.1 ruleMatch mapping (| 概念 | 适配层键 | 契约键 | 标注 |)
const ruleMapRows = sectionTable(/^##### 6\.2\.2\.1 /);
const adapterRuleMatch = ruleMapRows.map((r) => keyOf(r.cells[1])).filter(Boolean);
const adapterRuleMatchLineRefs = ruleMapRows.map((r) => r.line);
const engineRuleFromMap = ruleMapRows.map((r) => keyOf(r.cells[2])).filter(Boolean);

// §6.2.2.2 selected[] / excluded[]
const selExRows = sectionTable(/^##### 6\.2\.2\.2 /);
const adapterSelected = selExRows.map((r) => keyOf(r.cells[1])).filter(Boolean);
const adapterExcluded = selExRows.map((r) => keyOf(r.cells[2])).filter(Boolean);
const selExLineRefs = selExRows.map((r) => r.line);

// §6.2.2.3 groups[]
const groupRows = sectionTable(/^##### 6\.2\.2\.3 /);
const adapterGroups = groupRows.map((r) => keyOf(r.cells[1])).filter(Boolean);
const groupLineRefs = groupRows.map((r) => r.line);

// §6.2.2.4 selection
const selectionRows = sectionTable(/^##### 6\.2\.2\.4 /);
const adapterSelection = selectionRows.map((r) => keyOf(r.cells[1])).filter(Boolean);
const selectionLineRefs = selectionRows.map((r) => r.line);

// §6.2.2.5 counts.* and top-level list keys
const countersRows = sectionTable(/^##### 6\.2\.2\.5 /);
const counterKeys = countersRows.map((r) => keyOf(r.cells[1])).filter(Boolean);
const countersLineRefs = countersRows.map((r) => r.line);
const adapterCounts = counterKeys.filter((k) => k.startsWith('counts.')).map((k) => k.slice('counts.'.length));
const adapterTopLevelDeclared = counterKeys.filter((k) => !k.includes('.'));

// ------------------------------------------------------------------ fail-closed structural floors
const GROUPS = [
  { name: 'engineTopLevel', declared: engineTopLevel, mode: 'exact', floor: 8, docRefs: engineTopLineRefs },
  { name: 'engineRuleMatch', declared: engineRuleMatch, mode: 'exact', floor: 7, docRefs: engineRuleLineRefs },
  { name: 'adapterRuleMatch', declared: adapterRuleMatch, mode: 'exact', floor: 7, docRefs: adapterRuleMatchLineRefs },
  { name: 'adapterSelected', declared: adapterSelected, mode: 'exact', floor: 9, docRefs: selExLineRefs },
  { name: 'adapterExcluded', declared: adapterExcluded, mode: 'exact', floor: 7, docRefs: selExLineRefs },
  { name: 'adapterGroups', declared: adapterGroups, mode: 'exact', floor: 7, docRefs: groupLineRefs },
  { name: 'adapterSelection', declared: adapterSelection, mode: 'exact', floor: 2, docRefs: selectionLineRefs },
  { name: 'adapterCounts', declared: adapterCounts, mode: 'subset', floor: 3, docRefs: countersLineRefs },
  { name: 'adapterTopLevelDeclared', declared: adapterTopLevelDeclared, mode: 'subset', floor: 2, docRefs: countersLineRefs },
];
for (const g of GROUPS) {
  if (g.declared.length < g.floor) {
    fail(`group ${g.name} parsed only ${g.declared.length} key(s), below its structural floor of ${g.floor} — the ${path.relative(ROOT, DOC_PATH)} table format probably changed; refusing to compare against an empty/partial expectation set`);
  }
}

const SECRET_RE = /(^|\/)\.env|\.pem$|\.key$|(^|\/)id_rsa|(^|\/)credentials|(^|\/)secrets\//i;
const isSecret = (p) => typeof p === 'string' && SECRET_RE.test(p);

function secretScan(label, selectionIncluded, adapterJson) {
  const included = selectionIncluded ?? [];
  const leaked = included.filter(isSecret);
  const selectedLeaked = (adapterJson.selected ?? []).map((s) => s.path).filter(isSecret);
  const ruleMatchLeaked = (adapterJson.ruleMatch ?? []).map((r) => r.file).filter(isSecret);
  const groupedLeaked = (adapterJson.groups ?? []).flatMap((g) => g.files ?? []).filter(isSecret);
  const excludedSecrets = (adapterJson.excluded ?? []).filter((e) => isSecret(e.path));
  return {
    label,
    includedCount: included.length,
    selectedCount: (adapterJson.selected ?? []).length,
    leakedInSelectionIncluded: leaked,
    leakedInSelected: selectedLeaked,
    leakedInRuleMatch: ruleMatchLeaked,
    leakedInGroups: groupedLeaked,
    secretsExcluded: excludedSecrets.map((e) => ({ path: e.path, reason: e.reason, decided_by: e.decided_by, rule_source: e.rule_source })),
    safetyBlock: adapterJson.safety ?? null,
    invariantHolds: leaked.length === 0 && selectedLeaked.length === 0 && ruleMatchLeaked.length === 0 && groupedLeaked.length === 0,
  };
}

const adapterDefault = loadArtifact('adapter-preview-default.json');
const adapterMalicious = loadArtifact('adapter-preview-safe002-include.json');
const adapterFlagInclude = loadArtifact('adapter-preview-include-flags.json');
const adapterSameFiles = loadArtifact('adapter-preview-same-files.json');
const engineSameFiles = loadArtifact('engine-preview-same-files.json');
const engineCliRule = loadArtifact('engine-preview-cli-rule.json');

const security = [
  secretScan('adapter demo diff + demo rule (default)', adapterDefault.selection.included, adapterDefault),
  secretScan('adapter demo diff + SAFE_002 malicious --rule (explicit include of secret paths)', adapterMalicious.selection.included, adapterMalicious),
  secretScan('adapter demo diff + --include .env* / **/*.pem / **/id_rsa* / secrets/** / **/credentials*', adapterFlagInclude.selection.included, adapterFlagInclude),
];

const keys = (obj) => Object.keys(obj ?? {}).sort();
const actualByName = {
  engineTopLevel: keys(engineSameFiles),
  engineRuleMatch: keys(engineSameFiles.ruleMatch?.[0]),
  adapterRuleMatch: keys(adapterSameFiles.ruleMatch?.[0]),
  adapterSelected: keys(adapterSameFiles.selected?.[0]),
  adapterExcluded: keys(adapterSameFiles.excluded?.[0]),
  adapterGroups: keys(adapterSameFiles.groups?.[0]),
  adapterSelection: keys(adapterSameFiles.selection),
  adapterCounts: keys(adapterSameFiles.counts),
  adapterTopLevelDeclared: keys(adapterSameFiles),
};

const keySetChecks = GROUPS.map((g) => {
  const declared = [...new Set(g.declared)].sort();
  const actual = actualByName[g.name];
  const missingFromActual = declared.filter((k) => !actual.includes(k));
  const extraInActual = g.mode === 'exact' ? actual.filter((k) => !declared.includes(k)) : [];
  return {
    name: g.name,
    mode: g.mode,
    docSection: g.name === 'engineTopLevel' || g.name === 'engineRuleMatch' ? '§6.2.1' : '§6.2.2.x',
    docLines: g.docRefs,
    parseFloor: g.floor,
    declared,
    actual,
    missingFromActual,
    extraInActual,
    match: missingFromActual.length === 0 && extraInActual.length === 0,
  };
});

const layerOf = (source) => {
  if (source === '--rule' || source === 'cli:--rule' || source === 'cli:flags') return 'cli';
  if (source === 'project' || source === 'project:rule') return 'project';
  if (source === 'user') return 'user';
  if (source === 'builtin' || String(source).startsWith('builtin:')) return 'builtin';
  if (source === 'none') return 'none';
  return source;
};
const layerPriorities = (ruleMatch) => {
  const out = {};
  for (const entry of ruleMatch ?? []) {
    const layer = layerOf(entry.ruleSource);
    out[layer] = out[layer] ?? new Set();
    out[layer].add(entry.priority);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
};

const engineLayers = layerPriorities(engineSameFiles.ruleMatch);
const adapterLayers = layerPriorities(adapterSameFiles.ruleMatch);
const formulaChecks = Object.keys(adapterLayers).filter((l) => engineLayers[l]).map((layer) => {
  const pairs = [];
  for (const ap of adapterLayers[layer]) for (const ep of engineLayers[layer]) pairs.push({ adapterPriority: ap, enginePriority: ep, delta: ap - ep });
  const deltas = [...new Set(pairs.map((p) => p.delta))];
  return { layer, adapterPriorities: adapterLayers[layer], enginePriorities: engineLayers[layer], deltas, formulaHolds: deltas.length === 1 && deltas[0] === 1, pairs };
});

const engineByFile = new Map((engineSameFiles.ruleMatch ?? []).map((e) => [e.file, e]));
const adapterByFile = new Map((adapterSameFiles.ruleMatch ?? []).map((e) => [e.file, e]));
const both = [...engineByFile.keys()].filter((f) => adapterByFile.has(f)).sort();
const perFile = both.map((file) => {
  const e = engineByFile.get(file);
  const a = adapterByFile.get(file);
  const el = layerOf(e.ruleSource);
  const al = layerOf(a.ruleSource);
  return { file, engineLayer: el, adapterLayer: al, enginePriority: e.priority, adapterPriority: a.priority, sameLayer: el === al, delta: al === el ? a.priority - e.priority : null };
});
const sameLayerComparable = perFile.filter((r) => r.sameLayer);

const diffs = keySetChecks.filter((k) => !k.match);
const report = {
  contractSource: { document: path.relative(ROOT, DOC_PATH), sections: ['§6.2.1', '§6.2.2.1', '§6.2.2.2', '§6.2.2.3', '§6.2.2.4', '§6.2.2.5'], mode: 'parsed from the frozen tables (no hand-copied key list)', failClosed: true },
  exitCodes: { aligned: EXIT_OK, diff: EXIT_DIFF, parseFailure: EXIT_PARSE_FAILURE },
  artifactsDir: path.relative(ROOT, ARTIFACTS),
  security,
  keySetChecks,
  newKeysCoveredByParsing: ['materialized', 'excluded_unmaterialized', 'counts.selected_materialized', 'counts.unmaterialized', 'counts.groups_dropped_unmaterialized', 'unmaterialized', 'selectedPathsMaterialized'],
  coverage: {
    adapterRuleMatchLength: (adapterSameFiles.ruleMatch ?? []).length,
    adapterSelectionIncludedLength: (adapterSameFiles.selection?.included ?? []).length,
    ruleMatchLengthEqualsIncluded: (adapterSameFiles.ruleMatch ?? []).length === (adapterSameFiles.selection?.included ?? []).length,
    engineRuleMatchLength: (engineSameFiles.ruleMatch ?? []).length,
    engineSelectionIncludedLength: (engineSameFiles.selection?.included ?? []).length,
    engineRuleMatchLengthEqualsIncluded: (engineSameFiles.ruleMatch ?? []).length === (engineSameFiles.selection?.included ?? []).length,
  },
  priority: {
    engineLayers,
    adapterLayers,
    formulaChecks,
    sameTreeOverlap: { both: both.length, engineOnly: [...engineByFile.keys()].filter((f) => !adapterByFile.has(f)).length, adapterOnly: [...adapterByFile.keys()].filter((f) => !engineByFile.has(f)).length, perFile },
    sameLayerComparable,
  },
  engineCliRuleLayers: layerPriorities(engineCliRule.ruleMatch),
  diffs,
  verdict: diffs.length === 0 ? 'aligned' : 'diff',
};

if (AS_JSON) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  console.log(`contract source: ${report.contractSource.document} (${report.contractSource.sections.join(', ')}) — expectations parsed from the tables, not hardcoded`);
  console.log('--- security ---');
  for (const s of security) console.log(`${s.invariantHolds ? 'OK  ' : 'FAIL'} ${s.label}: included=${s.includedCount} leaked=${JSON.stringify([...s.leakedInSelectionIncluded, ...s.leakedInSelected, ...s.leakedInRuleMatch, ...s.leakedInGroups])} excludedSecrets=${JSON.stringify(s.secretsExcluded.map((x) => x.path))}`);
  console.log('--- key sets (parsed from §6.2.1/§6.2.2 vs real artefacts) ---');
  for (const k of keySetChecks) {
    console.log(`${k.match ? 'OK  ' : 'DIFF'} ${k.name} [${k.mode}] doc ${k.docSection} lines ${k.docLines[0]}-${k.docLines[k.docLines.length - 1]} declared=${k.declared.length} actual=${k.actual.length} missing=${JSON.stringify(k.missingFromActual)} extra=${JSON.stringify(k.extraInActual)}`);
  }
  console.log(`new keys carried by the parsed tables: ${report.newKeysCoveredByParsing.join(', ')}`);
  console.log('--- §6.2.2.4 GAP-1 priority formula ---');
  console.log(`engine layers = ${JSON.stringify(engineLayers)}`);
  console.log(`adapter layers = ${JSON.stringify(adapterLayers)}`);
  for (const f of formulaChecks) console.log(`${f.formulaHolds ? 'OK  ' : 'FAIL'} layer=${f.layer} deltas=${JSON.stringify(f.deltas)}`);
  console.log(`coverage=${JSON.stringify(report.coverage)}`);
  console.log(diffs.length === 0 ? 'verdict: ALIGNED (exit 0)' : `verdict: ${diffs.length} DIFF group(s) (exit ${EXIT_DIFF})`);
}

process.exitCode = diffs.length === 0 ? EXIT_OK : EXIT_DIFF;

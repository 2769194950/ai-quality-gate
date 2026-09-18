#!/usr/bin/env node
// verification-t9/tools/y5-table-integrity.mjs — t60/Y5: does the t58 fix of the adapter README's §4
// invariant table actually render, and is the G1 row still a ROW of its own?
//
// The defect being re-checked (t58, fixed in passing): the G1 invariant ("at most 10 files per group")
// had been merged into the S4 row (unsupported extensions), so a reader could not see it and the table
// lost a row. A table that renders wrongly is invisible to `node --test`, so this is measured directly:
// every `|`-led block must have a constant number of cells, and §4 must contain both an S4 and a G1 row.
//
// Usage: node verification-t9/tools/y5-table-integrity.mjs [--json] [--file <md>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const opt = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

function cellCount(line) {
  // Cells are separated by UNESCAPED pipes only: `\|` inside a code span is content, not a separator
  // (a naive split mis-reads `| ` + "`--group-mode auto\\|single\\|per-file`" + ` | 分组模式 |` as 4 cells).
  const pipes = (line.match(/(?<!\\)\|/g) || []).length;
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = trimmed.split(/(?<!\\)\|/).map((s) => s.trim());
  return { cells, pipes };
}

function analyse(file) {
  const abs = path.resolve(ROOT, file);
  const lines = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const tables = [];
  let current = null;
  lines.forEach((line, idx) => {
    const looksLikeRow = /^\s*\|.*\|\s*$/.test(line);
    if (looksLikeRow) {
      if (!current) current = { startLine: idx + 1, rows: [] };
      current.rows.push({ line: idx + 1, text: line, ...cellCount(line) });
    } else if (current) {
      tables.push(current);
      current = null;
    }
  });
  if (current) tables.push(current);
  const broken = [];
  for (const t of tables) {
    const headerCells = t.rows[0].cells.length;
    for (const r of t.rows) {
      if (r.cells.length !== headerCells) broken.push({ startLine: t.startLine, line: r.line, headerCells, rowCells: r.cells.length, text: r.text.trim().slice(0, 90) });
    }
  }
  return { file, tables: tables.length, rows: tables.reduce((n, t) => n + t.rows.length, 0), broken, details: tables.map((t) => ({ startLine: t.startLine, rows: t.rows.length, cells: t.rows[0].cells.length })) };
}

function section4Rows(file) {
  const abs = path.resolve(ROOT, file);
  const lines = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##\s*4\.\s/.test(l));
  const endRel = lines.slice(start + 1).findIndex((l) => /^##\s*5\./.test(l));
  const end = endRel < 0 ? lines.length : start + 1 + endRel;
  const body = lines.slice(start, end);
  const rowIds = [];
  const pipeCounts = new Set();
  for (const line of body) {
    const m = /^\s*\|\s*\*\*([A-Z]+[0-9]+)\*\*\s*\|/.exec(line);
    if (m) {
      rowIds.push({ id: m[1], line: lines.indexOf(line) + 1 });
      pipeCounts.add((line.match(/(?<!\\)\|/g) || []).length);
    }
  }
  return { section: '§4', range: [start + 1, end], rowIds, distinctPipeCountsInInvariantTable: [...pipeCounts].sort() };
}

const README = opt('--file', 'adapters/opencodereview/README.md');
const integrity = analyse(README);
const section4 = section4Rows(README);
const ids = section4.rowIds.map((r) => r.id);
const report = {
  cwd: process.cwd(),
  readme: README,
  integrity,
  section4,
  summary: {
    tablesChecked: integrity.tables,
    rowsChecked: integrity.rows,
    brokenRows: integrity.broken,
    section4HasS4Row: ids.includes('S4'),
    section4HasG1Row: ids.includes('G1'),
    g1IsItsOwnRow: ids.includes('G1') && ids.includes('S4') && new Set(ids).size === ids.length,
    invariantTablePipeCountsConsistent: section4.distinctPipeCountsInInvariantTable.length === 1,
    section4RowIds: ids,
  },
};
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  console.log(`${README}: ${integrity.tables} tables / ${integrity.rows} rows; broken rows = ${integrity.broken.length}`);
  for (const b of integrity.broken) console.log(`  BROKEN L${b.line} (header ${b.headerCells} cells, row ${b.rowCells}): ${b.text}`);
  console.log(`§4 rows ${section4.range[0]}-${section4.range[1]} ids=${JSON.stringify(ids)} pipeCounts=${JSON.stringify(section4.distinctPipeCountsInInvariantTable)}`);
  console.log(`summary=${JSON.stringify(report.summary)}`);
}
const ok = integrity.broken.length === 0 && report.summary.section4HasS4Row && report.summary.section4HasG1Row && report.summary.g1IsItsOwnRow && report.summary.invariantTablePipeCountsConsistent;
process.exitCode = ok ? 0 : 1;

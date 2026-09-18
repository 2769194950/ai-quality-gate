#!/usr/bin/env node
// verification/tools/schema-meta.mjs — structural report on the four frozen schemas.
// Usage: node verification/tools/schema-meta.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', `${n}.schema.json`), 'utf8').replace(/^\uFEFF/, ''));

for (const name of ['config', 'run-result', 'evidence-ledger', 'trace-matrix']) {
  const file = path.join(ROOT, 'schemas', `${name}.schema.json`);
  const schema = load(name);
  console.log(`=== ${name}.schema.json ===`);
  console.log(`  exists=true bytes=${fs.statSync(file).size}`);
  console.log(`  $schema=${schema.$schema}`);
  console.log(`  $id=${schema.$id}`);
  console.log(`  title=${JSON.stringify(schema.title)}`);
  console.log(`  description=${JSON.stringify(String(schema.description ?? '').slice(0, 80))}`);
  console.log(`  root properties=${Object.keys(schema.properties ?? {}).join(',')}`);
  console.log(`  $defs=${Object.keys(schema.$defs ?? {}).join(',')}`);
}

const rr = load('run-result');
const led = load('evidence-ledger');
const tr = load('trace-matrix');
console.log('=== §9.1 nullability form + schemas/README oneOf claim ===');
console.log(`  run-result humanGate.approvedBy = ${JSON.stringify(rr.$defs?.humanGateResult?.properties?.approvedBy)}`);
console.log(`  run-result humanGate.approvedAt = ${JSON.stringify(rr.$defs?.humanGateResult?.properties?.approvedAt)}`);
console.log(`  ledger entry.testId = ${JSON.stringify(led.$defs?.ledgerEntry?.properties?.testId)}`);
console.log(`  trace requirement.testIds = ${JSON.stringify(tr.$defs?.requirementTrace?.properties?.testIds)}`);
const approvalSchemaFiles = fs.readdirSync(path.join(ROOT, 'schemas')).filter((f) => /approval/i.test(f));
console.log(`  dedicated approval.json schema files = ${JSON.stringify(approvalSchemaFiles)}`);

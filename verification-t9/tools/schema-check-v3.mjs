#!/usr/bin/env node
// verification-t9/tools/schema-check-v3.mjs — validate a captured artefact against a frozen schema
// using the repository's dependency-free draft 2020-12 subset evaluator.
// Usage: node verification-t9/tools/schema-check-v3.mjs <schema.json> <instance.json> [<schema> <instance> ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../../packages/qgate/test/helpers/json-schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), 'utf8').replace(/^\uFEFF/, '').replace(/^[^{[]*/, ''));

const args = process.argv.slice(2);
const results = [];
for (let i = 0; i + 1 < args.length; i += 2) {
  const schemaPath = args[i];
  const instancePath = args[i + 1];
  const schema = readJson(schemaPath);
  const instance = readJson(instancePath);
  const out = validate(schema, instance, { rootDocument: schema });
  results.push({ schema: schemaPath, instance: instancePath, valid: out.valid, errorCount: out.errors.length, errors: out.errors.slice(0, 6) });
}
for (const r of results) console.log(`${r.valid ? 'valid=true ' : 'valid=false'} ${r.instance}  vs  ${r.schema}  errors=${r.errorCount}${r.valid ? '' : ` :: ${JSON.stringify(r.errors)}`}`);
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
process.exitCode = results.every((r) => r.valid) ? 0 : 1;

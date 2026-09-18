#!/usr/bin/env node
// verification/tools/schema-eval.mjs — assertion #11 evidence (rebuilt after the 02:32 wipe).
// Reuses the repo's dependency-free draft 2020-12 subset evaluator; the project is deliberately
// zero-dependency/offline, and Node ships no JSON Schema validator.
// Usage: node verification/tools/schema-eval.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../../packages/qgate/test/helpers/json-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, ''));

const CONFIG_SCHEMA = readJson('schemas/config.schema.json');
const positives = [
  'demo/qgate.config.json',
  'packages/qgate/test/_canonical-config.json',
  'packages/qgate/examples/valid/five-stage.json',
];
// NOTE (t40): `packages/qgate/examples/valid/self-contained-five-stage.json` was removed by t41 as
// a byte-identical, zero-reference orphan copy. It is intentionally NOT referenced here; the
// remaining example covers the same shape, so coverage is not reduced. (T41-1)
for (let i = 2; i < process.argv.length; i += 1) if (process.argv[i] === '--config') positives.push(process.argv[i + 1]);

const cases = [];
for (const rel of positives) {
  const result = validate(CONFIG_SCHEMA, readJson(rel), { rootDocument: CONFIG_SCHEMA });
  cases.push({ id: `positive:${rel}`, expected: 'valid=true', valid: result.valid, errorCount: result.errors.length, errors: result.errors });
}
const mutated = JSON.parse(JSON.stringify(readJson('demo/qgate.config.json')));
mutated.gates[0].checks[0].type = 'file_exist';
const mutResult = validate(CONFIG_SCHEMA, mutated, { rootDocument: CONFIG_SCHEMA });
cases.push({ id: 'negative:demo/qgate.config.json check.type="file_exist"', expected: 'valid=false', valid: mutResult.valid, errorCount: mutResult.errors.length, errors: mutResult.errors });

process.stdout.write(`${JSON.stringify({ evaluator: 'packages/qgate/test/helpers/json-schema.mjs (dependency-free draft 2020-12 subset)', schema: 'schemas/config.schema.json', schemaDraft: CONFIG_SCHEMA.$schema, schemaId: CONFIG_SCHEMA.$id, cases }, null, 2)}\n`);
process.exitCode = cases.every((c) => (c.expected === 'valid=true' ? c.valid : !c.valid)) ? 0 : 1;

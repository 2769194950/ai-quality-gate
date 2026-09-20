#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildStageManifest } from '../../packages/qgate/src/stage-review.mjs';
import { safeExcerpt } from '../../packages/qgate/src/util/text.mjs';

const [stage, output, manifestOutput, diff] = process.argv.slice(2);
if (!stage || !output || !manifestOutput) {
  process.stderr.write('usage: write-stage-context.mjs <stage> <output> <manifest-output> [diff.json]\n');
  process.exit(2);
}
const root = process.cwd();
const manifest = buildStageManifest({
  stage,
  root,
  configPath: path.join(root, 'qgate.config.json'),
  diff: diff ?? null,
});
const lines = [`# qgate stage: ${stage}`, `purpose: ${manifest.purpose}`, `input_fingerprint: ${manifest.inputFingerprint}`, ''];
let budget = 7000;
for (const source of manifest.sources) {
  if (budget <= 0) break;
  const body = safeExcerpt(source.content, Math.min(1200, budget));
  lines.push(`## ${source.path}`, body, '');
  budget -= body.length + source.path.length + 8;
}
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(path.resolve(output), `${lines.join('\n').slice(0, 7000)}\n`);
fs.writeFileSync(path.resolve(manifestOutput), `${JSON.stringify(manifest, null, 2)}\n`);

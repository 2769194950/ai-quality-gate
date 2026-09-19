#!/usr/bin/env node
// Public release guard: verify that the tracked tree does not contain local OCR
// configuration or recognizable long-lived API credentials.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });

if (tracked.error || tracked.status !== 0) {
  console.error(`PUBLIC_RELEASE_CHECK_ERROR: git ls-files failed (${tracked.error?.message || tracked.status})`);
  process.exit(2);
}

const files = tracked.stdout.split('\0').filter(Boolean);
const findings = [];
const credentialPatterns = [
  { name: 'Atria/OCR token', re: /atr_[A-Za-z0-9_-]{20,}/g },
  { name: 'Anthropic token', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenAI-style token', re: /sk-[A-Za-z0-9]{20,}/g },
];

for (const rel of files) {
  if (rel === '.opencodereview/config.json' || rel.endsWith('/.opencodereview/config.json')) {
    findings.push(`${rel}: real OpenCodeReview config must stay outside Git`);
    continue;
  }

  const abs = path.join(ROOT, rel);
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    findings.push(`${rel}: cannot read tracked file (${error.message})`);
    continue;
  }
  if (content.includes('\u0000')) continue;

  // These paths intentionally contain short sentinel credentials used to prove
  // that scanners catch fixture material. They are not runtime configuration.
  if (/(^|[/\\])(test|tests|fixtures|verification-t9)([/\\]|$)/i.test(rel)) continue;

  for (const pattern of credentialPatterns) {
    if (pattern.re.test(content)) findings.push(`${rel}: ${pattern.name} pattern detected`);
    pattern.re.lastIndex = 0;
  }
}

if (findings.length > 0) {
  console.error(`PUBLIC_RELEASE_CHECK_FAILED findings=${findings.length}`);
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`PUBLIC_RELEASE_CHECK_OK tracked_files=${files.length} credential_findings=0`);

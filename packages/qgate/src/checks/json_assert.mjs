// `json_assert` — RFC 6901 pointer assertions (`exists` / `equals` / `matches`)
// against a single JSON file. A missing or unparseable file is FILE_MISSING.
import fs from 'node:fs';
import { clip } from '../util/text.mjs';
import { evidence, missingFileEvidence } from '../evidence.mjs';
import { evaluatePointer, stringifyValue, MISSING } from '../util/jsonptr.mjs';
import { fileExists } from '../util/fsx.mjs';
import { normalizeRel, absOf, result } from './_shared.mjs';

export function checkJsonAssert(ctx, check) {
  const rel = normalizeRel(check.file);
  const abs = absOf(ctx.root, rel);
  const evidenceList = [];
  if (!fileExists(abs)) {
    evidenceList.push(missingFileEvidence(ctx.configPath, rel, `not found: ${rel}`));
    return result(false, evidenceList, `FILE_MISSING: ${rel} does not exist (json_assert requires a single JSON file)`);
  }
  const text = fs.readFileSync(abs, 'utf8');
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    evidenceList.push(evidence(rel, 'file', `JSON parse error: ${error.message}`));
    return result(false, evidenceList, `JSON_ASSERT_FAILED: ${rel} is not parseable JSON (${error.message})`);
  }

  const failures = [];
  for (const assertion of check.assertions) {
    const pointer = assertion.pointer;
    const value = evaluatePointer(document, pointer);
    const exists = value !== MISSING;
    let ok = true;
    let detail = '';
    if (assertion.exists !== undefined) {
      ok = exists === assertion.exists;
      detail = `exists=${exists} expected=${assertion.exists}`;
    }
    if (ok && assertion.equals !== undefined) {
      ok = JSON.stringify(value) === JSON.stringify(assertion.equals);
      detail = `${detail ? `${detail}; ` : ''}equals=${exists ? JSON.stringify(value) : '<missing>'} expected=${JSON.stringify(assertion.equals)}`;
    }
    if (ok && assertion.matches !== undefined) {
      const haystack = stringifyValue(value);
      ok = new RegExp(assertion.matches, 'm').test(haystack);
      detail = `${detail ? `${detail}; ` : ''}matches=/${assertion.matches}/ against ${clip(haystack, 80)}`;
    }
    evidenceList.push(evidence(rel, 'json_pointer', `${pointer} -> ${clip(detail, 200)}`));
    if (!ok) failures.push({ pointer, detail });
  }

  const passed = failures.length === 0;
  const message = passed ? null : `JSON_ASSERT_FAILED: ${rel} ${failures.map((f) => `${f.pointer} (${f.detail})`).join('; ')}`;
  return result(passed, evidenceList, message);
}

export const type = 'json_assert';
export const description = 'assert JSON Pointer predicates against a single JSON document';

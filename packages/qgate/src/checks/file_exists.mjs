// `file_exists` — at least `minCount` (default 1) files must match the glob.
import { globList } from '../util/glob.mjs';
import { evidence, missingFileEvidence, fileEvidence } from '../evidence.mjs';
import { normalizeRel, result } from './_shared.mjs';

export function checkFileExists(ctx, check) {
  const pattern = normalizeRel(check.file);
  const matches = globList(ctx.root, pattern);
  const minCount = check.minCount ?? 1;
  const passed = matches.length >= minCount;
  const evidenceList = matches.slice(0, 5).map((rel) => fileEvidence(ctx.root, rel));
  if (matches.length === 0) {
    evidenceList.push(missingFileEvidence(ctx.configPath, pattern, `glob matched 0 file(s), minCount=${minCount}`));
  } else if (matches.length > 5) {
    evidenceList.push(evidence(matches[0], 'file', `matchedFiles=${matches.length} (first: ${matches.slice(0, 5).join(', ')})`));
  } else {
    evidenceList.push(evidence(matches[0], 'file', `matchedFiles=${matches.length} minCount=${minCount}`));
  }
  return result(passed, evidenceList, passed ? null : `FILE_MISSING: ${pattern} matched ${matches.length} file(s), minCount=${minCount}`);
}

export const type = 'file_exists';
export const description = 'assert that at least minCount files match a repo-relative glob';

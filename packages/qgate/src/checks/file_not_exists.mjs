// `file_not_exists` — no file may match the glob.
import { globList } from '../util/glob.mjs';
import { evidence, fileEvidence, missingFileEvidence } from '../evidence.mjs';
import { normalizeRel, result } from './_shared.mjs';

export function checkFileNotExists(ctx, check) {
  const pattern = normalizeRel(check.file);
  const matches = globList(ctx.root, pattern);
  const passed = matches.length === 0;
  const evidenceList = [];
  for (const rel of matches.slice(0, 5)) evidenceList.push(fileEvidence(ctx.root, rel, 'present (must not exist)'));
  // A satisfied `file_not_exists` has no file to point at, so the deciding
  // artefact is the configuration itself; the reference stays resolvable because
  // `kind="json_pointer"` is inline by contract (§5.3.1).
  evidenceList.push(
    passed
      ? missingFileEvidence(ctx.configPath, pattern, `${pattern} matched 0 file(s), allowed 0`)
      : evidence((ctx.configPath ?? 'qgate.config.json').split('\\').join('/'), 'json_pointer', `${pattern} matched ${matches.length} file(s), allowed 0`),
  );
  return result(passed, evidenceList, passed ? null : `FILE_PRESENT: ${pattern} matched ${matches.length} file(s): ${matches.slice(0, 5).join(', ')}`);
}

export const type = 'file_not_exists';
export const description = 'assert that no file matches a repo-relative glob';

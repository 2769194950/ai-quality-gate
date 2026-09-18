// `regex` — pattern matching across one or more files, with per-file and global
// counting semantics (`each` | `any` | `all` | `count`).
import { globList } from '../util/glob.mjs';
import { readTextIfExists } from '../util/fsx.mjs';
import { clip } from '../util/text.mjs';
import { evidence, fileEvidence, missingFileEvidence } from '../evidence.mjs';
import { internalError } from '../errors.mjs';
import { normalizeRel, absOf, result } from './_shared.mjs';

function collectMatches(re, text) {
  const local = new RegExp(re.source, re.flags);
  const matches = [];
  let match;
  while ((match = local.exec(text)) !== null) {
    matches.push({ value: match[0], index: match.index, line: text.slice(0, match.index).split('\n').length });
    if (match[0] === '') local.lastIndex += 1;
    if (matches.length > 200000) break;
  }
  return matches;
}

export function checkRegex(ctx, check) {
  const flags = check.flags ?? 'gm';
  const mode = check.mode ?? 'each';
  const minMatches = check.minMatches ?? 1;
  const countMode = check.countMode ?? 'total';
  const encoding = check.encoding ?? 'utf8';
  let re;
  try {
    re = new RegExp(check.pattern, flags);
  } catch (error) {
    throw internalError(`regex.pattern is not compilable: ${error.message}`, {
      details: [{ jsonPointer: '/pattern', expected: 'valid regular expression', actual: check.pattern, message: error.message }],
    });
  }

  const files = [];
  for (const declared of check.files) {
    const pattern = normalizeRel(declared);
    const matched = globList(ctx.root, pattern);
    if (matched.length === 0) {
      files.push({ declared: pattern, path: pattern, exists: false, matches: [], text: null });
      continue;
    }
    for (const rel of matched) {
      const text = readTextIfExists(absOf(ctx.root, rel), encoding);
      files.push({
        declared: pattern,
        path: rel,
        exists: text !== null,
        text,
        matches: text === null ? [] : collectMatches(re, text),
      });
    }
  }

  const allMatches = files.flatMap((f) => f.matches.map((m) => ({ ...m, file: f.path })));
  const uniqueValues = [...new Set(allMatches.map((m) => m.value))];
  const perFileUnique = new Map();
  for (const f of files) perFileUnique.set(f.path, new Set(f.matches.map((m) => m.value)));
  const totalCount = allMatches.length;
  const uniqueCount = countMode === 'unique' ? uniqueValues.length : totalCount;

  let passed;
  let reason = '';
  switch (mode) {
    case 'each': {
      const offenders = files.filter(
        (f) => (countMode === 'unique' ? perFileUnique.get(f.path).size : f.matches.length) < minMatches,
      );
      passed = files.length > 0 && offenders.length === 0;
      if (!passed) {
        reason = offenders.length > 0
          ? `files below minMatches=${minMatches}: ${offenders.map((f) => `${f.path}(=${countMode === 'unique' ? perFileUnique.get(f.path).size : f.matches.length})`).join(', ')}`
          : 'no file matched the declared patterns';
      }
      break;
    }
    case 'any': {
      passed = files.some((f) => f.matches.length > 0);
      if (!passed) reason = `no file matched pattern ${check.pattern}`;
      break;
    }
    case 'all': {
      const anchored = new RegExp(check.pattern, flags.replace('g', ''));
      passed = files.length > 0 && files.every((f) => (f.text ?? '') !== '' && anchored.test(f.text ?? ''));
      if (!passed) reason = `not every file matched pattern ${check.pattern}`;
      break;
    }
    case 'count': {
      passed = uniqueCount >= minMatches;
      if (!passed) reason = `${countMode} matches ${uniqueCount} < minMatches=${minMatches}`;
      break;
    }
    default:
      throw internalError(`unsupported regex mode "${mode}"`);
  }

  const evidenceList = [];
  for (const item of files.slice(0, 8)) {
    const sample = item.matches.slice(0, 3).map((m) => `L${m.line}:${clip(m.value, 60)}`).join(' | ');
    if (item.exists) {
      evidenceList.push(fileEvidence(ctx.root, item.path, `${item.matches.length} match(es)${sample ? `; ${sample}` : ''}`));
    } else {
      evidenceList.push(missingFileEvidence(ctx.configPath, item.declared, 'declared pattern matched no file'));
    }
  }
  const anchorPath = files.find((f) => f.exists)?.path ?? normalizeRel(check.files[0]);
  evidenceList.push(
    evidence(anchorPath, 'json_pointer', `pattern=${check.pattern} mode=${mode} countMode=${countMode} totalMatches=${totalCount} uniqueMatches=${uniqueCount} minMatches=${minMatches}`),
  );

  return result(passed, evidenceList, passed ? null : `REGEX_MISMATCH: pattern=${check.pattern} mode=${mode} ${reason}`);
}

export const type = 'regex';
export const description = 'pattern match across files with each|any|all|count semantics';

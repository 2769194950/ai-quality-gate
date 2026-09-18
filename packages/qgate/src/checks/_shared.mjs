// Shared helpers for the seven check executors.
import path from 'node:path';
import { toPosix, globList } from '../util/glob.mjs';
import { evidence } from '../evidence.mjs';

/** Collapse `./`, duplicate separators and `..` so config paths never double up. */
export function normalizeRel(rel) {
  const posix = toPosix(rel).replace(/\/+/g, '/');
  const parts = [];
  for (const segment of posix.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

export function absOf(root, rel) {
  return path.join(root, normalizeRel(rel).split('/').join(path.sep));
}

/** Build a check outcome with a guaranteed non-empty evidence list. */
export function result(passed, evidenceList, message = null) {
  return {
    passed,
    evidence: evidenceList.length > 0 ? evidenceList : [evidence('.', 'stdout', 'no evidence produced')],
    message,
  };
}

export { globList };

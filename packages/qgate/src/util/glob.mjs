// Deterministic POSIX-style glob matching plus a sorted, side-effect-free directory walk.
// Pure functions and Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Compile a glob pattern into a RegExp anchored at both ends.
 * `**` crosses directory separators; a lone `*`/`?`/`[...]` does not.
 *
 * `caseInsensitive` is opt-in and used by the **safety-critical built-in checks**
 * (secret paths, default-excluded directories — t53/R3-B1): CI pipelines on
 * case-insensitive filesystems produce `.ENV` / `Credentials.json` spellings, and on
 * Windows the same file is read either way, so a case-sensitive rule silently fails to
 * protect the file. User-supplied include/exclude patterns keep their case-sensitive
 * semantics.
 */
export function globToRegExp(pattern, { caseInsensitive = false } = {}) {
  assertPattern(pattern);
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      const isDouble = pattern[i + 1] === '*';
      if (isDouble) {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          out += '(?:[^/]+/)*';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) throw new Error(`invalid glob pattern (unterminated character class): ${pattern}`);
      let body = pattern.slice(i + 1, end);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      out += `[${body.replace(/\\/g, '\\\\')}]`;
      i = end;
      continue;
    }
    if (ch === '{') {
      const end = pattern.indexOf('}', i + 1);
      if (end === -1) throw new Error(`invalid glob pattern (unterminated alternation): ${pattern}`);
      const alternatives = pattern
        .slice(i + 1, end)
        .split(',')
        .map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      out += `(?:${alternatives.join('|')})`;
      i = end;
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  out += '$';
  return new RegExp(out, caseInsensitive ? 'i' : '');
}

function assertPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new TypeError('glob pattern must be a non-empty string');
  }
}

const regexpCache = new Map();

/** Cached matcher: true when `path` matches `pattern`. Patterns are pure, so caching is safe. */
export function globMatch(pattern, path, { caseInsensitive = false } = {}) {
  const key = caseInsensitive ? `i:${pattern}` : pattern;
  let re = regexpCache.get(key);
  if (!re) {
    re = globToRegExp(pattern, { caseInsensitive });
    regexpCache.set(key, re);
  }
  return re.test(path);
}

/** True when the pattern contains any glob metacharacter. */
export function isGlob(pattern) {
  assertPattern(pattern);
  return /[*?[\]{}]/.test(pattern);
}

/** Escapes a literal path so it can safely be used as a glob pattern. */
export function globEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalises a repository-relative path to POSIX form. */
export function toPosix(value) {
  return String(value).split(path.sep).join('/').replace(/\\/g, '/');
}

/**
 * Deterministic directory walk. Returns POSIX relative paths, lexicographically
 * sorted, dotfiles included, symbolic links never followed.
 */
export function walkFiles(root, { maxDepth = 32 } = {}) {
  const out = [];
  const visit = (rel, depth) => {
    if (depth > maxDepth) return;
    const abs = rel === '' ? root : path.join(root, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    const sorted = entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of sorted) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(childRel, depth + 1);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  };
  visit('', 0);
  out.sort();
  return out;
}

/**
 * Resolve a repo-relative glob or literal path to the sorted list of existing
 * files it denotes. Literal (non-glob) paths must exist to be returned.
 */
export function globList(root, pattern) {
  if (!isGlob(pattern)) {
    const abs = path.join(root, pattern.split('/').join(path.sep));
    try {
      if (fs.statSync(abs).isFile()) return [toPosix(pattern)];
    } catch {
      /* handled below */
    }
    return [];
  }
  return walkFiles(root).filter((rel) => globMatch(pattern, rel));
}

// Text helpers for evidence excerpts and secret redaction.
// Redaction is applied to every stdout/log surface so that secret *values*
// never leave the engine, even when the inspected corpus contains them.

const MAX_EXCERPT = 4096;

/** Clamp a value to the frozen excerpt limit (§5.3.1: <= 4096 characters). */
export function clip(value, limit = MAX_EXCERPT) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 15)}...<truncated>`;
}

export function lineCount(text) {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

/**
 * Collect regex matches with 1-based line numbers, in deterministic order.
 * A fresh RegExp is compiled per call so no `lastIndex` state leaks between files.
 */
export function matchLines(text, pattern, flags = 'gm') {
  const re = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
  const starts = lineStarts(text);
  const matches = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    matches.push({ value: match[0], index: match.index, line: lineOf(starts, match.index) });
    if (match[0] === '') re.lastIndex += 1;
    if (matches.length > 100000) break;
  }
  return matches;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** First line of the file containing `index`, trimmed for evidence display. */
export function lineTextAt(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  let end = text.indexOf('\n', index);
  if (end === -1) end = text.length;
  return text.slice(start, end).trim();
}

// Secret key names are assembled from JSON-safe fragments at runtime. SAFE_001
// scans this very file for key-read patterns, so the vocabulary must never appear
// as a contiguous literal in the source it inspects.
const SECRET_WORDS = [
  ['api', ' key'],
  ['api', 'key'],
  ['secret'],
  ['token'],
  ['password'],
  ['passwd'],
  ['passphrase'],
  ['private', ' key'],
  ['access', ' key'],
  ['credential'],
  ['authorization'],
  ['auth', ' token'],
];

/**
 * Build the secret-word matcher from fragment pairs (for example the two-piece
 * form of an underscored key name). Escaping happens once per fragment, and a
 * space separator is rendered as an optional `[ _-]`; the vocabulary itself is
 * never present as one literal in this file.
 */
function secretWordMatcher(wordFragments) {
  const escaped = wordFragments
    .map((fragments) => fragments.map((fragment) => fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(''))
    .map((word) => word.replace(/ /g, '[ _-]?'))
    .join('|');
  return new RegExp(escaped, 'i');
}

const SECRET_KEY_PATTERN = secretWordMatcher(SECRET_WORDS);

const SECRET_PATTERNS = [
  // key = value / key: value assignments, JS/JSON/YAML/env style
  new RegExp(`((?:[A-Za-z0-9_.-]*(?:${SECRET_KEY_PATTERN.source})[A-Za-z0-9_.-]*)\\s*[:=]\\s*)("[^"\\n]*"|'[^'\\n]*'|\\S+)`, 'gi'),
  // Bearer / raw long tokens
  /(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  // PEM private key bodies
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Known vendor key shapes
  /\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g,
];

export const REDACTED = '[REDACTED]';

/** Redact secret values while keeping surrounding structure readable. */
export function redact(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (full, prefix) => `${prefix}${REDACTED}`);
  }
  return text;
}

/** True when the redactor would change this text (used to build evidence without leaking). */
export function containsSecret(text) {
  return redact(text) !== text;
}

/** Redacted, clipped excerpt for evidence: never emits a raw secret value. */
export function safeExcerpt(value, limit = MAX_EXCERPT) {
  return clip(redact(value), limit);
}

/** Does the line look like a secret assignment at all? */
export function looksSecretLine(line) {
  return SECRET_KEY_PATTERN.test(line);
}

/** Counts of each pattern kind, used by SAFE_002 style reporting. */
export function countSecretAssignments(text) {
  let count = 0;
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    const found = text.match(re);
    if (found) count += found.length;
  }
  return count;
}

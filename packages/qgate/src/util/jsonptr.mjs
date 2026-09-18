// RFC 6901 JSON Pointer evaluation. Pure, no side effects.
export const MISSING = Symbol('qgate.missing');

/** Escape one reference token per RFC 6901 (~ => ~0, / => ~1). */
export function escapeToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Unescape one reference token per RFC 6901. */
export function unescapeToken(token) {
  return String(token).replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Split a JSON Pointer into reference tokens. `""` => [] ; throws on malformed input. */
export function parsePointer(pointer) {
  if (typeof pointer !== 'string') throw new TypeError('jsonPointer must be a string');
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new TypeError(`jsonPointer must start with "/" or be empty: ${pointer}`);
  return pointer.slice(1).split('/').map(unescapeToken);
}

/** Evaluate a pointer. Returns MISSING when the path cannot be resolved. */
export function evaluatePointer(document, pointer) {
  const tokens = parsePointer(pointer);
  let current = document;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return MISSING;
      const index = Number(token);
      if (index >= current.length) return MISSING;
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return MISSING;
      current = current[token];
      continue;
    }
    return MISSING;
  }
  return current;
}

/** True when the pointer resolves, even to `null`/`false`/`0`. */
export function pointerExists(document, pointer) {
  return evaluatePointer(document, pointer) !== MISSING;
}

/** Deterministic string form of a resolved value, used by `matches` assertions. */
export function stringifyValue(value) {
  if (value === MISSING) return '<missing>';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

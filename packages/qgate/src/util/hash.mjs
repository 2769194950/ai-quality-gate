// Deterministic hashing helpers. Node built-in crypto only, no network, no state.
import { createHash } from 'node:crypto';

/** sha256 hex digest of a string or Buffer. */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Canonical JSON serialization with recursively sorted object keys.
 * Required so that two structurally equal payloads always hash identically.
 */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

/** Stable fingerprint of any JSON-serializable payload (used for fixture matching). */
export function fingerprint(value) {
  return sha256(canonicalJson(value)).slice(0, 16);
}

const HEX = '0123456789abcdef';
const SUFFIX_PATTERN = /[0-9a-f]{8}/;

/**
 * Short hex suffix for run ids. A fixed token can be forced through
 * QGATE_DETERMINISTIC_SUFFIX so that recorded artefacts stay byte-stable.
 */
export function randomHex8(forced) {
  const override = forced ?? globalThis.process?.env?.QGATE_DETERMINISTIC_SUFFIX;
  if (typeof override === 'string' && SUFFIX_PATTERN.test(override)) {
    return override.match(SUFFIX_PATTERN)[0];
  }
  let out = '';
  for (let i = 0; i < 8; i += 1) out += HEX[Math.floor(Math.random() * 16)];
  return out;
}

// Filesystem helpers: atomic writes, readable UTF-8 IO, deterministic JSON snapshots.
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './hash.mjs';

export function readText(absPath, encoding = 'utf8') {
  return stripBom(fs.readFileSync(absPath, encoding));
}

export function readTextIfExists(absPath, encoding = 'utf8') {
  try {
    return stripBom(fs.readFileSync(absPath, encoding));
  } catch {
    return null;
  }
}

/**
 * Drop a leading UTF-8 byte-order mark. Windows editors (Notepad, PowerShell `>`
 * redirection) prepend one and `JSON.parse` rejects it. Only the mark is removed —
 * anything else about the document is untouched, so genuinely malformed JSON is
 * still rejected.
 */
export function stripBom(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Parse JSON text, tolerating a leading BOM. Throws on malformed JSON. */
export function parseJsonText(text) {
  return JSON.parse(stripBom(text));
}

export function fileExists(absPath) {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

export function dirExists(absPath) {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

export function fileSize(absPath) {
  try {
    return fs.statSync(absPath).size;
  } catch {
    return -1;
  }
}

export function sha256File(absPath) {
  try {
    return sha256(fs.readFileSync(absPath));
  } catch {
    return null;
  }
}

/** Pretty JSON with a trailing newline: byte-stable for a given value. */
export function stringifyJson(value, { indent = 2 } = {}) {
  return `${JSON.stringify(value, null, indent)}\n`;
}

export function writeJsonFile(absPath, value, options = {}) {
  writeFileAtomic(absPath, stringifyJson(value, options));
}

/** Write via a temporary sibling file + rename so readers never see a partial file. */
export function writeFileAtomic(absPath, content) {
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, absPath);
}

/** Append-only write: fails loudly instead of overwriting an existing artefact. */
export function writeFileExclusive(absPath, content) {
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const handle = fs.openSync(absPath, 'wx');
  try {
    fs.writeFileSync(handle, content);
  } finally {
    fs.closeSync(handle);
  }
}

export function ensureDir(absPath) {
  fs.mkdirSync(absPath, { recursive: true });
}

export function listDir(absPath) {
  try {
    return fs
      .readdirSync(absPath, { withFileTypes: true })
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

/** RFC3339 UTC timestamp with millisecond precision. */
export function rfc3339(date = new Date()) {
  return date.toISOString();
}

/** run_id form frozen by the contract: `<timestamp>-<hex8>` (colons replaced by dashes). */
export function makeRunId(startedAtIso, hex8) {
  return `${String(startedAtIso).replace(/:/g, '-')}-${hex8}`;
}

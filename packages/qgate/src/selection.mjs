// Deterministic file selection, a faithful re-implementation of the
// `open-code-review` selection pipeline (docs/01-architecture.md §4.1).
//
// Frozen filter order (REQ-012):
//   binary -> secret path -> user exclude -> user include -> extension
//   -> default excluded path -> size/token budget -> deleted
//
// The secret-path stage runs *before* the user include stage and is not
// overridable: no `include` pattern can re-admit a built-in sensitive path.
// Pure and side-effect free: same input => byte-identical output.
import path from 'node:path';
import fs from 'node:fs';
import { walkFiles, globMatch, toPosix } from './util/glob.mjs';
import { fileSize } from './util/fsx.mjs';
import { sha256 } from './util/hash.mjs';

export const DEFAULT_EXCLUDED_PATHS = Object.freeze([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.qgate/evidence',
  // Runtime products of a run (reports/bundles) are evidence of *running*, not part of the
  // revision: leaving them in made the root `SAFE_002` selection grow by one file per demo
  // `check`, i.e. the same RunResult instability from a second source (t63/F19).
  '.qgate/reports',
  '.qgate/out',
  // The audit/evidence trees are not the implementation surface. The engine writes its own
  // ledger/report products there and the verifier writes its evidence there, so scanning them
  // made `SAFE_002`'s `metrics.selected` follow *other agents' writes*: two runs of the same
  // revision produced different RunResult text (t63/F19, REQ-010 "same input, same output").
  // `policy.mjs`'s `SKIP_DIRECTORIES` already treats both trees as outside the scan surface
  // (SAFE_001/SAFE_003), and the root config has no `selection` of its own — this brings the
  // selection pipeline (and therefore SAFE_002, which uses the built-in list) in line.
  'verification',
  'verification-t9',
]);

export const DEFAULT_EXTENSIONS = Object.freeze([
  '.mjs',
  '.js',
  '.cjs',
  '.json',
  '.md',
  '.yaml',
  '.yml',
  '.txt',
]);

/** Built-in sensitive path rules. These are evaluated before user `include`. */
export const SECRET_PATH_RULES = Object.freeze([
  Object.freeze({ id: 'secret-env', pattern: '**/.env*', description: 'dotenv files' }),
  Object.freeze({ id: 'secret-pem', pattern: '**/*.pem', description: 'PEM certificates and keys' }),
  Object.freeze({ id: 'secret-key', pattern: '**/*.key', description: 'private key material' }),
  Object.freeze({ id: 'secret-rsa', pattern: '**/id_rsa*', description: 'ssh private keys' }),
  Object.freeze({ id: 'secret-credentials', pattern: '**/credentials*', description: 'credential stores' }),
  Object.freeze({ id: 'secret-dir', pattern: '**/secrets/**', description: 'secrets directory' }),
  Object.freeze({ id: 'secret-p12', pattern: '**/*.p12', description: 'PKCS#12 bundles' }),
  Object.freeze({ id: 'secret-kubeconfig', pattern: '**/.kube/config', description: 'kubernetes credentials' }),
]);

/** Built-in binary extensions plus a NUL-byte sniff fallback. */
export const BINARY_EXTENSIONS = Object.freeze([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.pdf', '.zip', '.gz', '.tar',
  '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin', '.class', '.jar', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.avi', '.wasm', '.node',
]);

export const FILTER_ORDER = Object.freeze([
  'binary',
  'secret_path',
  'user_exclude',
  'user_include',
  'extension',
  'default_excluded_path',
  'size_budget',
  'deleted',
]);

export const EXCLUSION_REASONS = Object.freeze([
  'binary',
  'secret_path',
  'user_exclude',
  'not_included',
  'extension',
  'default_excluded_path',
  'size_budget',
  'deleted',
]);

export function normalizeSelectionOptions(options = {}) {
  return {
    include: options.include ?? ['**/*'],
    exclude: options.exclude ?? [],
    // Deliberately **not** lower-cased: the file's extension is compared in lower case,
    // so a configuration that spells `.PNG`/`.MD` in its own allowlist matches nothing
    // and the file is excluded (`extension`) — the fail-closed direction. Lower-casing
    // the entries would let files back into `selected`, which t53 forbids.
    extensions: (options.extensions ?? DEFAULT_EXTENSIONS).map((e) => (e.startsWith('.') ? e : `.${e}`)),
    defaultExcludedPaths: options.defaultExcludedPaths ?? DEFAULT_EXCLUDED_PATHS,
    maxFileSizeBytes: options.maxFileSizeBytes ?? 262144,
  };
}

const SECRET_READERS = new Map();

/**
 * Returns true when the file content is binary (NUL byte in the first 4 KiB).
 * Results are cached per absolute path within a process so selection stays cheap
 * and deterministic.
 */
function isBinaryContent(absPath, { maxBytes = 4096 } = {}) {
  if (SECRET_READERS.has(absPath)) return SECRET_READERS.get(absPath);
  let result = false;
  try {
    const fd = fs.openSync(absPath, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
      result = buffer.subarray(0, read).includes(0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    result = false;
  }
  SECRET_READERS.set(absPath, result);
  return result;
}

/**
 * True when `rel` matches one of the built-in sensitive path rules by **name**.
 *
 * Matching is **case-insensitive** (t53/R3-B1): a CI diff generated on a
 * case-sensitive filesystem can spell the file `Credentials.json` / `.ENV` /
 * `Secrets/Db.Txt`, and on Windows the same file is read whatever the case — a
 * case-sensitive rule would silently fail to protect it. Only the comparison is
 * insensitive; the rule list stays lowercase. The identity chain below reuses this
 * helper, so an alias of a case-variant sensitive file is caught by the same rule.
 */
export function sensitiveNameRule(rel) {
  const posix = toPosix(rel);
  return (
    SECRET_PATH_RULES.find(
      (rule) =>
        globMatch(rule.pattern, posix, { caseInsensitive: true }) ||
        globMatch(`/${rule.pattern}`, `/${posix}`, { caseInsensitive: true }),
    ) ?? null
  );
}

/** Byte-identity key of a file: `${size}:${sha256}` (used with the `sha:` prefix). */
function contentKey(absPath, stat) {
  try {
    return `${stat.size}:${sha256(fs.readFileSync(absPath))}`;
  } catch {
    return null;
  }
}

/**
 * Identity chain of the built-in sensitive paths (t46/R3-H1).
 *
 * A hard link is *the same file* reached through another name, so `docs.txt` pointing at
 * `.env` has a perfectly harmless path and passes every name rule. This collects the
 * identity of **every candidate that is sensitive by name** — including the ones the
 * name rules already exclude, because the alias needs the excluded file's identity (the
 * mistake t42 found on the adapter side: collecting identities only from the surviving
 * set) — and hands it to the filter chain.
 *
 * Two signals, both consumed only for `nlink > 1` candidates, so ordinary files cost
 * nothing:
 *   A. `ino:<dev>:<ino>` — the same inode as a sensitive file (the primary signal; the
 *      adapter's regression cases rely on it and it fires for real hard links here);
 *   B. `sha:<size>:<sha256>` — byte-identical content to a sensitive file. This is the
 *      fallback for layouts/filesystems where a hard link is not reported to share
 *      `st_dev`/`st_ino` (measured on Windows, see t42), and it is *exact* rather than a
 *      shape heuristic: a hard link is byte-identical by definition.
 */
export function sensitivePathIdentities(root, candidates = []) {
  const identities = new Map();
  for (const rel of candidates) {
    const rule = sensitiveNameRule(rel);
    if (!rule) continue;
    const abs = path.join(root, toPosix(rel).split('/').join(path.sep));
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const entry = { sensitivePath: toPosix(rel), rule: rule.id };
    identities.set(`ino:${stat.dev}:${stat.ino}`, { ...entry, via: 'same-inode-as-sensitive-path' });
    const key = contentKey(abs, stat);
    if (key !== null && !identities.has(`sha:${key}`)) {
      identities.set(`sha:${key}`, { ...entry, via: 'same-content-as-sensitive-path' });
    }
  }
  return identities;
}

/**
 * Returns the sensitive file this path is an *alias* of, or null. The `nlink > 1` gate
 * mirrors the adapter (`SAFETY-005-HARDLINK-ALIAS`): only a file that is hard-linked can
 * be an alias of something else, and the gate keeps the common case free of I/O.
 */
export function sensitiveAliasOf(relPath, { root, identities }) {
  if (!identities || identities.size === 0) return null;
  const abs = path.join(root, toPosix(relPath).split('/').join(path.sep));
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const nlink = Number.isFinite(stat.nlink) ? stat.nlink : 1;
  if (nlink <= 1) return null;
  const byInode = identities.get(`ino:${stat.dev}:${stat.ino}`);
  if (byInode) return byInode;
  const key = contentKey(abs, stat);
  if (key === null) return null;
  return identities.get(`sha:${key}`) ?? null;
}

/**
 * Filter a single repo-relative file path through the frozen filter chain.
 * Returns `{ included: true, stage }` or `{ included: false, reason, rule, stage }`.
 */
export function filterFile(relPath, options, { root, exists = true, isBinary = null, sensitiveIdentities = null } = {}) {
  const opts = normalizeSelectionOptions(options);
  const posix = toPosix(relPath);
  const absolute = path.join(root, posix.split('/').join(path.sep));

  // 1. binary
  const ext = path.extname(posix).toLowerCase();
  if (BINARY_EXTENSIONS.includes(ext)) {
    return { included: false, reason: 'binary', rule: `extension:${ext}`, stage: 'binary' };
  }
  if (isBinary === null ? isBinaryContent(absolute) : isBinary) {
    return { included: false, reason: 'binary', rule: 'content:NUL', stage: 'binary' };
  }

  // 2. secret path — BEFORE user include, never overridable. Matching is
  // case-insensitive (t53/R3-B1) and `sensitiveNameRule` is the single source of truth,
  // so selection, the preview invariant and SAFE_002 cannot drift apart.
  const secret = sensitiveNameRule(posix);
  if (secret) {
    return { included: false, reason: 'secret_path', rule: secret.id, stage: 'secret_path' };
  }

  // 2b. identity chain (t46/R3-H1): a hard link whose *name* is harmless is still the
  // sensitive file. The reason stays inside the frozen `EXCLUSION_REASONS` set
  // (`secret_path`) and the free-form `rule` string carries the machinery-readable
  // detail `alias:<sensitiveRuleId>:<via>` — no new reason, no new field. The adapter's
  // equivalent vocabulary is `reason=hardlink_secret_alias:<via>` +
  // `ruleId=SAFETY-005-HARDLINK-ALIAS`.
  const alias = sensitiveAliasOf(posix, { root, identities: sensitiveIdentities });
  if (alias) {
    return { included: false, reason: 'secret_path', rule: `alias:${alias.rule}:${alias.via}`, stage: 'secret_path' };
  }

  // 3. user exclude
  for (const pattern of opts.exclude) {
    if (globMatch(pattern, posix)) {
      return { included: false, reason: 'user_exclude', rule: `exclude:${pattern}`, stage: 'user_exclude' };
    }
  }

  // 4. user include
  if (!opts.include.some((pattern) => globMatch(pattern, posix))) {
    return { included: false, reason: 'not_included', rule: 'include:none', stage: 'user_include' };
  }

  // 5. extension allowlist
  if (!opts.extensions.includes(ext)) {
    return { included: false, reason: 'extension', rule: `extensions:${ext || '<none>'}`, stage: 'extension' };
  }

  // 6. default excluded path (built-in). Case-insensitive (t53/R3-B1): `NODE_MODULES/`,
  // `.GIT/` and `Dist/` are the same directories on a case-insensitive filesystem, and
  // this step only ever *adds* exclusions, so the comparison cannot re-admit anything.
  const loweredPosix = posix.toLowerCase();
  const defaultExclude = opts.defaultExcludedPaths.find((entry) => {
    const lowered = String(entry).toLowerCase();
    return (
      loweredPosix === lowered ||
      loweredPosix.startsWith(`${lowered}/`) ||
      globMatch(`**/${lowered}/**`, loweredPosix) ||
      globMatch(`**/${lowered}`, loweredPosix)
    );
  });
  if (defaultExclude) {
    return { included: false, reason: 'default_excluded_path', rule: `builtin:${defaultExclude}`, stage: 'default_excluded_path' };
  }

  // 7. size / token budget
  const size = fileSize(absolute);
  if (size >= 0 && size > opts.maxFileSizeBytes) {
    return { included: false, reason: 'size_budget', rule: `maxFileSizeBytes:${opts.maxFileSizeBytes}`, stage: 'size_budget', size };
  }

  // 8. deleted
  if (!exists) {
    return { included: false, reason: 'deleted', rule: 'exists:false', stage: 'deleted' };
  }

  return { included: true, reason: null, rule: null, stage: null, size: size < 0 ? 0 : size };
}

/**
 * Run selection over a repository. `candidates` may be supplied explicitly
 * (used by tests and by `--preview` on a synthetic tree); otherwise the root is walked.
 */
export function selectFiles(root, options = {}, { candidates = null } = {}) {
  const opts = normalizeSelectionOptions(options);
  const files = candidates
    ? candidates.map(toPosix).slice().sort()
    : walkFiles(root).map(toPosix);
  // Identity of every sensitive path among the candidates (including the ones the name
  // rules exclude), so a harmless-named hard link to one of them cannot be selected.
  const identities = sensitivePathIdentities(root, files);
  const included = [];
  const excluded = [];
  for (const rel of files) {
    const decision = filterFile(rel, opts, { root, sensitiveIdentities: identities });
    if (decision.included) included.push(rel);
    else excluded.push({ path: rel, reason: decision.reason, rule: decision.rule, stage: decision.stage });
  }
  included.sort();
  excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { included, excluded };
}

/**
 * The safety invariant of REQ-012: with the widest possible include pattern
 * (`**`), no built-in sensitive path may appear in the selection result.
 * Returns the violating paths (empty array == invariant holds).
 */
export function assertNoSecretPathsSelected(root, { include = ['**/*'], candidates = null } = {}) {
  const result = selectFiles(root, { include, exclude: [], extensions: [...DEFAULT_EXTENSIONS, '.env', '.pem', '.key', '.p12'] }, { candidates });
  // Same case-insensitive rule as the filter chain (t53/R3-B1): an invariant computed
  // with a different rule than the one that excludes would report a false "clean".
  const violations = result.included.filter((rel) => sensitiveNameRule(rel) !== null);
  return { violations, selected: result.included, excluded: result.excluded };
}

export { walkFiles };

export const selectionVersion = '1.0';

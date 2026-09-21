// SAFE_001 / SAFE_002 / SAFE_003 / CONTRACT_001 policy implementations (§5.1 policy table).
//
// These four policies are the code-level enforcement of the three hard
// properties of the deliverable: no API key, no network, no re-admitting of
// secret paths. Forbidden tokens are assembled from fragments at runtime so the
// policy module itself never contains the literal it searches for.
import path from 'node:path';
import fs from 'node:fs';
import { walkFiles, globMatch } from './util/glob.mjs';
import { readTextIfExists, fileSize } from './util/fsx.mjs';
import { safeExcerpt, redact, REDACTED } from './util/text.mjs';
import { selectFiles, SECRET_PATH_RULES, sensitiveNameRule } from './selection.mjs';

export const SAFE_001 = 'SAFE_001';
export const SAFE_002 = 'SAFE_002';
export const SAFE_003 = 'SAFE_003';
export const CONTRACT_001 = 'CONTRACT_001';

/**
 * Directories that are never part of the implementation surface.
 *
 * The verification and artifact directories hold *recorded evidence*: they quote the
 * very violation text these policies emit, so scanning them is self-referential echo
 * rather than inspection of shipped code.
 */
const SKIP_DIRECTORIES = ['.git', 'node_modules', '.qgate', 'coverage', 'dist', 'build', '.cache', 'verification', 'verification-t9', 'artifacts'];

/**
 * Implementation surface scanned by SAFE_001 / SAFE_003.
 *
 * Prose files (`.md`/`.txt`) are deliberately NOT part of the default scan set: a
 * document can only *name* a forbidden construct (this repository's own contract
 * does exactly that in its §5.1 policy table), it cannot read a key or open a
 * socket. Scanning prose therefore buys no security and produces mass false
 * positives. A configuration that wants prose covered lists it explicitly via
 * `policy.expectedFiles`, which bypasses this filter.
 */
const CODE_EXTENSIONS = ['.mjs', '.js', '.cjs', '.mjsx', '.jsx', '.ts', '.tsx', '.json', '.yaml', '.yml', '.toml', '.ini', '.sh', '.bash', '.ps1', '.psm1', '.py', '.rb', '.go', '.java', '.cs', '.env'];
const MAX_SCAN_BYTES = 1048576;

/**
 * Test fixtures are not the shipped implementation surface: a suite that sets
 * sentinel key variables (or builds a call-surface sample) to *prove* the code does
 * not use them would otherwise be reported as the very hazard it is guarding
 * against. A configuration that wants tests covered lists them explicitly via
 * `policy.expectedFiles`, which bypasses this filter.
 */
const TEST_PATH_PATTERNS = [
  /(^|\/)tests?\//,
  /(^|\/)__tests__\//,
  /(^|\/)fixtures?\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
];

/**
 * A JS/JSON member name: `_` is a name character, so `_KEY` stays whole.
 */
const NAME = '[A-Za-z_$][A-Za-z0-9_$]*';
/** Sensitive-name vocabulary, assembled so this file never contains a read literal. */
const SENSITIVE_WORDS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASSPHRASE', 'CREDENTIAL', 'APIKEY', 'AUTH'];
const SENSITIVE_NAME = `[A-Za-z0-9_$]*(?:${SENSITIVE_WORDS.join('|')})[A-Za-z0-9_$]*`;
/**
 * Negative lookahead for "this is a definition, not a read": `X = …` assignments and
 * `X: …` object-literal keys are excluded, so only reads are reported.
 */
const NOT_A_DEFINITION = '(?!\\s*(?:=(?!=)|:))';

/**
 * Blank out code comments while preserving every byte offset and line break, so a
 * violation still reports the real source line.
 *
 * Comment syntax is the one *prose* form that survives the prose-file exclusion of
 * `scanCategory`: a `.mjs` file that documents "never write `process.env.X_API_KEY`"
 * is scannable code, and t26's boundary ("prose cannot read a key") did not cover it.
 * The captain's ruling for t34 is to skip comment syntax **only**; nothing else
 * changes — non-comment code, including a string literal that spells such a read,
 * keeps exactly the previous strength.
 *
 * The scanner is quote-aware (a `//` inside a string is not a comment) and
 * regex-literal-aware (a `/` starts a regex only where a value may start), so a
 * pattern such as `/https?|net/` is not mistaken for a line comment.
 */
export function stripComments(text) {
  const chars = text.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < chars.length; i += 1) if (chars[i] !== '\n') chars[i] = ' ';
  };
  let i = 0;
  let prevSignificant = '';
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < chars.length) {
        if (chars[i] === '\\') {
          i += 2;
          continue;
        }
        if (chars[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      prevSignificant = quote;
      continue;
    }
    if (ch === '/') {
      const next = chars[i + 1];
      if (next === '/') {
        // `//` opens a line comment — except inside a URL scheme (`https://…`), which is
        // ordinary data in the YAML/config files this surface also scans. Blanking the
        // rest of the line after a `://` would hide a real read written later on that
        // same line (measured, t46/R3-H2 sibling case). Fail closed: `://` is text.
        const schemeChar = chars[i - 2];
        if (chars[i - 1] === ':' && schemeChar !== undefined && /[A-Za-z0-9+.-]/.test(schemeChar)) {
          i += 2;
          prevSignificant = '/';
          continue;
        }
        const end = text.indexOf('\n', i);
        const stop = end === -1 ? chars.length : end;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (next === '*') {
        // A block comment is only a comment when it is actually **closed**. An
        // unterminated `/*` — the ordinary YAML scalar `path: /*/build` is one, because
        // the `*/` it contains overlaps the opener — must be treated as plain text.
        // Blanking to end-of-file would blind the assertion for the whole rest of the
        // file, which is the worst possible failure mode for a safety check
        // (t36/R3-H2). Fail closed: prefer over-reporting to a silent miss.
        const end = text.indexOf('*/', i + 2);
        if (end === -1) {
          i += 2;
          prevSignificant = '*';
          continue;
        }
        blank(i, end + 2);
        i = end + 2;
        continue;
      }
      if (canStartRegex(prevSignificant)) {
        i += 1;
        let inClass = false;
        while (i < chars.length) {
          const c = chars[i];
          if (c === '\\') {
            i += 2;
            continue;
          }
          if (c === '\n') break;
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) {
            i += 1;
            break;
          }
          i += 1;
        }
        prevSignificant = '/';
        continue;
      }
      prevSignificant = '/';
      i += 1;
      continue;
    }
    prevSignificant = ch;
    i += 1;
  }
  return chars.join('');
}

/** A `/` may start a regex literal only where a value may start. */
function canStartRegex(prev) {
  return prev === '' || '([{,;=:!&|?+-*%^~<>'.includes(prev);
}

/** The source line that contains `index`, taken from the *original* text. */
function lineAt(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  let lineEnd = text.indexOf('\n', index);
  if (lineEnd === -1) lineEnd = text.length;
  return text.slice(lineStart, lineEnd).trim();
}

/**
 * SAFE_001 matchers: **read** constructs only (docs/01-architecture.md §5.1 says the
 * policy asserts the absence of key *reads*, not of the words themselves).
 *
 *  1. environment reads: `<env>.NAME`, `<env>['NAME']`, `<env>["NAME"]`
 *     where `<env>` is a known environment accessor and NAME contains a sensitive
 *     word anywhere (`ANTHROPIC_API_KEY`, `MY_SECRET_TOKEN`, `_KEY`, …).
 *     Underscores are name characters, so a trailing `_KEY` is never cut off.
 *  2. `getenv('NAME')` style calls.
 *  3. vault references: an identifier member access on the vault object.
 *
 * Everything is context-anchored, so a comment or a string that merely mentions a
 * word like "apiKey" no longer matches.
 */
const ENV_ACCESSORS = ['process\\.env', 'import\\.meta\\.env', 'Deno\\.env', 'os\\.environ', 'os\\.getenv'];
// Case-insensitive on purpose: Windows environment-variable names are not
// case-sensitive, so `process.env.anthropic_api_key` reads exactly the same secret as
// the upper-case spelling (review-round2 high-3).
const KEY_READ_PATTERNS = [
  {
    label: 'environment key read',
    regex: new RegExp(
      `(?:${ENV_ACCESSORS.join('|')})\\s*(?:\\.\\s*(${SENSITIVE_NAME})|\\[\\s*(['"])(${SENSITIVE_NAME})\\2\\s*\\])${NOT_A_DEFINITION}`,
      'gi',
    ),
  },
  {
    label: 'environment key read (call)',
    regex: new RegExp(`\\b(?:getenv|GetEnvironmentVariable)\\s*\\(\\s*(['"])(${SENSITIVE_NAME})\\1`, 'gi'),
  },
  {
    label: 'vault reference',
    regex: new RegExp(`\\b(?:vault|secrets)\\s*\\.\\s*(${NAME})`, 'gi'),
  },
];

/**
 * SAFE_003 matchers: network call surface. Same fragment discipline as above — the
 * literal forms are assembled at runtime so the policy module never trips itself.
 *
 * The socket module is matched through its actual API members rather than any member
 * access on the module name: a bare module-name prefix also matches innocuous text
 * such as a file name that merely contains that word, which is noise rather than a
 * call surface.
 */
const NET_MODULE_MEMBERS = ['createServer', 'createConnection', 'connect', 'Socket', 'Server', 'isIP', 'isIPv4', 'isIPv6', 'getDefaultAutoSelectFamily'];
/** Node modules whose mere import is a network capability. */
const NET_MODULE_NAMES = ['https?', 'net', 'dns', 'tls', 'dgram', 'undici'];
/** Members whose call on a network-module/client binding is a network surface. */
const NET_CALL_MEMBERS = ['request', 'get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'send', 'connect', 'createServer', 'createConnection', 'Socket', 'Server', 'bind'];
/** Globals that open a network surface when called. */
const NET_GLOBAL_NAMES = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];
/**
 * HTTP-client package *names*. A `<name>.get(url)` call on one of these is the
 * documented review-round2 bypass (`axios.get(url)`, `client.get(url)`) where the
 * binding cannot be recovered textually (no import in the sample file). This is a
 * deliberate fail-closed name heuristic: a false positive costs a rename, a false
 * negative costs a silent network call. The measured repo-wide impact is 0 hits.
 */
const NET_CLIENT_NAMES = ['axios', 'got', 'superagent', 'needle', 'undici', 'ky', 'node-fetch', 'request', 'client', 'httpClient', 'apiClient', 'httpAgent'];
const NETWORK_TOKEN_SOURCES = [
  { parts: ['fetch', '('], note: 'global fetch call' },
  { parts: ['net', '.', { raw: `(?:${NET_MODULE_MEMBERS.join('|')})\\b` }], note: 'net module call' },
  { parts: [{ literal: 'http', optional: 's' }, '.request'], note: 'http request surface' },
  { parts: [{ literal: 'http', optional: 's' }, '.get'], note: 'http get surface' },
  { parts: [{ literal: 'http', optional: 's' }, '.post'], note: 'http post surface' },
  { parts: [{ literal: 'http', optional: 's' }, '.connect'], note: 'http connect surface' },
  {
    // `await import('node:https')`, `import * as h from 'node:http'`, `require('https')`:
    // loading a network module is the capability itself (review report M5 / round2).
    parts: [{ raw: `(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)(['"])(?:node:)?(?:${NET_MODULE_NAMES.join('|')})\\1` }],
    note: 'network module import/require surface',
    label: 'network module import/require (network import surface)',
    flags: 'gi',
  },
  {
    // Named network client called through its package name (no import needed).
    parts: [{ raw: `\\b(?:${NET_CLIENT_NAMES.join('|')})\\s*\\.\\s*(?:${NET_CALL_MEMBERS.join('|')})\\s*\\(` }],
    note: 'named network client call surface',
    label: '(named network client).call() (network client surface)',
    flags: 'gi',
  },
];

/**
 * Bindings recovered from the file text so an aliased call is still a network surface:
 *   `import * as h from 'node:http'; h.request(...)`   -> namespace alias
 *   `import { request as r } from 'node:http'; r(...)` -> member alias
 *   `const h = require('https'); h.get(...)`           -> require alias
 *   `const f = fetch; f(url)`                          -> global alias
 * Returns a Map of identifier -> 'module' | 'global' plus the set of directly bound
 * member call names (all of them callables).
 */
function networkBindings(text) {
  const bindings = new Map();
  const memberCalls = new Set();
  const moduleAlt = NET_MODULE_NAMES.join('|');
  let match;
  const importRe = new RegExp(
    `\\bimport\\s+(?:\\*\\s+as\\s+([A-Za-z_$][\\w$]*)|([A-Za-z_$][\\w$]*)|\\{([^}]*)\\})\\s*from\\s*(['"])(?:node:)?(?:${moduleAlt})\\4`,
    'g',
  );
  while ((match = importRe.exec(text)) !== null) {
    if (match[1]) bindings.set(match[1], 'module');
    if (match[2]) bindings.set(match[2], 'module');
    if (match[3]) {
      for (const part of match[3].split(',')) {
        const renamed = /([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/.exec(part);
        if (renamed) memberCalls.add(renamed[2]);
        else if (/^[A-Za-z_$][\w$]*$/.test(part.trim())) memberCalls.add(part.trim());
      }
    }
  }
  const requireRe = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?(?:require\\s*\\(\\s*|import\\s*\\(\\s*)?(['"])(?:node:)?(?:${moduleAlt})\\2\\s*\\)?`,
    'g',
  );
  while ((match = requireRe.exec(text)) !== null) bindings.set(match[1], 'module');
  const destructureRe = new RegExp(
    `\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\s*\\(\\s*(['"])(?:node:)?(?:${moduleAlt})\\2\\s*\\)`,
    'g',
  );
  while ((match = destructureRe.exec(text)) !== null) {
    for (const part of match[1].split(',')) {
      const renamed = /([A-Za-z_$][\w$]*)\s*(?::|as)\s*([A-Za-z_$][\w$]*)/.exec(part);
      if (renamed) memberCalls.add(renamed[2]);
      else if (/^[A-Za-z_$][\w$]*$/.test(part.trim())) memberCalls.add(part.trim());
    }
  }
  const globalRe = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:globalThis\\.|global\\.|window\\.)?(?:${NET_GLOBAL_NAMES.join('|')})\\b`,
    'g',
  );
  while ((match = globalRe.exec(text)) !== null) bindings.set(match[1], 'global');
  return { bindings, memberCalls };
}

/** Calls made through a binding recovered above. */
function findAliasedNetworkCalls(text) {
  const hits = [];
  const { bindings, memberCalls } = networkBindings(text);
  if (bindings.size === 0 && memberCalls.size === 0) return hits;
  const memberRe = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*(${NET_CALL_MEMBERS.join('|')})\\s*\\(`, 'g');
  let match;
  while ((match = memberRe.exec(text)) !== null) {
    if (bindings.get(match[1]) !== 'module') continue;
    hits.push({ index: match.index, matched: `${match[1]}.${match[2]}(` });
  }
  const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  while ((match = callRe.exec(text)) !== null) {
    const name = match[1];
    if (bindings.get(name) !== 'global' && !memberCalls.has(name)) continue;
    hits.push({ index: match.index, matched: `${name}(` });
  }
  return hits;
}

/**
 * `globalThis['fe' + 'tch'](url)` — a computed member access whose parts are string
 * literals. The concatenation is evaluated deterministically (no `eval`): if it names a
 * network global or a network module, the access is the surface. A non-literal index is
 * left alone (it would require data-flow analysis, not text matching).
 */
function findComputedGlobalNetworkAccess(text) {
  const hits = [];
  const accessRe = /\b(globalThis|global|window)\s*\[\s*([^\]\n]*)\]/g;
  const literalPartRe = /(['"])((?:\\.|(?!\1).)*)\1/g;
  const partsOnlyRe = /^\s*(?:['"](?:\\.|[^'"])*['"])(?:\s*\+\s*(?:['"](?:\\.|[^'"])*['"]))*\s*$/;
  let match;
  while ((match = accessRe.exec(text)) !== null) {
    const content = match[2];
    if (!partsOnlyRe.test(content)) continue;
    let concatenated = '';
    let literal;
    while ((literal = literalPartRe.exec(content)) !== null) concatenated += literal[2];
    const isNetworkGlobal = NET_GLOBAL_NAMES.some((name) => name.toLowerCase() === concatenated.toLowerCase());
    const isNetworkModule = new RegExp(`^(?:node:)?(?:${NET_MODULE_NAMES.join('|')})$`, 'i').test(concatenated);
    if (!isNetworkGlobal && !isNetworkModule) continue;
    hits.push({ index: match.index, matched: `${match[1]}['${concatenated}']` });
  }
  return hits;
}

/**
 * Build a matcher from literal fragments. Each fragment is escaped exactly once
 * and the pieces are glued directly; `\b` is added only where the neighbouring
 * fragment starts/ends with a word character. The trailing token of the call
 * pattern is a punctuation character, so no boundary may follow it (a boundary
 * there could never match).
 */
function tokenRegExp(parts) {
  const source = parts
    .map((part) => {
      if (typeof part === 'object' && part !== null) {
        if (part.raw) return part.raw;
        return `${escapeFragment(part.literal)}${part.optional ? `${part.optional}?` : ''}`;
      }
      return escapeFragment(part);
    })
    .join('');
  const firstPart = parts[0];
  const first = typeof firstPart === 'object' ? firstPart.literal ?? '' : firstPart;
  const lastPart = parts[parts.length - 1];
  const last = typeof lastPart === 'object' ? lastPart.literal ?? '' : lastPart;
  const head = /^[A-Za-z0-9_]/.test(first) ? '\\b' : '';
  const tail = /[A-Za-z0-9_]$/.test(last) ? '\\b' : '';
  return new RegExp(`${head}${source}${tail}`, 'g');
}

function escapeFragment(fragment) {
  return String(fragment).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fragmentLabel(part) {
  if (typeof part !== 'object') return part;
  if (part.raw) return `(?:${part.raw})`;
  return `${part.literal}${part.optional ?? ''}`;
}

const NETWORK_TOKENS = [
  ...NETWORK_TOKEN_SOURCES.map((source) => ({
    label: source.label ?? `${source.parts.map(fragmentLabel).join('')} (${source.note})`,
    regex: tokenRegExp(source.parts),
    flags: source.flags ?? 'g',
  })),
  // Derived (per-file) matchers: they need the file's bindings, not a single regex.
  { label: '(aliased network call) (network call surface)', find: findAliasedNetworkCalls },
  { label: "(globalThis['…' + '…']) (computed network access surface)", find: findComputedGlobalNetworkAccess },
];

/** Repository root used by policy scans (config root may sit in a subdirectory). */
export function resolveRepoRoot(configRoot) {
  let current = path.resolve(configRoot);
  for (let depth = 0; depth < 8; depth += 1) {
    const markers = [
      path.join(current, 'packages', 'qgate', 'bin', 'qgate.mjs'),
      path.join(current, 'docs', '00-requirements.md'),
      path.join(current, '.git'),
    ];
    if (markers.some((marker) => fs.existsSync(marker))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(configRoot);
}

const PROSE_EXTENSIONS = ['.md', '.txt', '.rst', '.adoc'];

/** Sort one candidate path into the reason it is (or is not) part of the scan surface. */
function scanCategory(rel, { extensions = CODE_EXTENSIONS } = {}) {
  const segments = rel.split('/');
  if (segments.some((segment) => SKIP_DIRECTORIES.includes(segment))) return 'evidence-or-generated';
  if (TEST_PATH_PATTERNS.some((pattern) => pattern.test(rel))) return 'fixture';
  const ext = path.extname(rel).toLowerCase();
  if (segments[segments.length - 1].startsWith('.env')) return 'scanned';
  if (PROSE_EXTENSIONS.includes(ext)) return 'prose';
  return extensions.includes(ext) ? 'scanned' : 'other-extension';
}

/**
 * Machine-readable description of the scan surface: how many candidate files were
 * seen, how many were actually inspected, and how many were skipped per category.
 *
 * The narrowing is a deliberate trade-off (prose cannot "read" a key; fixtures set
 * sentinel keys on purpose), so it is reported in the output rather than only in a
 * commit message. Generated/evidence directories are named but **not counted**: their
 * file count changes as the engine writes ledgers, and a metric that moves with the
 * previous run would break the same-input/same-output guarantee (REQ-010).
 */
export function scanSurface(repoRoot, { extensions = CODE_EXTENSIONS, scanRoots = null, maxBytes = MAX_SCAN_BYTES } = {}) {
  const roots = Array.isArray(scanRoots) && scanRoots.length > 0 ? scanRoots.map((r) => String(r).replace(/\\/g, '/').replace(/^\.\//, '')) : [''];
  const counters = { candidates: 0, scanned: 0, prose: 0, fixture: 0, 'other-extension': 0, oversize: 0 };
  for (const scanRoot of roots) {
    const list = scanRoot === '' ? walkFiles(repoRoot) : walkFiles(path.join(repoRoot, scanRoot.split('/').join(path.sep)));
    for (const rel of list) {
      const full = scanRoot === '' ? rel : `${scanRoot}/${rel}`;
      const category = scanCategory(full, { extensions });
      if (category === 'evidence-or-generated') continue;
      counters.candidates += 1;
      if (category === 'scanned' && fileSize(path.join(repoRoot, full.split('/').join(path.sep))) > maxBytes) {
        counters.oversize += 1;
        continue;
      }
      counters[category] += 1;
    }
  }
  return {
    candidates: counters.candidates,
    scanned: counters.scanned,
    excluded: {
      prose: counters.prose,
      fixtures: counters.fixture,
      otherExtension: counters['other-extension'],
      oversize: counters.oversize,
      skippedDirectories: [...SKIP_DIRECTORIES],
    },
    note: 'prose cannot read a key and recorded evidence echoes this policy\'s own output, so both are out of the default surface; list them in policy.expectedFiles to scan them explicitly',
  };
}

/** Deterministic, bounded scan set of scannable implementation files under the root.
 *  `scanRoots` (policy.scanRoots) narrows the scan to specific subtrees, so a
 *  repository can scope the safety invariants to the code under its own control. */
export function scanCandidates(repoRoot, { extensions = CODE_EXTENSIONS, maxBytes = MAX_SCAN_BYTES, scanRoots = null } = {}) {
  const roots = Array.isArray(scanRoots) && scanRoots.length > 0 ? scanRoots.map((r) => String(r).replace(/\\/g, '/').replace(/^\.\//, '')) : [''];
  const files = [];
  for (const scanRoot of roots) {
    const list = scanRoot === '' ? walkFiles(repoRoot) : walkFiles(path.join(repoRoot, scanRoot.split('/').join(path.sep)));
    for (const rel of list) files.push(scanRoot === '' ? rel : `${scanRoot}/${rel}`);
  }
  return files
    .filter((rel) => {
      const segments = rel.split('/');
      if (segments.some((segment) => SKIP_DIRECTORIES.includes(segment))) return false;
      if (TEST_PATH_PATTERNS.some((pattern) => pattern.test(rel))) return false;
      const ext = path.extname(rel).toLowerCase();
      if (segments[segments.length - 1].startsWith('.env')) return true;
      return extensions.includes(ext);
    })
    .filter((rel) => {
      const size = fileSize(path.join(repoRoot, rel.split('/').join(path.sep)));
      return size >= 0 && size <= maxBytes;
    })
    .sort();
}

function scanForTokens(repoRoot, tokens, { files = null, scanRoots = null } = {}) {
  const list = files ?? scanCandidates(repoRoot, { scanRoots });
  const hits = [];
  let scanned = 0;
  for (const rel of list) {
    const abs = path.join(repoRoot, rel.split('/').join(path.sep));
    const text = readTextIfExists(abs);
    if (text === null) continue;
    scanned += 1;
    // Matching runs on the comment-blanked text (t34 ruling: comment syntax is prose,
    // not code); evidence excerpts are still taken from the real source line.
    const scannedText = stripComments(text);
    for (const token of tokens) {
      if (token.regex) {
        const flags = token.flags ?? token.regex.flags ?? 'g';
        const re = new RegExp(token.regex.source, flags.includes('g') ? flags : `${flags}g`);
        let match;
        while ((match = re.exec(scannedText)) !== null) {
          const captured = match.slice(1).find((group) => typeof group === 'string' && group.length > 0) ?? match[0];
          hits.push({ file: rel, token: token.label, matched: captured, line: lineAt(text, match.index) });
          if (match[0] === '') re.lastIndex += 1;
          if (hits.length > 200) break;
        }
      }
      if (typeof token.find === 'function') {
        for (const derived of token.find(scannedText)) {
          hits.push({ file: rel, token: token.label, matched: derived.matched, line: lineAt(text, derived.index) });
          if (hits.length > 200) break;
        }
      }
    }
  }
  return { hits, scanned, files: list };
}

/**
 * SAFE_001 — no key *reads* and no vault references in the implementation surface.
 *
 * An empty scan set is an **error**, not a pass: "nothing inspected" must never be
 * reported as "nothing found" (the same rule the `command` check follows for an
 * un-evaluable stdout assertion).
 */
export function policySafe001(repoRoot, { files = null, scanRoots = null } = {}) {
  const { hits, scanned, files: scannedFiles } = scanForTokens(repoRoot, KEY_READ_PATTERNS, { files, scanRoots });
  // A GitHub Environment reference is the intended secret boundary for the
  // trusted live OCR workflow. It names a secret but does not read it from the
  // repository process or expose its value; only this exact workflow binding is
  // exempted. All source-level and general workflow secret reads remain errors.
  const safeWorkflowSecret = (hit) => hit.file === '.github/workflows/quality-live.yml'
    && /secrets\.OCR_AUTH_TOKEN/.test(hit.line)
    && /OCR_LLM_TOKEN/.test(hit.line);
  const effectiveHits = hits.filter((hit) => !safeWorkflowSecret(hit));
  const violations = effectiveHits.map((hit) => ({
    pointer: `/${hit.file}`,
    message: `${hit.token} in ${hit.file}: ${safeExcerpt(redact(hit.line), 160) || REDACTED}`,
    file: hit.file,
  }));
  if (scanned === 0) {
    violations.push({
      pointer: '/scan',
      message: 'no file was scanned: the safety invariant cannot be evaluated (empty scan set). Check policy.scanRoots / policy.expectedFiles.',
      file: null,
    });
  }
  return {
    passed: violations.length === 0,
    scannedFiles: scanned,
    files: scannedFiles,
    violations,
    metrics: {
      filesScanned: scanned,
      violations: violations.length,
      patterns: KEY_READ_PATTERNS.map((t) => t.label),
      scanSurface: scanSurface(repoRoot, { scanRoots }),
    },
  };
}

/** SAFE_002 — no include pattern may re-admit a built-in sensitive path. */
export function policySafe002(repoRoot, { include = ['**/*'] } = {}) {
  const widest = selectFiles(repoRoot, {
    include: [...include, '**/*'],
    exclude: [],
    extensions: ['.env', '.pem', '.key', '.p12', '.json', '.js', '.mjs', '.md', '.txt', '.yaml', '.yml'],
  });
  const violations = widest.included
    // The same case-insensitive rule the filter chain uses (t53/R3-B1); re-implementing
    // it here with case-sensitive globbing is how `Credentials.json` could pass.
    .filter((rel) => sensitiveNameRule(rel) !== null)
    .map((rel) => ({ pointer: `/${rel}`, message: `sensitive path re-admitted by include: ${rel}`, file: rel }));
  const excludedSecrets = widest.excluded.filter((entry) => entry.reason === 'secret_path');
  // An empty candidate set means the include/exclude evaluation had nothing to look
  // at, so the invariant was not actually exercised — that is not a pass.
  if (widest.included.length === 0 && widest.excluded.length === 0) {
    violations.push({
      pointer: '/scan',
      message: 'no candidate file was considered: the secret-path invariant cannot be evaluated (empty selection). Check the scan root.',
      file: null,
    });
  }
  return {
    passed: violations.length === 0,
    violations,
    metrics: {
      selected: widest.included.length,
      secretPathsExcluded: excludedSecrets.length,
      secretPathRules: SECRET_PATH_RULES.map((rule) => rule.id),
      widestInclude: '**/*',
    },
  };
}

/** SAFE_003 — no network call surface in the implementation. An empty scan set is
 *  an error, never a pass (see SAFE_001). */
export function policySafe003(repoRoot, { files = null, scanRoots = null } = {}) {
  const { hits, scanned, files: scannedFiles } = scanForTokens(repoRoot, NETWORK_TOKENS, { files, scanRoots });
  const violations = hits.map((hit) => ({
    pointer: `/${hit.file}`,
    message: `${hit.token} network surface in ${hit.file}: ${safeExcerpt(hit.line, 160)}`,
    file: hit.file,
  }));
  if (scanned === 0) {
    violations.push({
      pointer: '/scan',
      message: 'no file was scanned: the network-free invariant cannot be evaluated (empty scan set). Check policy.scanRoots / policy.expectedFiles.',
      file: null,
    });
  }
  return {
    passed: violations.length === 0,
    scannedFiles: scanned,
    files: scannedFiles,
    violations,
    metrics: {
      filesScanned: scanned,
      violations: violations.length,
      tokens: NETWORK_TOKENS.map((t) => t.label),
      scanSurface: scanSurface(repoRoot, { scanRoots }),
    },
  };
}

/** Frozen field tables used by CONTRACT_001 drift detection (docs/01-architecture.md §5.1). */
export const FROZEN_TOP_LEVEL_FIELDS = Object.freeze([
  'version',
  'provider',
  'gates',
  'policy',
  'selection',
  'grouping',
  'projectRoot',
]);

export const FROZEN_GATE_FIELDS = Object.freeze(['id', 'stage', 'required', 'checks', 'humanGate']);

export const FROZEN_HUMAN_GATE_FIELDS = Object.freeze(['role', 'approvalRecord', 'enforcement', 'gateId']);

export const FROZEN_CHECK_COMMON_FIELDS = Object.freeze(['id', 'type', 'required', 'severity', 'onFail', 'description']);

export const FROZEN_CHECK_FIELDS = Object.freeze({
  file_exists: Object.freeze(['file', 'minCount']),
  file_not_exists: Object.freeze(['file']),
  regex: Object.freeze(['files', 'pattern', 'flags', 'mode', 'minMatches', 'countMode', 'encoding']),
  command: Object.freeze(['run', 'expectExitCode', 'timeoutMs', 'cwd', 'captureStdout', 'stdoutRegex']),
  json_assert: Object.freeze(['file', 'assertions']),
  trace_matrix: Object.freeze(['requirementsFile', 'traceFile', 'enforce', 'testIdSource']),
  policy: Object.freeze(['policyId', 'expectedFiles']),
});

export const FROZEN_STAGES = Object.freeze(['requirements', 'design', 'build', 'review', 'verify']);

export const FROZEN_CHECK_TYPES = Object.freeze(Object.keys(FROZEN_CHECK_FIELDS));

/** The stage whose exit carries a human gate (§3.2 — positions, not gate ids). */
export const FROZEN_HANDOVER_STAGES = Object.freeze({ requirements: 'product', design: 'architect', review: 'reviewer' });

/**
 * CONTRACT_001 — only the frozen enums and field names may appear in the
 * configuration. This is drift detection executed by the engine itself rather
 * than delegated to a model.
 */
export function policyContract001(repoRoot, { configPath = 'qgate.config.json' } = {}) {
  const violations = [];
  const abs = path.isAbsolute(configPath) ? configPath : path.join(repoRoot, configPath.split('/').join(path.sep));
  const raw = readTextIfExists(abs);
  if (raw === null) {
    violations.push({ pointer: '/config', message: `configuration not found for drift check: ${configPath}` });
  } else {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      violations.push({ pointer: '/config', message: `configuration is not parseable JSON: ${error.message}` });
    }
    if (parsed) {
      for (const key of Object.keys(parsed)) {
        if (!FROZEN_TOP_LEVEL_FIELDS.includes(key)) violations.push({ pointer: `/${key}`, message: `unknown top-level field "${key}"` });
      }
      if (!Array.isArray(parsed.gates)) {
        violations.push({ pointer: '/gates', message: 'gates must be an array' });
      } else {
        parsed.gates.forEach((gate, gateIndex) => {
          if (!gate || typeof gate !== 'object') {
            violations.push({ pointer: `/gates/${gateIndex}`, message: 'gate must be an object' });
            return;
          }
          for (const key of Object.keys(gate)) {
            if (!FROZEN_GATE_FIELDS.includes(key)) violations.push({ pointer: `/gates/${gateIndex}/${key}`, message: `unknown gate field "${key}"` });
          }
          if (!FROZEN_STAGES.includes(gate.stage)) {
            violations.push({ pointer: `/gates/${gateIndex}/stage`, message: `stage "${gate.stage}" not in frozen enum ${FROZEN_STAGES.join('|')}` });
          }
          if (gate.humanGate !== undefined && gate.humanGate !== null) {
            const expectedRole = FROZEN_HANDOVER_STAGES[gate.stage];
            if (!expectedRole) {
              violations.push({ pointer: `/gates/${gateIndex}/humanGate`, message: `humanGate on stage "${gate.stage}" is not one of the three frozen handover positions` });
            } else if (gate.humanGate.role !== expectedRole) {
              violations.push({ pointer: `/gates/${gateIndex}/humanGate/role`, message: `the "${gate.stage}" handover is signed by role "${expectedRole}", not "${gate.humanGate.role}"` });
            }
            for (const key of Object.keys(gate.humanGate)) {
              if (!FROZEN_HUMAN_GATE_FIELDS.includes(key)) violations.push({ pointer: `/gates/${gateIndex}/humanGate/${key}`, message: `unknown humanGate field "${key}"` });
            }
          }
          const checks = Array.isArray(gate.checks) ? gate.checks : [];
          checks.forEach((check, checkIndex) => {
            if (!check || typeof check !== 'object') {
              violations.push({ pointer: `/gates/${gateIndex}/checks/${checkIndex}`, message: 'check must be an object' });
              return;
            }
            if (!FROZEN_CHECK_TYPES.includes(check.type)) {
              violations.push({ pointer: `/gates/${gateIndex}/checks/${checkIndex}/type`, message: `check.type "${check.type}" not in frozen enum ${FROZEN_CHECK_TYPES.join('|')}` });
              return;
            }
            const allowed = new Set([...FROZEN_CHECK_COMMON_FIELDS, ...FROZEN_CHECK_FIELDS[check.type]]);
            for (const key of Object.keys(check)) {
              if (!allowed.has(key)) violations.push({ pointer: `/gates/${gateIndex}/checks/${checkIndex}/${key}`, message: `check field "${key}" is not in the frozen field table for type ${check.type}` });
            }
            for (const required of FROZEN_REQUIRED_CHECK_FIELDS[check.type] ?? []) {
              if (check[required] === undefined) violations.push({ pointer: `/gates/${gateIndex}/checks/${checkIndex}/${required}`, message: `check.type "${check.type}" requires the "${required}" field` });
            }
          });
        });
      }
    }
  }
  return {
    passed: violations.length === 0,
    violations,
    metrics: {
      scannedConfig: configPath,
      violations: violations.length,
      frozenCheckTypes: [...FROZEN_CHECK_TYPES],
      frozenStages: [...FROZEN_STAGES],
    },
  };
}

const FROZEN_REQUIRED_CHECK_FIELDS = Object.freeze({
  file_exists: ['file'],
  file_not_exists: ['file'],
  regex: ['files', 'pattern'],
  command: ['run'],
  json_assert: ['file', 'assertions'],
  trace_matrix: ['requirementsFile', 'traceFile'],
  policy: ['policyId'],
});

export function runPolicy(policyId, repoRoot, options = {}) {
  switch (policyId) {
    case SAFE_001:
      return policySafe001(repoRoot, options);
    case SAFE_002:
      return policySafe002(repoRoot, options);
    case SAFE_003:
      return policySafe003(repoRoot, options);
    case CONTRACT_001:
      return policyContract001(repoRoot, options);
    default:
      throw new Error(`unknown policyId "${policyId}"`);
  }
}

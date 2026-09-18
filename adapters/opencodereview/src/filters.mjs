// adapters/opencodereview/src/filters.mjs
// OCR 确定性过滤层（复刻 selection.go / filters 的降噪动作）。
//
// 安全不变量（以代码强制，而非提示词约束）：
//   S1 清单 1 密钥/凭证路径的检查 **先于** 任何用户 include 规则，
//      且任何 include 模式都无法把敏感路径重新纳入 —— 见 classifyFile()：
//      敏感路径在 step 0 直接返回 excluded，根本不进入规则引擎。
//   S2 二进制文件（扩展名或魔数）始终排除。
//   S3 默认排除目录（.git/、node_modules/ …）始终排除。
//   S4 不支持的扩展名始终排除（白名单）。

import fs from 'node:fs';
import path from 'node:path';
import { toPosix, normalizeRel, matchesAnyPattern, extname, sizeOf, estimateTokens, globToRegExp } from './util.mjs';

/** 版本号参与 JSON 输出，便于追溯过滤语义变更。 */
export const FILTER_VERSION = '1.0.0';

/** 密钥/凭证路径清单（相对路径，任意深度匹配）。 */
export const SENSITIVE_PATH_PATTERNS = Object.freeze([
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '.envrc',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '**/id_rsa*',
  'credentials*',
  '**/credentials*',
  'secrets/**',
  '**/secrets/**',
  'secrets',
  '**/secrets',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '*.kdbx',
  'service-account*.json',
  '**/service-account*.json',
]);

/** 任意深度都必须排除的目录段。 */
export const DEFAULT_EXCLUDE_DIRS = Object.freeze([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  '.next',
  '.cache',
  '.gradle',
  '.tox',
  'bower_components',
]);

/** 二进制扩展名（即使出现在 diff 里也排除）。 */
export const BINARY_EXTENSIONS = Object.freeze([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.svgz',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.lib', '.class', '.pyc', '.pyo',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.ogg', '.flac', '.webm',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.db', '.sqlite', '.sqlite3',
  '.psd', '.sketch', '.swf', '.wasm',
  // 注意：`.lock` **刻意不在此列**（t51 / D06）。它此前被归入二进制扩展名，导致
  // `.lock` 与 `.PNG` 的排除理由串重叠（都是 `binary_file:extension`），
  // 掩盖了「它其实是**不支持扩展名**」这一事实。现在 `.lock` 走 SAFETY-004 分支，
  // 理由串为 `unsupported_extension:.lock`（仍然排除，安全判定未放宽）。
]);

/** 支持分析的文本扩展名（S4 白名单）。 */
export const SUPPORTED_EXTENSIONS = Object.freeze([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.properties', '.xml',
  '.md', '.markdown', '.txt', '.rst', '.adoc',
  '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte',
  '.java', '.kt', '.kts', '.scala', '.groovy',
  '.py', '.rb', '.php', '.go', '.rs', '.cs', '.c', '.h', '.cc', '.cpp', '.hpp',
  '.swift', '.m', '.mm', '.dart', '.lua', '.pl', '.r', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd',
  '.sql', '.proto', '.graphql', '.gql', '.tf', '.hcl', '.dockerfile', '.gradle', '.env.example',
]);

/** 无扩展名也视为文本的文件名白名单。 */
export const TEXT_BASENAMES = Object.freeze([
  'Dockerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Procfile', 'LICENSE', 'NOTICE', 'CODEOWNERS',
]);

const BINARY_EXT_SET = new Set(BINARY_EXTENSIONS);
const SUPPORTED_EXT_SET = new Set(SUPPORTED_EXTENSIONS);
const TEXT_BASENAME_SET = new Set(TEXT_BASENAMES);
const TEXT_BASENAME_LOWER_SET = new Set(TEXT_BASENAMES.map((b) => b.toLowerCase()));

/** 密钥/凭证类扩展名（大小写不敏感；`.PEM` 与 `.pem` 同等对待）。 */
export const SENSITIVE_EXTENSIONS = Object.freeze(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdbx']);
const SENSITIVE_EXT_SET = new Set(SENSITIVE_EXTENSIONS);

/**
 * 把路径的**最后一段**去掉 NTFS 备用数据流（ADS）后缀，返回原始最后一段。
 *
 * t64 / F17：`secrets/db.txt::$DATA`、`.env::$DATA`、`.pem:stream` 这类路径指向的是
 * **基础文件的数据流**。若整串拿去比对，`.env::$DATA` 会被扩展名白名单当成
 * `.env::$DATA` 扩展名 ⇒ 虽然仍被排除，但理由是 `unsupported_extension`（**兜底**）
 * 而不是名规则（`secret_path`）。这正是 R3-B1 的判据：**reason 必须是名规则命中**。
 *
 * **只切最后一段**（不逐段切）：这样 `secrets/db.txt::$DATA` 仍保留 `secrets/` 段，
 * 目录类名规则照常命中。
 *
 * ⚠ 反直觉但已实测（t64，Windows）：**尾随空格不会被文件系统剥掉** ——
 * 创建 `.env ` 后 `readdirSync` 得到 `.env `，且 `.env` 不存在；只有写 `.env::$DATA`
 * 才会产生基础文件 `.env`。所以这里**刻意不做 trim**：把 `.env ` 当成 `.env` 会引入
 * 事实错误（它们是两个不同文件）。空白类变体由**结构规则**（S4 白名单）兜住并排除，
 * 但其 `reason` 是兜底而非名规则 —— 这一点在 README 里如实登记。
 */
export function stripAlternateDataStream(relPath) {
  const posix = toPosix(String(relPath));
  const idx = posix.lastIndexOf('/');
  const dir = idx >= 0 ? posix.slice(0, idx + 1) : '';
  const base = idx >= 0 ? posix.slice(idx + 1) : posix;
  // 仅当冒号出现在**最后一段**且不是盘符形态时视为 ADS（Windows 语义）
  const colon = base.indexOf(':');
  const stripped = colon > 0 ? base.slice(0, colon) : base;
  return dir + stripped;
}

/**
 * 是否密钥类扩展名（**大小写不敏感**）。与 isSensitivePath 分开导出，
 * 便于 policy/CI 直接断言「大小写变体不再绕过」。
 */
export function isSensitiveExtension(relPath) {
  return SENSITIVE_EXT_SET.has(extname(stripAlternateDataStream(relPath)).toLowerCase());
}

/** 是否二进制扩展名（**大小写不敏感**：`.PNG` 也是二进制）。 */
export function isBinaryExtension(relPath) {
  return BINARY_EXT_SET.has(extname(stripAlternateDataStream(relPath)).toLowerCase());
}

/**
 * 读取文本文件头部（默认 8 KiB），用于「密钥形态」内容兜底扫描。
 * 读不到返回 null（例如 diff 中的新增文件在磁盘上不存在）。
 */
export function readHeadText(absPath, maxBytes = 8192) {
  if (!absPath) return null;
  try {
    const fd = fs.openSync(absPath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const read = fs.readSync(fd, buf, 0, maxBytes, 0);
      const slice = buf.subarray(0, read);
      if (slice.includes(0)) return null; // 二进制内容不作文本扫描
      return slice.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * 「密钥形态」内容扫描（H2 硬链接别名绕过的兜底）。
 *
 * 为什么需要：`docs.txt` **硬链接到** `.env` 时，路径本身完全无害（不含敏感名、扩展名正常），
 * 仅靠路径规则无法识别 ⇒ 会被静默纳入评审上下文（内容即密钥）。这里对内容做形态扫描，
 * 命中 PEM 私钥块、已知密钥格式、或「敏感名 = 实值」即视为密钥材料。
 *
 * 两段式判定（避免误报与漏报两头出错）：
 *   1) **高置信格式**（`sk-…` / `ghp_…` / `AKIA…` / `-----BEGIN … PRIVATE KEY-----`）：
 *      格式本身就说明是真实凭证 ⇒ **无视占位符词**直接判为密钥。
 *   2) **通用键值形态**（`api_key = <value>` 等）：只有当 value 部分**本身**是占位符时才放过。
 *      这里刻意不把「整段文本里出现过 placeholder」当作放过理由 —— `sk-ant-real-secret-…`
 *      这类真实值里恰好含 "real" 一词，早期版本因此漏报（实测踩过）。
 */
const SECRET_HIGH_CONFIDENCE = Object.freeze([
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, id: 'pem-private-key' },
  { re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, id: 'openai-anthropic-key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, id: 'github-token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, id: 'aws-access-key-id' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, id: 'slack-token' },
]);
const SENSITIVE_WORD_RE = /(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|passphrase|credentials?)/i;
/** 当「值」整体落在这些形态时才视为占位符（不看其它上下文）。 */
const VALUE_IS_PLACEHOLDER = /^(?:[\s"'`]*)(?:placeholder|example|sample|dummy|fake|redacted|changeme|change[-_]?me|n\/?a|none|null|todo|xxx+|\*+|\.+|your[-_][\w-]*|test[-_]?value|not[-_]?a[-_]?real[-_\w]*|demo[-_]?fixture[-_\w]*|sk-ant-placeholder[\w-]*|<[^>]*>|\$\{[^}]*\}|%[A-Za-z_]+%)/i;

/**
 * 「敏感名 = 值」赋值形态（用于第 2 段）。
 *
 * 关键细节：**名称必须以 `$` 或其它非名称字符收尾**，否则 `private_key` 里的
 * `key` 会先匹配上、把 `:` 之后的整段 JSON 当成值 ⇒ JSON 里的占位符因此躲过
 * VALUE_IS_PLACEHOLDER 判定而被**误报**为密钥材料（实测踩过：
 * `{"private_key":"PLACEHOLDER-NOT-A-REAL-KEY"}` 被误判）。
 * 用 `(?![\w$])` 保证名称边界，再用捕获组取右侧值。
 */
const ASSIGNMENT_RE = new RegExp(
  `(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|passphrase|credentials?)(?![\\w$])\\s*[:=]\\s*(.+)$`,
  'i',
);

export function looksLikeSecretMaterial(text) {
  if (typeof text !== 'string' || text === '') return { secret: false, patterns: [] };
  const hits = [];
  // 第 1 段：高置信格式（含 PEM 私钥）——不看占位符词
  for (const { re, id } of SECRET_HIGH_CONFIDENCE) {
    if (re.test(text)) hits.push(id);
  }
  if (hits.length > 0) return { secret: true, patterns: hits };
  // 第 2 段：通用「敏感名 = 实值」——仅当值本身是占位符时才放过
  for (const line of text.split(/\r?\n/)) {
    const m = ASSIGNMENT_RE.exec(line);
    if (!m) continue; // 没有「敏感名 = 值」形态（仅提到名字 / 是定义读法）⇒ 不算
    // 去掉包裹引号与 JSON 尾逗号/分号，避免 `"PLACEHOLDER"` 这类值因引号躲过判定
    const value = m[1].replace(/^[\s"'`]+/, '').replace(/[\s"',;]+$/, '');
    if (value.length < 8) continue; // 过短不足以构成凭证实值
    if (VALUE_IS_PLACEHOLDER.test(value)) continue; // 明确的占位符/示例值
    // 值本身是「环境读取/引用」而非内嵌材料（如 `const K = process.env.X`）⇒ 不是内嵌密钥
    if (/^(?:process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env|Deno\s*\.\s*env|os\s*\.\s*environ|vault|secrets|require\s*\(|await\s+import)/.test(value)) continue;
    hits.push('sensitive-name-with-value');
    break;
  }
  return { secret: hits.length > 0, patterns: hits };
}

/**
 * 硬链接别名检测（H2）。
 *
 * 硬链接到敏感文件的别名（如 `docs.txt` → `.env`）路径毫无破绽，因此这里结合两条信号：
 *   1) 该文件的 `nlink > 1`（被硬链接）；
 *   2) 内容看起来是密钥材料，**或**该 inode 与工作集内某个敏感路径同源。
 * 任一命中即返回 `{ alias: true, via }`，由 classifyFile 排除并给出机器可读原因。
 * 普通单链接文本文件零开销（不做内容扫描）。
 */
export function detectHardlinkSecret(relPath, absPath, ctx = {}) {
  if (!absPath) return { alias: false, via: null, nlink: null, patterns: [] };
  let st;
  try {
    st = fs.lstatSync(absPath);
  } catch {
    return { alias: false, via: null, nlink: null, patterns: [] };
  }
  if (!st.isFile()) return { alias: false, via: null, nlink: null, patterns: [] };
  const nlink = Number.isFinite(st.nlink) ? st.nlink : 1;
  if (nlink <= 1) return { alias: false, via: null, nlink, patterns: [] };

  // 信号 A：该 inode 与已知敏感文件同源（同设备 + 同 inode）
  const sensitiveInodes = ctx.sensitiveInodes instanceof Set ? ctx.sensitiveInodes : null;
  if (sensitiveInodes && sensitiveInodes.has(`${st.dev}:${st.ino}`)) {
    return { alias: true, via: 'same-inode-as-sensitive-path', nlink, patterns: [] };
  }
  // 信号 B：内容呈密钥形态（占位符除外）
  const text = readHeadText(absPath);
  const verdict = looksLikeSecretMaterial(text || '');
  if (verdict.secret) {
    return { alias: true, via: 'secret-content-in-hardlinked-file', nlink, patterns: verdict.patterns };
  }
  // 仅「被硬链接」但内容无害：不排除，但记录为可审计的低风险信号
  return { alias: false, via: 'hardlinked-but-no-secret-content', nlink, patterns: [] };
}

/** 是否为密钥/凭证类路径（S1）。 */
export function isSensitivePath(relPath) {
  const p = normalizeRel(relPath);
  if (p === '') return false;
  // 安全清单必须**大小写不敏感**：CI 的 diff 常由大小写敏感的 Linux/Ubuntu 生成，
  // 而清单按小写书写 ⇒ `Credentials.json` / `.ENV` / `Secrets/db.txt` 会被静默纳入，
  // 凭证文件因此进入评审上下文（这是 blocker 级绕过，见 test/security-bypass.test.mjs）。
  //
  // t64 / F17：先切掉 NTFS 备用数据流后缀（`.env::$DATA` ⇒ `.env`）。
  // 否则 `.env::$DATA` 只在扩展名白名单上被兜住，`reason` 会是 `unsupported_extension`
  // 而不是名规则 —— 「对答案而非对规则」（R3-B1 的判据）。
  const lower = stripAlternateDataStream(normalizeRel(p)).toLowerCase();
  const base = lower.split('/').pop();
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base.startsWith('id_rsa') || base.startsWith('id_dsa') || base.startsWith('id_ecdsa') || base.startsWith('id_ed25519')) return true;
  if (base.startsWith('credentials')) return true;
  const segs = lower.split('/');
  if (segs.includes('secrets')) return true;
  return matchesAnyPattern(lower, SENSITIVE_PATH_PATTERNS, { caseInsensitive: true }) !== null;
}

/**
 * 是否位于默认排除目录内（S3）。同样**大小写不敏感**：
 * `.GIT/`、`NODE_MODULES/`、`Dist/` 在大小写不敏感的文件系统上是同一目录。
 */
export function isInDefaultExcludedDir(relPath, dirs = DEFAULT_EXCLUDE_DIRS) {
  const segs = normalizeRel(relPath).toLowerCase().split('/');
  const dirSet = new Set(dirs.map((d) => String(d).toLowerCase()));
  for (const seg of segs.slice(0, -1)) {
    if (dirSet.has(seg)) return seg;
  }
  return null;
}

/** 是否二进制（S2）：扩展名优先（大小写不敏感）；对真实存在的文件再看魔数。 */
export function isBinaryFile(relPath, absPath = null) {
  // t64 / F17：先切 ADS 后缀，使 `.pem::$DATA` 走「密钥类扩展名」而不是未知扩展名分支。
  const ext = extname(stripAlternateDataStream(relPath)).toLowerCase();
  if (BINARY_EXT_SET.has(ext)) return { binary: true, via: 'extension', ext };
  if (SENSITIVE_EXT_SET.has(ext)) {
    // 密钥类扩展名按二进制处理（内容不可评审，且属敏感材料）——大小写变体同样适用。
    return { binary: true, via: 'sensitive-extension', ext };
  }
  if (absPath) {
    try {
      const fd = fs.openSync(absPath, 'r');
      const buf = Buffer.alloc(4096);
      const read = fs.readSync(fd, buf, 0, 4096, 0);
      fs.closeSync(fd);
      const slice = buf.subarray(0, read);
      if (slice.includes(0)) return { binary: true, via: 'magic-null-byte', ext };
    } catch {
      /* 读不到就按扩展名判定 */
    }
  }
  return { binary: false, via: 'none', ext };
}

/** 是否受支持的文本文件（S4）。 */
export function isSupportedExtension(relPath) {
  // t64 / F17：`.env::$DATA` 去掉 ADS 后缀后扩展名是 `.env`（仍不在白名单 ⇒ 仍排除），
  // 但理由应来自名规则；这里的 ADS 归一化保证「扩展名判定」与「名规则」看同一个名字。
  const normalized = stripAlternateDataStream(relPath);
  const ext = extname(normalized).toLowerCase();
  const base = normalizeRel(normalized).split('/').pop();
  if (ext === '') return TEXT_BASENAME_SET.has(base) || TEXT_BASENAME_LOWER_SET.has(base.toLowerCase());
  return SUPPORTED_EXT_SET.has(ext);
}

/**
 * 单个文件的确定性判定。返回：
 *   { path, decision:'included'|'excluded', reason, decidedBy:'safety'|'rule'|'builtin', ruleSource, ruleId, pattern, severity }
 * 判定顺序即安全优先级顺序，敏感路径一旦命中立刻返回，不受 include 影响。
 */
export function classifyFile(relPath, rules, context = {}) {
  const p = normalizeRel(relPath);
  const base = p.split('/').pop();
  const absPath = context.root ? path.join(context.root, p) : null;
  const excludedDirs = Array.isArray(rules?.defaultExcludeDirs) && rules.defaultExcludeDirs.length > 0
    ? rules.defaultExcludeDirs
    : DEFAULT_EXCLUDE_DIRS;

  // step 0 — S1：密钥/凭证路径**先于**用户 include，永远不可被重新纳入。
  if (isSensitivePath(p)) {
    return excluded(p, 'sensitive_path_never_included', {
      decidedBy: 'safety',
      ruleSource: 'SAFETY_INVARIANT',
      ruleId: 'SAFETY-001-SENSITIVE-PATH',
      pattern: matchedPatternFor(p),
      severity: 'blocker',
    });
  }

  // step 1 — S3：默认排除目录
  const dir = isInDefaultExcludedDir(p, excludedDirs);
  if (dir) {
    return excluded(p, `default_excluded_dir:${dir}`, {
      decidedBy: 'safety',
      ruleSource: 'SAFETY_INVARIANT',
      ruleId: 'SAFETY-002-DEFAULT-DIR',
      pattern: `${dir}/**`,
      severity: 'info',
    });
  }

  // step 2 — S2：二进制
  const bin = isBinaryFile(p, absPath);
  if (bin.binary) {
    return excluded(p, `binary_file:${bin.via}`, {
      decidedBy: 'safety',
      ruleSource: 'SAFETY_INVARIANT',
      ruleId: 'SAFETY-003-BINARY',
      pattern: bin.via === 'extension' ? `*${bin.ext}` : bin.via === 'sensitive-extension' ? `*${bin.ext} (sensitive)` : 'magic:null-byte',
      severity: 'info',
    });
  }

  // step 2b — H2：硬链接别名（路径无害但内容/同源 inode 指向密钥）
  // `docs.txt` 硬链接到 `.env` 时路径毫无破绽，仅靠路径规则无法识别 ⇒ 这里用
  // 「nlink>1 且（与敏感 inode 同源 或 内容呈密钥形态）」检出并排除，绝不静默纳入。
  const hardlink = detectHardlinkSecret(p, absPath, context);
  if (hardlink.alias) {
    return excluded(p, `hardlink_secret_alias:${hardlink.via}`, {
      decidedBy: 'safety',
      ruleSource: 'SAFETY_INVARIANT',
      ruleId: 'SAFETY-005-HARDLINK-ALIAS',
      pattern: hardlink.via,
      severity: 'blocker',
      evidence: { nlink: hardlink.nlink, contentPatterns: hardlink.patterns },
    });
  }

  // step 3 — S4：扩展名白名单
  if (!isSupportedExtension(p) && rules?.allowUnsupportedExtensions !== true) {
    return excluded(p, `unsupported_extension:${extname(p) || base}`, {
      decidedBy: 'safety',
      ruleSource: 'SAFETY_INVARIANT',
      ruleId: 'SAFETY-004-EXTENSION',
      pattern: extname(p) || base,
      severity: 'info',
    });
  }

  // step 4 — 用户规则层：第一条匹配生效（include 与 exclude 同层比较出现顺序）
  const projected = projectRules(rules);
  for (const layer of projected) {
    for (const entry of layer.excludes) {
      if (entry.re.test(p) || entry.re.test(base)) {
        return excluded(p, entry.rule.reason || 'excluded_by_rule', {
          decidedBy: 'rule',
          ruleSource: layer.source,
          ruleId: entry.rule.id || null,
          pattern: entry.rule.pattern,
          severity: 'info',
        });
      }
    }
    for (const entry of layer.includes) {
      if (entry.re.test(p) || entry.re.test(base)) {
        return included(p, entry.rule.reason || 'included_by_rule', {
          decidedBy: 'rule',
          ruleSource: layer.source,
          ruleId: entry.rule.id || null,
          pattern: entry.rule.pattern,
        });
      }
    }
    if (layer.includeExtensions && layer.includeExtensions.includes(extname(p))) {
      return included(p, `included_by_extension:${extname(p)}`, {
        decidedBy: 'rule',
        ruleSource: layer.source,
        ruleId: layer.id || null,
        pattern: `ext:${extname(p)}`,
      });
    }
  }

  // step 5 — 内置默认（来源标记为最低优先层的 source，保证可追溯）
  return included(p, 'default_include', {
    decidedBy: 'builtin',
    ruleSource: projected.length > 0 ? projected[projected.length - 1].source : 'builtin',
    ruleId: 'BUILTIN-DEFAULT-INCLUDE',
    pattern: null,
  });
}

function excluded(pathValue, reason, extra = {}) {
  return { path: pathValue, decision: 'excluded', reason, ...extra };
}

function included(pathValue, reason, extra = {}) {
  return { path: pathValue, decision: 'included', reason, ...extra };
}

/** 仅用于解释输出：说明敏感路径是命中哪条清单模式。 */
function matchedPatternFor(relPath) {
  const p = normalizeRel(relPath);
  const base = p.split('/').pop();
  for (const pat of SENSITIVE_PATH_PATTERNS) {
    const norm = toPosix(pat).replace(/\*\*\//g, '');
    if (norm === base || norm === p) return pat;
  }
  if (base.startsWith('.env')) return '.env*';
  if (base.startsWith('id_')) return 'id_rsa*';
  if (base.startsWith('credentials')) return 'credentials*';
  if (p.split('/').includes('secrets')) return 'secrets/**';
  return null;
}

/**
 * 把「规则对象」投影为可执行的层列表（保持数组顺序 ⇒ 第一条匹配生效）。
 * 规则对象的层序由 rules.mjs 负责（--rule > 项目 > 用户 > 内置）。
 */
export function projectRules(rules) {
  if (!rules) return [];
  if (Array.isArray(rules.layers)) {
    return rules.layers.map((layer) => ({
      source: layer.source || 'inline',
      id: layer.id || null,
      includeExtensions: Array.isArray(layer.includeExtensions) ? layer.includeExtensions : null,
      includes: compile(layer.include),
      excludes: compile(layer.exclude),
    }));
  }
  return [
    {
      source: rules.source || 'builtin',
      id: rules.id || null,
      includeExtensions: Array.isArray(rules.includeExtensions) ? rules.includeExtensions : null,
      includes: compile(rules.include),
      excludes: compile(rules.exclude),
    },
  ];
}

function compile(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (typeof item === 'string') out.push({ rule: { pattern: item }, re: compileOne(item) });
    else if (item && typeof item === 'object' && typeof item.pattern === 'string') {
      out.push({ rule: item, re: compileOne(item.pattern) });
    }
  }
  return out;
}

function compileOne(pattern) {
  // 复用 util 的编译结果（避免 glob 语义漂移）。
  return globToRegExp(pattern);
}

/** 读文件大小 + token 估算（供分组使用）。 */
export function describeFiles(paths, root) {
  return paths.map((rel) => {
    const abs = root ? path.join(root, rel) : null;
    const size = abs ? sizeOf(abs) : 0;
    return { path: rel, absPath: abs, size, tokens: estimateTokens(size) };
  });
}

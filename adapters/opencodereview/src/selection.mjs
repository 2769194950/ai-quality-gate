// adapters/opencodereview/src/selection.mjs
// 纯确定性文件选择（复刻 OCR internal/agent/selection.go 的语义）。
// 关键性质：无副作用、不读环境变量、不发起网络请求；
// `--preview` 与真实执行走同一条代码路径 ⇒ 预览结果 = 执行结果。

import fs from 'node:fs';
import path from 'node:path';
import {
  FILTER_VERSION,
  classifyFile,
  describeFiles,
  detectHardlinkSecret,
  isBinaryFile,
  isSupportedExtension,
  isSensitivePath,
  isInDefaultExcludedDir,
} from './filters.mjs';import { normalizeRel, sortPaths, toPosix, deepClone } from './util.mjs';

export const SELECTION_VERSION = '1.0.0';

export class SelectionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SelectionError';
    this.code = details.code || 'CONFIG_INVALID';
    this.details = details;
  }
}

/** 从 diff.json 读取候选文件（支持 git diff 常见字段）。 */
export function loadDiff(diffPath) {
  const abs = path.resolve(diffPath);
  if (!fs.existsSync(abs)) {
    throw new SelectionError(`diff file not found: ${abs}`, { code: 'CONFIG_NOT_FOUND', path: abs });
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new SelectionError(`diff file is not valid JSON: ${abs}`, { code: 'CONFIG_INVALID', path: abs, cause: String(err && err.message) });
  }
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.files) ? parsed.files : null;
  if (!entries) {
    throw new SelectionError(`diff file must be an array or {files:[...]}: ${abs}`, { code: 'CONFIG_INVALID', path: abs });
  }
  const files = [];
  for (const raw of entries) {
    if (typeof raw === 'string') {
      files.push({ path: normalizeRel(raw), status: 'modified', binary: false, size: null });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const p = raw.path || raw.file || raw.filename || raw.new_path || raw.newPath;
    if (!p) continue;
    files.push({
      path: normalizeRel(p),
      status: String(raw.status || raw.change || raw.type || 'modified').toLowerCase(),
      binary: raw.binary === true || raw.binary === 'true',
      size: Number.isFinite(raw.size) ? raw.size : null,
      additions: Number.isFinite(raw.additions) ? raw.additions : null,
      deletions: Number.isFinite(raw.deletions) ? raw.deletions : null,
    });
  }
  return { version: parsed.version || '1.0', files, diffPath: abs, diffPathRoots: inferDiffRoots(abs, entries) };
}

/**
 * 推断 diff 中相对路径的锚点目录（**同时**用于读取真实大小与「敏感文件身份链」）。
 *
 * 必须健壮的原因（t42 / blocker F1）：diff 文件常被放在**与被检仓库并列**的位置
 * （例如 `<base>/diff.json` + `<base>/repo/…`，CI 里也常见 diff 作为制品单独落地），
 * 此时「diff 所在目录」不是仓库根。早期实现只在「diff 目录 / cwd 及其祖先」里找，
 * 于是：
 *   * 大小估算退化为 0（小问题）；
 *   * **`sensitiveInodes` 变空 ⇒ 硬链接别名身份链失效**（blocker）——
 *     `docs.txt` 硬链接到 `.env` 时只能靠内容形态启发式，而内容不可判形态的密钥就直接绕过。
 *
 * 现在的候选集合（按优先级）：
 *   1) 显式 `--root`（由调用方直接给出，不经过本函数）；
 *   2) diff 所在目录及其逐级祖先；
 *   3) **diff 所在目录的直接子目录**（覆盖 `<base>/diff.json` + `<base>/repo/` 这一常见布局）；
 *   4) cwd 及其逐级祖先。
 * 取「能解释最多候选路径」的那个；命中率不足 50% 时返回 null 而不是给错值，
 * 但**只要 ≥1 条命中**就记录 best（身份链需要根，宁可命中率低也要拿到根）。
 */
export function inferDiffRoots(diffAbs, entries) {
  const sanity = Array.isArray(entries)
    ? entries.map((e) => (typeof e === 'string' ? e : e && (e.path || e.file || e.filename || e.new_path || e.newPath))).filter(Boolean)
    : [];
  const dir = path.dirname(diffAbs);
  const roots = [];
  const pushAncestors = (base) => {
    let cur = base;
    for (let i = 0; i < 6; i += 1) {
      roots.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  };
  pushAncestors(dir);
  pushAncestors(process.cwd());
  /**
   * diff 所在目录的**直接子目录**，以及其**父目录的直接子目录**：
   * 覆盖 t42 实测的两类真实布局 ——
   *   `<base>/diff.json` + `<base>/repo/…`（diff 与仓库并列）；
   *   `<base>/artifacts/diff.json` + `<base>/repo/…`（diff 落在子目录，仓库是**父目录的兄弟**）。
   * 只扫两层、只 stat 不写入，成本极低；找不到就退化为旧行为。
   */
  const scanChildren = (d) => {
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) roots.push(path.join(d, entry.name));
      }
    } catch {
      /* 读不到就跳过 */
    }
  };
  scanChildren(dir);
  scanChildren(path.dirname(dir));
  const unique = [...new Set(roots.map((r) => path.resolve(r)))];
  const score = (candidate) => {
    let hits = 0;
    for (const rel of sanity) {
      try {
        if (fs.statSync(path.join(candidate, rel)).isFile()) hits += 1;
      } catch {
        /* 该候选解释不了这条路径 */
      }
    }
    return hits;
  };
  // 保持候选的**优先级顺序**（先 diff 目录链，再 diff 子目录，最后 cwd 链），
  // 只用命中数做消歧；避免 cwd 祖先链里某个目录因巧合胜出。
  let best = null;
  for (const candidate of unique) {
    const hits = score(candidate);
    if (hits === 0) continue;
    if (!best || hits > best.hits) best = { root: candidate, hits };
    if (hits === sanity.length) break;
  }
  if (!best) return null;
  const ratio = sanity.length > 0 ? best.hits / sanity.length : 1;
  // 命中率低也照常返回：根对「敏感文件身份链」是必需的，且调用方只把它当只读锚点。
  // 低命中率一并暴露（lowConfidence）便于审计，但不再直接丢弃 —— 丢弃正是 F1 的成因。
  return { root: best.root, hits: best.hits, total: sanity.length, ratio, lowConfidence: ratio < 0.5 };
}

/** 扫描目录树得到候选文件（--root 模式）。 */
export function scanRoot(rootPath, opts = {}) {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root)) {
    throw new SelectionError(`root not found: ${root}`, { code: 'CONFIG_NOT_FOUND', path: root });
  }
  const maxFiles = Number.isFinite(opts.maxScanFiles) ? opts.maxScanFiles : 20000;
  const perDirReportCap = Number.isFinite(opts.perDirReportCap) ? opts.perDirReportCap : 200;
  const out = [];
  const excludedDirSummary = {};
  // 默认排除目录只做「浅层枚举」：不下钻，但把前 perDirReportCap 个文件作为候选上报，
  // 由 classifyFile 给出 default_excluded_dir 判定 ⇒ excluded 列表透明呈现被剪掉的噪声。
  const walkShallow = (dir, relDir, isExcludedDir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let reported = 0;
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = normalizeRel(path.relative(root, abs));
      if (entry.isDirectory()) {
        const seg = isInDefaultExcludedDir(`${rel}/x`);
        if (seg) {
          excludedDirSummary[seg] = (excludedDirSummary[seg] || 0) + 1;
          // 只浅层枚举该排除目录本身；不再下钻（.git/objects 这类目录不展开）。
          walkShallow(abs, rel, true);
        } else if (!isExcludedDir) {
          walkShallow(abs, rel, false);
        } else {
          excludedDirSummary[relDir] = (excludedDirSummary[relDir] || 0) + 1;
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (isExcludedDir) {
        excludedDirSummary[relDir] = (excludedDirSummary[relDir] || 0) + 1;
        if (reported >= perDirReportCap) continue;
        reported += 1;
      }
      if (out.length >= maxFiles) continue;
      out.push({ path: rel, status: 'modified', binary: isBinaryFile(rel, abs).binary, size: null });
    }
  };
  walkShallow(root, '', false);
  return { version: '1.0', files: out, diffPath: null, excludedDirSummary };
}

/**
 * 执行确定性选择。
 * @param {object} opts
 * @param {string} [opts.diffPath] 变更集（与 root 二选一）
 * @param {string} [opts.root]     扫描根（--root 模式）
 * @param {object} opts.rules      resolveRules() 的返回值（含 layers）
 * @param {string} [opts.rootForRules] 规则文件所在根（默认 = 扫描根或 cwd）
 * @returns {{included:Array,excluded:Array,counts:object,version:string}}
 */
export function selectFiles(opts = {}) {
  const rulesCtx = opts.rules || null;
  const layers = rulesCtx ? rulesCtx.layers : [{ source: 'builtin:opencodereview-default', include: [], exclude: [] }];

  let candidates;
  let sourceKind;
  let sizeRoot = opts.sizeRoot ? path.resolve(opts.sizeRoot) : null;
  if (opts.diffPath) {
    candidates = loadDiff(opts.diffPath);
    sourceKind = 'diff';
    if (!sizeRoot && candidates.diffPathRoots) sizeRoot = candidates.diffPathRoots.root;
  } else if (opts.root) {
    candidates = scanRoot(opts.root, opts);
    sourceKind = 'root';
    sizeRoot = sizeRoot || path.resolve(opts.root);
  } else {
    throw new SelectionError('either diffPath or root is required', { code: 'CONFIG_INVALID' });
  }

  const rootForSizes = sizeRoot || (opts.root ? path.resolve(opts.root) : null);
  const effectiveDirs = rulesCtx && rulesCtx.effective ? rulesCtx.effective.defaultExcludeDirs : null;
  const rules = {
    layers,
    defaultExcludeDirs: effectiveDirs || null,
    allowUnsupportedExtensions: opts.allowUnsupportedExtensions === true,
  };

  // 去重（同路径后者覆盖前者）后按确定性顺序处理 ⇒ 输出顺序与输入顺序无关。
  const byPath = new Map();
  for (const f of candidates.files) {
    if (!f.path) continue;
    byPath.set(f.path, f);
  }
  const order = sortPaths([...byPath.keys()]);

  // H2（硬链接别名）前置：先把工作集里**敏感路径对应文件**的 (dev:ino) 收集成一个集合，
  // 供 classifyFile 判定「某个无害路径是否与敏感文件同源 inode」。这样即使别名不叫 `.env`
  // （例如 `docs.txt` 硬链接到 `.env`），也能被识别为同一份密钥材料。
  const sensitiveInodes = new Set();
  if (rootForSizes) {
    for (const rel of order) {
      if (!isSensitivePath(rel)) continue;
      try {
        const st = fs.statSync(path.join(rootForSizes, rel));
        if (st.isFile()) sensitiveInodes.add(`${st.dev}:${st.ino}`);
      } catch {
        /* 文件不存在（diff 中的新增项）⇒ 无从取 inode，跳过 */
      }
    }
  }

  const included = [];
  const excluded = [];
  const unmaterialized = [];
  for (const rel of order) {
    const meta = byPath.get(rel);
    const verdict = classifyFile(rel, rules, { root: rootForSizes, sensitiveInodes });
    // 物化判定（t48 / R3-L2）：diff 声明的路径在盘上可能不存在（如 `gone/*.js`）。
    // 「声明了但没物化」必须**显式可查**，但不能污染「评审覆盖面」派生计数。
    const materialized = rootForSizes ? fs.existsSync(path.join(rootForSizes, rel)) : true;
    const detail = {
      path: rel,
      decision: verdict.decision,
      reason: verdict.reason,
      ruleSource: verdict.ruleSource,
      ruleId: verdict.ruleId ?? null,
      pattern: verdict.pattern ?? null,
      decidedBy: verdict.decidedBy,
      status: meta.status,
      materialized,
    };
    if (verdict.decision === 'included') {
      const size = Number.isFinite(meta.size) ? meta.size : null;
      included.push({ ...detail, size });
      if (!materialized) unmaterialized.push(rel);
    } else {
      excluded.push({
        path: rel,
        decision: 'excluded',
        reason: verdict.reason,
        ruleSource: verdict.ruleSource,
        ruleId: verdict.ruleId ?? null,
        pattern: verdict.pattern ?? null,
        decidedBy: verdict.decidedBy,
        status: meta.status,
      });
    }
  }

  // 附上真实文件大小以支撑 token 预算（读不到则为 0）。
  const sized = describeFiles(included.map((i) => i.path), rootForSizes);
  const sizeByPath = new Map(sized.map((s) => [s.path, s]));
  for (const item of included) {
    const s = sizeByPath.get(item.path);
    item.size = item.size ?? (s ? s.size : 0);
    item.tokens = s ? s.tokens : 0;
  }

  return {
    version: SELECTION_VERSION,
    filterVersion: FILTER_VERSION,
    source: sourceKind,
    sourcePath: candidates.diffPath || (opts.root ? path.resolve(opts.root) : null),
    sizeRoot: rootForSizes,
    // 敏感文件身份集（dev:ino）：供安全断言独立复检硬链接别名（两条路径同源，见 t42/F1）。
    sensitiveInodes,
    excludedDirSummary: candidates.excludedDirSummary || {},
    included,
    excluded,
    // 未物化路径（diff 声明了、盘上不存在）显式单列：事实可查，但不与「真实被评审的文件」
    // 混在同一个计数里（见 counts.materializedIncluded）。t48 / R3-L2。
    unmaterialized,
    counts: {
      candidates: order.length,
      included: included.length,
      excluded: excluded.length,
      // 「评审覆盖面」应当用这个数（= included.length - unmaterialized.length），
      // 而不是 included.length：diff 里的未物化路径不构成可评审内容。
      materializedIncluded: included.length - unmaterialized.length,
      unmaterialized: unmaterialized.length,
      excludedSensitive: excluded.filter((e) => String(e.reason).startsWith('sensitive_path')).length,
      excludedBinary: excluded.filter((e) => String(e.reason).startsWith('binary_file')).length,
      excludedDir: excluded.filter((e) => String(e.reason).startsWith('default_excluded_dir')).length,
      excludedExtension: excluded.filter((e) => String(e.reason).startsWith('unsupported_extension')).length,
    },
    snapshot: () => deepClone({ included: included.map((i) => i.path), excluded: excluded.map((e) => e.path) }),
  };
}

/**
 * 安全断言（供 qgate policy / CI 直接复用）：任何 selected 列表都不含密钥路径。
 *
 * 除路径类判定外，还要独立复检**硬链接别名**（S6）：`docs.txt` 硬链接到 `.env` 时
 * 路径毫无破绽，若只按路径断言就会给出**假保证**。这里对入选文件重新做一次
 * 「nlink>1 且内容呈密钥形态」检查（成本仅落在少数硬链接文件上），
 * 使断言本身不依赖 classifyFile 的正确性。
 */
export function assertNoSensitiveSelected(selection) {
  const violations = selection.included
    .map((i) => i.path)
    .filter((p) => isSensitivePath(p) || isBinaryFile(p).binary || isInDefaultExcludedDir(p) !== null || !isSupportedExtension(p));
  // 独立复检硬链接别名：使用 selection 记录的 sizeRoot 定位真实文件
  const hardlinkAliases = [];
  const root = selection.sizeRoot || null;
  if (root) {
    for (const item of selection.included) {
      const verdict = detectHardlinkSecret(item.path, path.join(root, item.path), selection.sensitiveInodes ? { sensitiveInodes: selection.sensitiveInodes } : {});
      if (verdict.alias) hardlinkAliases.push({ path: item.path, via: verdict.via, nlink: verdict.nlink, patterns: verdict.patterns });
    }
  }
  return {
    ok: violations.length === 0 && hardlinkAliases.length === 0,
    violations,
    hardlinkAliases,
    rule: 'SAFETY-001: selected 列表不得包含密钥/凭证路径、二进制、默认排除目录、不支持扩展名、硬链接密钥别名(S6)',
  };
}

export { toPosix };

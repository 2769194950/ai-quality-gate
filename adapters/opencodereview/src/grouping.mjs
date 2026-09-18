// adapters/opencodereview/src/grouping.mjs
// FileGroup 分组（复刻 OCR maxFilesPerGroup / token 预算降级 / 分组失败回退 per-file）。
//
// 硬约束：
//   G1 每组文件数 ≤ MAX_FILES_PER_GROUP（默认 10）。
//   G2 组内估算 token 超过 token 预算 ⇒ 该组降级为一组一个文件（单文件桶）。
//   G3 分组本身失败（异常）⇒ 回退为逐文件桶，绝不产生“半个结论”。
//   G4 同输入 ⇒ 同输出（分组键、组序、组内文件序全部确定性）。

import { sortPaths } from './util.mjs';
import { globToRegExp } from './util.mjs';

/** 每组最大文件数（OCR maxFilesPerGroup 的复刻值，测试按此字面量断言）。 */
export const MAX_FILES_PER_GROUP = 10;

/** 默认 token 预算（超预算按 OCR 语义降级为单文件组）。 */
export const DEFAULT_TOKEN_BUDGET = 32000;

/** 单字符预算：token ≈ chars/4，故 chars 预算 = token*4。 */
export const CHARS_PER_TOKEN = 4;

export const GROUPING_VERSION = '1.0.0';

/** 估算一组文件的总 token（无 size 信息按 0 计；容错，永不抛出）。 */
export function groupTokens(files) {
  let sum = 0;
  for (const f of files) {
    try {
      if (Number.isFinite(f.tokens)) sum += f.tokens;
      else if (Number.isFinite(f.size)) sum += Math.ceil(f.size / CHARS_PER_TOKEN);
    } catch {
      /* 单个文件的元数据不可读 ⇒ 按 0 计，不影响整体分组确定性 */
    }
  }
  return sum;
}

/** 计算所有路径的最长目录前缀（确定性分组锚点）。 */
export function commonDirPrefix(paths) {
  if (paths.length === 0) return '';
  const split = paths.map((p) => String(p).split('/').slice(0, -1));
  let prefix = split[0];
  for (const segs of split.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < segs.length && prefix[i] === segs[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix.join('/');
}

/** 自动分段：按「公共前缀后的第一段目录」聚类，无目录者归入 (root) 桶。 */
export function autoSegment(files, opts = {}) {
  const paths = files.map((f) => f.path);
  const prefix = commonDirPrefix(paths);
  const prefixDepth = prefix === '' ? 0 : prefix.split('/').length;
  const buckets = new Map();
  const ordered = sortPaths(paths);
  for (const rel of ordered) {
    const segs = rel.split('/');
    const key = segs.length - 1 > prefixDepth ? segs[prefixDepth] : '(root)';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(rel);
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, list]) => ({ key: key === '(root)' ? prefix || '(root)' : `${prefix ? `${prefix}/` : ''}${key}`, files: list.map((p) => byPath.get(p)).filter(Boolean) }));
}

/** 把一组文件切成 ≤ maxFiles 的块（保持组内确定性顺序）。 */
export function chunkBySize(files, maxFiles) {
  const out = [];
  for (let i = 0; i < files.length; i += maxFiles) out.push(files.slice(i, i + maxFiles));
  return out;
}

/** 单文件桶（G2/G3 降级形态）。 */
function perFileBuckets(files, reason, sourceGroup) {
  return files.map((f) => ({
    id: `per-file:${f.path}`,
    key: f.path,
    files: [f],
    downgraded: true,
    downgradeReason: reason,
    sourceGroup: sourceGroup ?? null,
  }));
}

/**
 * 主分组入口。
 * @param {Array<{path:string,size?:number,tokens?:number}>} files 已选中文件
 * @param {object} [opts]
 * @param {number} [opts.maxFilesPerGroup]     覆盖 MAX_FILES_PER_GROUP（不得超过 10）
 * @param {number} [opts.tokenBudget]          token 预算（默认 DEFAULT_TOKEN_BUDGET）
 * @param {boolean} [opts.singleGroup]         强制单组（用于 --group-mode single）
 * @param {boolean} [opts.perFile]             强制单文件桶
 * @param {Array} [opts.buckets]               [{id, patterns:[...]}] 显式分桶规则
 * @param {string} [opts.mode]                 auto | single | per-file
 */
export function groupFiles(files, opts = {}) {
  const requested = Number.isFinite(opts.maxFilesPerGroup) ? opts.maxFilesPerGroup : MAX_FILES_PER_GROUP;
  // G1：上限是硬约束，任何调用方都不能把它调大。
  const maxFiles = Math.max(1, Math.min(MAX_FILES_PER_GROUP, Math.floor(requested)));
  const tokenBudget = Number.isFinite(opts.tokenBudget) && opts.tokenBudget > 0 ? opts.tokenBudget : DEFAULT_TOKEN_BUDGET;
  const mode = opts.mode || (opts.perFile ? 'per-file' : opts.singleGroup ? 'single' : 'auto');

  // 排序本身也可能因输入畸形而失败（G3 要求：任何分组失败都必须回退 per-file）。
  let list;
  try {
    list = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  } catch (err) {
    const raw = Array.isArray(files) ? files.filter((f) => f && typeof f.path === 'string') : [];
    return finalize(perFileBuckets(raw, 'grouping_failed', null), {
      maxFiles,
      tokenBudget,
      mode: 'per-file',
      notes: [`grouping_failed_fallback:${String(err && err.message)}`],
    });
  }
  if (list.length === 0) {
    return {
      version: GROUPING_VERSION,
      maxFilesPerGroup: maxFiles,
      tokenBudget,
      mode,
      groupCount: 0,
      downgradedGroups: 0,
      singleFileGroups: 0,
      groups: [],
      notes: ['empty_selection'],
      invariantCheck: true,
    };
  }

  try {
    if (mode === 'per-file') {
      return finalize(perFileBuckets(list, 'requested_per_file', null), { maxFiles, tokenBudget, mode, notes: ['forced_per_file'] });
    }
    if (mode === 'single') {
      if (list.length > maxFiles) {
        return finalize(
          chunkBySize(list, maxFiles).map((chunk, i) => ({ id: `single:${i + 1}`, key: `single:${i + 1}`, files: chunk, downgraded: false })),
          { maxFiles, tokenBudget, mode, notes: ['single_mode_split_by_max_files'] },
        );
      }
      return finalize([{ id: 'single:1', key: 'single:1', files: list, downgraded: false }], { maxFiles, tokenBudget, mode, notes: [] });
    }

    const buckets = buildBuckets(list, opts.buckets);
    const groups = [];
    const notes = [];
    for (const bucket of buckets) {
      // G2 先判 token 预算：超预算整组降级为单文件桶（OCR 语义）。
      const tokens = groupTokens(bucket.files);
      if (tokens > tokenBudget) {
        notes.push(`token_budget_downgrade:${bucket.key}:${tokens}>${tokenBudget}`);
        groups.push(...perFileBuckets(bucket.files, 'token_budget_exceeded', bucket.key));
        continue;
      }
      const chunks = chunkBySize(bucket.files, maxFiles);
      if (chunks.length > 1) notes.push(`max_files_split:${bucket.key}:${chunks.length}`);
      chunks.forEach((chunk, idx) => {
        groups.push({
          id: chunks.length > 1 ? `${bucket.key}#${idx + 1}` : bucket.key,
          key: bucket.key,
          files: chunk,
          downgraded: false,
          downgradeReason: null,
          sourceGroup: bucket.key,
        });
      });
    }
    return finalize(groups, { maxFiles, tokenBudget, mode, notes });
  } catch (err) {
    // G3：分组失败 ⇒ 回退逐文件桶，不产生部分结果。
    return finalize(perFileBuckets(list, 'grouping_failed', null), {
      maxFiles,
      tokenBudget,
      mode: 'per-file',
      notes: [`grouping_failed_fallback:${String(err && err.message)}`],
    });
  }
}

/** 显式分桶规则优先；未命中任何规则的文件按公共前缀自动分段。 */
export function buildBuckets(files, bucketRules) {
  const rules = Array.isArray(bucketRules) ? bucketRules : [];
  const claimed = new Set();
  const out = [];
  for (const rule of rules) {
    if (!rule || !rule.id || !Array.isArray(rule.patterns)) continue;
    const regexps = rule.patterns.map((p) => globToRegExp(p));
    const matched = files.filter((f) => !claimed.has(f.path) && regexps.some((re) => re.test(f.path) || re.test(f.path.split('/').pop())));
    if (matched.length === 0) continue;
    for (const f of matched) claimed.add(f.path);
    out.push({ key: `bucket:${rule.id}`, files: matched });
  }
  const rest = files.filter((f) => !claimed.has(f.path));
  if (rest.length > 0) out.push(...autoSegment(rest));
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function finalize(groups, { maxFiles, tokenBudget, mode, notes }) {
  const normalized = groups.map((g) => ({
    id: g.id,
    key: g.key,
    files: g.files.map((f) => (typeof f === 'string' ? f : f.path)),
    fileCount: g.files.length,
    estimatedTokens: groupTokens(g.files),
    downgraded: Boolean(g.downgraded),
    downgradeReason: g.downgradeReason || null,
    sourceGroup: g.sourceGroup || null,
  }));
  return {
    version: GROUPING_VERSION,
    maxFilesPerGroup: maxFiles,
    tokenBudget,
    mode,
    groupCount: normalized.length,
    downgradedGroups: normalized.filter((g) => g.downgraded).length,
    singleFileGroups: normalized.filter((g) => g.fileCount === 1 && g.downgraded).length,
    notes,
    groups: normalized,
    invariantCheck: normalized.every((g) => g.fileCount <= maxFiles),
  };
}

/** 供 policy/CI 复用的断言：分组不变量全部成立。 */
export function assertGroupingInvariants(grouping) {
  const violations = [];
  if (!grouping.invariantCheck && grouping.groups.length > 0) violations.push('a group exceeds MAX_FILES_PER_GROUP');
  for (const g of grouping.groups) {
    if (g.fileCount > MAX_FILES_PER_GROUP) violations.push(`group ${g.id} has ${g.fileCount} files > ${MAX_FILES_PER_GROUP}`);
    if (g.fileCount === 0) violations.push(`group ${g.id} is empty`);
  }
  const seen = new Set();
  for (const g of grouping.groups) {
    for (const f of g.files) {
      if (seen.has(f)) violations.push(`file appears in multiple groups: ${f}`);
      seen.add(f);
    }
  }
  return { ok: violations.length === 0, violations, rules: ['G1 <= MAX_FILES_PER_GROUP', 'G2 token downgrade', 'G4 deterministic'] };
}

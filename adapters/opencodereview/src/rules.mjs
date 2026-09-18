// adapters/opencodereview/src/rules.mjs
// 四层优先级规则解析（复刻 .opencodereview/rule.json 语义）：
//   L1 --rule <path>                      （CLI 显式覆盖，最高）
//   L2 <root>/.opencodereview/rule.json   （项目级）
//   L3 ~/.opencodereview/rule.json        （用户级）
//   L4 内置默认                            （最低）
// 「第一条匹配生效」：对单个文件，按 L1→L4 遍历，同一层内按 include/exclude
// 数组出现顺序遍历，第一个命中的模式决定该文件命运并停止。
//
// 规则文件结构（v1.0）：
// {
//   "version": "1.0",
//   "include": ["**/*.mjs", { "id": "...", "pattern": "...", "reason": "..." }],
//   "exclude": ["**/*.md"],
//   "includeExtensions": [".mjs", ".ts"],
//   "defaultExcludeDirs": ["build"],
//   "maxTokensPerGroup": 32000,
//   "grouping": { "maxFilesPerGroup": 10 }
// }

import fs from 'node:fs';
import path from 'node:path';
import { normalizeRel, deepClone } from './util.mjs';

export const RULE_SOURCES = Object.freeze({
  CLI: 'cli:--rule',
  PROJECT: 'project:.opencodereview/rule.json',
  USER: 'user:~/.opencodereview/rule.json',
  BUILTIN: 'builtin:opencodereview-default',
});

export const RULE_PRIORITY = Object.freeze({
  [RULE_SOURCES.CLI]: 1,
  [RULE_SOURCES.PROJECT]: 2,
  [RULE_SOURCES.USER]: 3,
  [RULE_SOURCES.BUILTIN]: 4,
});

/**
 * 内置默认规则：不主动收窄，只保证默认排除目录与分组上限与 OCR 一致。
 * 注意：这里 **不含任何 include**，因此无法把敏感路径拉回来；
 * 即便未来加入 include，filters.classifyFile 的 step 0 也会先返回。
 */
export const BUILTIN_RULE = Object.freeze({
  version: '1.0',
  source: RULE_SOURCES.BUILTIN,
  id: 'builtin',
  include: [],
  exclude: [],
  maxTokensPerGroup: 32000,
  grouping: { maxFilesPerGroup: 10 },
  defaultExcludeDirs: null, // null ⇒ 使用 filters.DEFAULT_EXCLUDE_DIRS
});

export class RuleError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RuleError';
    this.code = 'CONFIG_INVALID';
    this.details = details;
  }
}

/** 读取并解析单个规则文件；不存在返回 null；不合法抛 RuleError。 */
export function readRuleFile(filePath, sourceLabel) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return null;
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new RuleError(`rule file is not readable: ${abs}`, { path: abs, cause: String(err && err.message) });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RuleError(`rule file is not valid JSON: ${abs}`, { path: abs, cause: String(err && err.message) });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RuleError(`rule file must be a JSON object: ${abs}`, { path: abs });
  }
  const check = inspectRuleShape(parsed);
  return { ...parsed, source: sourceLabel, file: abs, __shape: check };
}

/** 适配层能识别的规则文件键（用于判断「这份文件是不是给我们用的」）。 */
export const RECOGNIZED_RULE_KEYS = Object.freeze([
  'include', 'exclude', 'includeExtensions', 'defaultExcludeDirs', 'maxTokensPerGroup', 'grouping', 'allowUnsupportedExtensions',
]);

/**
 * 判断规则文件是否为本适配层可识别的格式。
 *
 * 为什么需要它（rule.json 格式不对称缺陷）：引擎侧 `qgate` 的规则文件格式是
 * `{ schemaVersion, rules: [{ id, match, severity, category }] }`，而本适配层用的是
 * `{ include, exclude, includeExtensions, grouping }`。两侧**格式不同且失效方向不对称**：
 *   * 引擎遇到不认识的格式 ⇒ exit 2 / CONFIG_INVALID（用户立刻知道规则没生效）；
 *   * 适配层此前遇到引擎格式 ⇒ **静默忽略**（规则没生效但无人知晓，输出看起来完全正常）。
 * 「看起来配了、实际没生效」正是确定性工程要消灭的状态，因此这里显式检出并上报，
 * 由调用方转成可见信号（degraded:true + RULE_FORMAT_UNSUPPORTED），不再静默。
 *
 * @returns {{ok: boolean, reason: string|null, detail: string|null, kind: string}}
 */
export function inspectRuleShape(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'RULE_FORMAT_UNSUPPORTED', detail: Array.isArray(parsed) ? 'top-level array' : typeof parsed, kind: 'invalid' };
  }
  const keys = Object.keys(parsed).filter((k) => !k.startsWith('_'));
  const recognized = keys.filter((k) => RECOGNIZED_RULE_KEYS.includes(k));
  if (recognized.length > 0) return { ok: true, reason: null, detail: null, kind: 'adapter' };
  // 引擎格式：{ schemaVersion, rules: [...] }（rules 是数组，或整个文件就是规则数组）
  if (Array.isArray(parsed.rules)) {
    return {
      ok: false,
      reason: 'RULE_FORMAT_UNSUPPORTED',
      detail: 'engine rule format detected: { rules: [{ id, match, severity, category }] } is not the adapter format ({ include, exclude, includeExtensions, grouping })',
      kind: 'engine',
    };
  }
  // 完全空对象 / 只有未知键：同样无法据此配置任何规则
  if (keys.length === 0 || recognized.length === 0) {
    return {
      ok: false,
      reason: 'RULE_FORMAT_UNSUPPORTED',
      detail: `no recognized rule keys found (expected one of: ${RECOGNIZED_RULE_KEYS.join(', ')})`,
      kind: 'unknown',
    };
  }
  return { ok: true, reason: null, detail: null, kind: 'adapter' };
}

function candidate(spec) {
  if (!spec) return null;
  if (typeof spec === 'object' && spec.path) return spec;
  return { path: spec };
}

/**
 * 解析四层规则。
 * @param {object} opts
 * @param {string} [opts.root]        项目根（用于定位项目级规则文件）
 * @param {string} [opts.cliRulePath] --rule 指定的文件
 * @param {string} [opts.projectRulePath] 显式覆盖项目级路径（测试用）
 * @param {string} [opts.userRulePath]    显式覆盖用户级路径（测试用）
 * @param {string} [opts.homeDir]         用于推导 ~/.opencodereview/rule.json
 * @param {string[]} [opts.include]       --include 追加到最高层
 * @param {string[]} [opts.exclude]       --exclude 追加到最高层
 * @param {boolean} [opts.strict]         true ⇒ anchor 文件缺失时抛错（默认 false=静默跳过）
 */
export function resolveRules(opts = {}) {
  const root = opts.root ? path.resolve(opts.root) : process.cwd();
  const homeDir = opts.homeDir || process.env.HOME || process.env.USERPROFILE || '';
  const layers = [];
  const trace = [];

  const cliSpec = candidate(opts.cliRulePath);
  if (cliSpec) {
    const file = path.resolve(cliSpec.path);
    const layer = readRuleFile(file, RULE_SOURCES.CLI);
    if (!layer && opts.strict) throw new RuleError(`--rule file not found: ${file}`, { path: file });
    trace.push({ source: RULE_SOURCES.CLI, priority: 1, path: file, loaded: Boolean(layer) });
    if (layer) layers.push(layer);
  }

  const projectPath = opts.projectRulePath
    ? path.resolve(opts.projectRulePath)
    : path.join(root, '.opencodereview', 'rule.json');
  const projectLayer = readRuleFile(projectPath, RULE_SOURCES.PROJECT);
  trace.push({ source: RULE_SOURCES.PROJECT, priority: 2, path: projectPath, loaded: Boolean(projectLayer) });
  if (projectLayer) layers.push(projectLayer);

  const userPath = opts.userRulePath
    ? path.resolve(opts.userRulePath)
    : homeDir
      ? path.join(homeDir, '.opencodereview', 'rule.json')
      : '';
  if (userPath) {
    const userLayer = readRuleFile(userPath, RULE_SOURCES.USER);
    trace.push({ source: RULE_SOURCES.USER, priority: 3, path: userPath, loaded: Boolean(userLayer) });
    if (userLayer) layers.push(userLayer);
  } else {
    trace.push({ source: RULE_SOURCES.USER, priority: 3, path: null, loaded: false });
  }

  // 内置层永远存在，保证规则引擎在「零用户配置」下也完全确定。
  const builtin = { ...deepClone({ ...BUILTIN_RULE, source: undefined }), source: RULE_SOURCES.BUILTIN };
  layers.push(builtin);
  trace.push({ source: RULE_SOURCES.BUILTIN, priority: 4, path: null, loaded: true });

  // --include/--exclude 组成一个额外的最高层（priority 0，仅本次调用有效）。
  if ((Array.isArray(opts.include) && opts.include.length > 0) || (Array.isArray(opts.exclude) && opts.exclude.length > 0)) {
    const overlay = {
      version: '1.0',
      source: 'cli:flags',
      id: 'cli-flags',
      include: Array.isArray(opts.include) ? opts.include : [],
      exclude: Array.isArray(opts.exclude) ? opts.exclude : [],
    };
    layers.unshift(overlay);
    trace.unshift({ source: 'cli:flags', priority: 0, path: null, loaded: true });
  }

  // 不可识别格式的规则层必须显式上报（不得静默忽略）——见 inspectRuleShape 的说明。
  const unsupported = layers
    .filter((l) => l.__shape && l.__shape.ok === false)
    .map((l) => ({ source: l.source, file: l.file ?? null, reason: l.__shape.reason, detail: l.__shape.detail, kind: l.__shape.kind }));
  for (const t of trace) {
    const hit = unsupported.find((u) => u.source === t.source);
    if (hit) {
      t.formatSupported = false;
      t.formatReason = hit.reason;
    } else {
      t.formatSupported = true;
      t.formatReason = null;
    }
  }

  return {
    version: '1.0',
    root,
    layers,
    trace,
    effective: effectiveSettings(layers),
    unsupportedLayers: unsupported,
    formatSupported: unsupported.length === 0,
    describe: () => describeLayers(trace),
  };
}

/** 合并各层的全局设置（高优先层覆盖低优先层；数组字段取最高优先层中第一个非空值）。 */
export function effectiveSettings(layers) {
  const pick = (key) => {
    for (const layer of layers) {
      const v = layer[key];
      if (Array.isArray(v) && v.length > 0) return v;
      if (!Array.isArray(v) && v !== undefined && v !== null) return v;
    }
    return undefined;
  };
  const grouping = {};
  for (const layer of layers) {
    if (layer.grouping && typeof layer.grouping === 'object') {
      for (const [k, v] of Object.entries(layer.grouping)) {
        if (grouping[k] === undefined && v !== undefined && v !== null) grouping[k] = v;
      }
    }
  }
  return {
    includeExtensions: pick('includeExtensions') || null,
    defaultExcludeDirs: pick('defaultExcludeDirs') || null,
    maxTokensPerGroup: pick('maxTokensPerGroup') || null,
    maxFilesPerGroup: grouping.maxFilesPerGroup ?? null,
    grouping,
  };
}

/** 人类可读的层来源表。 */
export function describeLayers(trace) {
  return trace.map((t) => ({
    priority: t.priority,
    source: t.source,
    file: t.path,
    loaded: t.loaded,
  }));
}

/**
 * 解释某个文件的最终命中来源：返回命中层、优先级、模式与判定。
 * 与 filters.classifyFile 的判定顺序保持一致（安全层优先）。
 */
export function explainFile(relPath, classification, ruleContext) {
  const p = normalizeRel(relPath);
  const source = classification.ruleSource || 'builtin';
  return {
    path: p,
    decision: classification.decision,
    reason: classification.reason,
    ruleSource: source,
    priority: RULE_PRIORITY[source] ?? (source === 'cli:flags' ? 0 : null),
    ruleId: classification.ruleId ?? null,
    pattern: classification.pattern ?? null,
    decidedBy: classification.decidedBy,
    layersLoaded: ruleContext ? ruleContext.trace.filter((t) => t.loaded).map((t) => t.source) : [],
  };
}

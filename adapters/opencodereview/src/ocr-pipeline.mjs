// adapters/opencodereview/src/ocr-pipeline.mjs
// 确定性预览流水线：rules → selection → grouping → 输出 JSON / Markdown。
// preview 与真实执行走同一选择/分组代码（同源），因此预览即执行。

import fs from 'node:fs';
import path from 'node:path';
import { resolveRules, explainFile, RULE_PRIORITY } from './rules.mjs';
import { selectFiles, assertNoSensitiveSelected, SELECTION_VERSION } from './selection.mjs';
import { groupFiles, assertGroupingInvariants, MAX_FILES_PER_GROUP, DEFAULT_TOKEN_BUDGET, GROUPING_VERSION } from './grouping.mjs';
import { resolveProvider, OCR_RUNNER_VERSION } from './ocr-runner.mjs';
import { isSensitivePath } from './filters.mjs';
import { sortPaths } from './util.mjs';

export const PREVIEW_SCHEMA_VERSION = '1.0.0';

/**
 * 生成确定性预览结果。
 * @param {object} opts
 * @param {string} [opts.diff]
 * @param {string} [opts.root]
 * @param {string} [opts.cliRulePath]
 * @param {string} [opts.projectRulePath]
 * @param {string} [opts.userRulePath]
 * @param {string} [opts.homeDir]
 * @param {string[]} [opts.include]
 * @param {string[]} [opts.exclude]
 * @param {number} [opts.tokenBudget]
 * @param {number} [opts.maxFilesPerGroup]
 * @param {string} [opts.groupMode]  auto|single|per-file
 * @param {boolean} [opts.useOcr]
 * @param {boolean} [opts.noOcr]
 * @param {string} [opts.ocrBin]
 * @param {string[]} [opts.restrictPaths] 仅解释这些路径（--explain）
 */
export function createPreview(opts = {}) {
  // GAP-5 修复：diff-only 且未显式给 `--root` 时，规则锚点必须与 process.cwd() 解耦，
  // 否则项目级规则层路径（rules.layer_trace[].file）会随调用目录漂移 —— 同一输入
  // 在不同 cwd 下产出不同结果，违反 REQ-010「同输入同输出」。
  //
  // 锚点解析顺序：
  //   1) 显式 `--root` ⇒ 用它（显式参数优先，行为与修复前一致）；
  //   2) 否则用**选择阶段推断出的同一个根**（selectFiles 内部的 inferDiffRoots
  //      从 diff 路径推断项目根，并作为 sizeRoot 返回）——
  //      「选择」与「规则解析」必须用同一个根，用两个不同根会引入新的不一致；
  //   3) 兜底 diff 文件所在目录 / cwd。
  // 这里先解析一次输入（未传 rules ⇒ 不做规则判定），只为拿到 anchorRoot。
  const probe = selectFiles({ diffPath: opts.diff, root: opts.root, rules: null, sizeRoot: opts.sizeRoot });
  const anchorRoot = opts.root
    ? path.resolve(opts.root)
    : probe.sizeRoot || (opts.diff ? path.dirname(path.resolve(opts.diff)) : process.cwd());

  const rulesCtx = resolveRules({
    root: anchorRoot,
    cliRulePath: opts.cliRulePath,
    projectRulePath: opts.projectRulePath,
    userRulePath: opts.userRulePath,
    homeDir: opts.homeDir,
    include: opts.include,
    exclude: opts.exclude,
    strict: opts.strictRules === true,
  });

  const selection = selectFiles({
    diffPath: opts.diff,
    root: opts.root,
    rules: rulesCtx,
    sizeRoot: anchorRoot,
  });

  const preset = rulesCtx.effective;
  const tokenBudget = Number.isFinite(opts.tokenBudget)
    ? opts.tokenBudget
    : Number.isFinite(preset.maxTokensPerGroup)
      ? preset.maxTokensPerGroup
      : DEFAULT_TOKEN_BUDGET;
  const maxFilesPerGroup = Number.isFinite(opts.maxFilesPerGroup)
    ? opts.maxFilesPerGroup
    : Number.isFinite(preset.maxFilesPerGroup)
      ? preset.maxFilesPerGroup
      : MAX_FILES_PER_GROUP;

  const extraBuckets = Array.isArray(rulesCtx.effective.grouping && rulesCtx.effective.grouping.buckets)
    ? rulesCtx.effective.grouping.buckets
    : Array.isArray(opts.buckets)
      ? opts.buckets
      : [];
  const bucketRules = collectBuckets(rulesCtx, extraBuckets);

  const grouping = groupFiles(selection.included, {
    maxFilesPerGroup,
    tokenBudget,
    mode: opts.groupMode || 'auto',
    buckets: bucketRules,
  });

  const provider = resolveProvider({
    useOcr: opts.useOcr === true,
    noOcr: opts.noOcr === true,
    ocrBin: opts.ocrBin,
    diff: opts.diff,
    root: opts.root,
    cliRulePath: opts.cliRulePath,
    timeoutMs: opts.timeoutMs,
  });

  const safety = assertNoSensitiveSelected(selection);
  const groupingInvariants = assertGroupingInvariants(grouping);

  // 确定性输出：selected / excluded / groups 全部按路径升序。
  const selected = [...selection.included].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const excluded = [...selection.excluded].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // ── 未物化路径（t48 / R3-L2）────────────────────────────────────────────
  // diff 声明的路径在盘上可能不存在（`gone/*.js`）。它们不构成可评审内容，因此
  // **不得**进入「评审覆盖面」派生值（selected 计数 / groups[].files），
  // 但「声明了却没物化」是审计事实，必须显式可查 ⇒ 单列 unmaterialized/selected.unmaterialized_count。
  // 注意：**不改 token 逻辑**（实测 token 本就没有膨胀：未物化项 size/tokens 均为 0）。
  // `--root` 模式下候选来自扫描 ⇒ 天然全部物化；`--diff` 模式按 sizeRoot 存在性判定。
  const isMaterialized = (rel) => (selection.source === 'root' ? true : selection.sizeRoot ? fs.existsSync(path.join(selection.sizeRoot, rel)) : true);
  const unmaterialized = selected.filter((s) => !isMaterialized(s.path)).map((s) => s.path);
  const selectedMaterialized = selected.filter((s) => isMaterialized(s.path));
  // 物化后为空的组直接丢弃：否则会留下 `gone`（0 文件）这类空组，使
  // `counts.groups`/group 数与被评审批次不一致（丢掉它们后与 `--root` 的 3/3/1 完全对齐）。
  const groupsOut = [];
  let groupsDroppedUnmaterialized = 0;
  for (const g of grouping.groups) {
    const files = g.files.filter((f) => isMaterialized(f));
    if (files.length === 0) {
      groupsDroppedUnmaterialized += 1;
      continue;
    }
    groupsOut.push({
      id: g.id,
      files,
      file_count: files.length,
      estimated_tokens: g.estimatedTokens,
      downgraded: g.downgraded,
      downgrade_reason: g.downgradeReason,
      excluded_unmaterialized: g.files.length - files.length,
    });
  }

  const explainTargets = Array.isArray(opts.restrictPaths) && opts.restrictPaths.length > 0
    ? opts.restrictPaths
    : selected.slice(0, 20).map((s) => s.path);
  const byPath = new Map([...selected, ...excluded].map((e) => [e.path, e]));
  const explanations = explainTargets
    .map((p) => {
      const cls = byPath.get(p.replace(/\\/g, '/'));
      if (!cls) return null;
      return explainFile(cls.path, cls, rulesCtx);
    })
    .filter(Boolean);

  // 规则格式不可识别时也必须 degraded:true —— 否则「规则配了但没生效」会被静默吞掉。
  const ruleFormatUnsupported = rulesCtx.formatSupported === false;
  const degradedReasons = [provider.degradedReason, ruleFormatUnsupported ? 'RULE_FORMAT_UNSUPPORTED' : null].filter(Boolean);

  const payload = {
    mode: 'preview',
    schema_version: PREVIEW_SCHEMA_VERSION,
    llm_called: false,
    degraded: provider.degraded || ruleFormatUnsupported,
    degraded_reason: degradedReasons.length > 0 ? degradedReasons.join('+') : null,
    degraded_reasons: degradedReasons,
    provider: {
      name: provider.name,
      requested: provider.requested,
      ocr_available: provider.ocrAvailable,
      ocr_bin: provider.ocrBin,
      ocr_version: provider.ocrVersion,
      degraded: provider.degraded,
      degraded_reason: provider.degradedReason,
      llm_called: false,
      note: provider.note,
    },
    versions: {
      preview: PREVIEW_SCHEMA_VERSION,
      selection: SELECTION_VERSION,
      grouping: GROUPING_VERSION,
      rules: rulesCtx.version,
      ocr_runner: OCR_RUNNER_VERSION,
      max_files_per_group: MAX_FILES_PER_GROUP,
    },
    source: { kind: selection.source, path: selection.sourcePath },
    counts: {
      candidates: selection.counts.candidates,
      selected: selected.length,
      // 「评审覆盖面」应当用这个值：未物化路径不构成可评审内容（t48 / R3-L2）。
      selected_materialized: selectedMaterialized.length,
      unmaterialized: unmaterialized.length,
      excluded: excluded.length,
      // 组数按**物化后**的组计（物化后为空的组已在上面丢弃）
      groups: groupsOut.length,
      groups_dropped_unmaterialized: groupsDroppedUnmaterialized,
      downgraded_groups: grouping.downgradedGroups,
      single_file_groups: grouping.singleFileGroups,
      excluded_sensitive: selection.counts.excludedSensitive,
      excluded_binary: selection.counts.excludedBinary,
      excluded_dir: selection.counts.excludedDir,
      excluded_extension: selection.counts.excludedExtension,
    },
    // 审计事实：diff 声明了、但盘上不存在的路径（单列，不混入 selected 计数）
    unmaterialized,
    selected: selected.map((s) => ({ path: s.path, reason: s.reason, rule_source: s.ruleSource, rule_id: s.ruleId, pattern: s.pattern ?? null, decided_by: s.decidedBy, size: s.size ?? 0, tokens: s.tokens ?? 0, materialized: isMaterialized(s.path) })),
    selectedPaths: selected.map((s) => s.path),
    selectedPathsMaterialized: selectedMaterialized.map((s) => s.path),
    excluded: excluded.map((e) => ({ path: e.path, reason: e.reason, rule_source: e.ruleSource, rule_id: e.ruleId, pattern: e.pattern ?? null, decided_by: e.decidedBy, severity: e.decidedBy === 'safety' ? 'safety-invariant' : 'info' })),
    excludedPaths: excluded.map((e) => e.path),
    groups: groupsOut,
    grouping: {
      mode: grouping.mode,
      max_files_per_group: grouping.maxFilesPerGroup,
      token_budget: grouping.tokenBudget,
      group_count: grouping.groupCount,
      downgraded_groups: grouping.downgradedGroups,
      notes: grouping.notes,
      invariant_ok: groupingInvariants.ok,
    },
    // 兼容 docs/01-architecture.md §6.2 的 qgate preview 形状（供 CI 比对）
    selection: {
      included: selected.map((s) => s.path),
      excluded: excluded.map((e) => ({ path: e.path, reason: e.reason })),
    },
    ruleMatch: explanations.map((e) => ({
      file: e.path,
      ruleSource: e.ruleSource,
      priority: RULE_PRIORITY[e.ruleSource] ?? (e.ruleSource === 'cli:flags' ? 0 : null),
      pattern: e.pattern,
      ruleId: e.ruleId,
      decision: e.decision,
      reason: e.reason,
    })),
    rules: {
      loaded_layers: rulesCtx.trace.filter((t) => t.loaded).map((t) => ({ source: t.source, priority: t.priority, file: t.path })),
      layer_trace: rulesCtx.trace.map((t) => ({
        source: t.source,
        priority: t.priority,
        file: t.path,
        loaded: t.loaded,
        format_supported: t.formatSupported !== false,
        format_reason: t.formatReason || null,
      })),
      // 规则格式兼容性：不可识别的规则文件不静默忽略，在此显式记账。
      // 背景见 src/rules.mjs 的 inspectRuleShape（引擎格式 {rules:[{match}]} 与
      // 适配层格式 {include,exclude} 不同，且引擎会 exit 2 而本层此前静默）。
      format_supported: rulesCtx.formatSupported !== false,
      unsupported_layers: rulesCtx.unsupportedLayers || [],
      effective: {
        include_extensions: preset.includeExtensions,
        default_exclude_dirs: preset.defaultExcludeDirs,
        max_tokens_per_group: preset.maxTokensPerGroup,
        max_files_per_group: preset.maxFilesPerGroup,
      },
      buckets: bucketRules,
    },
    safety: {
      no_sensitive_selected: safety.ok,
      violations: safety.violations,
      // S6：硬链接别名（如 `docs.txt` → `.env`）——路径无害但内容/同源 inode 指向密钥。
      // 以机器可读形式随输出给出，消费者可据此告警或阻断，而不是「静默纳入」。
      hardlink_aliases: safety.hardlinkAliases || [],
      rule: safety.rule,
      sensitive_paths_never_reincludable: true,
      grouping_invariants_ok: groupingInvariants.ok,
      grouping_violations: groupingInvariants.violations,
    },
    deterministic: {
      ordered_by: 'path-ascending',
      sources: ['diff-or-scan', 'rules-layers', 'filters', 'grouping'],
      same_input_same_bytes: true,
    },
  };

  return { payload, selection, grouping, rules: rulesCtx, provider, explanations };
}

/** 从各规则层收集显式分桶规则（按 id+patterns 去重，保持确定序）。 */
export function collectBuckets(rulesCtx, extraBuckets = []) {
  const candidates = [];
  for (const layer of rulesCtx.layers) {
    const buckets = layer.grouping && Array.isArray(layer.grouping.buckets) ? layer.grouping.buckets : null;
    if (!buckets) continue;
    for (const bucket of buckets) {
      if (bucket && bucket.id && Array.isArray(bucket.patterns)) candidates.push({ id: bucket.id, patterns: bucket.patterns, source: layer.source });
    }
  }
  for (const bucket of Array.isArray(extraBuckets) ? extraBuckets : []) {
    if (bucket && bucket.id && Array.isArray(bucket.patterns)) candidates.push({ id: bucket.id, patterns: bucket.patterns, source: bucket.source || 'cli' });
  }
  const seen = new Set();
  const out = [];
  for (const bucket of candidates) {
    const key = `${bucket.id}\u0000${bucket.patterns.join('\u0000')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bucket);
  }
  return out;
}

/** Markdown 渲染：文件 / 决策 / 原因 三列表格（selection.md 风格）。 */
export function renderMarkdown(payload) {
  const lines = [];
  lines.push('# OpenCodeReview 选择预览（selection.md）');
  lines.push('');
  lines.push(`- provider: \`${payload.provider.name}\` ｜ degraded: \`${payload.degraded}\` ｜ degraded_reason: \`${payload.degraded_reason ?? 'null'}\``);
  lines.push(`- llm_called: \`${payload.llm_called}\``);
  lines.push(`- 来源: \`${payload.source.kind}\` \`${payload.source.path}\``);
  lines.push(`- 候选 ${payload.counts.candidates} ｜ 选中 ${payload.counts.selected} ｜ 排除 ${payload.counts.excluded} ｜ 分组 ${payload.counts.groups}（降级 ${payload.counts.downgraded_groups}）`);
  lines.push(`- 安全不变量: 敏感路径进入 selected = ${payload.safety.violations.length} 条违规（必须为 0）`);
  // 规则格式告警：规则文件存在但格式不被识别时必须显式可见（不得静默忽略）。
  if (payload.rules && payload.rules.format_supported === false) {
    lines.push('');
    lines.push('> ⚠️ **RULE_FORMAT_UNSUPPORTED：存在无法识别的规则文件，其中的规则未生效。**');
    for (const u of payload.rules.unsupported_layers || []) {
      lines.push(`> - \`${u.file ?? u.source}\`：${u.detail ?? u.reason}`);
    }
    lines.push('> 本层规则格式为 `{ include, exclude, includeExtensions, grouping }`；');
    lines.push('> 引擎（`qgate`）的规则文件是 `{ rules: [{ id, match, severity, category }] }`，两者不通用，需按目标工具改写。');
  }
  lines.push('');
  lines.push('## 文件 / 决策 / 原因');
  lines.push('');
  lines.push('| 文件 | 决策 | 原因 | 规则来源 | 模式 |');
  lines.push('|---|---|---|---|---|');
  const rows = [
    ...payload.selected.map((s) => ({ path: s.path, decision: 'included', reason: s.reason, source: s.rule_source, pattern: '' })),
    ...payload.excluded.map((e) => ({ path: e.path, decision: 'excluded', reason: e.reason, source: e.rule_source, pattern: '' })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const row of rows) {
    lines.push(`| \`${row.path}\` | ${row.decision} | \`${row.reason}\` | ${row.source} | ${row.pattern || '—'} |`);
  }
  lines.push('');
  lines.push('## 分组');
  lines.push('');
  lines.push('| 组 | 文件数 | 估算 token | 降级 | 文件 |');
  lines.push('|---|---|---|---|---|');
  for (const g of payload.groups) {
    lines.push(`| \`${g.id}\` | ${g.file_count} | ${g.estimated_tokens} | ${g.downgraded ? g.downgrade_reason : '—'} | ${g.files.map((f) => `\`${f}\``).join('<br>')} |`);
  }
  lines.push('');
  lines.push('## 规则层（高 → 低）');
  lines.push('');
  lines.push('| 优先级 | 来源 | 文件 | 是否加载 |');
  lines.push('|---|---|---|---|');
  for (const layer of payload.rules.layer_trace) {
    lines.push(`| ${layer.priority} | ${layer.source} | ${layer.file ? `\`${layer.file}\`` : '—'} | ${layer.loaded} |`);
  }
  lines.push('');
  lines.push('> 本表格由 `adapters/opencodereview/bin/ocr-preview.mjs --md` 真实运行生成；');
  lines.push('> 同一输入重复运行结果字节级一致（详见 README「确定性」一节）。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export { sortPaths, isSensitivePath };

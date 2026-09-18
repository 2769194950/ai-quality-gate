// adapters/opencodereview/src/reflection.mjs
// 建议复核（离线规则化复刻 OCR 的 reflection / suggestion validation）。
// 目的：在把 LLM/规则建议交给下游门禁前，先用确定性规则剔除无法定位、
// 无证据、指向敏感路径或重复的建议 —— 提高 Precision、降低误报。
// 本模块不做任何模型调用，任何命令都不需要 API Key。

import { normalizeRel } from './util.mjs';

export const REFLECTION_VERSION = '1.0.0';

/** 复核规则表（按顺序执行，任一失败 ⇒ 丢弃该建议并记录原因）。 */
export const REFLECTION_RULES = Object.freeze([
  { id: 'R-VALID-PATH', description: 'suggestion.file 必须是已选中的仓库相对路径' },
  { id: 'R-FORBIDDEN-PATH', description: '建议不得指向密钥/凭证路径（否则直接丢弃）' },
  { id: 'R-NONEMPTY-MESSAGE', description: 'suggestion.message 不得为空' },
  { id: 'R-EVIDENCE-REQUIRED', description: '需带至少一条 evidence 或 line 定位' },
  { id: 'R-DEDUP', description: '同一 (file,line,message) 只保留 severity 最高的一条' },
  { id: 'R-SEVERITY-ENUM', description: 'severity 必须属于 blocker|high|medium|low' },
]);

const SEVERITY_RANK = { blocker: 4, high: 3, medium: 2, low: 1 };
const SEVERITY_SET = new Set(Object.keys(SEVERITY_RANK));

/**
 * @param {Array} suggestions 待复核建议
 * @param {object} opts
 * @param {Set<string>|Array<string>} [opts.selectedFiles] 已选中文件（路径白名单）
 * @param {(p:string)=>boolean} [opts.isForbidden] 敏感路径判定函数（默认无）
 */
export function reflectSuggestions(suggestions, opts = {}) {
  const selected = opts.selectedFiles ? new Set([...opts.selectedFiles].map(normalizeRel)) : null;
  const isForbidden = typeof opts.isForbidden === 'function' ? opts.isForbidden : () => false;
  const kept = [];
  const dropped = [];
  const seen = new Map();

  for (const raw of Array.isArray(suggestions) ? suggestions : []) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const file = s.file ? normalizeRel(s.file) : '';
    const reasons = [];
    if (!file) reasons.push('R-VALID-PATH');
    if (file && isForbidden(file)) reasons.push('R-FORBIDDEN-PATH');
    if (selected && file && !selected.has(file)) reasons.push('R-VALID-PATH');
    if (!s.message || String(s.message).trim() === '') reasons.push('R-NONEMPTY-MESSAGE');
    if (!Array.isArray(s.evidence) && !Number.isFinite(s.line)) reasons.push('R-EVIDENCE-REQUIRED');
    if (s.severity !== undefined && !SEVERITY_SET.has(s.severity)) reasons.push('R-SEVERITY-ENUM');

    if (reasons.length > 0) {
      dropped.push({ suggestion: s, reasons: [...new Set(reasons)] });
      continue;
    }

    const key = `${file}:${Number.isFinite(s.line) ? s.line : ''}:${String(s.message).trim()}`;
    if (seen.has(key)) {
      const prev = seen.get(key);
      if ((SEVERITY_RANK[s.severity] || 0) > (SEVERITY_RANK[prev.suggestion.severity] || 0)) {
        dropped.push({ suggestion: prev.suggestion, reasons: ['R-DEDUP'] });
        const idx = kept.indexOf(prev.suggestion);
        if (idx >= 0) kept.splice(idx, 1);
        seen.set(key, { suggestion: s });
        kept.push(s);
      } else {
        dropped.push({ suggestion: s, reasons: ['R-DEDUP'] });
      }
      continue;
    }
    seen.set(key, { suggestion: s });
    kept.push(s);
  }

  return {
    version: REFLECTION_VERSION,
    rules: REFLECTION_RULES.map((r) => r.id),
    kept,
    dropped,
    counts: { input: Array.isArray(suggestions) ? suggestions.length : 0, kept: kept.length, dropped: dropped.length },
  };
}

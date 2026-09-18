// adapters/opencodereview/src/util.mjs
// 零依赖工具集：路径归一化、glob 匹配、确定序、大小估算、原子写。
// 所有函数必须是纯的或只读文件系统；不得读取任何 API Key 环境变量。

import fs from 'node:fs';
import path from 'node:path';

/** 统一为正斜杠 POSIX 相对路径（去前导 ./，折叠重复分隔符）。 */
export function toPosix(p) {
  return String(p)
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '');
}

/** 归一化相对路径：归一化分隔符 + 折叠 . / .. 段（不触碰文件系统）。 */
export function normalizeRel(p) {
  const posix = toPosix(p);
  const parts = [];
  for (const seg of posix.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else parts.push('..');
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * 把 glob 模式编译为锚定的 RegExp。
 * 支持 `**`（跨目录）、`*`（段内）、`?`（单字符）、`{a,b}`（枚举）。
 * 不含 `/` 的模式按 basename 匹配（OCR 语义：`*.pem` 匹配任意深度）。
 *
 * `opts.caseInsensitive`（默认 false）为敏感路径/目录类清单使用：
 * 见 filters.mjs 对「大小写绕过」的说明（CI 的 diff 常由大小写敏感的 Linux 生成，
 * 而排除清单按小写书写 ⇒ 大小写变体会绕过安全过滤）。
 */
export function globToRegExp(pattern, opts = {}) {
  const pat = toPosix(String(pattern).trim());
  if (pat === '') return /$.^/; // 永不匹配

  let re = '';
  for (let i = 0; i < pat.length; i += 1) {
    const c = pat[i];
    if (c === '*') {
      const isDouble = pat[i + 1] === '*';
      if (isDouble) {
        // `**/` → 任意层级（含 0 层）；裸 `**` → 匹配任意字符
        if (pat[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      continue;
    }
    if (c === '{') {
      const close = pat.indexOf('}', i);
      if (close > i) {
        const alts = pat.slice(i + 1, close).split(',').map((s) => s.trim());
        re += `(?:${alts.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
        i = close;
        continue;
      }
      re += '\\{';
      continue;
    }
    re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const anchored = /(^|\/)\*\*/.test(pat) || pat.includes('/');
  const flags = opts.caseInsensitive ? 'i' : '';
  return anchored ? new RegExp(`^${re}$`, flags) : new RegExp(`(?:^|/)${re}$`, flags);
}

/**
 * 任意模式命中即真（对完整相对路径与 basename 都试一次）。
 * `opts.caseInsensitive` 用于安全清单（敏感路径）：大小写变体也必须命中。
 */
export function matchesAnyPattern(relPath, patterns, opts = {}) {
  if (!Array.isArray(patterns) || patterns.length === 0) return null;
  const p = normalizeRel(relPath);
  const base = p.split('/').pop();
  for (const raw of patterns) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const re = globToRegExp(raw, opts);
    if (re.test(p) || re.test(base)) return raw;
  }
  return null;
}

/** 扩展名（小写，含点）；无扩展名返回 ''。 */
export function extname(relPath) {
  const base = toPosix(relPath).split('/').pop() || '';
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return '';
  return base.slice(idx).toLowerCase();
}

/** 确定性排序：按 POSIX 路径升序（locale-independent，逐码位比较）。 */
export function sortPaths(paths) {
  return [...paths].sort((a, b) => {
    const x = normalizeRel(a);
    const y = normalizeRel(b);
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  });
}

/** 读取文件字节数；读不到（diff 里的新增/删除文件）回落 0。 */
export function sizeOf(absPath) {
  try {
    const st = fs.statSync(absPath);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/** 粗略 token 估算：UTF-8 字节数 / bytesPerToken（确定性，与语言无关）。 */
export function estimateTokens(text) {
  if (typeof text === 'string') {
    const bytes = Buffer.byteLength(text, 'utf8');
    return Math.ceil(bytes / 4);
  }
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n / 4) : 0;
}

/** 稳定 JSON 序列化：对象键排序，数组保持顺序 ⇒ 同输入字节级一致。 */
export function stableStringify(value, indent = 2) {
  return JSON.stringify(sortKeysDeep(value), null, indent);
}

export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/** 原子写：同目录临时文件 + rename，避免半截文件。 */
export function atomicWrite(absPath, content) {
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, absPath);
}

/** 深拷贝（结构化对象，无函数）。 */
export function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

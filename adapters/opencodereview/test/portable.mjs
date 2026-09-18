// adapters/opencodereview/test/portable.mjs
// 夹具可移植化：把「机器/目录相关」的绝对路径替换为稳定占位符，
// 让同一份夹具在任何 cwd、任何盘符、任何机器上都能被复现比对。
//
// 为什么需要它（GAP-6）：早期夹具把仓库绝对路径固化成**期望值**，
// 于是 `cwd=E:\Desktop\ai-quality-gate` 全绿，而 junction 别名 `E:\ai-quality-gate`
// 或非仓库根 `E:\Desktop` 下会有 3 条回归失败——同一输入在不同 cwd 得到不同断言结果。
//
// 设计取舍：用**基于根前缀的长前缀优先替换**，而不是「路径里出现某个目录名就替换」。
// 后者漏掉了 `…\.opencodereview\rule.json`（不含 `adapters/opencodereview` 段）这类路径，
// 正是当初漏网的那一个键。前缀法覆盖三类路径（含用户级规则路径）：
//   <ADAPTER_ROOT>  适配层根（…/adapters/opencodereview）
//   <REPO_ROOT>     仓库根（适配层根的上两级）
//   <HOME>          用户家目录（用户级规则 ~/.opencodereview/rule.json）
// 替换顺序必须「最长/最具体优先」：<ADAPTER_ROOT> → <REPO_ROOT> → <HOME>，
// 否则 <REPO_ROOT> 会先把适配层前缀吃掉，产出 <REPO_ROOT>/adapters/opencodereview/… 这种不稳定形式。

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 适配层根目录（…/adapters/opencodereview）。 */
export const ADAPTER_ROOT = path.resolve(HERE, '..');
/** 仓库根目录（适配层根的上两级）。 */
export const REPO_ROOT = path.resolve(ADAPTER_ROOT, '..', '..');
/** 用户家目录（用户级规则层 ~/.opencodereview/rule.json 的锚）。 */
export const HOME_DIR = os.homedir();

/** 统一分隔符为 POSIX，便于跨平台比对。 */
export const toPosix = (s) => String(s).replace(/\\/g, '/');

/**
 * 占位符 → 根的映射，**顺序即优先级**（最长/最具体优先）。
 * 断言侧构造真实路径时按同一顺序尝试。
 */
export const ROOT_TOKENS = Object.freeze([
  ['<ADAPTER_ROOT>', toPosix(ADAPTER_ROOT)],
  ['<REPO_ROOT>', toPosix(REPO_ROOT)],
  ['<HOME>', toPosix(HOME_DIR)],
]);

/**
 * 把字符串里的绝对根路径替换为占位符。
 * 只替换「以某个已知根开头」的路径；非仓库/非家目录的绝对路径原样保留
 * （避免把无关路径也抹平，那会掩盖真实差异）。
 */
export function portableizeString(value) {
  if (typeof value !== 'string') return value;
  let out = toPosix(value);
  for (const [token, root] of ROOT_TOKENS) {
    if (!root) continue;
    // 匹配「根本身」或「根 + /」开头，避免把 /reporoot2/... 误当成 /reporoot
    if (out === root) return token;
    if (out.startsWith(`${root}/`)) return `${token}${out.slice(root.length)}`;
  }
  return out;
}

/** 深度遍历对象/数组，对所有字符串做占位符化。 */
export function portableize(value) {
  if (Array.isArray(value)) return value.map(portableize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = portableize(v);
    return out;
  }
  return portableizeString(value);
}

/**
 * 文本级占位符化：把整段文本里**任意位置**出现的已知根路径替换为占位符
 * （并统一分隔符为 POSIX）。用于 Markdown 之类的自由文本。
 *
 * 与 `portableizeString` 的区别：后者只处理「整串恰是一个路径」的情形（前缀匹配），
 * 本函数处理「路径嵌在句子/表格里」的情形 —— 记录夹具与断言两侧都必须用它，
 * 否则会出现「夹具存了占位符、运行时输出是真实路径」的假失败（实测踩过）。
 */
export function portableizeText(text) {
  if (typeof text !== 'string') return text;
  let out = toPosix(text);
  for (const [token, root] of ROOT_TOKENS) {
    if (!root) continue;
    out = out.split(root).join(token);
  }
  return out;
}

/** 把占位符还原为真实绝对路径（断言侧需要时使用）。 */
export function materializeString(value) {
  if (typeof value !== 'string') return value;
  for (const [token, root] of ROOT_TOKENS) {
    if (value === token) return root;
    if (value.startsWith(`${token}/`)) return `${root}${value.slice(token.length)}`;
  }
  return value;
}

/**
 * 占位符化 + 选定字段集合的自检辅助：返回本次替换命中的占位符集合，
 * 供测试断言「三类路径都能被抹平」。
 */
export function portableizeWithReport(value) {
  const hits = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      const out = portableizeString(v);
      if (out !== toPosix(v)) {
        for (const [token] of ROOT_TOKENS) if (out.startsWith(token)) hits.add(token);
      }
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  return { value: walk(value), hits };
}

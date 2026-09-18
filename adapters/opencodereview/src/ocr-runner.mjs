// adapters/opencodereview/src/ocr-runner.mjs
// ocr CLI 探测与调用 + 缺失/失败时的降级编排。
//
// 硬不变量：
//   R1 任何命令都不得要求 API Key：探测与调用只用白名单环境变量
//      （PATH / SystemRoot / ComSpec / PATHEXT），绝不透传任何 *_KEY / *_TOKEN。
//   R2 `ocr` 不存在、超时、非零退出或输出不可解析 ⇒ 一律降级为本地确定性实现，
//      命令仍然退出 0，并在输出中标注 degraded:true 与具体原因。
//   R3 预览路径（preview）本身不触发 LLM：llm_called 恒为 false。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const OCR_RUNNER_VERSION = '1.0.0';

/** 降级原因枚举（确定性、可断言）。 */
export const DEGRADE_REASONS = Object.freeze({
  NOT_FOUND: 'OCR_CLI_NOT_FOUND',
  SKIPPED: 'OCR_SKIPPED_BY_FLAG',
  EXIT_NONZERO: 'OCR_EXIT_NONZERO',
  TIMEOUT: 'OCR_TIMEOUT',
  BAD_JSON: 'OCR_OUTPUT_NOT_JSON',
  SPAWN_FAILED: 'OCR_SPAWN_FAILED',
  DISABLED: 'OCR_DISABLED_BY_ENV',
});

/** 只允许这些环境变量进入子进程（R1）。 */
export const ENV_ALLOWLIST = Object.freeze(['PATH', 'Path', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']);

/** 子进程环境：白名单 + 显式离线标记，无任何密钥。 */
export function buildChildEnv(baseEnv = process.env, extra = {}) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  // 显式声明离线/免遥测，避免 ocr 尝试联网或索要凭据。
  env.OCR_PROVIDER = 'deterministic';
  env.OCR_OFFLINE = '1';
  env.OCR_NO_TELEMETRY = '1';
  env.OCR_NO_API_KEY = '1';
  env.NO_COLOR = '1';
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

/** 校验一个路径是否是真正可执行的 ocr。 */
function isExecutableFile(candidate) {
  try {
    const st = fs.statSync(candidate);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * 探测 ocr CLI。
 * @param {object} [opts]
 * @param {string} [opts.ocrBin]   显式指定可执行文件路径（--ocr-bin）
 * @param {boolean} [opts.noOcr]   强制不使用 ocr（--no-ocr）
 * @param {string} [opts.cwd]
 * @returns {{available:boolean, bin:string|null, version:string|null, reason:string|null, probe:{command:string|null, exitCode:number|null, stdout:string, stderr:string}}}
 */
export function probeOcr(opts = {}) {
  if (opts.noOcr === true) {
    return { available: false, bin: null, version: null, reason: DEGRADE_REASONS.SKIPPED, probe: { command: null, exitCode: null, stdout: '', stderr: '' } };
  }
  if (String(process.env.OCR_DISABLE || '') === '1') {
    return { available: false, bin: null, version: null, reason: DEGRADE_REASONS.DISABLED, probe: { command: null, exitCode: null, stdout: '', stderr: '' } };
  }

  const candidates = [];
  if (opts.ocrBin) {
    candidates.push(path.resolve(opts.ocrBin));
  } else {
    const dirs = String(process.env.PATH || process.env.Path || '')
      .split(path.delimiter)
      .filter(Boolean);
    const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat', '.ps1'] : [''];
    for (const dir of dirs) {
      for (const ext of exts) candidates.push(path.join(dir, `ocr${ext}`));
    }
  }

  for (const candidate of candidates) {
    if (!isExecutableFile(candidate)) continue;
    const res = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 3000,
      env: buildChildEnv(process.env),
      shell: false,
      windowsHide: true,
    });
    const stdout = res.stdout ? String(res.stdout).trim() : '';
    const stderr = res.stderr ? String(res.stderr).trim() : '';
    if (res.error) {
      // 找到文件但无法执行：继续尝试下一个候选，避免误判为可用。
      continue;
    }
    if (res.status === 0) {
      return {
        available: true,
        bin: candidate,
        version: stdout.split('\n')[0] || null,
        reason: null,
        probe: { command: `${candidate} --version`, exitCode: res.status, stdout, stderr },
      };
    }
  }

  return {
    available: false,
    bin: opts.ocrBin ? path.resolve(opts.ocrBin) : null,
    version: null,
    reason: DEGRADE_REASONS.NOT_FOUND,
    probe: { command: null, exitCode: null, stdout: '', stderr: '' },
  };
}

/**
 * 调用 `ocr review --format json` 并解析。
 * 失败永不抛出：返回 { ok:false, degraded:true, reason }。
 * @param {object} opts
 * @param {{available:boolean,bin:string|null}} opts.probe  probeOcr() 结果
 * @param {string} [opts.diff]    变更集路径（--diff）
 * @param {string} [opts.root]    扫描根（--root）
 * @param {string} [opts.rule]    规则文件（--rule）
 * @param {number} [opts.timeoutMs]
 */
export function runOcrReview(opts = {}) {
  const probe = opts.probe || { available: false, bin: null, reason: DEGRADE_REASONS.NOT_FOUND };
  if (!probe.available || !probe.bin) {
    return {
      ok: false,
      degraded: true,
      degradedReason: probe.reason || DEGRADE_REASONS.NOT_FOUND,
      llmCalled: false,
      command: null,
      exitCode: null,
      data: null,
      stdout: '',
      stderr: '',
    };
  }

  const args = ['review', '--format', 'json', '--audience', 'agent'];
  if (opts.root) args.push('--repo', path.resolve(opts.root));
  // OpenCodeReview consumes Git refs for diff review. The adapter's JSON diff
  // is still used by the deterministic preview path, not passed to OCR as a
  // native CLI flag that does not exist.
  if (opts.from) args.push('--from', opts.from);
  if (opts.to) args.push('--to', opts.to);
  if (opts.commit) args.push('--commit', opts.commit);
  if (opts.rule) args.push('--rule', path.resolve(opts.rule));
  if (opts.extraArgs && Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);

  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 60000;
  const command = [probe.bin, ...args].join(' ');
  let res;
  try {
    res = spawnSync(probe.bin, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: buildChildEnv(process.env),
      shell: false,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    return {
      ok: false,
      degraded: true,
      degradedReason: DEGRADE_REASONS.SPAWN_FAILED,
      llmCalled: false,
      command,
      exitCode: null,
      data: null,
      stdout: '',
      stderr: String(err && err.message),
    };
  }

  const stdout = res.stdout ? String(res.stdout) : '';
  const stderr = res.stderr ? String(res.stderr) : '';

  if (res.error && res.error.code === 'ETIMEDOUT') {
    return { ok: false, degraded: true, degradedReason: DEGRADE_REASONS.TIMEOUT, llmCalled: false, command, exitCode: null, data: null, stdout, stderr };
  }
  if (res.error) {
    return { ok: false, degraded: true, degradedReason: DEGRADE_REASONS.SPAWN_FAILED, llmCalled: false, command, exitCode: res.status ?? null, data: null, stdout, stderr: `${stderr}${String(res.error.message)}` };
  }
  if (res.status !== 0) {
    return { ok: false, degraded: true, degradedReason: DEGRADE_REASONS.EXIT_NONZERO, llmCalled: false, command, exitCode: res.status, data: null, stdout, stderr };
  }

  let data = null;
  try {
    data = JSON.parse(stdout);
  } catch {
    // 尝试从混合输出中截取第一个 JSON 对象。
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        data = JSON.parse(stdout.slice(start, end + 1));
      } catch {
        data = null;
      }
    }
  }
  if (!data) {
    return { ok: false, degraded: true, degradedReason: DEGRADE_REASONS.BAD_JSON, llmCalled: false, command, exitCode: res.status, data: null, stdout, stderr };
  }

  return { ok: true, degraded: false, degradedReason: null, llmCalled: false, command, exitCode: res.status, data, stdout, stderr };
}

/**
 * 编排：有 ocr 则调用，否则/失败则本地实现。
 * 返回统一的 provider 描述，供 bin/ocr-preview.mjs 写进 JSON 输出。
 */
export function resolveProvider(opts = {}) {
  const probe = probeOcr({ ocrBin: opts.ocrBin, noOcr: opts.noOcr || opts.localOnly, timeoutMs: opts.probeTimeoutMs });
  const useOcr = opts.useOcr === true;
  if (!useOcr) {
    return {
      name: 'local',
      requested: opts.useOcr ? 'ocr' : 'auto',
      ocrAvailable: probe.available,
      degraded: true,
      degradedReason: probe.available ? DEGRADE_REASONS.SKIPPED : probe.reason || DEGRADE_REASONS.NOT_FOUND,
      llmCalled: false,
      ocrBin: probe.bin,
      ocrVersion: probe.version,
      ocrResult: null,
      probe,
      note: 'preview 走本地确定性实现（与执行同源），不调用 ocr，也不调用 LLM',
    };
  }
  const result = runOcrReview({
    probe,
    diff: opts.diff,
    root: opts.root,
    rule: opts.cliRulePath,
    timeoutMs: opts.timeoutMs,
  });
  return {
    name: result.ok ? 'ocr' : 'local',
    requested: 'ocr',
    ocrAvailable: probe.available,
    degraded: !result.ok,
    degradedReason: result.degradedReason,
    llmCalled: false,
    ocrBin: probe.bin,
    ocrVersion: probe.version,
    ocrResult: result,
    probe,
    note: result.ok ? 'ocr review --format json 成功，使用其结果' : 'ocr 不可用或失败，降级为本地确定性实现',
  };
}

// ── SAFE_001：密钥**读取**面（大小写不敏感）──────────────────────────────────
// 背景（t33 / R2-H3）：早期实现用 `/_KEY/`、`/process\.env\.[A-Z_]*API_KEY/` 等
// **大小写敏感**的模式，于是 `process.env.anthropic_api_key` 这类写法全部漏检。
// 而 **Windows 的环境变量名不区分大小写** ⇒ 这些小写写法在 Windows 上确实能取到密钥，
// 属真实绕过。这里改为大小写不敏感 + 覆盖 8 种写法（含 `['name']` 与解构）。
//
// 与 packages/qgate 侧 SAFE_001 的关系：引擎侧的同类问题由 core-engineer 在 t34 处理；
// 本模块是适配层自带的简化扫描器，只对本层负责，不 import 引擎内部实现。
const SENSITIVE_WORDS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASSPHRASE', 'CREDENTIAL', 'APIKEY'];
const SENSITIVE_NAME = `[A-Za-z0-9_$]*(?:${SENSITIVE_WORDS.join('|')})[A-Za-z0-9_$]*`;
/** 环境访问器：process.env / import.meta.env / Deno.env / os.environ；大小写不敏感。 */
const ENV_ACCESSOR = '(?:process\\s*\\.\\s*env|import\\s*\\.\\s*meta\\s*\\.\\s*env|Deno\\s*\\.\\s*env|os\\s*\\.\\s*environ)';
const KEY_READ_PATTERNS = Object.freeze([
  // process.env.NAME / process.env['NAME'] / process.env["NAME"]（大小写不敏感）
  new RegExp(`${ENV_ACCESSOR}\\s*(?:\\.\\s*(${SENSITIVE_NAME})|\\[\\s*(['"\`])(${SENSITIVE_NAME})\\2\\s*\\])`, 'gi'),
  // const { NAME } = process.env  /  const { NAME, OTHER } = process.env
  new RegExp(`\\{[^}]*(${SENSITIVE_NAME})[^}]*\\}\\s*=\\s*${ENV_ACCESSOR}`, 'gi'),
  // getenv('NAME') / GetEnvironmentVariable('NAME')
  new RegExp(`\\b(?:getenv|GetEnvironmentVariable)\\s*\\(\\s*(['"\`])(${SENSITIVE_NAME})\\1`, 'gi'),
  // 裸的 `NAME` 引用只在**含敏感词且形如标识符**时命中——覆盖 `const k = process.env` 之外的
  // 直接引用（例如 `os.environ['X_API_KEY']` 已由第 1 条覆盖，此处兜底 vault 风格 `vault.NAME`）。
  new RegExp(`\\b(?:vault|secrets)\\s*\\.\\s*(${SENSITIVE_NAME})`, 'gi'),
]);

// ── SAFE_003：网络调用面（含静态 import 别名）─────────────────────────────────
// 背景（t33）：早期适配层**没有**网络扫描器；reviewer 给出的 4 种写法全部 BYPASS，
// 其中 `import * as h from 'node:http'; h.request()` 是最隐蔽的变体（模块被改名后
// 字面量 `http.request` 不再出现）。这里先解析 import 得到的**别名表**，再据此匹配调用。
// t56 / F12：词表必须与引擎侧对齐。引擎 `packages/qgate/src/policy.mjs` 的
// `NET_MODULE_NAMES = ['https?','net','dns','tls','dgram','undici']`（注意 `https?` 是**正则片段**，
// 展开为 `http`/`https`）。本层早期漏了 `dns` 与 `undici`（`http` 在引擎侧由 `https?` 覆盖），
// 于是同一 SAFE_003 断言两侧保证强度不同：引擎报、适配层不报。
// 现补齐；`test/network-import.test.mjs` 另有一条自检「适配层词表 ⊇ 引擎词表」——
// 它从引擎源码文本解析该常量再断言，下次再漂移会直接失败。
export const NET_MODULES = [
  'node:http', 'http', 'node:https', 'https',
  'node:net', 'net',
  'node:dns', 'dns',
  'node:tls', 'tls',
  'node:dgram', 'dgram',
  'node:undici', 'undici',
];
const NET_METHODS = ['request', 'get', 'post', 'connect', 'createServer', 'createConnection', 'Socket', 'Server', 'fetch', 'send', 'bind'];
const BARE_NET_FUNCS = ['fetch', 'XMLHttpRequest', 'WebSocket'];
// t58 / F14：命名网络客户端调用面。引擎 `packages/qgate/src/policy.mjs` 有一套
// `NET_CLIENT_NAMES`（12 个客户端名）+ `NET_CALL_MEMBERS`（14 个 HTTP-ish 成员），
// 识别**通过包名直接调用**的形态（`axios.get(url)`、`client.get(url)`）——
// 这些文件里没有 import，绑定无法从文本恢复，只能靠「名字 + 成员」的组合。
// 本层早期完全没有这一面 ⇒ 与 t54/t56 同类：同一 SAFE_003 断言两侧保证强度不同。
//
// **刻意只做「精确组合」而不是粗放的 `*.get()`**：这正是良性对照不误报的原因。
// `cache.get(key)` / `headers.get('x')` / `new Map().get(k)` 等非网络语义对象之所以不报，
// 不是因为加了「排除名单」，而是因为它们的名字**不在**这份客户端名单里。
// 名单与成员表逐项与引擎对齐（引擎实测：12 名字 × 3 成员 = 36 格全报；21 条良性对照 0 误报）。
//
// fail-closed 取舍（与引擎同源）：`client` 这个名字在非网络语义下也常见（缓存/映射客户端），
// 所以 `client.get(...)` 会被报。这是**引擎既有的取舍**（多报代价是改名，漏报代价是静默联网）；
// 本层照搬以保持两侧同判，代价与边界都记在 README §4.4。
const NET_CLIENT_NAMES = [
  'axios', 'got', 'superagent', 'needle', 'undici', 'ky',
  'node-fetch', 'request', 'client', 'httpClient', 'apiClient', 'httpAgent',
];
const NET_CLIENT_MEMBERS = [
  'request', 'get', 'head', 'post', 'put', 'patch', 'delete', 'options',
  'send', 'connect', 'createServer', 'createConnection', 'Socket', 'Server', 'bind',
];
const NET_CLIENT_CALL_RE = new RegExp(
  `\\b(?:${NET_CLIENT_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})` +
  `\\s*\\.\\s*(?:${NET_CLIENT_MEMBERS.join('|')})\\s*\\(`,
);

/**
 * 从源码里解析 `import ... from '<net module>'` 得到的本地别名。
 * 覆盖：默认导入（`import http from 'node:http'`）、命名空间（`import * as h from …`）、
 * 命名成员（`import { request } from …` ⇒ 记录 request 为可调用网络函数）。
 */
export function extractNetworkAliases(text) {
  const aliases = new Set();
  const bareFuncs = new Set();
  const importRe = /import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(text)) !== null) {
    const clause = m[1];
    const mod = m[2].replace(/^node:/, '');
    if (!NET_MODULES.includes(m[2]) && !NET_MODULES.includes(mod)) continue;
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) aliases.add(ns[1]);
    const def = clause.replace(/\{[^}]*\}/g, '').replace(/\*\s+as\s+[A-Za-z_$][\w$]*/g, '').split(',')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(def)) aliases.add(def);
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) {
      for (const part of named[1].split(',')) {
        const name = part.split(/\s+as\s+/).pop().trim();
        if (NET_METHODS.includes(name)) bareFuncs.add(name);
      }
    }
  }
  // require('node:http') 形态
  const reqRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reqRe.exec(text)) !== null) {
    const mod = m[2].replace(/^node:/, '');
    if (NET_MODULES.includes(m[2]) || NET_MODULES.includes(mod)) aliases.add(m[1]);
  }
  // 动态 import 形态：`const h = await import('node:http')` / `const { request } = await import('node:http')`
  const dynRe = /(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*await\s+import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(text)) !== null) {
    const mod = m[2].replace(/^node:/, '');
    if (!NET_MODULES.includes(m[2]) && !NET_MODULES.includes(mod)) continue;
    const lhs = m[1];
    if (lhs.startsWith('{')) {
      for (const part of lhs.slice(1, -1).split(',')) {
        const name = part.split(/\s+as\s+/).pop().trim();
        if (NET_METHODS.includes(name)) bareFuncs.add(name);
      }
    } else {
      aliases.add(lhs);
    }
  }
  return { aliases, bareFuncs };
}

/**
 * 网络模块「导入面」本身是否出现（t54 / R3-L3）。
 *
 * 背景：引擎侧 SAFE_003 的 matcher 明确把 `network module import/require` 列为命中标签，
 * 即**导入网络模块这件事本身就构成网络调用面**；而适配层早期只在「别名被调用」时才报，
 * 于是同一个 SAFE_003 断言在两侧的保证强度不同——`import https from 'node:https';`
 * 单独出现时引擎报、适配层不报。此处与引擎对齐：静态 import / 动态 import('…') /
 * require('…') 三形态一旦命中 NET_MODULES，导入语句所在行即为违规。
 *
 * 边界（刻意保持，不得放宽）：
 * - 只有**网络模块**命中；`node:fs`、`node:path` 等非网络模块不报。
 * - 需要真实的导入语法：`const s = 'node:https'`（纯字符串字面量）、
 *   `// see node:https`（注释）都不报。
 * - 调用面（别名调用 / 模块成员调用 / 全局 fetch / 解构函数调用）的既有判定不变。
 */
const NET_IMPORT_RE = /(?:import\s*\(\s*|require\s*\(\s*|import\s+(?:[\s\S]*?\s+from\s+)?)['"]([^'"]+)['"]/;
function isNetworkModuleImport(line) {
  const m = NET_IMPORT_RE.exec(line);
  if (!m) return false;
  const mod = m[1].replace(/^node:/, '');
  return NET_MODULES.includes(m[1]) || NET_MODULES.includes(mod);
}

/**
 * 把源码拆成「逻辑单元」（t64 / F15 + F16 的共同基础）。
 *
 * 两个要点：
 *
 * 1. **t64 / F16：未闭合 `/*` 不再让后续整段失明。** `isCommentLine()` 会把 ` * …` 开头的行
 *    当 JSDoc 续行跳过 —— 若前面的 `/*` 其实**从未闭合**，那些行是**可执行代码**，跳过就是漏报
 *    （与引擎 t46 / R3-H2 同族：引擎已改为 fail-closed，本层此前残留）。
 *    这里的判据是「**仅当存在闭合 `*​/` 时**才按块注释处理」：先看该 `/*` 之后是否还有 `*​/`，
 *    有则进入块注释态（跳过到闭合行），没有则**该行按代码处理并立即结束块注释态**（fail-closed）。
 *
 * 2. **t64 / F15：为跨行链式调用提供「逻辑单元」视图。** 把相邻代码行拼成一个单元后，
 *    被 prettier 折行的 `ky\n  .get(url)` 在单元里表现为 `ky .get(url)`，即可被同一套正则命中。
 *
 * 返回 `{lines, units}`：`lines[i].flat` 是该行**去掉行注释尾巴**后的文本（用于匹配），
 * `lines[i].raw` 保留原样（用于 `isNegatedLine` 与输出）；`isComment` 标记该行是否处于注释态。
 */
function splitLogicalUnits(text) {
  const rawLines = text.split('\n');
  let inBlock = false;
  let offset = 0; // 当前行首在 text 中的字符偏移
  const lines = [];
  /** 该行是否位于一个「**确实有开启符、且尚未闭合**」的块注释内（只看该行之前的内容）。 */
  const insideOpenBlock = (i) => {
    const before = rawLines.slice(0, i).join('\n');
    const close = before.lastIndexOf('*/');
    // 关键：先在「关闭符之后」的残余里找开启符，否则 `lastIndexOf('/*')` 会命中 `*/` 里的那对
    // 字符（`*/` 自身形如 `*` + `/`，而 `/*` 需要 `*` 紧跟 `/`）——早期实现因此把
    // 「已闭合的 JSDoc 之后」误判成「仍在注释内」，导致整段被跳过。
    const open = before.slice(close + 2).lastIndexOf('/*');
    return open >= 0;
  };
  for (const raw of rawLines) {
    const lineStart = offset;
    const idx = lines.length;
    offset += raw.length + 1; // +1 为换行符
    // 去掉行注释尾巴（'code; // note' ⇒ 'code;'），但**不动**块注释标记
    const flat = raw.replace(/\/\/.*$/, '');
    // 行注释形态：`//`、`#`、`<!--`（与旧 isCommentLine 的集合一致；`*` 与 `/*` 由下面的
    // 块注释状态机单独判定，不在这里一刀切）。
    const isLineComment = /^\s*(?:\/\/|#|<!--)/.test(raw);
    let isComment = isLineComment;
    if (inBlock) {
      // 块注释态：跳过到闭合行（含闭合行本身）
      isComment = true;
      if (raw.includes('*/')) inBlock = false;
    } else if (/\/\*/.test(raw) && /^\s*\/\*/.test(raw)) {
      // 该行含块注释开启符（此时按定义**不在**注释态内）。
      // 三种情形：
      //  a) 同一行内闭合 ⇒ 整行是注释，跳过；
      //  b) 后续存在关闭符 ⇒ 进入块注释态，本行跳过；
      //  c) 真·未闭合 ⇒ fail-closed：本行按代码处理，且**不**进入注释态。
      const afterOpen = raw.replace(/^\s*\/\*/, '');
      if (afterOpen.includes('*/')) {
        isComment = true;
      } else if (text.slice(lineStart + raw.length).includes('*/')) {
        inBlock = true;
        isComment = true;
      } else {
        // 后面没有关闭符（真·未闭合）：fail-closed —— 该行按代码处理，不进入注释态
        isComment = false;
      }
    } else if (/^\s*\*/.test(raw)) {
      // 以星号开头的行：仅当**它确实位于一个块注释内**（该行之前有开启符、且开启符之后
      // 尚未出现关闭符）才按 JSDoc 续行跳过；否则按代码处理（t64/F16 fail-closed）。
      // 不变量：合法 JSDoc 中 `*/` 总在其 `*` 行**之后**，所以「之前已有闭合」就意味着
      // 这个星号不属于任何注释块 —— 此时跳过它没有任何依据，只能按代码看。
      isComment = insideOpenBlock(idx);
    }
    lines.push({ raw, flat, isComment, line: idx + 1 });
  }

  // 逻辑单元：相邻的非注释行拼成一段（跨行链式调用的载体）
  const units = [];
  let cur = null;
  for (const L of lines) {
    if (L.isComment) {
      if (cur) { units.push(cur); cur = null; }
      continue;
    }
    if (!cur) cur = { startLine: L.line, parts: [] };
    cur.parts.push(L.flat.trim());
  }
  if (cur) units.push(cur);
  for (const u of units) u.joined = u.parts.join(' ').replace(/\s+/g, ' ').trim();
  return { lines, units };
}

/** 逐行扫描网络调用面（SAFE_003）。 */
export function scanNetworkSurface(text) {
  const { aliases, bareFuncs } = extractNetworkAliases(text);
  const violations = [];
  const aliasRe = aliases.size > 0
    ? new RegExp(`\\b(?:${[...aliases].map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*\\.\\s*(${NET_METHODS.join('|')})\\b`)
    : null;
  const { lines, units } = splitLogicalUnits(text);

  for (const L of lines) {
    if (L.isComment || isNegatedLine(L.raw)) continue;
    const line = L.flat;
    // 导入面优先：导入网络模块本身就是网络面（与引擎 SAFE_003 语义对齐）
    if (isNetworkModuleImport(line)) {
      violations.push({ line: L.line, text: line.trim(), via: 'network-module-import' });
      continue;
    }
    if (aliasRe && aliasRe.test(line)) {
      violations.push({ line: L.line, text: line.trim(), via: 'imported-module-alias' });
      continue;
    }
    // 直接的模块名调用：http.request / https.get / net.createServer …
    if (/\b(?:https?|net|dgram|tls)\s*\.\s*(?:request|get|post|connect|createServer|createConnection|Socket|Server|send|bind)\b/.test(line)) {
      violations.push({ line: L.line, text: line.trim(), via: 'module-member-call' });
      continue;
    }
    // t58：命名网络客户端调用（`axios.get(url)`、`client.get(url)`）——「客户端名 + HTTP-ish 成员」
    // 的**精确组合**，与引擎 `NET_CLIENT_NAMES` × `NET_CALL_MEMBERS` 逐项对齐。
    // 位置放在「模块成员调用」之后、全局函数与解构函数之前：`client`/`request` 等固定名字不会
    // 出现在动态捕获的 aliases 里，所以与前面几条不冲突；这一条只负责「无 import 的包名直呼」。
    if (NET_CLIENT_CALL_RE.test(line)) {
      violations.push({ line: L.line, text: line.trim(), via: 'named-network-client-call' });
      continue;
    }
    // 全局 fetch / XMLHttpRequest / WebSocket
    let done = false;
    for (const fn of BARE_NET_FUNCS) {
      if (new RegExp(`\\b${fn}\\s*\\(`).test(line)) {
        violations.push({ line: L.line, text: line.trim(), via: 'global-network-call' });
        done = true;
        break;
      }
    }
    if (done) continue;
    // 解构出来的成员函数直接调用：request('http://…')
    for (const fn of bareFuncs) {
      if (new RegExp(`\\b${fn}\\s*\\(`).test(line)) {
        violations.push({ line: L.line, text: line.trim(), via: 'destructured-network-call' });
        break;
      }
    }
  }

  // t64 / F15：跨行链式调用。上面按行已覆盖绝大多数形态；这里补「名字与 `.member(` 被折到
  // 不同行」的情形（prettier 对长链式调用的默认折行）。仅在**该逻辑单元内单行都没报出**时补报，
  // 避免与按行结果重复计数。
  for (const u of units) {
    if (u.parts.length < 2) continue; // 单行单元已由上面按行处理
    if (NET_CLIENT_CALL_RE.test(u.joined)) {
      const already = violations.some((v) => v.line >= u.startLine && v.line <= u.startLine + u.parts.length - 1);
      if (!already) {
        violations.push({ line: u.startLine, text: u.joined, via: 'named-network-client-call' });
      }
    }
  }

  violations.sort((a, b) => a.line - b.line);
  return { aliases: [...aliases].sort(), bareFuncs: [...bareFuncs].sort(), violations };
}

function isCommentLine(line) {
  return /^\s*(\/\/|\*|\/\*|#|<!--)/.test(line);
}
function isNegatedLine(line) {
  return /OCR_NO_API_KEY|不得|never|forbid|禁止|not\s+required|无需|no\s+network|offline/i.test(line);
}

/**
 * 无 API Key 断言：源码中不得出现「读取 / 要求密钥」的代码，也不得出现网络调用面。
 *
 * 只扫描**可执行代码行**：跳过注释行与显式否定行（说明性文字），避免把自己的文档判成违规。
 * 匹配一律**大小写不敏感**（Windows 环境变量名不区分大小写，小写写法同样能取到密钥）。
 *
 * @returns {{ok:boolean, violations:string[], networkViolations:Array, scanned:boolean, files:number}}
 */
export function assertNoApiKeyRequirement(sourceDir) {
  const violations = [];
  const networkViolations = [];
  let files = 0;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(mjs|js|cjs|json|yml|yaml)$/.test(entry.name)) {
        files += 1;
        const text = fs.readFileSync(abs, 'utf8');
        const rel = path.relative(sourceDir, abs);
        text.split('\n').forEach((line, idx) => {
          if (isCommentLine(line) || isNegatedLine(line)) return;
          for (const re of KEY_READ_PATTERNS) {
            re.lastIndex = 0;
            if (re.test(line)) {
              violations.push(`${rel}:${idx + 1}: ${line.trim()}`);
              break;
            }
          }
        });
        for (const v of scanNetworkSurface(text).violations) {
          networkViolations.push(`${rel}:${v.line}: [${v.via}] ${v.text}`);
        }
      }
    }
  };
  walk(sourceDir);
  return {
    ok: violations.length === 0 && networkViolations.length === 0,
    violations,
    networkViolations,
    files,
    scanned: true,
  };
}

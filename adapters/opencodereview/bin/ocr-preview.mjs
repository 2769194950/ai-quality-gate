#!/usr/bin/env node
// adapters/opencodereview/bin/ocr-preview.mjs
//
// 确定性文件选择预览（OpenCodeReview 适配层入口）。
//   node adapters/opencodereview/bin/ocr-preview.mjs --diff <diff.json> [--rule <rule.json>] --json
//   node adapters/opencodereview/bin/ocr-preview.mjs --root <dir> --md
//
// 退出码（与 qgate 契约一致）：
//   0 = 成功（ocr 缺失时 degraded:true 仍为 0）
//   2 = 配置错误（参数非法、diff/规则不可解析）
//   3 = 内部错误
// 任何路径都不需要 API Key，也不要求 ocr 存在。

import fs from 'node:fs';
import path from 'node:path';
import { createPreview, renderMarkdown } from '../src/ocr-pipeline.mjs';
import { RuleError } from '../src/rules.mjs';
import { SelectionError } from '../src/selection.mjs';
import { atomicWrite, stableStringify } from '../src/util.mjs';

const EXIT_OK = 0;
const EXIT_GATE_FAIL = 1;
const EXIT_CONFIG = 2;
const EXIT_INTERNAL = 3;

const USAGE = `ocr-preview（OpenCodeReview 适配层确定性预览）

用法：
  node bin/ocr-preview.mjs --diff <diff.json> [--rule <rule.json>] --json
  node bin/ocr-preview.mjs --root <dir> [--rule <rule.json>] --md
  node bin/ocr-preview.mjs --diff <diff.json> --explain <path> --json

参数：
  --diff <path>            变更集 JSON（数组或 {files:[...]}）
  --root <dir>             扫描目录（无 --diff 时用于枚举候选）；与 --diff 同时给出时
                           仅作为规则发现锚点与文件大小/ token 估算的解析根
  --rule <path>            最高优先规则文件（--rule > 项目 > 用户 > 内置）
  --project-rule <path>    显式指定项目级规则文件（默认 <root>/.opencodereview/rule.json）
  --user-rule <path>       显式指定用户级规则文件（默认 ~/.opencodereview/rule.json）
  --home <dir>             用于推导用户级规则路径（默认 HOME/USERPROFILE）
  --include <glob>         追加到最高层的 include（可重复；不能救回密钥路径）
  --exclude <glob>         追加到最高层的 exclude（可重复）
  --max-files <n>          每组文件数上限（硬上限 10，调大无效）
  --token-budget <n>       每组 token 预算（超预算降级为单文件桶）
  --group-mode <mode>      auto | single | per-file
  --explain <path>         只解释指定路径的命中规则（可重复）
  --ocr-bin <path>         显式指定 ocr 可执行文件
  --no-ocr                 强制不使用 ocr（纯本地实现）
  --use-ocr                允许调用 \`ocr review --format json\`（失败仍降级）
  --json                   stdout 输出 JSON（与 --md 互斥）
  --md                     stdout 输出 selection.md 风格三列表格
  --out <path>             额外把 JSON 结果原子写盘
  --print-selection-md <p> 额外把 Markdown 写盘
  --quiet                  抑制 stderr 日志
  -h, --help               显示本帮助

退出码：0 成功 ｜ 1 门禁失败（预览不使用） ｜ 2 配置错误 ｜ 3 内部错误
`;

function parseArgs(argv) {
  const opts = { include: [], exclude: [], explain: [], quiet: false };
  let json = false;
  let md = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const need = (name) => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new ArgError(`option ${name} requires a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--diff': opts.diff = need(arg); break;
      case '--root': opts.root = need(arg); break;
      case '--rule': opts.cliRulePath = need(arg); break;
      case '--rule-file': opts.cliRulePath = need(arg); break;
      case '--project-rule': opts.projectRulePath = need(arg); break;
      case '--user-rule': opts.userRulePath = need(arg); break;
      case '--home': opts.homeDir = need(arg); break;
      case '--include': opts.include.push(need(arg)); break;
      case '--exclude': opts.exclude.push(need(arg)); break;
      case '--max-files': opts.maxFilesPerGroup = Number(need(arg)); break;
      case '--token-budget': opts.tokenBudget = Number(need(arg)); break;
      case '--group-mode': opts.groupMode = need(arg); break;
      case '--explain': opts.explain.push(need(arg)); break;
      case '--ocr-bin': opts.ocrBin = need(arg); break;
      case '--no-ocr': opts.noOcr = true; break;
      case '--use-ocr': opts.useOcr = true; break;
      case '--strict-rules': opts.strictRules = true; break;
      case '--json': json = true; break;
      case '--md':
      case '--markdown': md = true; break;
      case '--out': opts.out = need(arg); break;
      case '--print-selection-md': opts.selectionMd = need(arg); break;
      case '--quiet': opts.quiet = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        if (arg.startsWith('--')) throw new ArgError(`unknown option: ${arg}`);
        throw new ArgError(`unexpected positional argument: ${arg}`);
    }
  }
  if (!opts.help) {
    // --diff 与 --root 可以同时给出：--diff 提供变更集，--root 只作为
    // 规则发现锚点与文件大小/ token 估算的解析根（两者互补，不冲突）。
    if (!opts.diff && !opts.root) throw new ArgError('one of --diff or --root is required');
    if (json && md) throw new ArgError('--json and --md are mutually exclusive');
    if (opts.groupMode && !['auto', 'single', 'per-file'].includes(opts.groupMode)) {
      throw new ArgError(`--group-mode must be auto|single|per-file, got: ${opts.groupMode}`);
    }
    for (const key of ['maxFilesPerGroup', 'tokenBudget']) {
      if (opts[key] !== undefined && (!Number.isFinite(opts[key]) || opts[key] <= 0)) {
        throw new ArgError(`--${key === 'maxFilesPerGroup' ? 'max-files' : 'token-budget'} must be a positive number`);
      }
    }
  }
  opts.json = json;
  opts.md = md;
  return opts;
}

class ArgError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgError';
    this.code = 'CONFIG_INVALID';
  }
}

function emitError(code, message, details) {
  const payload = {
    ok: false,
    mode: 'preview',
    llm_called: false,
    error: {
      code,
      message,
      details: details || [],
    },
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgError) {
      emitError('CONFIG_INVALID', err.message, [{ pointer: '/argv', expected: '见 --help', actual: err.message }]);
      process.stderr.write(`ocr-preview: ${err.message}\n`);
      return EXIT_CONFIG;
    }
    throw err;
  }

  if (opts.help) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }

  const result = createPreview({ ...opts, restrictPaths: opts.explain });
  const { payload } = result;

  if (opts.md) {
    process.stdout.write(renderMarkdown(payload));
  } else if (opts.json) {
    process.stdout.write(`${stableStringify(payload, 2)}\n`);
  } else if (opts.out || opts.selectionMd) {
    // 已把结果写盘 ⇒ stdout 只给一行摘要，避免把 JSON 刷到控制台（CI 静默场景）。
    process.stdout.write(
      `ok: mode=preview provider=${payload.provider.name} degraded=${payload.degraded} selected=${payload.counts.selected} excluded=${payload.counts.excluded} groups=${payload.counts.groups}${opts.out ? ` out=${path.resolve(opts.out)}` : ''}${opts.selectionMd ? ` md=${path.resolve(opts.selectionMd)}` : ''}\n`,
    );
  } else {
    // 默认：人类可读摘要（仍保持确定性）
    const lines = [];
    lines.push(`mode=preview provider=${payload.provider.name} degraded=${payload.degraded} llm_called=${payload.llm_called}`);
    lines.push(`candidates=${payload.counts.candidates} selected=${payload.counts.selected} excluded=${payload.counts.excluded} groups=${payload.counts.groups} downgraded=${payload.counts.downgraded_groups}`);
    lines.push(`safety.no_sensitive_selected=${payload.safety.no_sensitive_selected}`);
    for (const g of payload.groups) lines.push(`  group ${g.id} (${g.file_count} files${g.downgraded ? `, downgraded:${g.downgrade_reason}` : ''})`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  if (opts.out) {
    atomicWrite(path.resolve(opts.out), `${stableStringify(payload, 2)}\n`);
  }
  if (opts.selectionMd) {
    atomicWrite(path.resolve(opts.selectionMd), renderMarkdown(payload));
  }

  if (!opts.quiet) {
    process.stderr.write(
      `ocr-preview: provider=${payload.provider.name} degraded=${payload.degraded}(${payload.degraded_reason ?? 'n/a'}) selected=${payload.counts.selected} excluded=${payload.counts.excluded} groups=${payload.counts.groups}\n`,
    );
  }
  return EXIT_OK;
}

/** 仅在作为脚本直接执行时运行 main（被 import 时不产生副作用）。 */
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const a = fs.realpathSync(path.resolve(entry));
    const b = fs.realpathSync(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    return a === b;
  } catch {
    return path.resolve(entry).replace(/\\/g, '/').toLowerCase().endsWith('/adapters/opencodereview/bin/ocr-preview.mjs');
  }
}

if (isDirectRun()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof RuleError || err instanceof SelectionError) {
      emitError(err.code || 'CONFIG_INVALID', err.message, [{ pointer: '/rules', actual: JSON.stringify(err.details || {}) }]);
      process.stderr.write(`ocr-preview: ${err.message}\n`);
      process.exitCode = EXIT_CONFIG;
    } else {
      emitError('INTERNAL_ERROR', String(err && err.message ? err.message : err));
      process.stderr.write(`ocr-preview: internal error: ${err && err.stack ? err.stack : err}\n`);
      process.exitCode = EXIT_INTERNAL;
    }
  }
}

export { parseArgs, main, isDirectRun, EXIT_OK, EXIT_GATE_FAIL, EXIT_CONFIG, EXIT_INTERNAL };

// adapters/opencodereview/test/helpers.mjs
// 测试辅助：在进程内运行预览（避免子进程管道限制导致 Windows 沙箱下 EPERM），
// 以及构造临时目录/规则文件夹具。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreview } from '../src/ocr-pipeline.mjs';
import { main as binMain } from '../bin/ocr-preview.mjs';

export const ADAPTER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO_DIR = path.join(ADAPTER_ROOT, 'demo');
export const DEMO_DIFF = path.join(DEMO_DIR, 'diff.json');
export const DEMO_RULE = path.join(DEMO_DIR, 'rule.json');
export const REPO_ROOT = path.resolve(ADAPTER_ROOT, '..', '..');

/** 进程内运行预览；返回 {exitCode, payload, markdown, error}。 */
export function runPreview(argv) {
  const originalArgv = process.argv;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalErrWrite = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  process.stdout.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    err += String(chunk);
    return true;
  };
  let exitCode = 0;
  try {
    process.argv = ['node', 'ocr-preview.mjs', ...argv, '--quiet'];
    exitCode = binMain(process.argv.slice(2));
  } catch (err0) {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrWrite;
    process.argv = originalArgv;
    throw err0;
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrWrite;
    process.argv = originalArgv;
  }
  let payload = null;
  let markdown = null;
  if (/^\s*[{[]/.test(out)) {
    try {
      payload = JSON.parse(out);
    } catch {
      payload = null;
    }
  }
  if (/^#\s/.test(out)) markdown = out;
  return { exitCode, payload, markdown, stdout: out, stderr: err };
}

/** 创建临时目录；调用方负责 cleanup()。 */
export function tempDir(prefix = 'ocr-adapter-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    path: dir,
    write(rel, content) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return abs;
    },
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** 写一个 JSON 规则文件。 */
export function writeRule(dir, rel, obj) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  return abs;
}

/** 写一个 diff 夹具。 */
export function writeDiff(dir, rel, files) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify({ version: '1.0', files }, null, 2)}\n`, 'utf8');
  return abs;
}

export function pathsOf(list) {
  return list.map((x) => (typeof x === 'string' ? x : x.path));
}

/** 稳定字符串化（与 bin 的 --json 输出同源），用于字节级比较。 */
export function stableJson(payload) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
      return o;
    }
    return v;
  };
  return JSON.stringify(sortKeys(payload), null, 2);
}

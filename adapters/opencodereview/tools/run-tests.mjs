#!/usr/bin/env node
// adapters/opencodereview/tools/run-tests.mjs
// 汇总运行适配层全部测试文件，并输出与 `node --test test/` 等价的计数摘要。
//
// 为什么需要它：`node --test <dir>` 会为每个测试文件派生一个子进程；在某些受限沙箱
// （禁止带管道的子进程）里这会产生 EPERM。本脚本在当前进程内依次 import 每个
// `*.test.mjs`（node:test 的 TAP 摘要仍完整输出），在任何环境下都能给出同样的结论。
//
// 用法： node adapters/opencodereview/tools/run-tests.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.resolve(here, '..', 'test');

const files = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (files.length === 0) {
  process.stderr.write(`no test files found in ${testDir}\n`);
  process.exit(1);
}

process.stdout.write(`run-tests: 共 ${files.length} 个测试文件（进程内执行）\n`);
const started = Date.now();
for (const file of files) {
  const abs = path.join(testDir, file);
  try {
    await import(pathToFileURL(abs).href);
  } catch (err) {
    process.stderr.write(`FAILED to load ${file}: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  }
}
// 等待 node:test 把结果冲刷到 stdout。
await new Promise((resolve) => setTimeout(resolve, 250));
process.stdout.write(`run-tests: 完成，用时 ${Date.now() - started} ms\n`);

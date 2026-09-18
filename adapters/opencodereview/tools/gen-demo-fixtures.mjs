#!/usr/bin/env node
// adapters/opencodereview/tools/gen-demo-fixtures.mjs
// 可复现地生成 demo 演示夹具：真实文件 + diff.json。
// 用法： node adapters/opencodereview/tools/gen-demo-fixtures.mjs
//
// 约定：diff.json 中的相对路径以 **适配层 demo 目录**
// （adapters/opencodereview/demo）为锚，与
//   node bin/ocr-preview.mjs --root adapters/opencodereview/demo
// 的扫描根完全一致 ⇒ --diff 与 --root 对同一份夹具给出完全相同的相对路径。
//
// 说明：diff.json 是 **夹具**（fixture），不是真实 git diff 的导出；
//       但其中每个路径都对应 demo/ 下真实存在的文件（二进制/密钥文件亦真实存在，
//       用于证明「即使真实存在也永远不进 selected」）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '..', 'demo');

const files = new Map();

const add = (rel, content, opts = {}) => {
  files.set(rel, { content, binary: opts.binary === true, status: opts.status || 'modified' });
};

// ── 跨文件注入调用链：handler → service → repository → mapper ────────────────
add('src/chain/user-handler.mjs', `import { UserService } from './user-service.mjs';

export function handleGetUser(req, res) {
  const service = new UserService();
  const id = req.params && req.params.id;
  const user = service.findById(id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  return res.json(user);
}
`, { status: 'added' });

add('src/chain/user-service.mjs', `import { UserRepository } from './user-repository.mjs';
import { toUserDto } from './user-mapper.mjs';

export class UserService {
  constructor(repository = new UserRepository()) {
    this.repository = repository;
  }

  findById(id) {
    // 注入点：service 依赖 repository 与 mapper 的具体形状
    const row = this.repository.selectById(id);
    return row ? toUserDto(row) : null;
  }
}
`, { status: 'added' });

add('src/chain/user-repository.mjs', `export class UserRepository {
  constructor(db = null) {
    this.db = db;
  }

  selectById(id) {
    // 夹具：真实实现应查询数据库；此处返回固定行以保持离线确定性
    return { id, name: 'fixture-user', created_at: '2024-01-01T00:00:00Z' };
  }
}
`, { status: 'added' });

add('src/chain/user-mapper.mjs', `export function toUserDto(row) {
  // 若 repository 字段改名（created_at → createdAt），此处静默产生 undefined
  return {
    id: row.id,
    name: row.name,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
`, { status: 'added' });

add('src/chain/chain.test.mjs', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleGetUser } from './user-handler.mjs';

test('handler → service → repository → mapper 链路返回 DTO', () => {
  const res = { json: (v) => v, status: () => res };
  const out = handleGetUser({ params: { id: 'u-1' } }, res);
  assert.equal(out.id, 'u-1');
  assert.equal(out.createdAt, '2024-01-01T00:00:00.000Z');
});
`, { status: 'added' });

// ── 单文件桶示例文件（与 chain 同属 src/ 前缀） ─────────────────────────────
add('src/util/format.mjs', `export function formatDate(value) {
  return new Date(value).toISOString();
}
`);

// ── 同一目录内多文件（演示「按目录分段 + ≤10 切块」与 token 预算降级） ──────
for (let i = 1; i <= 8; i += 1) {
  const padding = Array.from({ length: 6 }, (_, k) => `  'reader-${i}-key-${k}': 'value-${i}-${k}',`).join('\n');
  add(`src/reader/reader-part-${i}.mjs`, `// reader part ${i}
const TABLE_${i} = {
${padding}
};

export function read${i}(input) {
  const key = String(input).trim();
  return TABLE_${i}[key] ?? key;
}
`);
}

// ── 应被排除：密钥类路径（真实存在，但永不可纳入） ─────────────────────────
add('.env.production', 'DATABASE_URL=postgres://demo:DEMO_ONLY_PLACEHOLDER@localhost:5432/demo\nANTHROPIC_API_KEY=placeholder-not-a-real-key\n');
add('config/service-account.json', '{"type":"service_account","private_key":"PLACEHOLDER-NOT-A-REAL-KEY"}\n');
add('config/tls/server.pem', '-----BEGIN CERTIFICATE-----\nDEMO-FIXTURE-PLACEHOLDER\n-----END CERTIFICATE-----\n');
add('.opencodereview/secrets/db-password.txt', 'DEMO-FIXTURE-PLACEHOLDER\n');
add('src/chain/id_rsa', 'DEMO-FIXTURE-PLACEHOLDER-PRIVATE-KEY\n');

// ── 应被排除：默认排除目录 ─────────────────────────────────────────────────
add('node_modules/left-pad/index.js', 'module.exports = (s, n) => String(s).padStart(n);\n');
add('dist/bundle.js', '(()=>{console.log("built")})();\n');

// ── 应被排除：二进制与不支持扩展名 ─────────────────────────────────────────
add('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]), { binary: true, status: 'added' });
add('src/chain/user-handler.mjs.bak', 'placeholder for unsupported extension\n');

// ── 写盘 ───────────────────────────────────────────────────────────────────
fs.mkdirSync(fixtureRoot, { recursive: true });
for (const [rel, spec] of [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const abs = path.join(fixtureRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (spec.binary) fs.writeFileSync(abs, spec.content);
  else fs.writeFileSync(abs, spec.content, 'utf8');
}

// ── diff.json（夹具） ──────────────────────────────────────────────────────
const diff = {
  version: '1.0',
  fixture: true,
  note: '本文件是 OCR 适配层的离线夹具（fixture），不是真实 git diff 导出，也不来自任何真实 ocr 调用。相对路径以 adapters/opencodereview/demo 为锚（与 --root 同根）。',
  files: [...files.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([rel, spec]) => ({
      path: rel,
      status: spec.status,
      binary: spec.binary === true,
    })),
};
fs.writeFileSync(path.join(fixtureRoot, 'diff.json'), `${JSON.stringify(diff, null, 2)}\n`, 'utf8');

process.stdout.write(`demo fixtures written: ${files.size} files + diff.json -> ${fixtureRoot}\n`);

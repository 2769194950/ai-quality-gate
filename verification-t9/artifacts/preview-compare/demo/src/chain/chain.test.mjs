import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleGetUser } from './user-handler.mjs';

test('handler → service → repository → mapper 链路返回 DTO', () => {
  const res = { json: (v) => v, status: () => res };
  const out = handleGetUser({ params: { id: 'u-1' } }, res);
  assert.equal(out.id, 'u-1');
  assert.equal(out.createdAt, '2024-01-01T00:00:00.000Z');
});

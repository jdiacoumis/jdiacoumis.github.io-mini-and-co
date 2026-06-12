import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers.js';
import { allowRate } from '../../src/lib/ratelimit.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

test('allows exactly the limit within a window, then refuses', async () => {
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await allowRate(env, 'unit:key-a', 3, 3600), true, `attempt ${i + 1} should pass`);
  }
  assert.equal(await allowRate(env, 'unit:key-a', 3, 3600), false);
  assert.equal(await allowRate(env, 'unit:key-a', 3, 3600), false);
});

test('keys are independent', async () => {
  assert.equal(await allowRate(env, 'unit:key-b', 1, 3600), true);
  assert.equal(await allowRate(env, 'unit:key-b', 1, 3600), false);
  assert.equal(await allowRate(env, 'unit:key-c', 1, 3600), true);
});

test('different window lengths for the same key are independent counters', async () => {
  assert.equal(await allowRate(env, 'unit:key-d', 1, 60), true);
  assert.equal(await allowRate(env, 'unit:key-d', 1, 3600), true);
  assert.equal(await allowRate(env, 'unit:key-d', 1, 60), false);
});

test('concurrent burst never exceeds the limit', async () => {
  const results = await Promise.all(
    Array.from({ length: 10 }, () => allowRate(env, 'unit:key-e', 4, 3600)),
  );
  assert.equal(results.filter(Boolean).length, 4);
});

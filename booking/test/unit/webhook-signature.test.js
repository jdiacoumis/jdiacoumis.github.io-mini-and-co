import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPaymentsDriver } from '../../src/lib/payments-driver.js';
import { hmacSha256Hex } from '../../src/lib/crypto.js';

const SECRET = 'whsec_test_secret_value';
const env = { PAYMENTS_DRIVER: 'stripe', STRIPE_WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: 'https://example.com' };

async function sign(body, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const v1 = await hmacSha256Hex(secret, `${timestamp}.${body}`);
  return `t=${timestamp},v1=${v1}`;
}

test('correctly signed webhook verifies and parses', async () => {
  const driver = getPaymentsDriver(env);
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const event = await driver.verifyWebhook(await sign(body), body);
  assert.equal(event.id, 'evt_1');
});

test('tampered payload is rejected', async () => {
  const driver = getPaymentsDriver(env);
  const body = JSON.stringify({ id: 'evt_1', amount: 100 });
  const header = await sign(body);
  const tampered = JSON.stringify({ id: 'evt_1', amount: 999999 });
  await assert.rejects(() => driver.verifyWebhook(header, tampered), /signature mismatch/);
});

test('signature made with the wrong secret is rejected', async () => {
  const driver = getPaymentsDriver(env);
  const body = '{}';
  const header = await sign(body, { secret: 'whsec_other' });
  await assert.rejects(() => driver.verifyWebhook(header, body), /signature mismatch/);
});

test('stale timestamp outside the 5-minute tolerance is rejected', async () => {
  const driver = getPaymentsDriver(env);
  const body = '{}';
  const header = await sign(body, { timestamp: Math.floor(Date.now() / 1000) - 600 });
  await assert.rejects(() => driver.verifyWebhook(header, body), /tolerance/);
});

test('missing or malformed signature header is rejected', async () => {
  const driver = getPaymentsDriver(env);
  await assert.rejects(() => driver.verifyWebhook(null, '{}'), /malformed/);
  await assert.rejects(() => driver.verifyWebhook('v1=abc', '{}'), /malformed/);
  await assert.rejects(() => driver.verifyWebhook('t=123', '{}'), /malformed/);
});

test('any valid v1 candidate among several passes (secret roll)', async () => {
  const driver = getPaymentsDriver(env);
  const body = '{}';
  const timestamp = Math.floor(Date.now() / 1000);
  const good = await hmacSha256Hex(SECRET, `${timestamp}.${body}`);
  const header = `t=${timestamp},v1=${'0'.repeat(64)},v1=${good}`;
  const event = await driver.verifyWebhook(header, body);
  assert.deepEqual(event, {});
});

test('mock payments driver refuses to load in production (fail-closed)', () => {
  assert.throws(
    () => getPaymentsDriver({ PAYMENTS_DRIVER: 'mock', ENVIRONMENT: 'production' }),
    /cannot load in production/,
  );
});

test('unconfigured webhook secret rejects everything — even a signature keyed on "undefined"', async () => {
  const driver = getPaymentsDriver({ PAYMENTS_DRIVER: 'stripe', PUBLIC_BASE_URL: 'https://example.com' });
  const body = '{}';
  const timestamp = Math.floor(Date.now() / 1000);
  // The pre-fix failure mode: String(undefined) becomes the HMAC key, which
  // an attacker can compute. That signature must not verify.
  const forged = await hmacSha256Hex('undefined', `${timestamp}.${body}`);
  await assert.rejects(
    () => driver.verifyWebhook(`t=${timestamp},v1=${forged}`, body),
    /not configured/,
  );
});

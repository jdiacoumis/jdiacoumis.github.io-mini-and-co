// Review fix (task 3.2, low): emails were logged as 'sent' BEFORE sending, so
// a send that died part-way was never retried and the log said it had gone.
// The row is now 'pending' while sending, then 'sent' (with the provider's
// id) or 'failed'; the dedupe key skips a sent email and one still being
// sent (pending under ten minutes), and retries a failed or abandoned one.
// Also: searches stay within D1's 50-character LIKE-pattern limit.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, signedIn, formRequest, outcome, routeHandler, iso } from './helpers.js';
import { sendTemplate, PENDING_RETRY_SECS } from '../../src/lib/notify.js';
import { listCustomers } from '../../src/lib/admin-ops.js';
import * as adminEmail from '../../src/routes/admin-email.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const logRow = (key) => env.DB.prepare(`SELECT status, provider_ref, error FROM email_log WHERE dedupe_key = ?1`).bind(key).first();
const message = { template: 'test', to: 'fam@example.com', subject: 'Hello', text: 'Hi' };

test('the log row is pending while the email is sent, then sent with the provider id', async () => {
  const realFetch = globalThis.fetch;
  let seenDuringSend = null;
  globalThis.fetch = async () => {
    seenDuringSend = (await logRow('t:pending')).status;
    return Response.json({ id: 'resend-123' });
  };
  try {
    const result = await sendTemplate({ ...env, EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_x' }, { ...message, dedupeKey: 't:pending' });
    assert.equal(result.sent, true);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seenDuringSend, 'pending');
  assert.deepEqual(await logRow('t:pending'), { status: 'sent', provider_ref: 'resend-123', error: null });
});

test('a send still in flight is skipped; one abandoned for ten minutes is retried; a failed one is retried', async () => {
  const insert = (key, status, ageSecs) => env.DB.prepare(
    `INSERT INTO email_log (id, template, dedupe_key, to_email, subject, status, sent_at) VALUES (?1, 'test', ?2, 'fam@example.com', 's', ?3, ?4)`,
  ).bind(crypto.randomUUID(), key, status, iso(Date.now() - ageSecs * 1000)).run();
  await insert('t:recent', 'pending', 60);
  await insert('t:abandoned', 'pending', PENDING_RETRY_SECS + 60);
  await insert('t:sent', 'sent', PENDING_RETRY_SECS + 60);
  assert.deepEqual(await sendTemplate(env, { ...message, dedupeKey: 't:recent' }), { skipped: true });
  assert.equal((await sendTemplate(env, { ...message, dedupeKey: 't:abandoned' })).sent, true);
  assert.equal((await logRow('t:abandoned')).status, 'sent');
  assert.deepEqual(await sendTemplate(env, { ...message, dedupeKey: 't:sent' }), { skipped: true });

  const broken = await sendTemplate({ ...env, EMAIL_DRIVER: 'broken' }, { ...message, dedupeKey: 't:failed' });
  assert.equal(broken.sent, false);
  assert.equal((await logRow('t:failed')).status, 'failed');
  assert.equal((await sendTemplate(env, { ...message, dedupeKey: 't:failed' })).sent, true);
  assert.equal((await logRow('t:failed')).status, 'sent');
  const delivered = await env.DB.prepare(`SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = 'fam@example.com'`).first();
  assert.equal(delivered.n, 2, 'the abandoned and the failed one, once each');
});

test('long searches stay within D1\'s LIKE-pattern limit', async () => {
  assert.deepEqual(await listCustomers(env, { query: 'x'.repeat(100) }), []);
  assert.deepEqual(await listCustomers(env, { query: '%'.repeat(60) }), []);
  const owner = await signedIn(env, 'owner@example.com');
  const res = await outcome(routeHandler(adminEmail, 'GET', '/admin/email/log')(
    formRequest('GET', `/admin/email/log?q=${'a'.repeat(100)}&status=pending`, { cookie: owner.cookie }), env, {}));
  assert.equal(res.status, 200);
});

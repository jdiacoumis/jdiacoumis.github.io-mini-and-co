// Session lifecycle against a real D1 database, including the expiry
// comparison regression: expires_at is an ISO 'YYYY-MM-DDTHH:MM:SSZ' string
// and must be compared against the same format — a same-day-expired session
// must be treated as unauthenticated immediately, not at UTC midnight.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers.js';
import { createSession, getSession, deleteSession } from '../../src/lib/session.js';
import { sha256Hex } from '../../src/lib/crypto.js';
import { nowIso, isoPlusSeconds } from '../../src/lib/db.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

await env.DB.prepare(
  `INSERT INTO users (id, email, created_at) VALUES ('u1', 'p@example.com', ?1)`,
).bind(nowIso()).run();

test('a fresh session resolves to its user with a CSRF token', async () => {
  const { sessionId } = await createSession(env, 'u1');
  const session = await getSession(env, sessionId);
  assert.equal(session.userId, 'u1');
  assert.ok(session.csrfToken.length >= 40);
});

test('each sign-in issues a distinct session id', async () => {
  const a = await createSession(env, 'u1');
  const b = await createSession(env, 'u1');
  assert.notEqual(a.sessionId, b.sessionId);
});

test('a session expired earlier the same UTC day is rejected (regression)', async () => {
  const { sessionId } = await createSession(env, 'u1');
  const sessionHash = await sha256Hex(sessionId);
  // Expired 10 minutes ago: same UTC date as "now" in almost every run, which
  // is exactly the case the old datetime() comparison got wrong.
  await env.DB.prepare(
    `UPDATE web_sessions SET expires_at = ?1 WHERE session_hash = ?2`,
  ).bind(isoPlusSeconds(-600), sessionHash).run();

  assert.equal(await getSession(env, sessionId), null);
});

test('deleteSession revokes server-side: the old cookie value is dead', async () => {
  const { sessionId, sessionHash } = await createSession(env, 'u1');
  assert.ok(await getSession(env, sessionId));
  await deleteSession(env, sessionHash);
  assert.equal(await getSession(env, sessionId), null);
});

test('garbage session ids are rejected without a database round trip', async () => {
  // A database that fails the test if it is touched at all.
  const untouchable = { ...env, DB: { prepare() { throw new Error('getSession queried the database'); }, batch() { throw new Error('batch'); } } };
  assert.equal(await getSession(untouchable, ''), null);
  assert.equal(await getSession(untouchable, 'short'), null);
  assert.equal(await getSession(untouchable, null), null);
  assert.equal(await getSession(untouchable, 'x'.repeat(500)), null, 'absurdly long');
  // …while a well-formed id does ask the database.
  const { sessionId } = await createSession(env, 'u1');
  await assert.rejects(getSession(untouchable, sessionId), /queried the database/);
});

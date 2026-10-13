// Review fix (task 3.2, finding 4): anyone could block a family's — or the
// owner's — sign-in by asking for links in their name: the per-address
// counter went up even when the per-IP limit refused the request, and was
// shared by every IP. Now the per-IP limit is checked first and alone, the
// per-address limit counts per address + IP, and reaching it shows the
// usual "check your email" page (nothing is sent; it is logged).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, formRequest, outcome, routeHandler } from './helpers.js';
import * as auth from '../../src/routes/auth.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const ask = routeHandler(auth, 'POST', '/auth/request-magic-link');
const request = (email, ip) => outcome(ask(formRequest('POST', '/auth/request-magic-link', {
  form: { email }, headers: { 'CF-Connecting-IP': ip },
}), env, {}));
const links = async (email) => (await env.DB.prepare(
  `SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = ?1 AND subject = 'Your Mini & Co. sign-in link'`,
).bind(email).first()).n;

test('a flood for someone else\'s address from one IP never stops them signing in from theirs', async () => {
  const victim = 'family-a@example.com';
  const statuses = [];
  for (let i = 0; i < 10; i += 1) statuses.push((await request(victim, '203.0.113.7')).status);
  assert.deepEqual(statuses, Array(10).fill(200), 'over the per-address limit the page still says "check your email"');
  assert.equal(await links(victim), auth.MAGIC_LINKS_PER_ADDRESS_AND_IP_HOUR, 'only three links from that IP');
  const blocked = await request(victim, '203.0.113.7');
  assert.equal(blocked.status, 429, 'the eleventh request from that IP is refused by the per-IP limit');

  const own = await request(victim, '198.51.100.20');
  assert.equal(own.status, 200);
  assert.match(await own.text(), /Check your email/);
  assert.equal(await links(victim), 4, 'the family still gets a link from their own connection');
});

test('requests refused by the per-IP limit are never counted against the address', async () => {
  const owner = 'owner@example.com';
  const attacker = '203.0.113.99';
  for (let i = 0; i < auth.MAGIC_LINKS_PER_IP_HOUR; i += 1) await request(`spray-${i}@example.com`, attacker);
  for (let i = 0; i < 5; i += 1) assert.equal((await request(owner, attacker)).status, 429);
  const counted = await env.DB.prepare(`SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'auth:email:owner@%'`).first();
  assert.equal(counted.n, 0, 'nothing counted for the owner');
  assert.equal((await request(owner, '198.51.100.30')).status, 200);
  assert.equal(await links(owner), 1);
});

test('the over-limit page is identical to a sent link (no enumeration)', async () => {
  const email = 'family-b@example.com';
  const ip = '192.0.2.44';
  const pages = [];
  for (let i = 0; i < 4; i += 1) pages.push(await (await request(email, ip)).text());
  assert.equal(pages[3], pages[0]);
});

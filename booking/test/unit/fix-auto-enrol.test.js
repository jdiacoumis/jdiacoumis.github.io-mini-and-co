// Review fix (task 3.2, finding 6): re-running auto-enrol held places
// without telling anyone — the invitation was deduped on term + child for
// good, and a skipped send was reported as "invitation sent". The dedupe key
// is now term + child + the held booking, and the result says what really
// happened. Auto-enrol also runs one family per request (D1 per-request
// limits), carrying the rest in a Continue form.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestDb, seedFamilyAndTerm, signedIn, formRequest, outcome, routeHandler, iso, daysFromNow, countingEnv,
} from './helpers.js';
import { createTermsWithSessions } from '../../src/lib/admin-ops.js';
import * as adminTerms from '../../src/routes/admin-terms.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const run = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).run();
const all = async (sql, ...binds) => (await env.DB.prepare(sql).bind(...binds).all()).results;

// A closed previous term with `families` term families, and the next term.
async function setup(prefix, families = 1) {
  const prev = await seedFamilyAndTerm(env, { prefix, startInDays: -70, status: 'closed', weeks: 10, children: families });
  for (const [i, childId] of prev.childIds.entries()) {
    await run(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, amount_cents, payment_method, payment_status, created_at)
               VALUES (?1, ?2, ?3, 'term', ?4, 'confirmed', 16800, 'offline', 'paid', ?5)`, `${prefix}-prev-${i}`, prev.userId, childId, prev.termId, iso(Date.now()));
  }
  const [termId] = await createTermsWithSessions(env, [{
    classId: prev.classId, name: `${prefix} next`, startsOn: '2099-01-07', endsOn: '2099-03-11', termPriceCents: 16800,
    casualPriceCents: 3000, returningPriceCents: 15000, previousTermId: prev.termId, status: 'draft', durationMins: 45, capacity: 12,
    sessions: Array.from({ length: 10 }, (_, i) => ({ startsAt: daysFromNow(20 + 7 * i) })),
  }]);
  return { prev, termId };
}

const post = (termId, owner, form, e = env) => outcome(routeHandler(adminTerms, 'POST', '/admin/terms/:id/auto-enrol')(
  formRequest('POST', `/admin/terms/${termId}/auto-enrol`, { cookie: owner.cookie, form: [['csrf', owner.csrf], ...form] }), e, { id: termId }));

test('a place held again after the first hold lapsed is announced again — and reported truthfully', async () => {
  const { prev, termId } = await setup('ae6');
  const owner = await signedIn(env, 'owner@example.com');
  const first = await post(termId, owner, [['child', prev.childId]]);
  assert.match(await first.text(), /Place held — invitation sent/);
  const [held] = await all(`SELECT id FROM bookings WHERE term_id = ?1`, termId);
  // Nobody paid: the hold lapses, and the owner runs auto-enrol again.
  await run(`UPDATE bookings SET status = 'expired' WHERE id = ?1`, held.id);
  const second = await post(termId, owner, [['child', prev.childId]]);
  assert.match(await second.text(), /Place held — invitation sent/);
  const bookings = await all(`SELECT id, status FROM bookings WHERE term_id = ?1 ORDER BY created_at`, termId);
  assert.equal(bookings.length, 2);
  const invitations = await all(`SELECT dedupe_key, booking_id FROM email_log WHERE template = 'reenrol_invitation' AND term_id = ?1 ORDER BY sent_at`, termId);
  assert.equal(invitations.length, 2, 'the family is told about the new hold');
  assert.deepEqual(invitations.map((i) => i.dedupe_key), bookings.map((b) => `reenrol:${termId}:${prev.childId}:${b.id}`));
});

test('an invitation that cannot be sent is reported as not sent', async () => {
  const { prev, termId } = await setup('ae6b');
  const owner = await signedIn(env, 'owner@example.com');
  const res = await post(termId, owner, [['child', prev.childId]], { ...env, EMAIL_DRIVER: 'broken' });
  const text = await res.text();
  assert.match(text, /the invitation could not be sent: please tell the family yourself/);
  assert.doesNotMatch(text, /invitation sent/);
});

test('one family per step: the rest is carried in a Continue form that carries on by itself', async () => {
  const { prev, termId } = await setup('ae6c', 3);
  const owner = await signedIn(env, 'owner@example.com');
  const counted = countingEnv(env);
  const step1 = await post(termId, owner, prev.childIds.map((id) => ['child', id]), counted.env);
  assert.ok(counted.stats.statements <= 40, `one step stays within ~40 D1 statements (${JSON.stringify(counted.stats)})`);
  const text1 = await step1.text();
  assert.match(text1, /data-auto-continue/);
  assert.match(text1, /<script src="\/js\/admin-continue.js" defer><\/script>/);
  assert.match(text1, /Continue \(2 left\)/);
  assert.equal((await all(`SELECT id FROM bookings WHERE term_id = ?1`, termId)).length, 1);

  // The browser posts the Continue form as rendered (plus a forged entry,
  // which is ignored).
  const fields = [...text1.matchAll(/<input type="hidden" name="(done|child)" value="([^"]+)">/g)].map((m) => [m[1], m[2]]);
  const step2 = await post(termId, owner, [...fields, ['done', `${prev.childIds[2]}.-.held`], ['done', 'nobody.-.held']]);
  const text2 = await step2.text();
  assert.match(text2, /Continue \(1 left\)/);
  const step3Fields = [...text2.matchAll(/<input type="hidden" name="(done|child)" value="([^"]+)">/g)].map((m) => [m[1], m[2]]);
  const step3 = await post(termId, owner, step3Fields);
  const text3 = await step3.text();
  assert.doesNotMatch(text3, /data-auto-continue/);
  assert.equal((text3.match(/Place held — invitation sent/g) || []).length, 3, 'every family listed once at the end');
  assert.equal((await all(`SELECT id FROM bookings WHERE term_id = ?1 AND status = 'pending'`, termId)).length, 3);
});

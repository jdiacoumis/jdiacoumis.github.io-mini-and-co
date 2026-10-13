// Review fixes (task 3.2) — cancelling a session:
//   finding 8  a place held but not yet paid (pay-later, an offer, a
//              re-enrolment) used to keep its full price, so Pay now charged
//              for the cancelled class: the hold now costs one week less
//              (amount and list price, with a note), and the family's notice
//              says so;
//   finding 9  the owner can set each paid family's credit on the cancel
//              page (imported ClassForKids bookings, special cases);
//   D1 limits  the cancellation is one batch with the same number of
//              statements however many families are booked.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestDb, seedFamilyAndTerm, signedIn, formRequest, outcome, routeHandler, iso, countingEnv,
} from './helpers.js';
import { prepareBooking, createPendingBooking, confirmBooking } from '../../src/lib/domain.js';
import { createAdminBooking, cancelSessionWithCredits, sessionCancellationPlan } from '../../src/lib/admin-ops.js';
import * as admin from '../../src/routes/admin.js';
import * as account from '../../src/routes/account.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const run = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).run();
const row = (id) => env.DB.prepare(`SELECT * FROM bookings WHERE id = ?1`).bind(id).first();

async function addFamily(prefix, fam) {
  const userId = `${prefix}-user`;
  await run(`INSERT INTO users (id, email, name, created_at) VALUES (?1, ?2, 'Parent', ?3)`, userId, `${prefix}@example.com`, iso(Date.now()));
  await run(`INSERT INTO children (id, user_id, name, dob, photo_consent, created_at) VALUES (?1, ?2, ?3, '2025-10-01', 1, ?4)`,
    `${prefix}-child`, userId, `Child ${prefix}`, iso(Date.now()));
  return { ...fam, userId, childId: `${prefix}-child` };
}

async function paidTerm(fam) {
  const prepared = await prepareBooking(env, { userId: fam.userId, childId: fam.childId, kind: 'term', termId: fam.termId });
  const created = await createPendingBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'term', termId: fam.termId, sessionIds: prepared.quote.sessionIds, quote: prepared.quote,
  });
  await confirmBooking(env, created.id, {
    provider: 'mock', payment: { kind: 'checkout', amountCents: prepared.quote.amountCents, provider: 'mock', providerRef: `pi_${created.id}` },
  });
  return created.id;
}

test('finding 8: an unpaid hold over a cancelled class costs a week less, so Pay now charges the right amount', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'sc8' }); // 6 weeks, $168
  const held = await createAdminBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'term', termId: fam.termId, mode: 'paylater', by: 'owner',
  });
  assert.equal(held.ok, true);
  const plan = await sessionCancellationPlan(env, fam.sessionIds[2]);
  assert.deepEqual(plan.map((r) => [r.status, r.creditCents, r.reductionCents]), [['pending', 0, 2800]]);

  const owner = await signedIn(env, 'owner@example.com');
  const res = await outcome(routeHandler(admin, 'POST', '/admin/sessions/:id/cancel')(formRequest('POST', `/admin/sessions/${fam.sessionIds[2]}/cancel`, {
    cookie: owner.cookie, form: { csrf: owner.csrf, reason: 'Venue flooded' },
  }), env, { id: fam.sessionIds[2] }));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Price reduced by \$28\.00 \(not paid yet\)/);
  const b = await row(held.bookingId);
  assert.deepEqual([b.status, b.list_amount_cents, b.amount_cents], ['pending', 14000, 14000]);
  assert.match(b.admin_notes, /price of this unpaid place was reduced by one week's value/);
  assert.equal(await env.DB.prepare(`SELECT COUNT(*) AS n FROM credits WHERE source_booking_id = ?1`).bind(held.bookingId).first().then((r) => r.n), 0,
    'no credit as well');

  // The family's notice says so, and Pay now asks for the new amount.
  const mail = await env.DB.prepare(`SELECT body_text FROM dev_emails WHERE to_email = 'sc8@example.com' AND subject LIKE 'Class cancelled:%'`).first();
  assert.match(mail.body_text, /we've taken \$28\.00 off its price — it's now \$140\.00/);
  const parent = await signedIn(env, 'sc8@example.com');
  const pay = await routeHandler(account, 'GET', '/account/bookings/:id/pay')(
    formRequest('GET', `/account/bookings/${held.bookingId}/pay`, { cookie: parent.cookie }), env, { id: held.bookingId });
  assert.match(await pay.text(), /To pay<\/td><td>\$140\.00 AUD/);
});

test('finding 9: the owner sets each paid family\'s credit on the cancel page (blank = the per-week value, 0 = none)', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'sc9' });
  const a = await paidTerm(fam);
  const b = await paidTerm(await addFamily('sc9b', fam));
  const c = await paidTerm(await addFamily('sc9c', fam));
  const owner = await signedIn(env, 'owner@example.com');
  const session = fam.sessionIds[1];
  const page = await routeHandler(admin, 'GET', '/admin/sessions/:id/cancel')(
    formRequest('GET', `/admin/sessions/${session}/cancel`, { cookie: owner.cookie }), env, { id: session });
  const text = await page.text();
  assert.match(text, new RegExp(`name="credit_${a}" value="28.00"`), 'prefilled with the per-week value');

  const bad = await outcome(routeHandler(admin, 'POST', '/admin/sessions/:id/cancel')(formRequest('POST', `/admin/sessions/${session}/cancel`, {
    cookie: owner.cookie, form: { csrf: owner.csrf, reason: 'Unwell', [`credit_${a}`]: 'lots' },
  }), env, { id: session }));
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Each credit must be an amount like 28/);
  assert.equal((await env.DB.prepare(`SELECT status FROM class_sessions WHERE id = ?1`).bind(session).first()).status, 'scheduled');

  const done = await outcome(routeHandler(admin, 'POST', '/admin/sessions/:id/cancel')(formRequest('POST', `/admin/sessions/${session}/cancel`, {
    cookie: owner.cookie, form: { csrf: owner.csrf, reason: 'Unwell', [`credit_${a}`]: '35', [`credit_${b}`]: '0', [`credit_${c}`]: '' },
  }), env, { id: session }));
  assert.equal(done.status, 200);
  const credits = (await env.DB.prepare(`SELECT source_booking_id, amount_cents FROM credits WHERE source_session_id = ?1`).bind(session).all()).results;
  const by = Object.fromEntries(credits.map((cr) => [cr.source_booking_id, cr.amount_cents]));
  assert.deepEqual(by, { [a]: 3500, [c]: 2800 }, 'the owner\'s amount, none, and the default');
});

test('the cancellation batch has the same number of statements for 2 families or 8', async () => {
  const measure = async (prefix, families) => {
    const fam = await seedFamilyAndTerm(env, { prefix });
    await paidTerm(fam);
    for (let i = 1; i < families; i += 1) await paidTerm(await addFamily(`${prefix}-${i}`, fam));
    const counted = countingEnv(env);
    const result = await cancelSessionWithCredits(counted.env, fam.sessionIds[0], { reason: 'Test', by: 'owner' });
    assert.equal(result.ok, true);
    assert.equal(result.creditsIssued, families);
    return counted.stats;
  };
  const two = await measure('scn2', 2);
  const eight = await measure('scn8', 8);
  assert.deepEqual(eight, two, `${JSON.stringify(two)} vs ${JSON.stringify(eight)}`);
  assert.ok(eight.statements <= 15, JSON.stringify(eight));
});

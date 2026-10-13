// Review fixes (task 3.2, low): caps on children and unfinished checkouts
// per account, at most two Pay now extensions per held place, a GET of the
// "cancelled" page that changes nothing, no money column for staff, roster
// ages on the Sydney date, and a limit on voucher codes tried per hour.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestDb, seedFamilyAndTerm, signedIn, formRequest, outcome, routeHandler, iso, daysFromNow,
} from './helpers.js';
import { createPendingBooking, prepareBooking, MAX_CHECKOUT_HOLDS_PER_ACCOUNT } from '../../src/lib/domain.js';
import { createAdminBooking } from '../../src/lib/admin-ops.js';
import { formatAge } from '../../src/lib/time.js';
import * as childProfiles from '../../src/routes/child-profiles.js';
import * as booking from '../../src/routes/booking.js';
import * as account from '../../src/routes/account.js';
import * as admin from '../../src/routes/admin.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const run = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).run();
const one = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).first();

// A signed-in family that owns the seeded child and term.
async function family(prefix, options = {}) {
  const fam = await seedFamilyAndTerm(env, { prefix, ...options });
  const session = await signedIn(env, `${prefix}@example.com`);
  return { ...fam, ...session };
}

const checkout = (fam, sessionId, extra = {}) => outcome(routeHandler(booking, 'POST', '/book/checkout')(
  formRequest('POST', '/book/checkout', {
    cookie: fam.cookie,
    form: {
      csrf: fam.csrf, kind: 'casual', term: fam.termId, session: sessionId, child: fam.childId,
      photo_consent: 'yes', medical: '', waiver: 'accepted', ...extra,
    },
  }), env, {}, { waitUntil() {} }));

test(`a family account holds at most ${childProfiles.MAX_CHILDREN_PER_ACCOUNT} children (two quick submits included)`, async () => {
  const fam = await family('lc', { children: 5 });
  const add = (name) => outcome(routeHandler(childProfiles, 'POST', '/account/children/new')(formRequest('POST', '/account/children/new', {
    cookie: fam.cookie, form: { csrf: fam.csrf, name, dob: '2026-01-01', medical: '', photo_consent: 'no' },
  }), env, {}));
  const results = await Promise.all([add('Sixth'), add('Seventh')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [303, 400]);
  const refused = results.find((r) => r.status === 400);
  assert.match(await refused.text(), /You can add up to 6 children here/);
  assert.equal((await one(`SELECT COUNT(*) AS n FROM children WHERE user_id = ?1`, fam.userId)).n, 6);
});

test(`at most ${MAX_CHECKOUT_HOLDS_PER_ACCOUNT} unfinished checkouts per account; places the owner holds don't count`, async () => {
  const fam = await family('lh');
  for (let i = 0; i < MAX_CHECKOUT_HOLDS_PER_ACCOUNT; i += 1) {
    const res = await checkout(fam, fam.sessionIds[i]);
    assert.equal(res.status, 303, `checkout ${i + 1}`);
  }
  const fourth = await checkout(fam, fam.sessionIds[3]);
  assert.equal(fourth.status, 429);
  assert.match(await fourth.text(), /Finish one payment first/);
  assert.equal((await one(`SELECT COUNT(*) AS n FROM bookings WHERE user_id = ?1`, fam.userId)).n, MAX_CHECKOUT_HOLDS_PER_ACCOUNT);

  // Racing past the page's check: the booking batch itself refuses.
  const prepared = await prepareBooking(env, { userId: fam.userId, childId: fam.childId, kind: 'casual', termId: fam.termId, sessionIds: [fam.sessionIds[4]] });
  const raced = await createPendingBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'casual', termId: fam.termId, sessionIds: [fam.sessionIds[4]], quote: prepared.quote,
    maxCheckoutHolds: MAX_CHECKOUT_HOLDS_PER_ACCOUNT,
  });
  assert.equal(raced.error, 'too_many_holds');

  // A family with three places the owner is holding for them can still book.
  const held = await family('lh2', { children: 4 });
  for (let i = 0; i < 3; i += 1) {
    const r = await createAdminBooking(env, {
      userId: held.userId, childId: held.childIds[i], kind: 'term', termId: held.termId, mode: 'paylater', by: 'owner',
    });
    assert.equal(r.ok, true);
  }
  assert.equal((await checkout({ ...held, childId: held.childIds[3] }, held.sessionIds[0])).status, 303);
});

test('Pay now stretches a hold about to end at most twice', async () => {
  const fam = await family('lx');
  const held = await createAdminBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'casual', termId: fam.termId, sessionIds: [fam.sessionIds[0]], mode: 'paylater', by: 'owner',
  });
  // A week-long hold in its last ten minutes.
  const nearlyOver = () => run(`UPDATE bookings SET created_at = ?3, expires_at = ?2 WHERE id = ?1`,
    held.bookingId, daysFromNow(10 / 1440), daysFromNow(-7));
  const pay = () => outcome(routeHandler(account, 'POST', '/account/bookings/:id/pay')(formRequest('POST', `/account/bookings/${held.bookingId}/pay`, {
    cookie: fam.cookie, form: { csrf: fam.csrf, payment: 'full', photo_consent: 'yes', medical: '', waiver: 'accepted' },
  }), env, { id: held.bookingId }, { waitUntil() {} }));
  const row = () => one(`SELECT expires_at, hold_extensions FROM bookings WHERE id = ?1`, held.bookingId);
  for (let i = 1; i <= 2; i += 1) {
    await nearlyOver();
    assert.equal((await pay()).status, 303);
    const r = await row();
    assert.equal(r.hold_extensions, i);
    assert.ok(r.expires_at > daysFromNow(30 / 1440), `extension ${i} covers the checkout`);
  }
  await nearlyOver();
  const before = await row();
  await pay();
  const after = await row();
  assert.deepEqual(after, before, 'the third press does not stretch it again');
});

test('opening the "payment cancelled" page changes nothing; its button (POST, CSRF) releases the place', async () => {
  const fam = await family('lb');
  const started = await checkout(fam, fam.sessionIds[0]);
  const bookingId = /booking=([a-f0-9-]+)/.exec(started.headers.get('Location'))[1];
  const page = await outcome(routeHandler(booking, 'GET', '/book/cancelled')(
    formRequest('GET', `/book/cancelled?booking=${bookingId}`, { cookie: fam.cookie }), env, {}));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Cancel this payment and release the place/);
  assert.equal((await one(`SELECT status FROM bookings WHERE id = ?1`, bookingId)).status, 'pending');
  const forged = await outcome(routeHandler(booking, 'POST', '/book/checkout/release')(formRequest('POST', '/book/checkout/release', {
    cookie: fam.cookie, form: { csrf: 'not-the-token', booking: bookingId, from: 'cancelled' },
  }), env, {}));
  assert.equal(forged.status, 403);
  const released = await outcome(routeHandler(booking, 'POST', '/book/checkout/release')(formRequest('POST', '/book/checkout/release', {
    cookie: fam.cookie, form: { csrf: fam.csrf, booking: bookingId, from: 'cancelled' },
  }), env, {}));
  assert.equal(released.status, 200);
  assert.match(await released.text(), /No money was taken and your places have been released/);
  assert.equal((await one(`SELECT status FROM bookings WHERE id = ?1`, bookingId)).status, 'expired');
});

test('staff rosters show no payment column; the owner\'s do', async () => {
  const fam = await family('lr');
  await createAdminBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'term', termId: fam.termId, mode: 'paylater', by: 'owner',
  });
  const roster = async (email) => {
    const who = await signedIn(env, email);
    const res = await routeHandler(admin, 'GET', '/admin/sessions/:id/roster')(
      formRequest('GET', `/admin/sessions/${fam.sessionIds[0]}/roster`, { cookie: who.cookie }), env, { id: fam.sessionIds[0] });
    return res.text();
  };
  const staff = await roster('staff@example.com');
  assert.match(staff, /Child 0/);
  assert.doesNotMatch(staff, /<th>Payment<\/th>|Unpaid|\$168\.00/);
  const owner = await roster('owner@example.com');
  assert.match(owner, /<th>Payment<\/th>/);
  assert.match(owner, /Unpaid \$168\.00/);
});

test('ages on a roster follow the Sydney calendar date of the class', () => {
  // 9:30 am on 15 April in Sydney is still 14 April in UTC.
  assert.equal(formatAge('2026-01-15', '2026-04-14T23:30:00Z'), '3 months');
  assert.equal(formatAge('2026-01-15', '2026-04-14T13:59:00Z'), '2 months', 'still 14 April in Sydney');
});

test(`at most ${booking.VOUCHER_TRIES_PER_HOUR} voucher codes an hour per account`, async () => {
  const fam = await family('lv');
  const now = iso(Date.now());
  await run(`INSERT INTO vouchers (code, kind, value, applies_to, created_at) VALUES ('LV10', 'amount', 1000, 'any', ?1)`, now);
  const view = (code) => routeHandler(booking, 'GET', '/book/checkout')(formRequest('GET',
    `/book/checkout?kind=casual&term=${fam.termId}&session=${fam.sessionIds[0]}&child=${fam.childId}&voucher=${code}`,
    { cookie: fam.cookie }), env, {});
  for (let i = 0; i < booking.VOUCHER_TRIES_PER_HOUR - 1; i += 1) await (await view(`GUESS${i}`)).text();
  const last = await (await view('LV10')).text();
  assert.match(last, /\$10\.00/, 'the twentieth try still works');
  const limited = await (await view('LV10')).text();
  assert.match(limited, /a lot of voucher codes in a short time/);
  assert.doesNotMatch(limited, /Voucher LV10/);
});

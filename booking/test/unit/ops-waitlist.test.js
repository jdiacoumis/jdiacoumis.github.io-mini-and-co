// Admin waitlist (routes/admin-waitlist.js): offers create a 48-hour held
// booking and an email; withdraw / decline / remove release the seat; add a
// family by phone; and every route is admin-only with CSRF on each POST.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm, iso } from './helpers.js';
import {
  offerPlace, changeEntry, addToWaitlist, releaseOffer, describeOffer, loadEntry, registerRoutes, OFFER_HOLD_HOURS,
} from '../../src/routes/admin-waitlist.js';
import { createSession } from '../../src/lib/session.js';
import { HttpError } from '../../src/lib/http.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const run = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).run();
const one = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).first();
const count = async (sql, ...binds) => (await one(sql, ...binds)).n;

async function entry(id, fam, childIndex, { status = 'waiting', joinedAt = iso(Date.now()), note = '' } = {}) {
  await run(`INSERT INTO waitlist (id, term_id, user_id, child_id, status, note, joined_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    id, fam.termId, fam.userId, fam.childIds[childIndex], status, note, joinedAt);
  return id;
}

async function seatsHeld(sessionId) {
  return count(`SELECT COUNT(*) AS n FROM booking_sessions bs JOIN bookings b ON b.id = bs.booking_id
                WHERE bs.session_id = ?1 AND bs.status = 'booked'
                  AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.expires_at > ?2))`, sessionId, iso(Date.now()));
}

test('offering the rest of the term holds every remaining week for 48 hours and emails the family', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'wo', children: 2, capacity: 2 });
  await run(`UPDATE users SET name = 'Wendy' WHERE id = ?1`, fam.userId);
  await run(`UPDATE children SET medical_notes = 'Egg allergy', photo_consent = 1 WHERE id = ?1`, fam.childIds[0]);
  await entry('wo-1', fam, 0);
  const now = iso(Date.now());

  const result = await offerPlace(env, { entryId: 'wo-1', kind: 'term', now });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.amountCents, 16800);
  assert.equal(result.expiresAt, iso(Date.parse(now) + OFFER_HOLD_HOURS * 3600e3));
  assert.equal(result.emailed, true);

  const booking = await one(`SELECT * FROM bookings WHERE id = ?1`, result.bookingId);
  assert.equal(booking.status, 'pending');
  assert.equal(booking.kind, 'term');
  assert.equal(booking.expires_at, result.expiresAt);
  assert.equal(booking.payment_method, 'full');
  assert.equal(booking.medical_notes_snapshot, 'Egg allergy', 'the roster gets the current notes');
  assert.equal(booking.photo_consent_snapshot, 1);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM booking_sessions WHERE booking_id = ?1`, result.bookingId), 6);
  assert.equal(await seatsHeld(fam.sessionIds[0]), 1);

  const row = await loadEntry(env, 'wo-1');
  assert.equal(row.status, 'offered');
  assert.equal(row.offer_booking_id, result.bookingId);
  assert.equal(row.offer_expires_at, result.expiresAt);

  const log = await one(`SELECT template, user_id, booking_id, term_id FROM email_log WHERE dedupe_key = ?1`,
    `waitlist_offer:wo-1:${result.bookingId}`);
  assert.deepEqual(log, { template: 'waitlist_offer', user_id: fam.userId, booking_id: result.bookingId, term_id: fam.termId });
  const mail = await one(`SELECT subject, body_text FROM dev_emails WHERE to_email = 'wo@example.com'`);
  assert.equal(mail.subject, 'A place has opened up for Child 0 — Test Term');
  assert.ok(mail.body_text.startsWith('Hi Wendy,'));
  assert.ok(mail.body_text.includes('the rest of the term — 6 weeks'));
  assert.ok(mail.body_text.includes('Pay now ($168.00)'));

  // A second offer to the same entry (double click) is refused, nothing new held.
  const again = await offerPlace(env, { entryId: 'wo-1', kind: 'term', now });
  assert.deepEqual([again.ok, again.error], [false, 'not_waiting']);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM bookings WHERE child_id = ?1`, fam.childIds[0]), 1);
});

test('trial and chosen-week offers: trial price, edited price, credit, and full weeks refused', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'wt', children: 3, capacity: 1, trialPrice: 2500 });
  await entry('wt-trial', fam, 0);
  await entry('wt-weeks', fam, 1);
  await entry('wt-full', fam, 2);
  const [s1, s2, s3] = fam.sessionIds;

  const trial = await offerPlace(env, { entryId: 'wt-trial', kind: 'trial', sessionIds: [s1] });
  assert.equal(trial.ok, true, JSON.stringify(trial));
  assert.equal(trial.amountCents, 2500, 'the term trial price');
  assert.equal((await one(`SELECT kind FROM bookings WHERE id = ?1`, trial.bookingId)).kind, 'trial');

  await run(`INSERT INTO credits (id, user_id, amount_cents, remaining_cents, issued_at) VALUES ('wt-credit', ?1, 1000, 1000, ?2)`,
    fam.userId, iso(Date.now()));
  const weeks = await offerPlace(env, { entryId: 'wt-weeks', kind: 'casual', sessionIds: [s2, s3], priceCents: 5000 });
  assert.equal(weeks.ok, true, JSON.stringify(weeks));
  assert.equal(weeks.amountCents, 4000, 'edited price $50, less $10 account credit');
  const held = await one(`SELECT list_amount_cents, credit_cents, kind FROM bookings WHERE id = ?1`, weeks.bookingId);
  assert.deepEqual(held, { list_amount_cents: 5000, credit_cents: 1000, kind: 'casual' });
  assert.equal((await one(`SELECT remaining_cents FROM credits WHERE id = 'wt-credit'`)).remaining_cents, 0);
  assert.ok((await one(`SELECT body_text FROM dev_emails WHERE subject LIKE '%Child 1%'`)).body_text.includes('2 classes:'));

  // Week 1 is now full (capacity 1): an offer including it is refused and the entry stays waiting.
  const full = await offerPlace(env, { entryId: 'wt-full', kind: 'casual', sessionIds: [s1] });
  assert.deepEqual([full.ok, full.error], [false, 'full']);
  assert.equal((await loadEntry(env, 'wt-full')).status, 'waiting');
  // A trial for a child who already had one is refused.
  await changeEntry(env, 'wt-trial', 'withdraw');
  await run(`UPDATE bookings SET status = 'confirmed' WHERE id = ?1`, trial.bookingId); // they booked a trial themselves
  const second = await offerPlace(env, { entryId: 'wt-trial', kind: 'trial', sessionIds: [fam.sessionIds[4]] });
  assert.deepEqual([second.ok, second.error], [false, 'trial_used']);
  assert.deepEqual([(await offerPlace(env, { entryId: 'wt-full', kind: 'nope' })).error], ['invalid_kind']);
  assert.equal((await offerPlace(env, { entryId: 'missing', kind: 'term' })).error, 'not_found');
});

test('withdraw, decline, remove and restore release the held seat and keep the line in order', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'wa', children: 3 });
  const joined = iso(Date.now() - 86400e3);
  await entry('wa-1', fam, 0, { joinedAt: joined });
  await entry('wa-2', fam, 1);
  await entry('wa-3', fam, 2);

  const first = await offerPlace(env, { entryId: 'wa-1', kind: 'term' });
  assert.equal(await seatsHeld(fam.sessionIds[0]), 1);
  const withdrawn = await changeEntry(env, 'wa-1', 'withdraw');
  assert.equal(withdrawn.ok, true);
  assert.equal(withdrawn.released, 'released');
  const back = await loadEntry(env, 'wa-1');
  assert.equal(back.status, 'waiting');
  assert.equal(back.offer_booking_id, null);
  assert.equal(back.joined_at, joined, 'keeps their place in line');
  assert.match(back.note, /Offer withdrawn/);
  assert.equal((await one(`SELECT status FROM bookings WHERE id = ?1`, first.bookingId)).status, 'expired');
  assert.equal(await seatsHeld(fam.sessionIds[0]), 0);

  const offer = await offerPlace(env, { entryId: 'wa-1', kind: 'term' });
  assert.equal((await changeEntry(env, 'wa-1', 'decline')).ok, true);
  assert.equal((await loadEntry(env, 'wa-1')).status, 'declined');
  assert.equal((await one(`SELECT status FROM bookings WHERE id = ?1`, offer.bookingId)).status, 'expired');
  assert.equal((await changeEntry(env, 'wa-1', 'decline')).error, 'unchanged', 'a double click changes nothing');

  const restored = await changeEntry(env, 'wa-1', 'restore');
  assert.equal(restored.ok, true);
  const again = await loadEntry(env, 'wa-1');
  assert.deepEqual([again.status, again.joined_at, again.offer_expires_at], ['waiting', joined, null]);

  assert.equal((await changeEntry(env, 'wa-2', 'remove')).ok, true);
  assert.equal((await loadEntry(env, 'wa-2')).status, 'removed');
  assert.equal((await changeEntry(env, 'wa-2', 'withdraw')).error, 'unchanged');
  assert.equal((await changeEntry(env, 'missing', 'remove')).error, 'not_found');
  await assert.rejects(changeEntry(env, 'wa-3', 'explode'), /Unknown waitlist action/);

  // The family paid just before the owner pressed decline: they stay booked.
  const paid = await offerPlace(env, { entryId: 'wa-3', kind: 'term' });
  await run(`UPDATE bookings SET status = 'confirmed' WHERE id = ?1`, paid.bookingId);
  const late = await changeEntry(env, 'wa-3', 'decline');
  assert.deepEqual([late.ok, late.error], [false, 'already_paid']);
  assert.equal((await loadEntry(env, 'wa-3')).status, 'booked');
  assert.equal(await releaseOffer(env, null), 'none');
});

test('adding a family by phone: new parent and child, existing child by name, re-joining at the back', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'wp' });
  const added = await addToWaitlist(env, {
    termId: fam.termId, email: ' New.Parent@Example.com ', parentName: 'Nina', phone: '0412 345 678',
    childName: 'Oscar', childDob: '2026-01-15', note: 'Can only do 11 am',
  });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.deepEqual([added.createdParent, added.createdChild, added.rejoined], [true, true, false]);
  const parent = await one(`SELECT name, phone, role FROM users WHERE email = 'new.parent@example.com'`);
  assert.deepEqual(parent, { name: 'Nina', phone: '0412345678', role: 'parent' });
  const row = await loadEntry(env, added.entryId);
  assert.deepEqual([row.status, row.child_name, row.note], ['waiting', 'Oscar', 'Can only do 11 am']);

  const dup = await addToWaitlist(env, { termId: fam.termId, email: 'new.parent@example.com', childName: 'oscar' });
  assert.deepEqual([dup.ok, dup.error], [false, 'already_listed']);
  assert.match(dup.message, /already on this waitlist \(waiting\)/);

  // An existing family is matched; their details are never changed here.
  const existing = await addToWaitlist(env, { termId: fam.termId, email: 'wp@example.com', parentName: 'Changed', childName: 'child 0' });
  assert.deepEqual([existing.ok, existing.createdParent, existing.createdChild], [true, false, false]);
  assert.equal((await one(`SELECT name FROM users WHERE id = ?1`, fam.userId)).name, '');
  const sibling = await addToWaitlist(env, { termId: fam.termId, email: 'wp@example.com', childName: 'Sprout', childDob: '2026-05-05' });
  assert.deepEqual([sibling.ok, sibling.createdParent, sibling.createdChild], [true, false, true]);
  assert.equal((await loadEntry(env, sibling.entryId)).user_id, fam.userId, 'a new child joins the existing family');

  assert.equal((await addToWaitlist(env, { termId: fam.termId, email: 'wp@example.com', childName: 'Newborn' })).error, 'dob_needed');
  assert.equal((await addToWaitlist(env, { termId: fam.termId, email: 'ghost@example.com', childName: 'Kid', childDob: '2099-01-01' })).error, 'invalid_dob');
  assert.equal(await count(`SELECT COUNT(*) AS n FROM users WHERE email = 'ghost@example.com'`), 0, 'nothing is written when validation fails');
  assert.equal((await addToWaitlist(env, { termId: fam.termId, email: 'wp@example.com', childName: 'Newborn', childDob: '2099-01-01' })).error, 'invalid_dob');
  assert.equal((await addToWaitlist(env, { termId: fam.termId, email: 'not-an-email', childName: 'X' })).error, 'invalid_email');
  assert.equal((await addToWaitlist(env, { termId: fam.termId, email: 'a@example.com', childName: '  ' })).error, 'invalid_child_name');
  assert.equal((await addToWaitlist(env, { termId: fam.termId, email: 'a@example.com', childName: 'X', phone: '12' })).error, 'invalid_phone');
  assert.equal((await addToWaitlist(env, { termId: 'no-such-term', email: 'a@example.com', childName: 'X' })).error, 'term_not_found');

  await changeEntry(env, added.entryId, 'remove');
  const rejoined = await addToWaitlist(env, { termId: fam.termId, email: 'new.parent@example.com', childName: 'Oscar' });
  assert.deepEqual([rejoined.ok, rejoined.rejoined, rejoined.entryId], [true, true, added.entryId]);
  const after = await loadEntry(env, added.entryId);
  assert.equal(after.status, 'waiting');
  assert.ok(after.joined_at >= row.joined_at, 'joins again at the back');
  assert.equal(after.note, 'Can only do 11 am', 'an empty note keeps the old one');
});

test('describeOffer reads naturally for each kind', () => {
  const s = (d) => ({ starts_at: `2027-02-${d}T00:00:00Z` });
  assert.match(describeOffer('term', [s('03'), s('10'), s('17')]), /^the rest of the term — 3 weeks, Wed,? 3 Feb 2027 to Wed,? 17 Feb 2027$/);
  assert.match(describeOffer('trial', [s('03')]), /^a trial class on Wed,? 3 Feb 2027, 11:00\s?am$/);
  assert.match(describeOffer('casual', [s('10'), s('03')]), /^2 classes: Wed,? 3 Feb 2027, Wed,? 10 Feb 2027$/);
  assert.equal(describeOffer('casual', []), '');
});

// --- Routes: admin only, CSRF on every POST, escaped output ---------------

const routes = [];
registerRoutes((method, pattern, handler) => routes.push({ method, pattern, handler }));

async function account(email) {
  const id = `acct-${email}`;
  await run(`INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?1, ?2, ?3)`, id, email, iso(Date.now()));
  const session = await createSession(env, id);
  return { cookie: `session=${session.sessionId}`, csrf: session.csrfToken };
}

function request(method, path, { cookie = null, form = null } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  return new Request(`http://localhost:8787${path}`, { method, headers, body: form ? new URLSearchParams(form).toString() : undefined });
}

async function outcome(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof Response || err instanceof HttpError) return err;
    throw err;
  }
}

test('every waitlist route is admin-only, and every POST needs the CSRF token', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'wr' });
  await entry('wr-1', fam, 0);
  const parent = await account('wr-parent@example.com');
  const admin = await account('owner@example.com');
  assert.equal(routes.length, 8);
  for (const r of routes) {
    const path = r.pattern.replace(':id', 'wr-1');
    const params = { id: 'wr-1' };
    const anon = await outcome(r.handler(request(r.method, path, { form: r.method === 'POST' ? {} : null }), env, params));
    assert.ok(anon instanceof Response && anon.status === 303 && anon.headers.get('Location').startsWith('/auth/request-magic-link'),
      `${r.method} ${r.pattern} signed out`);
    const denied = await outcome(r.handler(request(r.method, path, { cookie: parent.cookie, form: r.method === 'POST' ? { csrf: parent.csrf } : null }), env, params));
    assert.ok(denied instanceof HttpError && denied.status === 403, `${r.method} ${r.pattern} as a parent`);
    if (r.method === 'POST') {
      const forged = await outcome(r.handler(request('POST', path, { cookie: admin.cookie, form: { csrf: 'wrong' } }), env, params));
      assert.ok(forged instanceof HttpError && forged.status === 403, `${r.pattern} without CSRF`);
    }
  }
  assert.equal((await loadEntry(env, 'wr-1')).status, 'waiting', 'nothing changed');
});

test('the waitlist page lists entries in join order, escaped, with offer and message links', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'wv', children: 2 });
  await run(`UPDATE children SET name = '<script>alert(1)</script>' WHERE id = ?1`, fam.childIds[1]);
  await entry('wv-2', fam, 1, { joinedAt: iso(Date.now() - 1000), note: '<b>note</b>' });
  await entry('wv-1', fam, 0, { joinedAt: iso(Date.now() - 2000) });
  const admin = await account('owner@example.com');
  const page = routes.find((r) => r.method === 'GET' && r.pattern === '/admin/waitlist');
  const res = await page.handler(request('GET', `/admin/waitlist?term=${fam.termId}`, { cookie: admin.cookie }), env, {});
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.ok(body.indexOf('Child 0') < body.indexOf('&lt;script&gt;'), 'join order');
  assert.ok(!body.includes('<script>alert(1)</script>') && !body.includes('<b>note</b>'));
  assert.ok(body.includes('href="/admin/waitlist/wv-1/offer"'));
  assert.ok(body.includes(`href="/admin/email?audience=waitlist&amp;term=${fam.termId}"`));
  assert.ok(body.includes('12 places free for the rest of the term'));
  assert.ok(body.includes('2 families waiting'));

  // The offer page works out the price, and posting it makes the offer.
  const offerPage = routes.find((r) => r.method === 'GET' && r.pattern === '/admin/waitlist/:id/offer');
  const quote = await offerPage.handler(request('GET', '/admin/waitlist/wv-1/offer?kind=term', { cookie: admin.cookie }), env, { id: 'wv-1' });
  const quoteBody = await quote.text();
  assert.equal(quote.status, 200);
  for (const page of [body, quoteBody]) {
    assert.ok(!/\bundefined\b|\bnull\b|\[object /.test(page.replace(/<[^>]*>/g, ' ')), 'no rendering artefacts');
  }
  assert.ok(quoteBody.includes('name="price" value="168.00"'));
  assert.ok(quoteBody.includes('The family pays'));
  const send = routes.find((r) => r.method === 'POST' && r.pattern === '/admin/waitlist/:id/offer');
  const bad = await send.handler(request('POST', '/admin/waitlist/wv-1/offer', { cookie: admin.cookie, form: { csrf: admin.csrf, kind: 'term', price: 'lots' } }), env, { id: 'wv-1' });
  assert.equal(bad.status, 400);
  const made = await send.handler(request('POST', '/admin/waitlist/wv-1/offer', { cookie: admin.cookie, form: { csrf: admin.csrf, kind: 'term', price: '150' } }), env, { id: 'wv-1' });
  assert.equal(made.status, 303);
  assert.equal(made.headers.get('Location'), `/admin/waitlist?term=${fam.termId}&ok=offered`);
  const offered = await loadEntry(env, 'wv-1');
  assert.equal(offered.status, 'offered');
  assert.equal(offered.offer_amount_cents, 15000);
  const repeat = await send.handler(request('POST', '/admin/waitlist/wv-1/offer', { cookie: admin.cookie, form: { csrf: admin.csrf, kind: 'term', price: '150' } }), env, { id: 'wv-1' });
  assert.equal(repeat.status, 409, 'a resubmitted offer is refused');

  const add = routes.find((r) => r.method === 'POST' && r.pattern === '/admin/waitlist/add');
  const missing = await add.handler(request('POST', '/admin/waitlist/add', { cookie: admin.cookie, form: { csrf: admin.csrf, term: fam.termId, email: 'x@example.com', child_name: 'Zed' } }), env, {});
  assert.equal(missing.status, 400);
  assert.ok((await missing.text()).includes('please add their date of birth'));
});

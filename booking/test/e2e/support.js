// Shared helpers for the cross-feature journeys (journeys/x-*.js), which run
// last and cross the Phase 2 areas: parent flow, admin operations, waitlist,
// comms and cron. Not a journey itself — the runner only loads
// test/e2e/journeys/*.js.
//
// Every x-journey builds its own classes, terms and families (ids and email
// addresses start with "x-"), so it never depends on another journey's data,
// and its checks look only at its own rows — the scheduled jobs it triggers
// also process everything earlier journeys left behind.

import { createHash, randomBytes } from 'node:crypto';

export const ADMIN = 'miniandco.classes@gmail.com'; // ADMIN_EMAILS (and EMAIL_REPLY_TO) in .dev.vars
export const STAFF = 'facilitator@example.com'; // STAFF_EMAILS in .dev.vars

export const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";
const offset = (n, unit) => `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '${n >= 0 ? '+' : ''}${n} ${unit}')`;
export const inDays = (n) => offset(n, 'days');
export const inHours = (n) => offset(n, 'hours');
export const inMinutes = (n) => offset(n, 'minutes');

export const q = (value) => `'${String(value).replace(/'/g, "''")}'`;

// The owner's session. The owner's address may request only three sign-in
// links an hour, so the whole run shares ONE (ctx.adminCookie, also used by
// the admin-* journeys).
export async function ownerSession(ctx) {
  if (!ctx.adminCookie) ctx.adminCookie = await ctx.signIn(ADMIN);
  return { cookie: ctx.adminCookie, csrf: await ctx.csrfFor(ctx.adminCookie) };
}

// A web session minted directly in the database (sign-in itself is covered by
// core-20/core-40/admin-10) — used for the facilitator, whose address also has
// the three-links-an-hour limit and already signs in twice per run.
export function mintedSession(ctx, email) {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  ctx.sqlWrite(`INSERT OR IGNORE INTO users (id, email, created_at) VALUES (${q(randomBytes(16).toString('hex'))}, ${q(email)}, ${NOW})`);
  ctx.sqlWrite(`INSERT INTO web_sessions (session_hash, user_id, csrf_token, created_at, expires_at)
                SELECT ${q(hash)}, id, ${q(csrf)}, ${NOW}, ${inDays(1)} FROM users WHERE email = ${q(email)}`);
  return { cookie: `session=${token}`, csrf };
}

// A parent who signs in (magic link) and adds one child.
export async function family(ctx, email, childName, { dob = '2026-01-15', consent = 'yes', medical = '' } = {}) {
  const cookie = await ctx.signIn(email);
  const csrf = await ctx.csrfFor(cookie);
  await ctx.fetch('/account/children/new', {
    method: 'POST', cookie, body: { csrf, name: childName, dob, medical, photo_consent: consent },
  });
  const [user] = ctx.sql(`SELECT id FROM users WHERE email = ${q(email)}`);
  const [child] = ctx.sql(`SELECT id FROM children WHERE user_id = ${q(user.id)} AND name = ${q(childName)}`);
  return { email, cookie, csrf, userId: user.id, childId: child.id, childName };
}

// A class (one weekly slot) with a term of `weeks` weekly sessions, written
// straight into the database (creating terms through the admin pages is
// covered by admin-10). Sessions start `startInDays` from now at `utcTime`
// (01:00Z and 03:00Z fall on the same calendar day in Sydney); the class's
// weekday is that day's, so the admin pages (re-run, add week) accept it.
export function createTerm(ctx, key, {
  className = `X ${key}`, utcTime = '01:00', localTime = '11:00', weeks = 4, startInDays = 3, capacity = 12,
  termPriceCents = 12000, casualPriceCents = 3000, trialPriceCents = null, returningPriceCents = null,
  planInstalments = 0, status = 'open', previousTermId = null, publicOpensAt = null, termName = `X Term ${key}`,
  classId = null,
} = {}) {
  const cls = classId || `x-cls-${key}`;
  if (!classId) {
    ctx.sqlWrite(`INSERT INTO classes (id, name, description, venue, age_range, weekday, start_time, default_duration_mins,
                                       default_capacity, active, created_at)
                  VALUES (${q(cls)}, ${q(className)}, 'Cross-feature e2e class.', 'Test Hall', '3–12 months',
                          CAST(strftime('%w', 'now', '+${startInDays} days') AS INTEGER), ${q(localTime)}, 45, ${capacity}, 1, ${NOW})`);
  }
  const termId = `x-term-${key}`;
  const sql = (v) => (v === null || v === undefined ? 'NULL' : v);
  ctx.sqlWrite(`INSERT INTO terms (id, class_id, name, starts_on, ends_on, term_price_cents, casual_price_cents,
                                   trial_price_cents, returning_price_cents, public_opens_at, previous_term_id,
                                   plan_instalments, plan_interval, status, created_at)
                VALUES (${q(termId)}, ${q(cls)}, ${q(termName)}, date('now', '+${startInDays} days'),
                        date('now', '+${startInDays + 7 * (weeks - 1)} days'), ${termPriceCents}, ${casualPriceCents},
                        ${sql(trialPriceCents)}, ${sql(returningPriceCents)}, ${publicOpensAt ? q(publicOpensAt) : 'NULL'},
                        ${previousTermId ? q(previousTermId) : 'NULL'}, ${planInstalments}, 'week', ${q(status)}, ${NOW})`);
  const sessionIds = [];
  for (let w = 0; w < weeks; w += 1) {
    const id = `${termId}-w${w + 1}`;
    sessionIds.push(id);
    ctx.sqlWrite(`INSERT INTO class_sessions (id, class_id, term_id, starts_at, duration_mins, capacity, casual_price_cents,
                                              status, created_at)
                  VALUES (${q(id)}, ${q(cls)}, ${q(termId)},
                          strftime('%Y-%m-%dT${utcTime}:00Z', 'now', '+${startInDays + 7 * w} days'),
                          45, ${capacity}, ${casualPriceCents}, 'scheduled', ${NOW})`);
  }
  return { classId: cls, termId, sessionIds };
}

// POST /book/checkout for a family (waiver accepted, consent answered).
export function checkout(ctx, fam, { kind = 'term', termId = null, sessionIds = [], payment = 'full', voucher = '' } = {}) {
  return ctx.fetch('/book/checkout', {
    method: 'POST', cookie: fam.cookie,
    body: {
      csrf: fam.csrf, kind, term: termId || undefined, session: sessionIds, child: fam.childId, photo_consent: 'yes',
      medical: '', waiver: 'accepted', payment, voucher: voucher || undefined,
    },
  });
}

// The booking id and checkout ref in a hosted-checkout (mock) redirect.
export function hosted(location) {
  return {
    bookingId: /booking=([A-Za-z0-9-]+)/.exec(location || '')?.[1] || null,
    ref: /ref=([A-Za-z0-9_]+)/.exec(location || '')?.[1] || null,
  };
}

// Pay on the mock hosted page (the dev stand-in for Stripe Checkout).
export function payHosted(ctx, fam, location, outcome = 'pay') {
  const { bookingId, ref } = hosted(location);
  return ctx.fetch('/dev/mock-checkout', { method: 'POST', cookie: fam.cookie, body: { csrf: fam.csrf, booking: bookingId, ref, outcome } });
}

// Book (checkout) and pay in one go. Returns the booking id.
export async function bookAndPay(ctx, fam, options) {
  const started = await checkout(ctx, fam, options);
  if (started.status !== 303 || !started.location.includes('/dev/mock-checkout')) {
    throw new Error(`checkout did not reach the hosted page (HTTP ${started.status}) ${started.location} ${started.text.slice(0, 200)}`);
  }
  await payHosted(ctx, fam, started.location);
  return hosted(started.location).bookingId;
}

export async function waitFor(ready, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await ready()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return ready();
}

// Run the Worker's scheduled() handler and wait until its jobs have finished.
// scheduled() works in waitUntil, after the HTTP response, so each run plants
// a waitlist entry whose offer is already paid: reconcileWaitlist — the last
// job — marks it booked. (The sentinel booking holds no seat.)
export function cronRunner(ctx, key) {
  const user = `x-cron-${key}-u`;
  const term = `x-cron-${key}-t`;
  ctx.sqlWrite(`INSERT INTO users (id, email, created_at) VALUES (${q(user)}, ${q(`x-cron-${key}@example.com`)}, ${NOW})`);
  ctx.sqlWrite(`INSERT INTO terms (id, class_id, name, starts_on, ends_on, term_price_cents, casual_price_cents, status, created_at)
                VALUES (${q(term)}, 'cls-wed-11', ${q(`X cron sentinel ${key}`)}, date('now'), date('now'), 0, 0, 'draft', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO children (id, user_id, name, dob, created_at) VALUES (${q(`${user}-c0`)}, ${q(user)}, 'Sentinel', '2026-01-01', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, amount_cents, created_at)
                VALUES (${q(`${user}-b`)}, ${q(user)}, ${q(`${user}-c0`)}, 'complimentary', ${q(term)}, 'confirmed', 0, ${NOW})`);
  let runs = 0;
  return async () => {
    runs += 1;
    const child = `${user}-c${runs}`;
    const entry = `${user}-w${runs}`;
    ctx.sqlWrite(`INSERT INTO children (id, user_id, name, dob, created_at) VALUES (${q(child)}, ${q(user)}, 'Sentinel', '2026-01-01', ${NOW})`);
    ctx.sqlWrite(`INSERT INTO waitlist (id, term_id, user_id, child_id, status, joined_at, offer_booking_id)
                  VALUES (${q(entry)}, ${q(term)}, ${q(user)}, ${q(child)}, 'offered', ${NOW}, ${q(`${user}-b`)})`);
    const status = await ctx.runCron();
    const finished = await waitFor(() => ctx.sql(`SELECT status FROM waitlist WHERE id = ${q(entry)}`)[0].status === 'booked');
    if (status !== 200 || !finished) throw new Error(`scheduled() run ${runs} did not finish (HTTP ${status})`);
    return true;
  };
}

// A booking row and its seat count by the one held-seat definition.
export function bookingRow(ctx, id) {
  return ctx.sql(`SELECT * FROM bookings WHERE id = ${q(id)}`)[0];
}

export function seatsHeld(ctx, sessionId) {
  return ctx.sql(`SELECT COUNT(*) AS n FROM booking_sessions bs JOIN bookings b ON b.id = bs.booking_id
                  WHERE bs.session_id = ${q(sessionId)} AND bs.status = 'booked'
                    AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.expires_at > ${NOW}))`)[0].n;
}

export function ledger(ctx, bookingId) {
  return ctx.sql(`SELECT kind, amount_cents, provider_ref FROM payments WHERE booking_id = ${q(bookingId)} ORDER BY paid_at, created_at`);
}

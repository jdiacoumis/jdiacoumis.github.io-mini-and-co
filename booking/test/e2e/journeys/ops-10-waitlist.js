// Waitlist admin end to end (waitlist spec, design D7): the owner adds two
// families by phone, offers the rest of the term (held pending booking +
// email), the offer lapses through the real scheduled() handler and the
// family is back in line with the seat free; chosen weeks are offered and
// marked declined (seat released) and put back; a paid offer shows booked.
// Uses its own draft term so nothing appears on the public class list.

import { createHash, randomBytes } from 'node:crypto';

export const title = 'Ops: waitlist offers, lapse, decline';

const ADMIN = 'miniandco.classes@gmail.com'; // ADMIN_EMAILS in .dev.vars

// The owner's address may request only 3 sign-in links an hour (auth rate
// limit) and other journeys sign in as the owner too, so this journey mints
// the owner's web session directly. Sign-in itself is covered by core-20/50.
function ownerSession(ctx) {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  ctx.sqlWrite(`INSERT OR IGNORE INTO users (id, email, name, role, created_at)
                VALUES ('${randomBytes(16).toString('hex')}', '${ADMIN}', 'Owner', 'admin', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`);
  ctx.sqlWrite(`INSERT INTO web_sessions (session_hash, user_id, csrf_token, created_at, expires_at)
                SELECT '${hash}', id, '${csrf}', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+1 days')
                FROM users WHERE email = '${ADMIN}'`);
  return { cookie: `session=${token}`, csrf };
}
const PARENT_A = 'e2e-ops-wl-a@example.com';
const PARENT_B = 'e2e-ops-wl-b@example.com';
const TERM = 'ops-term-wl';
const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`;

// Poll the database until `ready()` is true (scheduled() work runs in waitUntil).
async function waitFor(ready, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (ready()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return ready();
}

export async function run(ctx) {
  ctx.sqlWrite(`INSERT INTO terms (id, class_id, name, starts_on, ends_on, term_price_cents, casual_price_cents,
                                   trial_price_cents, plan_instalments, status, created_at)
                VALUES ('${TERM}', 'cls-wed-13', 'Ops Waitlist Term', date('now', '+40 days'), date('now', '+54 days'),
                        9000, 3000, 2500, 0, 'draft', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO class_sessions (id, class_id, term_id, starts_at, duration_mins, capacity, casual_price_cents, status, created_at) VALUES
                ('ops-wl-s1', 'cls-wed-13', '${TERM}', strftime('%Y-%m-%dT03:00:00Z', 'now', '+40 days'), 45, 2, 3000, 'scheduled', ${NOW}),
                ('ops-wl-s2', 'cls-wed-13', '${TERM}', strftime('%Y-%m-%dT03:00:00Z', 'now', '+47 days'), 45, 2, 3000, 'scheduled', ${NOW}),
                ('ops-wl-s3', 'cls-wed-13', '${TERM}', strftime('%Y-%m-%dT03:00:00Z', 'now', '+54 days'), 45, 2, 3000, 'scheduled', ${NOW})`);
  const seatsHeld = (sessionId) => ctx.sql(
    `SELECT COUNT(*) AS n FROM booking_sessions bs JOIN bookings b ON b.id = bs.booking_id
     WHERE bs.session_id = '${sessionId}' AND bs.status = 'booked'
       AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.expires_at > ${NOW}))`,
  )[0].n;
  const entryFor = (email) => ctx.sql(
    `SELECT w.id, w.status, w.note, w.offer_booking_id, w.offered_at, w.offer_expires_at, w.joined_at
     FROM waitlist w JOIN users u ON u.id = w.user_id WHERE w.term_id = '${TERM}' AND u.email = '${email}'`,
  )[0];

  const { cookie: admin, csrf } = ownerSession(ctx);

  ctx.section('Add families who rang');
  const addA = await ctx.fetch('/admin/waitlist/add', {
    method: 'POST', cookie: admin,
    body: { csrf, term: TERM, email: PARENT_A, parent_name: 'Ada', phone: '0412 345 678', child_name: 'Wren <b>', child_dob: '2026-03-01', note: 'Prefers 1 pm' },
  });
  ctx.check('a new family is added to the waitlist', addA.status === 303 && addA.location.includes('ok=added'), addA.location);
  await ctx.fetch('/admin/waitlist/add', {
    method: 'POST', cookie: admin, body: { csrf, term: TERM, email: PARENT_B, child_name: 'Arlo', child_dob: '2026-02-01' },
  });
  const dup = await ctx.fetch('/admin/waitlist/add', {
    method: 'POST', cookie: admin, body: { csrf, term: TERM, email: PARENT_A, child_name: 'wren <B>' },
  });
  ctx.check('the same child cannot be added twice', dup.status === 400 && dup.text.includes('already on this waitlist'));
  const list = await ctx.fetch(`/admin/waitlist?term=${TERM}`, { cookie: admin });
  ctx.check('the waitlist lists families in join order',
    list.status === 200 && list.text.indexOf('Wren &lt;b&gt;') > 0 && list.text.indexOf('Wren &lt;b&gt;') < list.text.indexOf('Arlo'));
  ctx.check('names are escaped, notes and contact details shown',
    !list.text.includes('Wren <b>') && list.text.includes('Prefers 1 pm') && list.text.includes('tel:0412345678'));
  ctx.check('the page links to messaging this waitlist', list.text.includes(`href="/admin/email?audience=waitlist&amp;term=${TERM}"`));
  ctx.check('seats for the rest of the term are shown', list.text.includes('2 places free for the rest of the term'));

  ctx.section('Offer the rest of the term');
  const a = entryFor(PARENT_A);
  const quote = await ctx.fetch(`/admin/waitlist/${a.id}/offer?kind=term`, { cookie: admin });
  ctx.check('the offer page works out the term price', quote.status === 200 && ctx.field(quote.text, 'price') === '90.00');
  const offer = await ctx.fetch(`/admin/waitlist/${a.id}/offer`, { method: 'POST', cookie: admin, body: { csrf, kind: 'term', price: '90.00' } });
  ctx.check('the offer is sent', offer.status === 303 && offer.location.includes('ok=offered'), offer.location);
  const offered = entryFor(PARENT_A);
  ctx.check('the entry is offered with a 48-hour hold',
    offered.status === 'offered' && Date.parse(offered.offer_expires_at) - Date.parse(offered.offered_at) === 48 * 3600 * 1000,
    JSON.stringify(offered));
  const [held] = ctx.sql(`SELECT status, kind, amount_cents, expires_at,
                                 (SELECT COUNT(*) FROM booking_sessions WHERE booking_id = b.id) AS weeks
                          FROM bookings b WHERE id = '${offered.offer_booking_id}'`);
  ctx.check('a pending booking holds every week until the offer deadline',
    held && held.status === 'pending' && held.kind === 'term' && held.amount_cents === 9000 && held.weeks === 3
      && held.expires_at === offered.offer_expires_at, JSON.stringify(held));
  ctx.check('the seat is held', seatsHeld('ops-wl-s1') === 1);
  const [mail] = await ctx.mailbox(PARENT_A);
  ctx.check('the family is emailed the offer',
    mail && mail.subject === 'A place has opened up for Wren <b> — Ops Waitlist Term'
      && mail.body.includes('Pay now ($90.00)') && mail.body.includes('/account'), mail && mail.subject);
  const again = await ctx.fetch(`/admin/waitlist/${a.id}/offer`, { method: 'POST', cookie: admin, body: { csrf, kind: 'term', price: '90.00' } });
  ctx.check('a resubmitted offer is refused', again.status === 409
    && ctx.sql(`SELECT COUNT(*) AS n FROM bookings WHERE child_id = (SELECT child_id FROM waitlist WHERE id = '${a.id}')`)[0].n === 1);
  const page = await ctx.fetch(`/admin/waitlist?term=${TERM}`, { cookie: admin });
  ctx.check('the list shows the offer and its deadline', page.text.includes('Offer sent') && page.text.includes('held until'));

  ctx.section('The offer lapses');
  ctx.sqlWrite(`UPDATE waitlist SET offer_expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 minutes') WHERE id = '${a.id}'`);
  ctx.sqlWrite(`UPDATE bookings SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 minutes') WHERE id = '${offered.offer_booking_id}'`);
  const cron = await ctx.runCron();
  ctx.check('the scheduled handler runs', cron === 200, `HTTP ${cron}`);
  const lapsed = await waitFor(() => entryFor(PARENT_A).status === 'waiting');
  const back = entryFor(PARENT_A);
  ctx.check('the lapsed offer is back to waiting, the lapse noted', lapsed && back.note.includes('Offer lapsed'), JSON.stringify(back));
  ctx.check('its booking expired and the seat is free',
    ctx.sql(`SELECT status FROM bookings WHERE id = '${offered.offer_booking_id}'`)[0].status === 'expired' && seatsHeld('ops-wl-s1') === 0);
  ctx.check('they keep their place in line', back.joined_at === a.joined_at);

  ctx.section('Offer chosen weeks, then mark declined');
  const b = entryFor(PARENT_B);
  const weeksQuote = await ctx.fetch(`/admin/waitlist/${b.id}/offer?kind=casual&session=ops-wl-s1&session=ops-wl-s2`, { cookie: admin });
  ctx.check('chosen weeks are priced at the casual price', ctx.field(weeksQuote.text, 'price') === '60.00');
  const weeks = await ctx.fetch(`/admin/waitlist/${b.id}/offer`, {
    method: 'POST', cookie: admin, body: [['csrf', csrf], ['kind', 'casual'], ['session', 'ops-wl-s1'], ['session', 'ops-wl-s2'], ['price', '50']],
  });
  ctx.check('the edited price is offered', weeks.status === 303
    && ctx.sql(`SELECT b.amount_cents FROM bookings b JOIN waitlist w ON w.offer_booking_id = b.id WHERE w.id = '${b.id}'`)[0].amount_cents === 5000);
  ctx.check('both weeks are held', seatsHeld('ops-wl-s1') === 1 && seatsHeld('ops-wl-s2') === 1 && seatsHeld('ops-wl-s3') === 0);
  const declined = await ctx.fetch(`/admin/waitlist/${b.id}/decline`, { method: 'POST', cookie: admin, body: { csrf } });
  const bAfter = entryFor(PARENT_B);
  ctx.check('marking declined releases the held seats', declined.status === 303 && bAfter.status === 'declined'
    && ctx.sql(`SELECT status FROM bookings WHERE id = '${bAfter.offer_booking_id}'`)[0].status === 'expired'
    && seatsHeld('ops-wl-s1') === 0 && seatsHeld('ops-wl-s2') === 0, JSON.stringify(bAfter));
  const earlier = await ctx.fetch(`/admin/waitlist?term=${TERM}`, { cookie: admin });
  ctx.check('declined families can be put back', earlier.text.includes(`/admin/waitlist/${b.id}/restore`));
  await ctx.fetch(`/admin/waitlist/${b.id}/restore`, { method: 'POST', cookie: admin, body: { csrf } });
  ctx.check('put back in line', entryFor(PARENT_B).status === 'waiting');

  ctx.section('A paid offer shows booked');
  const trial = await ctx.fetch(`/admin/waitlist/${a.id}/offer`, {
    method: 'POST', cookie: admin, body: [['csrf', csrf], ['kind', 'trial'], ['session', 'ops-wl-s3'], ['price', '25']],
  });
  const trialEntry = entryFor(PARENT_A);
  ctx.check('a trial class is offered', trial.status === 303 && trialEntry.status === 'offered'
    && ctx.sql(`SELECT kind FROM bookings WHERE id = '${trialEntry.offer_booking_id}'`)[0].kind === 'trial');
  // The family pays by a route that bypasses confirmBooking (e.g. a manual fix).
  ctx.sqlWrite(`UPDATE bookings SET status = 'confirmed', payment_status = 'paid' WHERE id = '${trialEntry.offer_booking_id}'`);
  await ctx.runCron();
  ctx.check('the entry becomes booked', await waitFor(() => entryFor(PARENT_A).status === 'booked'));

  ctx.section('Only the owner');
  const parent = await ctx.signIn(PARENT_B);
  const parentCsrf = await ctx.csrfFor(parent);
  ctx.check('a parent cannot open the waitlist admin', (await ctx.fetch('/admin/waitlist', { cookie: parent })).status === 403);
  const sneaky = await ctx.fetch(`/admin/waitlist/${b.id}/remove`, { method: 'POST', cookie: parent, body: { csrf: parentCsrf } });
  ctx.check('a parent cannot change an entry', sneaky.status === 403 && entryFor(PARENT_B).status === 'waiting');
  const forged = await ctx.fetch(`/admin/waitlist/${b.id}/remove`, { method: 'POST', cookie: admin, body: { csrf: 'forged' } });
  ctx.check('admin actions need the CSRF token', forged.status === 403 && entryFor(PARENT_B).status === 'waiting');
}

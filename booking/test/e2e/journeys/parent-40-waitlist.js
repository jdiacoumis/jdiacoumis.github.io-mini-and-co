// Parent waitlist (waitlist spec, D7): a full term offers its waitlist;
// families join for a child (one entry per child per term), see their place
// in line by join order on the waitlist page and the account, leave and
// re-join at the back; a term with places sends them to book instead.
// Offers (made by the owner — inserted here as the admin page would) are
// paid with Pay now, which marks the entry booked, or declined, which
// releases the held place and tells the owner.

export const title = 'Parent: waitlist join, place in line, leave, offers';

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";
const at = (days) => `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '${days} days')`;
const TERM = 'term-pf-wait';
const OWNER = 'miniandco.classes@gmail.com'; // ADMIN_EMAILS in .dev.vars

function createFullTerm(ctx) {
  ctx.sqlWrite(`INSERT INTO classes (id, name, description, venue, age_range, weekday, start_time, default_duration_mins,
                                     default_capacity, active, created_at)
                VALUES ('cls-pf-wait', 'PF Waitlist Class', 'An e2e class.', 'Test Hall', '3–12 months', 2, '10:00', 45, 1, 1, ${NOW})`);
  ctx.sqlWrite(`INSERT INTO terms (id, class_id, name, starts_on, ends_on, term_price_cents, casual_price_cents, plan_instalments,
                                   plan_interval, status, created_at)
                VALUES ('${TERM}', 'cls-pf-wait', 'Waitlist Term', date('now', '3 days'), date('now', '17 days'), 9000, 3000, 0, 'week', 'open', ${NOW})`);
  const rows = Array.from({ length: 3 }, (_, i) => `('${TERM}-w${i + 1}', 'cls-pf-wait', '${TERM}', ${at(3 + 7 * i)},
    45, 1, 3000, 'scheduled', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO class_sessions (id, class_id, term_id, starts_at, duration_mins, capacity, casual_price_cents, status, created_at)
                VALUES ${rows.join(', ')}`);
  ctx.sqlWrite(`INSERT INTO users (id, email, created_at) VALUES ('e2e-pf-wfill-user', 'e2e-pf-wfill@example.com', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO children (id, user_id, name, dob, created_at) VALUES ('e2e-pf-wfill-child', 'e2e-pf-wfill-user', 'Filler', '2025-09-01', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, amount_cents, created_at)
                VALUES ('e2e-pf-wfill-booking', 'e2e-pf-wfill-user', 'e2e-pf-wfill-child', 'term', '${TERM}', 'confirmed', 0, ${NOW})`);
  ctx.sqlWrite(`INSERT INTO booking_sessions (booking_id, session_id, status)
                SELECT 'e2e-pf-wfill-booking', id, 'booked' FROM class_sessions WHERE term_id = '${TERM}'`);
}

// A term with plenty of places.
function createOpenTerm(ctx) {
  ctx.sqlWrite(`INSERT INTO classes (id, name, description, venue, age_range, weekday, start_time, default_duration_mins,
                                     default_capacity, active, created_at)
                VALUES ('cls-pf-open', 'PF Open Class', 'An e2e class.', 'Test Hall', '3–12 months', 2, '13:00', 45, 12, 1, ${NOW})`);
  ctx.sqlWrite(`INSERT INTO terms (id, class_id, name, starts_on, ends_on, term_price_cents, casual_price_cents, plan_instalments,
                                   plan_interval, status, created_at)
                VALUES ('term-pf-open', 'cls-pf-open', 'Open Term', date('now', '3 days'), date('now', '17 days'), 9000, 3000, 0, 'week', 'open', ${NOW})`);
  const rows = Array.from({ length: 3 }, (_, i) => `('term-pf-open-w${i + 1}', 'cls-pf-open', 'term-pf-open', ${at(3 + 7 * i)},
    45, 12, 3000, 'scheduled', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO class_sessions (id, class_id, term_id, starts_at, duration_mins, capacity, casual_price_cents, status, created_at)
                VALUES ${rows.join(', ')}`);
  return 'term-pf-open';
}

async function family(ctx, email, childName) {
  const cookie = await ctx.signIn(email);
  const csrf = await ctx.csrfFor(cookie);
  await ctx.fetch('/account/children/new', {
    method: 'POST', cookie, body: { csrf, name: childName, dob: '2025-10-20', medical: '', photo_consent: 'yes' },
  });
  const [user] = ctx.sql(`SELECT id FROM users WHERE email = '${email}'`);
  const [child] = ctx.sql(`SELECT id FROM children WHERE user_id = '${user.id}'`);
  return { cookie, csrf, userId: user.id, childId: child.id };
}

const entry = (ctx, childId) => ctx.sql(`SELECT id, status, joined_at, note FROM waitlist WHERE term_id = '${TERM}' AND child_id = '${childId}'`);

// Owner side, as the admin waitlist page would do it: open a seat and hold
// it for this family for 48 hours.
function offer(ctx, fam, bookingId) {
  ctx.sqlWrite(`UPDATE class_sessions SET capacity = capacity + 1 WHERE term_id = '${TERM}'`);
  ctx.sqlWrite(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, list_amount_cents, amount_cents, payment_method,
                                      payment_status, created_at, expires_at)
                VALUES ('${bookingId}', '${fam.userId}', '${fam.childId}', 'term', '${TERM}', 'pending', 9000, 9000, 'full', 'unpaid', ${NOW}, ${at(2)})`);
  ctx.sqlWrite(`INSERT INTO booking_sessions (booking_id, session_id, status)
                SELECT '${bookingId}', id, 'booked' FROM class_sessions WHERE term_id = '${TERM}'`);
  ctx.sqlWrite(`UPDATE waitlist SET status = 'offered', offered_at = ${NOW}, offer_expires_at = ${at(2)}, offer_booking_id = '${bookingId}'
                WHERE term_id = '${TERM}' AND child_id = '${fam.childId}'`);
}

export async function run(ctx) {
  createFullTerm(ctx);
  const ada = await family(ctx, 'e2e-pf-wait-ada@example.com', 'Ada');
  const bo = await family(ctx, 'e2e-pf-wait-bo@example.com', 'Bo');

  ctx.section('Joining');
  const list = await ctx.fetch('/book', { cookie: ada.cookie });
  ctx.check('the full term offers its waitlist', list.text.includes(`href="/book/waitlist?term=${TERM}"`));
  const page = await ctx.fetch(`/book/waitlist?term=${TERM}`, { cookie: ada.cookie });
  ctx.check('the waitlist page asks which child to add',
    page.status === 200 && page.text.includes('This term is full') && page.text.includes(`name="child" value="${ada.childId}"`)
      && page.text.includes('booking-pixel.js'));
  const join = await ctx.fetch('/book/waitlist', { method: 'POST', cookie: ada.cookie, body: { csrf: ada.csrf, term: TERM, child: ada.childId } });
  ctx.check('joining confirms it', join.status === 303 && join.location === `/book/waitlist?term=${TERM}&ok=joined`, join.location);
  const joined = await ctx.fetch(join.location, { cookie: ada.cookie });
  ctx.check('the family sees its place in line', joined.text.includes('on the waitlist — we') && joined.text.includes('Ada</strong> is on the waitlist — first in line'));
  const twice = await ctx.fetch('/book/waitlist', { method: 'POST', cookie: ada.cookie, body: { csrf: ada.csrf, term: TERM, child: ada.childId } });
  ctx.check('one entry per child per term', twice.location.endsWith('ok=already') && entry(ctx, ada.childId).length === 1);

  await ctx.fetch('/book/waitlist', { method: 'POST', cookie: bo.cookie, body: { csrf: bo.csrf, term: TERM, child: bo.childId } });
  const boPage = await ctx.fetch(`/book/waitlist?term=${TERM}`, { cookie: bo.cookie });
  ctx.check('the next family is second in line', boPage.text.includes('Bo</strong> is on the waitlist — number 2 in line'));
  const boList = await ctx.fetch('/book', { cookie: bo.cookie });
  ctx.check('the class list shows the place in line', boList.text.includes('Bo is on the waitlist — number 2 in line'));
  const account = await ctx.fetch('/account', { cookie: ada.cookie });
  ctx.check('the account lists the waitlist place with Leave',
    account.text.includes('Waitlist Term') && account.text.includes('On the waitlist — first in line') && account.text.includes('Leave the waitlist'));
  ctx.check("another family's entries are not on this account", !account.text.includes('>Bo<'));

  ctx.section('Leaving and re-joining');
  const [adaEntry] = entry(ctx, ada.childId);
  const theirs = await ctx.fetch('/book/waitlist/leave', { method: 'POST', cookie: bo.cookie, body: { csrf: bo.csrf, entry: adaEntry.id } });
  ctx.check("another family can't remove the entry", theirs.status === 404 && entry(ctx, ada.childId)[0].status === 'waiting');
  const forged = await ctx.fetch('/book/waitlist/leave', { method: 'POST', cookie: ada.cookie, body: { csrf: 'forged', entry: adaEntry.id } });
  ctx.check('leaving requires the CSRF token', forged.status === 403);
  const leave = await ctx.fetch('/book/waitlist/leave', {
    method: 'POST', cookie: ada.cookie, body: { csrf: ada.csrf, entry: adaEntry.id, from: 'account' },
  });
  ctx.check('leaving returns to the account', leave.status === 303 && leave.location === '/account?ok=waitlist-left#waitlist', leave.location);
  ctx.check('the entry is marked as left', entry(ctx, ada.childId)[0].status === 'removed' && entry(ctx, ada.childId)[0].note.includes('Left the waitlist'));
  ctx.check('the next family moves up', (await ctx.fetch(`/book/waitlist?term=${TERM}`, { cookie: bo.cookie })).text.includes('Bo</strong> is on the waitlist — first in line'));
  await ctx.fetch('/book/waitlist', { method: 'POST', cookie: ada.cookie, body: { csrf: ada.csrf, term: TERM, child: ada.childId } });
  const rejoined = await ctx.fetch(`/book/waitlist?term=${TERM}`, { cookie: ada.cookie });
  ctx.check('re-joining goes to the back of the line',
    rejoined.text.includes('Ada</strong> is on the waitlist — number 2 in line') && entry(ctx, ada.childId)[0].status === 'waiting');

  ctx.section('A term with places');
  const openTerm = createOpenTerm(ctx);
  const open = await ctx.fetch(`/book/waitlist?term=${openTerm}`, { cookie: ada.cookie });
  ctx.check('a term with places sends the family to book', open.text.includes('no need to wait') && open.text.includes(`kind=term&amp;term=${openTerm}`));
  const notFull = await ctx.fetch('/book/waitlist', { method: 'POST', cookie: ada.cookie, body: { csrf: ada.csrf, term: openTerm, child: ada.childId } });
  ctx.check('and does not add a waitlist entry',
    notFull.location.endsWith('ok=places') && ctx.sql(`SELECT COUNT(*) AS n FROM waitlist WHERE term_id = '${openTerm}' AND child_id = '${ada.childId}'`)[0].n === 0);
  const strangersChild = await ctx.fetch('/book/waitlist', { method: 'POST', cookie: ada.cookie, body: { csrf: ada.csrf, term: TERM, child: bo.childId } });
  ctx.check("a family can't add someone else's child", strangersChild.status === 404);

  ctx.section('Offers');
  offer(ctx, bo, 'e2e-pf-offer-bo');
  const boAccount = await ctx.fetch('/account', { cookie: bo.cookie });
  ctx.check('an offer shows on the account with Pay now and a way to say no thanks',
    boAccount.text.includes('A place is being held for Bo') && boAccount.text.includes('href="/account/bookings/e2e-pf-offer-bo/pay"')
      && boAccount.text.includes('No thanks — release the place'));
  const [boEntry] = entry(ctx, bo.childId);
  const decline = await ctx.fetch('/book/waitlist/leave', {
    method: 'POST', cookie: bo.cookie, body: { csrf: bo.csrf, entry: boEntry.id, from: 'account' },
  });
  ctx.check('declining returns to the account', decline.status === 303 && decline.location === '/account?ok=offer-declined#waitlist');
  ctx.check('the entry is declined and the held place released',
    entry(ctx, bo.childId)[0].status === 'declined' && ctx.sql(`SELECT status FROM bookings WHERE id = 'e2e-pf-offer-bo'`)[0].status === 'expired');
  ctx.check('the owner is told the place is free again',
    (await ctx.mailbox(OWNER)).some((m) => m.subject.includes('Waitlist place declined') && m.body.includes("Bo's family")));

  offer(ctx, ada, 'e2e-pf-offer-ada');
  const pay = await ctx.fetch('/account/bookings/e2e-pf-offer-ada/pay', {
    method: 'POST', cookie: ada.cookie, body: { csrf: ada.csrf, payment: 'full', photo_consent: 'yes', medical: '', waiver: 'accepted' },
  });
  const ref = /ref=([A-Za-z0-9_]+)/.exec(pay.location)?.[1];
  await ctx.fetch('/dev/mock-checkout', { method: 'POST', cookie: ada.cookie, body: { csrf: ada.csrf, booking: 'e2e-pf-offer-ada', ref, outcome: 'pay' } });
  ctx.check('paying for an offer books the place and marks the entry booked',
    ctx.sql(`SELECT status FROM bookings WHERE id = 'e2e-pf-offer-ada'`)[0].status === 'confirmed' && entry(ctx, ada.childId)[0].status === 'booked');
  const adaAfter = await ctx.fetch('/account', { cookie: ada.cookie });
  ctx.check('the booked entry leaves the waitlist list', !adaAfter.text.includes('id="waitlist"'));

  ctx.sqlWrite(`UPDATE terms SET status = 'closed' WHERE id IN ('${TERM}', '${openTerm}')`);
}

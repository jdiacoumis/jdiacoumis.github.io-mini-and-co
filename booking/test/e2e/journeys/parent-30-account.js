// Account and Pay now (booking-flow spec "Pay-Later Pending Bookings", D7/D8):
// a place the owner held for the family (inserted here as the admin pages
// would) shows on the account and the class list with Pay now; checkout
// for it explains the hold; Pay now takes the waiver, starts the hosted
// checkout for the amount owed, expires any earlier checkout first, keeps
// the hold's own expiry, and confirms with the same seats. A held place can
// also be paid by instalments; backing out keeps the hold; a lapsed hold
// says so; another family gets a 404.

export const title = 'Parent: account, Pay now for held places, credit, isolation';

const EMAIL = 'e2e-pf-account@example.com';
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";
const at = (days) => `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '${days} days')`;

function createTerm(ctx, key, termName) {
  ctx.sqlWrite(`INSERT INTO classes (id, name, description, venue, age_range, weekday, start_time, default_duration_mins,
                                     default_capacity, active, created_at)
                VALUES ('cls-${key}', 'PF Held Class', 'An e2e class.', 'Test Hall', '3–12 months', 6, '09:00', 45, 12, 1, ${NOW})`);
  ctx.sqlWrite(`INSERT INTO terms (id, class_id, name, starts_on, ends_on, term_price_cents, casual_price_cents, plan_instalments,
                                   plan_interval, status, created_at)
                VALUES ('term-${key}', 'cls-${key}', '${termName}', date('now', '2 days'), date('now', '37 days'), 16800, 3000, 6, 'week', 'open', ${NOW})`);
  const rows = Array.from({ length: 6 }, (_, i) => `('term-${key}-w${i + 1}', 'cls-${key}', 'term-${key}', ${at(2 + 7 * i)},
    45, 12, 3000, 'scheduled', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO class_sessions (id, class_id, term_id, starts_at, duration_mins, capacity, casual_price_cents, status, created_at)
                VALUES ${rows.join(', ')}`);
  return `term-${key}`;
}

// A pending pay-later term booking, as an owner booking / offer / re-enrolment
// creates it: a seven-day hold, no waiver accepted yet.
function heldBooking(ctx, { id, userId, childId, termId, days = 7 }) {
  ctx.sqlWrite(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, list_amount_cents, amount_cents, payment_method,
                                      payment_status, created_at, expires_at)
                VALUES ('${id}', '${userId}', '${childId}', 'term', '${termId}', 'pending', 16800, 16800, 'full', 'unpaid',
                        ${NOW}, ${at(days)})`);
  ctx.sqlWrite(`INSERT INTO booking_sessions (booking_id, session_id, status)
                SELECT '${id}', id, 'booked' FROM class_sessions WHERE term_id = '${termId}'`);
}

const refOf = (location) => /ref=([A-Za-z0-9_]+)/.exec(location)?.[1];

export async function run(ctx) {
  const termId = createTerm(ctx, 'pf-held', 'Held Term');
  const cookie = await ctx.signIn(EMAIL);
  const csrf = await ctx.csrfFor(cookie);
  for (const name of ['Wren', 'Fern']) {
    await ctx.fetch('/account/children/new', {
      method: 'POST', cookie, body: { csrf, name, dob: '2025-11-01', medical: name === 'Wren' ? 'Egg allergy' : '', photo_consent: 'yes' },
    });
  }
  const [user] = ctx.sql(`SELECT id FROM users WHERE email = '${EMAIL}'`);
  const kids = Object.fromEntries(ctx.sql(`SELECT id, name FROM children WHERE user_id = '${user.id}'`).map((c) => [c.name, c.id]));
  heldBooking(ctx, { id: 'e2e-pf-held-1', userId: user.id, childId: kids.Wren, termId });

  ctx.section('A held place on the account and the class list');
  const account = await ctx.fetch('/account', { cookie });
  ctx.check('the account lists the held place with what to pay and Pay now',
    account.text.includes('To pay: $168.00') && account.text.includes('held for you until')
      && account.text.includes('href="/account/bookings/e2e-pf-held-1/pay"'));
  ctx.check('the account leads with the held place', account.text.includes('is held until') && account.text.indexOf('is held until') < account.text.indexOf('My bookings'));
  const list = await ctx.fetch('/book', { cookie });
  ctx.check('the class list shows the held place with Pay now',
    list.text.includes('place is held until') && list.text.includes('href="/account/bookings/e2e-pf-held-1/pay"'));
  const checkout = await ctx.fetch(`/book/checkout?kind=term&term=${termId}&child=${kids.Wren}`, { cookie });
  ctx.check('booking the same term again points to the held place',
    checkout.status === 409 && checkout.text.includes('place is already held') && checkout.text.includes('/account/bookings/e2e-pf-held-1/pay'));

  ctx.section('Pay now');
  const review = await ctx.fetch('/account/bookings/e2e-pf-held-1/pay', { cookie });
  ctx.check('Pay now shows the place, the amount, the instalment option and the waiver',
    review.status === 200 && review.text.includes('$168.00 AUD') && review.text.includes('Pay in 6 weekly instalments — $28.00 today')
      && review.text.includes('Waiver version') && review.text.includes('Egg allergy'));
  ctx.check('Pay now is not a funnel page (no pixel)', !review.text.includes('booking-pixel.js'));
  const noWaiver = await ctx.fetch('/account/bookings/e2e-pf-held-1/pay', { method: 'POST', cookie, body: { csrf, payment: 'full' } });
  ctx.check('Pay now needs the waiver and consent first', noWaiver.status === 400);
  const [{ expires_at: holdUntil }] = ctx.sql(`SELECT expires_at FROM bookings WHERE id = 'e2e-pf-held-1'`);

  const first = await ctx.fetch('/account/bookings/e2e-pf-held-1/pay', {
    method: 'POST', cookie, body: { csrf, payment: 'full', photo_consent: 'no', medical: 'Egg allergy', waiver: 'accepted' },
  });
  ctx.check('Pay now starts the hosted checkout', first.status === 303 && first.location.includes('/dev/mock-checkout?booking=e2e-pf-held-1'), first.location);
  const [snap] = ctx.sql(`SELECT waiver_version, photo_consent_snapshot, medical_notes_snapshot, payment_ref FROM bookings WHERE id = 'e2e-pf-held-1'`);
  ctx.check('the waiver and consent are snapshotted on the booking',
    snap.waiver_version && snap.photo_consent_snapshot === 0 && snap.medical_notes_snapshot === 'Egg allergy' && snap.payment_ref === refOf(first.location),
    JSON.stringify(snap));

  // The parent closes that tab and presses Pay now again.
  const again = await ctx.fetch('/account/bookings/e2e-pf-held-1/pay', { cookie });
  ctx.check('the second visit does not ask for the waiver again', again.status === 200 && !again.text.includes('Waiver version'));
  const second = await ctx.fetch('/account/bookings/e2e-pf-held-1/pay', { method: 'POST', cookie, body: { csrf, payment: 'full' } });
  ctx.check('a new checkout replaces the earlier one', second.status === 303 && refOf(second.location) && refOf(second.location) !== refOf(first.location));
  const old = await ctx.fetch('/dev/mock-checkout', {
    method: 'POST', cookie, body: { csrf, booking: 'e2e-pf-held-1', ref: refOf(first.location), outcome: 'pay' },
  });
  ctx.check('the earlier checkout can no longer take a payment', old.status === 409);
  ctx.check('the hold keeps its own expiry',
    ctx.sql(`SELECT expires_at, status FROM bookings WHERE id = 'e2e-pf-held-1'`)[0].expires_at === holdUntil);

  const hosted = await ctx.fetch(second.location, { cookie });
  ctx.check('the hosted page charges the amount owed', hosted.text.includes('Total: $168.00 AUD'));
  await ctx.fetch('/dev/mock-checkout', {
    method: 'POST', cookie, body: { csrf, booking: 'e2e-pf-held-1', ref: refOf(second.location), outcome: 'pay' },
  });
  const [paid] = ctx.sql(`SELECT status, payment_status, paid_cents,
                                 (SELECT COUNT(*) FROM booking_sessions WHERE booking_id = 'e2e-pf-held-1' AND status = 'booked') AS seats
                          FROM bookings WHERE id = 'e2e-pf-held-1'`);
  ctx.check('paying confirms the booking with the same six seats',
    paid.status === 'confirmed' && paid.payment_status === 'paid' && paid.paid_cents === 16800 && paid.seats === 6, JSON.stringify(paid));
  ctx.check('exactly one payment is in the ledger', ctx.sql(`SELECT COUNT(*) AS n FROM payments WHERE booking_id = 'e2e-pf-held-1'`)[0].n === 1);
  const confirm = await ctx.fetch('/book/confirm?booking=e2e-pf-held-1', { cookie });
  ctx.check('the confirmation page fires Purchase once', confirm.text.includes("You're booked in") && confirm.text.includes('data-pixel-purchase'));
  ctx.check('…and not again', !(await ctx.fetch('/book/confirm?booking=e2e-pf-held-1', { cookie })).text.includes('data-pixel-purchase'));
  ctx.check('the family gets the confirmation email',
    (await ctx.mailbox(EMAIL)).filter((m) => m.subject === 'Booking confirmed — see you soon, Wren!').length === 1);
  const paidAccount = await ctx.fetch('/account', { cookie });
  ctx.check('the account now shows it paid with the next class', paidAccount.text.includes('Next class:') && !paidAccount.text.includes('e2e-pf-held-1/pay'));
  const chooser = await ctx.fetch(`/book/checkout?kind=term&term=${termId}`, { cookie });
  ctx.check('the child chooser marks the child already booked in and offers the other',
    chooser.text.includes('Who is coming along?') && chooser.text.includes('is already booked in for this term')
      && chooser.text.includes(`child=${kids.Fern}`) && !chooser.text.includes(`child=${kids.Wren}`));

  ctx.section('Paying a held place by instalments');
  heldBooking(ctx, { id: 'e2e-pf-held-2', userId: user.id, childId: kids.Fern, termId });
  const plan = await ctx.fetch('/account/bookings/e2e-pf-held-2/pay', {
    method: 'POST', cookie, body: { csrf, payment: 'plan', photo_consent: 'yes', medical: '', waiver: 'accepted' },
  });
  const planHosted = await ctx.fetch(plan.location, { cookie });
  ctx.check('the plan checkout asks for the first instalment', planHosted.text.includes('Pay first instalment') && planHosted.text.includes('$28.00'));
  await ctx.fetch('/dev/mock-checkout', { method: 'POST', cookie, body: { csrf, booking: 'e2e-pf-held-2', ref: refOf(plan.location), outcome: 'pay' } });
  const [planRow] = ctx.sql(`SELECT status, payment_method, payment_status, plan_instalments, plan_instalment_cents, paid_cents
                             FROM bookings WHERE id = 'e2e-pf-held-2'`);
  ctx.check('the held place is confirmed on a six-week plan',
    planRow.status === 'confirmed' && planRow.payment_method === 'plan' && planRow.payment_status === 'plan_active'
      && planRow.plan_instalments === 6 && planRow.plan_instalment_cents === 2800 && planRow.paid_cents === 2800, JSON.stringify(planRow));
  ctx.check('the account shows the plan progress', (await ctx.fetch('/account', { cookie })).text.includes('Instalments: 1 of 6 paid'));

  ctx.section('Backing out, lapsed holds, other families');
  ctx.sqlWrite(`INSERT INTO children (id, user_id, name, dob, created_at) VALUES ('e2e-pf-ivy', '${user.id}', 'Ivy', '2025-10-01', ${NOW})`);
  heldBooking(ctx, { id: 'e2e-pf-held-3', userId: user.id, childId: 'e2e-pf-ivy', termId, days: 3 });
  const third = await ctx.fetch('/account/bookings/e2e-pf-held-3/pay', {
    method: 'POST', cookie, body: { csrf, payment: 'full', photo_consent: 'yes', medical: '', waiver: 'accepted' },
  });
  const cancelled = await ctx.fetch('/book/cancelled?booking=e2e-pf-held-3', { cookie });
  ctx.check('backing out of a held place keeps it', cancelled.text.includes('No money was taken') && cancelled.text.includes('still held'));
  const [kept] = ctx.sql(`SELECT status, payment_ref FROM bookings WHERE id = 'e2e-pf-held-3'`);
  ctx.check('the hold stays, without the abandoned checkout', kept.status === 'pending' && kept.payment_ref === null, JSON.stringify(kept));
  const late = await ctx.fetch('/dev/mock-checkout', { method: 'POST', cookie, body: { csrf, booking: 'e2e-pf-held-3', ref: refOf(third.location), outcome: 'pay' } });
  ctx.check('the abandoned checkout cannot be paid', late.status === 409);

  ctx.sqlWrite(`UPDATE bookings SET expires_at = ${at(-0.01)} WHERE id = 'e2e-pf-held-3'`);
  const lapsed = await ctx.fetch('/account/bookings/e2e-pf-held-3/pay', { cookie });
  ctx.check('a lapsed hold says the place is no longer held', lapsed.status === 409 && lapsed.text.includes('no longer held'));
  const lapsedPost = await ctx.fetch('/account/bookings/e2e-pf-held-3/pay', { method: 'POST', cookie, body: { csrf, payment: 'full' } });
  ctx.check('and cannot be paid', lapsedPost.status === 409);

  const stranger = await ctx.signIn('e2e-pf-account-stranger@example.com');
  const strangerCsrf = await ctx.csrfFor(stranger);
  const missing = await ctx.fetch('/account/bookings/00000000-0000-4000-8000-000000000000/pay', { cookie: stranger });
  const theirs = await ctx.fetch('/account/bookings/e2e-pf-held-1/pay', { cookie: stranger });
  ctx.check("another family can't open the Pay now page (same 404 as a missing id)",
    theirs.status === 404 && missing.status === 404 && theirs.text === missing.text);
  const theirsPost = await ctx.fetch('/account/bookings/e2e-pf-held-3/pay', { method: 'POST', cookie: stranger, body: { csrf: strangerCsrf } });
  ctx.check("another family can't pay for it", theirsPost.status === 404);
  const forged = await ctx.fetch('/account/bookings/e2e-pf-held-3/pay', { method: 'POST', cookie, body: { csrf: 'forged' } });
  ctx.check('Pay now requires the CSRF token', forged.status === 403);

  ctx.section('Money that arrived when the place could not be honoured');
  ctx.sqlWrite(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, list_amount_cents, amount_cents, paid_cents,
                                      payment_status, needs_attention, created_at, expires_at)
                VALUES ('e2e-pf-noseat', '${user.id}', 'e2e-pf-ivy', 'casual', 'term-dev-13', 'expired', 3000, 3000, 3000, 'paid',
                        'paid_no_seat', ${at(-1)}, ${at(-0.9)})`);
  ctx.sqlWrite(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, list_amount_cents, amount_cents, paid_cents,
                                      payment_status, needs_attention, created_at, cancelled_at)
                VALUES ('e2e-pf-latepay', '${user.id}', 'e2e-pf-ivy', 'casual', 'term-dev-13', 'cancelled', 3000, 3000, 3000, 'paid',
                        'paid_after_cancel', ${at(-1)}, ${at(-0.5)})`);
  const noSeat = await ctx.fetch('/book/confirm?booking=e2e-pf-noseat', { cookie });
  ctx.check('paid but no seat: the payment is acknowledged and Camila will be in touch',
    noSeat.status === 200 && noSeat.text.includes('received your payment') && noSeat.text.includes('Camila has been')
      && !/no (money|payment) (was|has been) taken/i.test(noSeat.text));
  const latePay = await ctx.fetch('/book/confirm?booking=e2e-pf-latepay', { cookie });
  ctx.check('paid after cancellation: acknowledged too',
    latePay.text.includes('received your payment') && latePay.text.includes('had been cancelled') && !/no (money|payment) (was|has been) taken/i.test(latePay.text));
  const backOut = await ctx.fetch('/book/cancelled?booking=e2e-pf-noseat', { cookie });
  ctx.check('the cancel page never claims no money was taken for it', backOut.status === 303 && backOut.location === '/book/confirm?booking=e2e-pf-noseat');
  const flagged = await ctx.fetch('/account', { cookie });
  ctx.check('the account shows the payment was received', (flagged.text.match(/Payment received<\/strong> — Camila will be in touch/g) || []).length === 2);

  ctx.section('Account credit and children');
  ctx.sqlWrite(`INSERT INTO credits (id, user_id, child_id, amount_cents, remaining_cents, reason, issued_by, issued_at, expires_at)
                VALUES ('e2e-pf-acc-credit', '${user.id}', '${kids.Wren}', 1200, 1200, 'Class cancelled', 'system', ${NOW}, ${at(60)})`);
  const final = await ctx.fetch('/account', { cookie });
  ctx.check('credit shows its balance, reason, child and expiry',
    final.text.includes('Balance: <strong>$12.00</strong>') && final.text.includes('Class cancelled') && final.text.includes('for Wren')
      && final.text.includes('use by'));
  ctx.check('children link to their profiles', final.text.includes(`href="/account/children/${kids.Wren}/edit"`)
    && final.text.includes('href="/account/children/new"'));
  ctx.check('cancelled and unfinished bookings are tucked away', final.text.includes('Cancelled and unfinished bookings (1)'));

  ctx.sqlWrite(`UPDATE terms SET status = 'closed' WHERE id = '${termId}'`);
}

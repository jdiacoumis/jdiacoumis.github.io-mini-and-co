// Cross-feature (Phase 3): a payment that arrives after the hold lapsed
// (design D6). Family A starts paying for the last place but the hold lapses
// (the cron sweeps it); family B takes the place and pays; A's payment then
// arrives (a delayed webhook). A is recorded as paid but flagged "paid, no
// seat" — B keeps the place, nothing is oversold — and the owner sees it in
// Needs attention (Check with Stripe changes nothing), gives A a credit,
// records the decision and marks it sorted. A's credit is then taken off A's
// next booking automatically.

import {
  ADMIN, ownerSession, family, createTerm, checkout, bookAndPay, hosted, cronRunner, bookingRow, seatsHeld,
  ledger, inMinutes, q,
} from '../support.js';

export const title = 'Cross-feature: late payment after the hold → paid_no_seat → credit';

export async function run(ctx) {
  const term = createTerm(ctx, 'late', { className: 'X Late Class', weeks: 3, startInDays: 6, capacity: 1 });
  const [lastSeat, laterWeek] = term.sessionIds;
  const cron = cronRunner(ctx, 'late');
  const { cookie: admin, csrf } = await ownerSession(ctx);
  const a = await family(ctx, 'x-late-a@example.com', 'Arlo');
  const b = await family(ctx, 'x-late-b@example.com', 'Bea');

  ctx.section("A's hold lapses");
  const startedA = await checkout(ctx, a, { kind: 'casual', termId: term.termId, sessionIds: [lastSeat] });
  const { bookingId: aId, ref: aRef } = hosted(startedA.location);
  ctx.check('A holds the last seat while paying', Boolean(aId) && seatsHeld(ctx, lastSeat) === 1);
  // 45 minutes pass: the hold (35 minutes) is over and the cron sweeps it.
  ctx.sqlWrite(`UPDATE bookings SET created_at = ${inMinutes(-45)}, expires_at = ${inMinutes(-10)} WHERE id = ${q(aId)}`);
  await cron();
  ctx.check('the sweep expires it and frees the seat', bookingRow(ctx, aId).status === 'expired' && seatsHeld(ctx, lastSeat) === 0);

  ctx.section('B takes the seat');
  const bId = await bookAndPay(ctx, b, { kind: 'casual', termId: term.termId, sessionIds: [lastSeat] });
  ctx.check('B is booked and paid', bookingRow(ctx, bId).status === 'confirmed' && seatsHeld(ctx, lastSeat) === 1);

  ctx.section("A's payment arrives late");
  const event = {
    id: `evt_x_late_${Date.now()}`, type: 'checkout.session.completed',
    data: { object: {
      id: aRef, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid',
      client_reference_id: aId, metadata: { booking_id: aId }, payment_intent: 'pi_x_late_a', amount_total: 3000, customer: null,
    } },
  };
  const hook = await ctx.fetch('/api/stripe/webhook', { method: 'POST', body: JSON.stringify(event), headers: { 'Content-Type': 'application/json' } });
  ctx.check('the webhook is accepted', hook.status === 200, `HTTP ${hook.status} ${hook.text}`);
  const aRow = bookingRow(ctx, aId);
  ctx.check('A is paid but flagged paid_no_seat, still without a seat', aRow.status === 'expired' && aRow.needs_attention === 'paid_no_seat'
    && aRow.paid_cents === 3000, JSON.stringify(aRow));
  ctx.check('the money is in the ledger once', JSON.stringify(ledger(ctx, aId).map((r) => [r.kind, r.amount_cents, r.provider_ref]))
    === JSON.stringify([['checkout', 3000, 'pi_x_late_a']]));
  ctx.check('B keeps the seat — nothing is oversold', bookingRow(ctx, bId).status === 'confirmed' && seatsHeld(ctx, lastSeat) === 1);
  const replay = await ctx.fetch('/api/stripe/webhook', { method: 'POST', body: JSON.stringify(event), headers: { 'Content-Type': 'application/json' } });
  ctx.check('a webhook retry is a replay', replay.status === 200 && replay.text.includes('replay') && ledger(ctx, aId).length === 1);
  ctx.check('the owner is alerted', ctx.sql(`SELECT COUNT(*) AS n FROM email_log WHERE template = 'owner_attention' AND booking_id = ${q(aId)}`)[0].n === 1);
  const confirmA = await ctx.fetch(`/book/confirm?booking=${aId}`, { cookie: a.cookie });
  ctx.check("A's page thanks them and says Camila will be in touch", confirmA.text.includes("we've received your payment")
    && confirmA.text.includes('will be in touch') && !confirmA.text.includes('No money was taken'));

  ctx.section('The owner sorts it out');
  const attention = await ctx.fetch('/admin/attention', { cookie: admin });
  ctx.check('Needs attention lists A with the reason', attention.status === 200 && attention.text.includes(`/admin/bookings/${aId}/resolve`)
    && attention.text.includes('Paid, but no seat was free'));
  const checked = await ctx.fetch(`/admin/bookings/${aId}/check`, { method: 'POST', cookie: admin, body: { csrf, back: 'attention' } });
  ctx.check('Check with Stripe confirms there is still no seat, and records nothing twice',
    checked.location === '/admin/attention?ok=check-paid-no-seat' && ledger(ctx, aId).length === 1 && seatsHeld(ctx, lastSeat) === 1, checked.location);
  const credit = await ctx.fetch(`/admin/customers/${a.userId}/credit`, {
    method: 'POST', cookie: admin, body: { csrf, amount: '30', child: a.childId, reason: 'Paid after the class filled', expires: '' },
  });
  ctx.check('a $30 credit is given to the family', credit.location.endsWith('ok=credit-issued')
    && ctx.sql(`SELECT amount_cents FROM credits WHERE user_id = ${q(a.userId)} AND reason = 'Paid after the class filled'`)[0]?.amount_cents === 3000);
  const cancelled = await ctx.fetch(`/admin/bookings/${aId}/cancel`, { method: 'POST', cookie: admin, body: { csrf, reason: 'No seat — credit given' } });
  ctx.check('the booking is closed as cancelled', cancelled.location.endsWith('ok=cancelled-ended') && bookingRow(ctx, aId).status === 'cancelled');
  const resolved = await ctx.fetch(`/admin/bookings/${aId}/resolve`, {
    method: 'POST', cookie: admin, body: { csrf, back: 'attention', note: 'Gave a $30 credit instead' },
  });
  const after = bookingRow(ctx, aId);
  ctx.check('the flag is cleared and the note kept', resolved.location.endsWith('ok=resolved') && after.needs_attention === null
    && after.admin_notes.includes('Gave a $30 credit instead'));
  ctx.check('Needs attention no longer lists it', !(await ctx.fetch('/admin/attention', { cookie: admin })).text.includes(`/admin/bookings/${aId}/resolve`));

  ctx.section("A's credit pays for the next class");
  const account = await ctx.fetch('/account', { cookie: a.cookie });
  ctx.check("A's account shows the credit", account.text.includes('Balance: <strong>$30.00</strong>'));
  const review = await ctx.fetch(`/book/checkout?kind=casual&term=${term.termId}&session=${laterWeek}&child=${a.childId}`, { cookie: a.cookie });
  ctx.check('checkout takes it off automatically', review.status === 200 && review.text.includes('Account credit applied'));
  const next = await checkout(ctx, a, { kind: 'casual', termId: term.termId, sessionIds: [laterWeek] });
  const nextId = /booking=([A-Za-z0-9-]+)/.exec(next.location)?.[1];
  const nextRow = bookingRow(ctx, nextId);
  ctx.check('fully covered: confirmed straight away with nothing to pay', next.status === 303 && next.location.startsWith('/book/confirm')
    && nextRow.status === 'confirmed' && nextRow.amount_cents === 0 && nextRow.credit_cents === 3000 && nextRow.payment_status === 'paid',
    JSON.stringify(nextRow));
  ctx.check('the ledger shows the credit applied and the credit is used',
    ledger(ctx, nextId).some((r) => r.kind === 'credit_applied' && r.amount_cents === 3000)
      && ctx.sql(`SELECT remaining_cents FROM credits WHERE user_id = ${q(a.userId)}`)[0].remaining_cents === 0);
  ctx.check('the owner was emailed nothing new about it', ctx.sql(`SELECT COUNT(*) AS n FROM email_log WHERE booking_id = ${q(nextId)} AND to_email = ${q(ADMIN)}`)[0].n === 0);
}

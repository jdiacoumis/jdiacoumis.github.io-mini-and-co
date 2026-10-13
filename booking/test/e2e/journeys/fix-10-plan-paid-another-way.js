// Review fix (task 3.2, finding 1, high): recording a cash/transfer payment
// on a live instalment plan used to leave the Stripe subscription billing —
// $224 taken for a $168 term, nothing flagged. A $168 term on 6 × $28: the
// first instalment is paid, the second fails, the family pays the remaining
// $140 by bank transfer and the owner records it. The plan is complete, the
// (mock) subscription is cancelled so no further instalment can be taken,
// the overdue flag clears, and the booking page says the plan has ended.
// While the plan was live the record-payment form warned the owner; Stop
// plan and Record refund are on the booking page.

import {
  ownerSession, family, createTerm, checkout, hosted, payHosted, bookingRow, ledger, q,
} from '../support.js';

export const title = 'Review fix: a plan paid off another way stops taking instalments';

export async function run(ctx) {
  const term = createTerm(ctx, 'fx-paid', { className: 'Fix Plan Class', weeks: 6, termPriceCents: 16800, planInstalments: 6 });
  const fam = await family(ctx, 'fix-plan@example.com', 'Juno');
  const { cookie: admin, csrf } = await ownerSession(ctx);
  const mock = (bookingId, outcome) => ctx.fetch('/dev/mock-checkout', {
    method: 'POST', cookie: fam.cookie, body: { csrf: fam.csrf, booking: bookingId, outcome },
  });

  ctx.section('A $168 term on six weekly instalments; the second fails');
  const started = await checkout(ctx, fam, { kind: 'term', termId: term.termId, payment: 'plan' });
  const { bookingId } = hosted(started.location);
  await payHosted(ctx, fam, started.location);
  let b = bookingRow(ctx, bookingId);
  ctx.check('first instalment paid', b.status === 'confirmed' && b.payment_status === 'plan_active' && b.paid_cents === 2800, JSON.stringify(b));
  const sub = b.stripe_subscription_id;
  ctx.check('the subscription was given its end date', ctx.sql(`SELECT cancel_at FROM dev_mock_subscriptions WHERE id = ${q(sub)}`)[0]?.cancel_at > 0);
  await mock(bookingId, 'instalment_failed');
  b = bookingRow(ctx, bookingId);
  ctx.check('the plan is overdue and flagged', b.payment_status === 'plan_overdue' && b.needs_attention === 'plan_overdue', JSON.stringify(b));

  ctx.section('The owner records the rest, paid by bank transfer');
  const page = await ctx.fetch(`/admin/bookings/${bookingId}`, { cookie: admin });
  ctx.check('the record-payment form warns that Stripe is still taking instalments',
    page.text.includes('Instalments are still being taken by card for this booking') && page.text.includes(`/admin/bookings/${bookingId}/stop-plan`));
  const nonce = new RegExp(`/admin/bookings/${bookingId}/record-payment"[\\s\\S]*?name="nonce" value="([^"]+)"`).exec(page.text)?.[1];
  const recorded = await ctx.fetch(`/admin/bookings/${bookingId}/record-payment`, {
    method: 'POST', cookie: admin, body: { csrf, nonce, amount: '140', method: 'bank transfer', note: 'Transfer 14 Oct' },
  });
  ctx.check('recorded: the plan is stopped because everything is paid', recorded.status === 303
    && recorded.location.includes('ok=payment-recorded-plan-stopped'), recorded.location);
  b = bookingRow(ctx, bookingId);
  ctx.check('complete, $168 received, nothing flagged, the end recorded',
    b.payment_status === 'plan_complete' && b.paid_cents === 16800 && b.needs_attention === null && Boolean(b.plan_ended_at)
      && b.plan_next_charge_at === null, JSON.stringify(b));
  ctx.check('the subscription is cancelled at the (mock) provider',
    ctx.sql(`SELECT status FROM dev_mock_subscriptions WHERE id = ${q(sub)}`)[0]?.status === 'canceled');
  const more = await mock(bookingId, 'instalment_paid');
  ctx.check('no further instalment can be taken', more.status === 409 && more.text.includes('has been stopped'));
  const money = ledger(ctx, bookingId);
  ctx.check('the ledger holds $168: one instalment and the transfer',
    money.length === 2 && money.reduce((sum, r) => sum + r.amount_cents, 0) === 16800, JSON.stringify(money));
  const after = await ctx.fetch(`/admin/bookings/${bookingId}?ok=payment-recorded-plan-stopped`, { cookie: admin });
  ctx.check('the booking page says the plan has ended and offers no Stop plan',
    after.text.includes('plan ended') && after.text.includes('the instalment plan has been stopped')
      && !after.text.includes(`/admin/bookings/${bookingId}/stop-plan`) && !after.text.includes('Instalments are still being taken'));
  ctx.check('a refund can be recorded from the booking page', after.text.includes(`/admin/bookings/${bookingId}/record-refund`));
  const account = await ctx.fetch('/account', { cookie: fam.cookie });
  ctx.check('the family sees it paid, with no "update your card"', account.text.includes('Paid') && !account.text.includes('Payment overdue'));
}

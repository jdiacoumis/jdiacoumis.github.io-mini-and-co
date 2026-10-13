// Payment plans (payment-plans spec, D4/D5): a term paid in six weekly
// instalments through the mock subscription checkout — first instalment at
// checkout, later ones simulated as Stripe invoice events through the same
// webhook processing; a failed instalment flags the booking without
// cancelling the place; the plan completes after the sixth.

export const title = 'Payment plans: instalments, failure, completion';

const EMAIL = 'e2e-plan@example.com';

async function mockAction(ctx, cookie, csrf, bookingId, outcome) {
  return ctx.fetch('/dev/mock-checkout', { method: 'POST', cookie, body: { csrf, booking: bookingId, outcome } });
}

function booking(ctx, id) {
  return ctx.sql(`SELECT status, payment_method, payment_status, paid_cents, needs_attention, plan_instalments,
                         plan_instalment_cents, plan_next_charge_at, stripe_subscription_id
                  FROM bookings WHERE id = '${id}'`)[0];
}

export async function run(ctx) {
  const cookie = await ctx.signIn(EMAIL);
  const csrf = await ctx.csrfFor(cookie);
  await ctx.fetch('/account/children/new', {
    method: 'POST', cookie, body: { csrf, name: 'Mia', dob: '2025-12-02', medical: '', photo_consent: 'no' },
  });

  ctx.section('Checkout with a plan');
  const review = await ctx.fetch('/book/checkout?kind=term&term=term-dev-13', { cookie });
  const childId = ctx.field(review.text, 'child');
  ctx.check('the schedule is shown before payment', review.text.includes('Pay in 6 weekly instalments — $28.00 today, then $28.00 each week')
    && review.text.includes('See the instalment dates'));
  const start = await ctx.fetch('/book/checkout', {
    method: 'POST', cookie,
    body: { csrf, kind: 'term', term: 'term-dev-13', child: childId, photo_consent: 'no', medical: '', waiver: 'accepted', payment: 'plan' },
  });
  ctx.check('plan checkout redirects to the hosted page', start.status === 303 && start.location.includes('/dev/mock-checkout'));
  const bookingId = /booking=([a-f0-9-]+)/.exec(start.location)?.[1];
  const ref = /ref=([A-Za-z0-9_]+)/.exec(start.location)?.[1];
  const pending = booking(ctx, bookingId);
  ctx.check('the pending booking snapshots the plan', pending.payment_method === 'plan' && pending.plan_instalments === 6
    && pending.plan_instalment_cents === 2800, JSON.stringify(pending));

  const mock = await ctx.fetch(start.location, { cookie });
  ctx.check('the hosted page asks for the first instalment', mock.text.includes('Pay first instalment') && mock.text.includes('$28.00'));
  const paid = await ctx.fetch('/dev/mock-checkout', { method: 'POST', cookie, body: { csrf, booking: bookingId, ref, outcome: 'pay' } });
  ctx.check('first instalment paid', paid.status === 303);

  const active = booking(ctx, bookingId);
  ctx.check('the booking is confirmed with the plan running',
    active.status === 'confirmed' && active.payment_status === 'plan_active' && active.paid_cents === 2800
      && active.stripe_subscription_id && active.plan_next_charge_at, JSON.stringify(active));
  const confirm = await ctx.fetch(`/book/confirm?booking=${bookingId}`, { cookie });
  ctx.check('confirmation shows the amount paid so far', confirm.text.includes('Paid so far: $28.00 of $168.00 AUD'));
  const mail = await ctx.mailbox(EMAIL);
  ctx.check('the confirmation email carries the instalment schedule',
    mail.some((m) => m.subject.startsWith('Booking confirmed') && m.body.includes('Payment plan: 6 weekly instalments')));

  ctx.section('Instalments');
  await mockAction(ctx, cookie, csrf, bookingId, 'instalment_paid');
  ctx.check('second instalment recorded', booking(ctx, bookingId).paid_cents === 5600);

  await mockAction(ctx, cookie, csrf, bookingId, 'instalment_failed');
  const overdue = booking(ctx, bookingId);
  ctx.check('a failed instalment marks the plan overdue and flags it',
    overdue.payment_status === 'plan_overdue' && overdue.needs_attention === 'plan_overdue', JSON.stringify(overdue));
  ctx.check('the place is kept', overdue.status === 'confirmed');
  const ownerMail = await ctx.mailbox('miniandco.classes@gmail.com');
  ctx.check('the owner is told about the failed instalment', ownerMail.some((m) => m.subject.includes('Instalment failed')));

  await mockAction(ctx, cookie, csrf, bookingId, 'instalment_paid');
  const recovered = booking(ctx, bookingId);
  ctx.check('a successful retry clears the overdue flag', recovered.payment_status === 'plan_active' && recovered.needs_attention === null,
    JSON.stringify(recovered));

  for (let i = 0; i < 3; i += 1) await mockAction(ctx, cookie, csrf, bookingId, 'instalment_paid');
  const complete = booking(ctx, bookingId);
  ctx.check('after the sixth instalment the plan is complete',
    complete.paid_cents === 16800 && complete.payment_status === 'plan_complete' && complete.plan_next_charge_at === null,
    JSON.stringify(complete));
  await mockAction(ctx, cookie, csrf, bookingId, 'instalment_paid');
  const rows = ctx.sql(`SELECT COUNT(*) AS n FROM payments WHERE booking_id = '${bookingId}' AND kind = 'instalment'`);
  ctx.check('no instalment beyond the sixth', rows[0].n === 6, JSON.stringify(rows));

  ctx.section('A plan that ends short');
  const second = await ctx.fetch('/book/checkout', {
    method: 'POST', cookie,
    body: { csrf, kind: 'term', term: 'term-dev-11', child: childId, photo_consent: 'no', medical: '', waiver: 'accepted', payment: 'plan' },
  });
  const shortId = /booking=([a-f0-9-]+)/.exec(second.location)?.[1];
  const shortRef = /ref=([A-Za-z0-9_]+)/.exec(second.location)?.[1];
  await ctx.fetch('/dev/mock-checkout', { method: 'POST', cookie, body: { csrf, booking: shortId, ref: shortRef, outcome: 'pay' } });
  await mockAction(ctx, cookie, csrf, shortId, 'plan_ended');
  const short = booking(ctx, shortId);
  ctx.check('a subscription that ends early is flagged plan_ended_short',
    short.status === 'confirmed' && short.needs_attention === 'plan_ended_short' && short.paid_cents === 2800, JSON.stringify(short));
}

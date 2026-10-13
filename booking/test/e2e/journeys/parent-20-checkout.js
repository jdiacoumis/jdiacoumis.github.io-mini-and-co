// Checkout (booking-flow and payment-plans specs, D3/D4): a $100 term over
// three weekly instalments ($33.34, $33.33, $33.33) through the mock
// subscription checkout — schedule shown first, confirmation with paid marks,
// Purchase once, the plan on the account page, an overdue instalment with
// Update card; a voucher plus account credit on a casual class with the
// ledger behind it; plain pages for impossible requests; and an unfinished
// checkout the parent cancels and restarts.

export const title = 'Parent: checkout with a plan, voucher and credit, conflicts';

const EMAIL = 'e2e-pf-checkout@example.com';
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";
const at = (days) => `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '${days} days')`;

function createTerm(ctx, { key, className, termName, weeks, firstDay = 1, termPrice, plan }) {
  ctx.sqlWrite(`INSERT INTO classes (id, name, description, venue, age_range, weekday, start_time, default_duration_mins,
                                     default_capacity, active, created_at)
                VALUES ('cls-${key}', '${className}', 'An e2e class.', 'Test Hall', '3–12 months', 5, '10:00', 45, 12, 1, ${NOW})`);
  ctx.sqlWrite(`INSERT INTO terms (id, class_id, name, starts_on, ends_on, term_price_cents, casual_price_cents, plan_instalments,
                                   plan_interval, status, created_at)
                VALUES ('term-${key}', 'cls-${key}', '${termName}', date('now', '${firstDay} days'), date('now', '${firstDay + 7 * (weeks - 1)} days'),
                        ${termPrice}, 3000, ${plan}, 'week', 'open', ${NOW})`);
  const rows = Array.from({ length: weeks }, (_, i) => `('term-${key}-w${i + 1}', 'cls-${key}', 'term-${key}', ${at(firstDay + 7 * i)},
    45, 12, 3000, 'scheduled', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO class_sessions (id, class_id, term_id, starts_at, duration_mins, capacity, casual_price_cents, status, created_at)
                VALUES ${rows.join(', ')}`);
  return `term-${key}`;
}

const bookingRef = (location) => ({
  id: /booking=([a-f0-9-]+)/.exec(location)?.[1],
  ref: /ref=([A-Za-z0-9_]+)/.exec(location)?.[1],
});

export async function run(ctx) {
  const termId = createTerm(ctx, { key: 'pf-plan', className: 'PF Plan Class', termName: 'Plan Term', weeks: 3, termPrice: 10000, plan: 3 });
  const casualTerm = createTerm(ctx, { key: 'pf-casual', className: 'PF Casual Class', termName: 'Casual Term', weeks: 3, termPrice: 9000, plan: 0 });
  const cookie = await ctx.signIn(EMAIL);
  const csrf = await ctx.csrfFor(cookie);
  await ctx.fetch('/account/children/new', {
    method: 'POST', cookie, body: { csrf, name: 'Pip', dob: '2025-12-12', medical: '', photo_consent: 'no' },
  });
  const [user] = ctx.sql(`SELECT id FROM users WHERE email = '${EMAIL}'`);
  const [child] = ctx.sql(`SELECT id FROM children WHERE user_id = '${user.id}'`);

  ctx.section('Pay by instalments');
  const review = await ctx.fetch(`/book/checkout?kind=term&term=${termId}`, { cookie });
  ctx.check('the plan choice shows the uneven split before payment',
    review.text.includes('Pay $100.00 in full today')
      && review.text.includes('Pay in 3 weekly instalments — $33.34 today, then $33.33 each week'), review.text.slice(0, 300));
  const dates = /<ol class="plan-dates">([\s\S]*?)<\/ol>/.exec(review.text)?.[1] || '';
  ctx.check('the dated schedule lists today and two weekly dates',
    (dates.match(/<li>/g) || []).length === 3 && dates.includes('Today') && dates.includes('$33.34')
      && (dates.match(/\$33\.33/g) || []).length === 2, dates);

  const start = await ctx.fetch('/book/checkout', {
    method: 'POST', cookie,
    body: { csrf, kind: 'term', term: termId, child: child.id, photo_consent: 'no', medical: '', waiver: 'accepted', payment: 'plan' },
  });
  const plan = bookingRef(start.location);
  ctx.check('plan checkout goes to the hosted page', start.status === 303 && start.location.includes('/dev/mock-checkout') && plan.id);
  const [pending] = ctx.sql(`SELECT payment_method, plan_instalments, plan_instalment_cents, amount_cents FROM bookings WHERE id = '${plan.id}'`);
  ctx.check('the plan is snapshotted on the booking',
    pending.payment_method === 'plan' && pending.plan_instalments === 3 && pending.plan_instalment_cents === 3333 && pending.amount_cents === 10000,
    JSON.stringify(pending));
  const hosted = await ctx.fetch(start.location, { cookie });
  ctx.check('the hosted page takes the first instalment', hosted.text.includes('Pay first instalment') && hosted.text.includes('$33.34'));
  await ctx.fetch('/dev/mock-checkout', { method: 'POST', cookie, body: { csrf, booking: plan.id, ref: plan.ref, outcome: 'pay' } });

  const confirm = await ctx.fetch(`/book/confirm?booking=${plan.id}`, { cookie });
  ctx.check('the confirmation shows what is paid and the schedule',
    confirm.text.includes("You're booked in") && confirm.text.includes('Paid so far: $33.34 of $100.00 AUD')
      && confirm.text.includes('$33.34 — paid') && confirm.text.includes('The remaining 2 instalments are taken automatically'),
    confirm.text.slice(confirm.text.indexOf('confirm-panel'), confirm.text.indexOf('confirm-panel') + 1500));
  ctx.check('Purchase renders on the first confirmation view',
    confirm.text.includes('data-pixel-purchase') && confirm.text.includes(`data-booking-id="${plan.id}"`) && confirm.text.includes('data-amount="100.00"'));
  const again = await ctx.fetch(`/book/confirm?booking=${plan.id}`, { cookie });
  ctx.check('Purchase never renders twice', again.status === 200 && !again.text.includes('data-pixel-purchase'));

  const mail = (await ctx.mailbox(EMAIL)).find((m) => m.subject.startsWith('Booking confirmed'));
  ctx.check('the confirmation email carries the dated schedule',
    mail && mail.body.includes('Payment plan: 3 weekly instalments') && mail.body.includes('$33.34 (charged at checkout)')
      && (mail.body.match(/— \$33\.33/g) || []).length === 2, mail ? mail.body : 'no email');

  const account = await ctx.fetch('/account', { cookie });
  ctx.check('the account shows the plan progress and the next payment',
    account.text.includes('Instalments: 1 of 3 paid') && account.text.includes('next payment'));

  ctx.section('An instalment fails');
  await ctx.fetch('/dev/mock-checkout', { method: 'POST', cookie, body: { csrf, booking: plan.id, outcome: 'instalment_failed' } });
  const overdue = await ctx.fetch('/account', { cookie });
  ctx.check('the account flags the overdue payment and keeps the place',
    overdue.text.includes('Payment overdue') && overdue.text.includes('your place is kept') && overdue.text.includes('to update your card'));
  const overdueConfirm = await ctx.fetch(`/book/confirm?booking=${plan.id}`, { cookie });
  ctx.check('the booking page explains the failed instalment',
    overdueConfirm.text.includes('An instalment didn') && overdueConfirm.text.includes('Your place is kept'));
  ctx.check('without a card on file there is no Update card button', !overdue.text.includes('action="/account/billing-portal"'));
  const noCard = await ctx.fetch('/account/billing-portal', { method: 'POST', cookie, body: { csrf } });
  ctx.check('the billing portal needs a card on file', noCard.status === 303 && noCard.location === '/account?ok=no-card');

  ctx.sqlWrite(`UPDATE users SET stripe_customer_id = 'cus_e2epfcheckout' WHERE id = '${user.id}'`);
  const withCard = await ctx.fetch('/account', { cookie });
  ctx.check('with a card on file the account offers Update card', withCard.text.includes('action="/account/billing-portal"')
    && withCard.text.includes('Update card'));
  const portal = await ctx.fetch('/account/billing-portal', { method: 'POST', cookie, body: { csrf } });
  ctx.check('Update card opens the billing portal', portal.status === 303 && portal.location === '/dev/mock-portal', portal.location);
  const forged = await ctx.fetch('/account/billing-portal', { method: 'POST', cookie, body: { csrf: 'forged' } });
  ctx.check('Update card requires the CSRF token', forged.status === 403);

  ctx.section('Voucher and account credit');
  ctx.sqlWrite(`INSERT INTO credits (id, user_id, amount_cents, remaining_cents, reason, issued_by, issued_at, expires_at)
                VALUES ('e2e-pf-credit', '${user.id}', 1000, 1000, 'Goodwill', 'admin', ${NOW}, ${at(30)})`);
  ctx.sqlWrite(`INSERT INTO vouchers (code, kind, value, applies_to, active, created_at)
                VALUES ('PFFIVE', 'amount', 500, 'any', 1, ${NOW})`);
  ctx.sqlWrite(`INSERT INTO vouchers (code, kind, value, applies_to, valid_until, active, created_at)
                VALUES ('OLDIE', 'amount', 500, 'any', ${at(-1)}, 1, ${NOW})`);
  const credited = await ctx.fetch('/account', { cookie });
  ctx.check('the account lists the credit with its expiry',
    credited.text.includes('Account credit') && credited.text.includes('$10.00') && credited.text.includes('Goodwill') && credited.text.includes('use by'));
  const casualUrl = `/book/checkout?kind=casual&term=${casualTerm}&session=${casualTerm}-w3&child=${child.id}`;
  const quoted = await ctx.fetch(`${casualUrl}&voucher=pf%20five`, { cookie });
  ctx.check('voucher first, then credit, shown line by line',
    quoted.text.includes('Voucher PFFIVE') && quoted.text.includes('−$5.00') && quoted.text.includes('Account credit applied')
      && quoted.text.includes('−$10.00') && quoted.text.includes('$15.00 AUD') && quoted.text.includes('used automatically'));
  const expired = await ctx.fetch(`${casualUrl}&voucher=oldie`, { cookie });
  ctx.check('an expired voucher is explained and not applied', expired.text.includes('That voucher has expired') && expired.text.includes('$20.00 AUD'));

  const paid = await ctx.fetch('/book/checkout', {
    method: 'POST', cookie,
    body: { csrf, kind: 'casual', term: casualTerm, session: `${casualTerm}-w3`, child: child.id, voucher: 'PFFIVE', photo_consent: 'no', medical: '', waiver: 'accepted' },
  });
  const casual = bookingRef(paid.location);
  await ctx.fetch('/dev/mock-checkout', { method: 'POST', cookie, body: { csrf, booking: casual.id, ref: casual.ref, outcome: 'pay' } });
  const [row] = ctx.sql(`SELECT status, list_amount_cents, discount_cents, credit_cents, amount_cents, paid_cents, payment_status
                         FROM bookings WHERE id = '${casual.id}'`);
  ctx.check('the booking records list, voucher, credit and the amount paid',
    row.status === 'confirmed' && row.list_amount_cents === 3000 && row.discount_cents === 500 && row.credit_cents === 1000
      && row.amount_cents === 1500 && row.paid_cents === 2500 && row.payment_status === 'paid', JSON.stringify(row));
  const ledger = ctx.sql(`SELECT kind, amount_cents FROM payments WHERE booking_id = '${casual.id}' ORDER BY kind`);
  ctx.check('the ledger holds the card payment and the credit applied',
    JSON.stringify(ledger) === JSON.stringify([{ kind: 'checkout', amount_cents: 1500 }, { kind: 'credit_applied', amount_cents: 1000 }]),
    JSON.stringify(ledger));
  ctx.check('the credit is spent', ctx.sql(`SELECT remaining_cents FROM credits WHERE id = 'e2e-pf-credit'`)[0].remaining_cents === 0);
  const casualConfirm = await ctx.fetch(`/book/confirm?booking=${casual.id}`, { cookie });
  ctx.check('the confirmation shows the voucher and credit used',
    casualConfirm.text.includes('Paid: $15.00 AUD') && casualConfirm.text.includes('Voucher PFFIVE: −$5.00') && casualConfirm.text.includes('Account credit: −$10.00'));
  ctx.check('the voucher use is counted', ctx.sql(`SELECT uses FROM vouchers WHERE code = 'PFFIVE'`)[0].uses === 1);

  ctx.section('Requests that cannot go ahead');
  const twoTrials = await ctx.fetch(`/book/checkout?kind=trial&term=${termId}&session=${termId}-w2&session=${termId}-w3&child=${child.id}`, { cookie });
  ctx.check('a trial of two classes is explained', twoTrials.status === 400 && twoTrials.text.includes('A trial is one class'));
  const none = await ctx.fetch(`/book/checkout?kind=casual&term=${casualTerm}`, { cookie });
  ctx.check('a casual booking with no class ticked is explained', none.status === 400 && none.text.includes('Choose a class'));
  const unknown = await ctx.fetch('/book/checkout?kind=term&term=no-such-term', { cookie });
  ctx.check('an unknown term is a friendly 404', unknown.status === 404 && unknown.text.includes('find that class'));
  const done = await ctx.fetch(`/book/checkout?kind=term&term=${termId}&child=${child.id}`, { cookie });
  ctx.check('booking the same term twice says it is already booked', done.status === 409 && done.text.includes('Already booked'));

  ctx.section('An unfinished checkout is cancelled and restarted');
  const session = `${casualTerm}-w2`;
  const firstTry = await ctx.fetch('/book/checkout', {
    method: 'POST', cookie,
    body: { csrf, kind: 'casual', term: casualTerm, session, child: child.id, photo_consent: 'no', medical: '', waiver: 'accepted' },
  });
  const abandoned = bookingRef(firstTry.location);
  const retry = await ctx.fetch(`/book/checkout?kind=casual&term=${casualTerm}&session=${session}&child=${child.id}`, { cookie });
  ctx.check('coming back explains the unfinished booking and offers to start again',
    retry.status === 409 && retry.text.includes('already started this booking') && retry.text.includes('action="/book/checkout/release"'));
  const release = await ctx.fetch('/book/checkout/release', {
    method: 'POST', cookie,
    body: { csrf, booking: abandoned.id, kind: 'casual', term: casualTerm, session, child: child.id },
  });
  ctx.check('starting again returns to the same checkout',
    release.status === 303 && release.location === `/book/checkout?kind=casual&term=${casualTerm}&session=${session}&child=${child.id}`, release.location);
  ctx.check('the unfinished booking is released', ctx.sql(`SELECT status FROM bookings WHERE id = '${abandoned.id}'`)[0].status === 'expired');
  const stale = await ctx.fetch('/dev/mock-checkout', { method: 'POST', cookie, body: { csrf, booking: abandoned.id, ref: abandoned.ref, outcome: 'pay' } });
  ctx.check('its payment page can no longer take a payment', stale.status === 409);
  const fresh = await ctx.fetch(release.location, { cookie });
  ctx.check('the checkout works again', fresh.status === 200 && fresh.text.includes('Continue to payment'));
  const noCsrf = await ctx.fetch('/book/checkout/release', { method: 'POST', cookie, body: { csrf: 'nope', booking: abandoned.id } });
  ctx.check('starting again requires the CSRF token', noCsrf.status === 403);

  ctx.sqlWrite(`UPDATE terms SET status = 'closed' WHERE id IN ('${termId}', '${casualTerm}')`);
}

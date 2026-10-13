// Cross-feature (Phase 3): an instalment plan meets the owner's transfers and
// Check with Stripe. A family books a term on a four-week plan through the
// hosted (mock) checkout; the owner moves one week to the 1:00 pm class; the
// term grids and both rosters agree and no money moves; the next instalment
// arrives (plan 2 of 4); one more is charged but its webhook is lost, and
// Check with Stripe finds it through the invoice list — once.

import {
  ownerSession, family, createTerm, checkout, hosted, payHosted, bookingRow, seatsHeld, ledger, q,
} from '../support.js';

export const title = 'Cross-feature: instalment plan + transfer + lost instalment webhook';

export async function run(ctx) {
  const eleven = createTerm(ctx, 'pt-11', { className: 'X Plan Class — 11:00 am', utcTime: '01:00', planInstalments: 4 });
  const one = createTerm(ctx, 'pt-13', { className: 'X Plan Class — 1:00 pm', utcTime: '03:00', localTime: '13:00', planInstalments: 4 });
  const fam = await family(ctx, 'x-plan@example.com', 'Pia');
  const { cookie: admin, csrf } = await ownerSession(ctx);

  ctx.section('A term on a four-week plan');
  const review = await ctx.fetch(`/book/checkout?kind=term&term=${eleven.termId}&child=${fam.childId}&payment=plan`, { cookie: fam.cookie });
  ctx.check('the plan and its schedule are shown before paying',
    review.status === 200 && review.text.includes('Pay in 4 weekly instalments — $30.00 today, then $30.00 each week'));
  const started = await checkout(ctx, fam, { kind: 'term', termId: eleven.termId, payment: 'plan' });
  const { bookingId } = hosted(started.location);
  ctx.check('the plan checkout goes to the hosted page', started.status === 303 && Boolean(bookingId), started.location);
  await payHosted(ctx, fam, started.location);
  let b = bookingRow(ctx, bookingId);
  ctx.check('first instalment paid: confirmed, plan running, 1 of 4',
    b.status === 'confirmed' && b.payment_method === 'plan' && b.payment_status === 'plan_active' && b.paid_cents === 3000
      && b.plan_instalments === 4 && Boolean(b.stripe_subscription_id), JSON.stringify(b));
  const ledgerBefore = JSON.stringify(ledger(ctx, bookingId));

  ctx.section('The owner moves week 2 to the 1:00 pm class');
  const [w2, w2pm] = [eleven.sessionIds[1], one.sessionIds[1]];
  const page = await ctx.fetch(`/admin/bookings/${bookingId}/transfer?session=${w2}`, { cookie: admin });
  ctx.check('the move page offers the 1:00 pm class that week', page.status === 200 && page.text.includes(`value="${w2pm}"`));
  const moved = await ctx.fetch(`/admin/bookings/${bookingId}/transfer`, { method: 'POST', cookie: admin, body: { csrf, from: w2, to: w2pm } });
  ctx.check('the week is moved', moved.status === 303 && moved.location.endsWith('ok=transferred'), moved.location);
  const rows = ctx.sql(`SELECT session_id, status, transferred_to_session_id FROM booking_sessions WHERE booking_id = ${q(bookingId)}`);
  const row = (id) => rows.find((r) => r.session_id === id) || {};
  ctx.check('11:00 week 2 is marked moved, pointing at the 1:00 pm seat',
    row(w2).status === 'transferred_out' && row(w2).transferred_to_session_id === w2pm && row(w2pm).status === 'booked', JSON.stringify(rows));
  ctx.check('seats follow the move', seatsHeld(ctx, w2) === 0 && seatsHeld(ctx, w2pm) === 1);

  const grid11 = await ctx.fetch(`/admin/terms/${eleven.termId}`, { cookie: admin });
  ctx.check('the 11:00 grid shows the moved week and the plan', grid11.status === 200 && grid11.text.includes(`/admin/bookings/${bookingId}`)
    && grid11.text.includes('grid-cell grid-moved') && grid11.text.includes('Plan 1 of 4'));
  const grid13 = await ctx.fetch(`/admin/terms/${one.termId}`, { cookie: admin });
  ctx.check('the 1:00 pm grid lists the family for that week', grid13.status === 200 && grid13.text.includes(`/admin/bookings/${bookingId}`)
    && (grid13.text.match(/grid-cell grid-booked/g) || []).length === 1);
  ctx.check('the 1:00 pm grid counts the seat', /Seats left<\/th>\s*<td class="grid-seats">12<\/td>\s*<td class="grid-seats">11<\/td>/.test(grid13.text));
  const roster11 = await ctx.fetch(`/admin/sessions/${w2}/roster`, { cookie: admin });
  const roster13 = await ctx.fetch(`/admin/sessions/${w2pm}/roster`, { cookie: admin });
  ctx.check('the rosters agree: Pia is on the 1:00 pm roster, not the 11:00 one',
    roster13.text.includes('Pia') && !roster11.text.includes('Pia') && roster11.text.includes('No bookings for this session yet'));
  ctx.check('no money moved', JSON.stringify(ledger(ctx, bookingId)) === ledgerBefore && bookingRow(ctx, bookingId).paid_cents === 3000);
  const parentView = await ctx.fetch(`/book/confirm?booking=${bookingId}`, { cookie: fam.cookie });
  ctx.check("the family's booking shows the 1:00 pm class for that week", parentView.text.includes('X Plan Class — 1:00 pm'));

  ctx.section('The next instalment');
  await ctx.fetch('/dev/mock-checkout', { method: 'POST', cookie: fam.cookie, body: { csrf: fam.csrf, booking: bookingId, outcome: 'instalment_paid' } });
  b = bookingRow(ctx, bookingId);
  ctx.check('instalment 2 is in the ledger: plan_active, 2 of 4',
    b.payment_status === 'plan_active' && b.paid_cents === 6000 && ledger(ctx, bookingId).filter((r) => r.kind === 'instalment').length === 2,
    JSON.stringify(b));
  ctx.check('the grid says Plan 2 of 4', (await ctx.fetch(`/admin/terms/${eleven.termId}`, { cookie: admin })).text.includes('Plan 2 of 4'));
  ctx.check('the account says 2 of 4 paid', (await ctx.fetch('/account', { cookie: fam.cookie })).text.includes('Instalments: 2 of 4 paid'));

  ctx.section('An instalment whose webhook never arrives');
  await ctx.fetch('/dev/mock-checkout', {
    method: 'POST', cookie: fam.cookie, body: { csrf: fam.csrf, booking: bookingId, outcome: 'instalment_paid_quietly' },
  });
  ctx.check('Stripe charged it, the ledger does not know yet',
    bookingRow(ctx, bookingId).paid_cents === 6000
      && ctx.sql(`SELECT COUNT(*) AS n FROM dev_mock_invoices WHERE booking_id = ${q(bookingId)} AND status = 'paid'`)[0].n === 3);
  const checked = await ctx.fetch(`/admin/bookings/${bookingId}/check`, { method: 'POST', cookie: admin, body: { csrf } });
  ctx.check('Check with Stripe adds the missing instalment', checked.status === 303
    && checked.location === `/admin/bookings/${bookingId}?ok=check-plan-active-added`, checked.location);
  b = bookingRow(ctx, bookingId);
  ctx.check('3 of 4 paid, keyed on the invoice id', b.paid_cents === 9000 && b.payment_status === 'plan_active'
    && ledger(ctx, bookingId).filter((r) => r.kind === 'instalment' && r.provider_ref.startsWith('in_mock_')).length === 3);
  const notice = await ctx.fetch(checked.location, { cookie: admin });
  ctx.check('the owner is told what was added', notice.text.includes('have been added to the ledger'));
  const again = await ctx.fetch(`/admin/bookings/${bookingId}/check`, { method: 'POST', cookie: admin, body: { csrf } });
  ctx.check('checking again adds nothing', again.location.endsWith('ok=check-plan-active') && bookingRow(ctx, bookingId).paid_cents === 9000);
  ctx.check('the grid says Plan 3 of 4', (await ctx.fetch(`/admin/terms/${eleven.termId}`, { cookie: admin })).text.includes('Plan 3 of 4'));
}

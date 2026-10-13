// Admin journey (Phase 2B): Needs attention and "Check with Stripe" with the
// mock driver (a paid checkout whose webhook never arrived is confirmed and
// recorded once; a lapsed unpaid checkout is released; a flag is resolved
// with a note), the booking page (adjustment, offline payment receipt,
// cancel and restore), vouchers CRUD, customer and child editing, credits
// (issue, list, void), and the bookings filters and CSV.
//
// Self-contained: its own class, term and families.

import { adminSession, nextWeekday } from './admin-10-terms.js';

export const title = 'Admin: needs attention, Check with Stripe, vouchers, customers, credits';

const PARENT = 'e2e-admin-e@example.com';
const TERM_NAME = 'Ops Term 1 2030';

const minutesAgo = (n) => `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-${n} minutes')`;

export async function run(ctx) {
  const admin = await adminSession(ctx);
  const csrf = await ctx.csrfFor(admin);

  ctx.section('An open term families can book online');
  await ctx.fetch('/admin/classes/new', {
    method: 'POST', cookie: admin,
    body: { csrf, name: 'Admin Ops — Friday 9:15 am', description: 'E2E', venue: 'Test Hall', age_range: '3–12 months', weekday: '5', start_time: '09:15', default_duration_mins: '45', default_capacity: '6' },
  });
  const [cls] = ctx.sql(`SELECT id FROM classes WHERE name = 'Admin Ops — Friday 9:15 am'`);
  const created = await ctx.fetch('/admin/terms/new', {
    method: 'POST', cookie: admin,
    body: {
      csrf, class_id: cls.id, name: TERM_NAME, starts_on: nextWeekday(ctx, 5, 10), weeks: '4', ends_on: '', holidays: '',
      term_price: '100', casual_price: '30', trial_price: '', returning_price: '', returning_opens_at: '', public_opens_at: '',
      previous_term_id: 'auto', plan_instalments: '0', plan_interval: 'week', open_now: '1',
    },
  });
  ctx.check('term created open for bookings', created.status === 303);
  const [term] = ctx.sql(`SELECT id, status FROM terms WHERE name = '${TERM_NAME}'`);
  const sessions = ctx.sql(`SELECT id FROM class_sessions WHERE term_id = '${term.id}' ORDER BY starts_at`).map((s) => s.id);
  ctx.check('the term is open with four weeks', term.status === 'open' && sessions.length === 4);

  const parent = await ctx.signIn(PARENT);
  const parentCsrf = await ctx.csrfFor(parent);
  await ctx.fetch('/account/children/new', {
    method: 'POST', cookie: parent, body: { csrf: parentCsrf, name: 'Evie', dob: '2025-09-20', medical: '', photo_consent: 'yes' },
  });
  const [evie] = ctx.sql(`SELECT c.id, c.user_id FROM children c JOIN users u ON u.id = c.user_id WHERE u.email = '${PARENT}'`);
  const checkout = (session) => ctx.fetch('/book/checkout', {
    method: 'POST', cookie: parent,
    body: { csrf: parentCsrf, kind: 'casual', term: term.id, session, child: evie.id, photo_consent: 'yes', medical: '', waiver: 'accepted' },
  });

  ctx.section('Check with Stripe: paid, but the webhook never came');
  const paidStart = await checkout(sessions[0]);
  const paidId = /booking=([a-f0-9-]+)/.exec(paidStart.location)?.[1];
  ctx.check('online checkout started', Boolean(paidId) && paidStart.location.includes('/dev/mock-checkout'), paidStart.location);
  // 45 minutes pass; the family paid on Stripe's page, but no event arrived.
  ctx.sqlWrite(`UPDATE bookings SET created_at = ${minutesAgo(45)}, expires_at = ${minutesAgo(10)},
                paid_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = '${paidId}'`);
  const attention = await ctx.fetch('/admin/attention', { cookie: admin });
  ctx.check('the stale checkout is listed with Check with Stripe',
    attention.status === 200 && attention.text.includes(`/admin/bookings/${paidId}/check`));
  const checked = await ctx.fetch(`/admin/bookings/${paidId}/check`, { method: 'POST', cookie: admin, body: { csrf, back: 'attention' } });
  ctx.check('Stripe says paid → confirmed', checked.status === 303 && checked.location === '/admin/attention?ok=check-confirmed', checked.location);
  const [paidRow] = ctx.sql(`SELECT status, paid_cents, payment_status, payment_ref FROM bookings WHERE id = '${paidId}'`);
  const paidLedger = ctx.sql(`SELECT kind, amount_cents, provider_ref FROM payments WHERE booking_id = '${paidId}'`);
  ctx.check('the booking is confirmed and the payment recorded', paidRow.status === 'confirmed' && paidRow.payment_status === 'paid'
    && paidLedger.length === 1 && paidLedger[0].kind === 'checkout' && paidLedger[0].amount_cents === 3000
    && paidLedger[0].provider_ref === paidRow.payment_ref, JSON.stringify({ paidRow, paidLedger }));
  await ctx.fetch(`/admin/bookings/${paidId}/check`, { method: 'POST', cookie: admin, body: { csrf } });
  ctx.check('checking again records nothing twice', ctx.sql(`SELECT COUNT(*) AS n FROM payments WHERE booking_id = '${paidId}'`)[0].n === 1);
  ctx.check('the family got the booking confirmation', (await ctx.mailbox(PARENT)).length >= 1
    && ctx.sql(`SELECT COUNT(*) AS n FROM email_log WHERE booking_id = '${paidId}' AND template = 'booking_confirmed'`)[0].n === 1);

  ctx.section('Check with Stripe: never paid');
  const unpaidStart = await checkout(sessions[1]);
  const unpaidId = /booking=([a-f0-9-]+)/.exec(unpaidStart.location)?.[1];
  ctx.sqlWrite(`UPDATE bookings SET created_at = ${minutesAgo(45)}, expires_at = ${minutesAgo(10)} WHERE id = '${unpaidId}'`);
  const released = await ctx.fetch(`/admin/bookings/${unpaidId}/check`, { method: 'POST', cookie: admin, body: { csrf, back: 'attention' } });
  ctx.check('Stripe says expired → the place is released', released.location.endsWith('ok=check-expired'), released.location);
  ctx.check('the booking is expired', ctx.sql(`SELECT status FROM bookings WHERE id = '${unpaidId}'`)[0].status === 'expired');
  const afterRelease = await ctx.fetch('/admin/attention', { cookie: admin });
  ctx.check('ended checkouts stay findable for three days', afterRelease.text.includes('Online payments that ended without a payment')
    && afterRelease.text.includes(`/admin/bookings/${unpaidId}/check`));

  ctx.section('Resolve a flag with a note');
  ctx.sqlWrite(`UPDATE bookings SET needs_attention = 'webhook_mismatch' WHERE id = '${paidId}'`);
  const flagged = await ctx.fetch('/admin/attention', { cookie: admin });
  ctx.check('flagged booking listed with its reason', flagged.text.includes('match the booking') && flagged.text.includes(`/admin/bookings/${paidId}/resolve`));
  const dash = await ctx.fetch('/admin', { cookie: admin });
  ctx.check('the dashboard counts what needs attention', /stat-number">[1-9]\d*<\/span><span class="stat-label">bookings? needs? attention/.test(dash.text));
  const resolved = await ctx.fetch(`/admin/bookings/${paidId}/resolve`, {
    method: 'POST', cookie: admin, body: { csrf, back: 'attention', note: 'Checked the amount in Stripe' },
  });
  const [resolvedRow] = ctx.sql(`SELECT needs_attention, admin_notes FROM bookings WHERE id = '${paidId}'`);
  ctx.check('flag cleared, note kept', resolved.location.endsWith('ok=resolved') && resolvedRow.needs_attention === null
    && resolvedRow.admin_notes.includes('Checked the amount in Stripe'));

  ctx.section('The booking page');
  const page = await ctx.fetch(`/admin/bookings/${paidId}`, { cookie: admin });
  ctx.check('booking page shows weeks, ledger and notes', page.status === 200 && page.text.includes('Card payment')
    && page.text.includes('Checked the amount in Stripe') && page.text.includes('Move to another class'));
  const nonce = () => crypto.randomUUID();
  const adjusted = await ctx.fetch(`/admin/bookings/${paidId}/adjustment`, {
    method: 'POST', cookie: admin, body: { csrf, nonce: nonce(), amount: '-5', note: 'Late enrolment fee' },
  });
  ctx.check('a negative adjustment adds to what is owed', adjusted.location.endsWith('ok=adjusted')
    && (await ctx.fetch(`/admin/bookings/${paidId}`, { cookie: admin })).text.includes('owes $5.00'));
  const recorded = await ctx.fetch(`/admin/bookings/${paidId}/record-payment`, {
    method: 'POST', cookie: admin, body: { csrf, nonce: nonce(), amount: '5', method: 'cash', note: 'At class' },
  });
  ctx.check('an offline payment is recorded with a receipt', recorded.location.endsWith('ok=payment-recorded')
    && ctx.sql(`SELECT COUNT(*) AS n FROM email_log WHERE booking_id = '${paidId}' AND template = 'offline_receipt'`)[0].n === 1);
  ctx.check('nothing is owed now', ctx.sql(`SELECT payment_status FROM bookings WHERE id = '${paidId}'`)[0].payment_status === 'paid');
  const confirmCancel = await ctx.fetch(`/admin/bookings/${paidId}/cancel`, { cookie: admin });
  ctx.check('cancelling asks first', confirmCancel.status === 200 && confirmCancel.text.includes('Yes, cancel the booking'));
  await ctx.fetch(`/admin/bookings/${paidId}/cancel`, { method: 'POST', cookie: admin, body: { csrf, reason: 'Changed days' } });
  ctx.check('booking cancelled', ctx.sql(`SELECT status FROM bookings WHERE id = '${paidId}'`)[0].status === 'cancelled');
  const restored = await ctx.fetch(`/admin/bookings/${paidId}/restore`, { method: 'POST', cookie: admin, body: { csrf } });
  ctx.check('and restored while its seat is free', restored.location.endsWith('ok=restored')
    && ctx.sql(`SELECT status FROM bookings WHERE id = '${paidId}'`)[0].status === 'confirmed');

  ctx.section('Vouchers');
  const vouchers = await ctx.fetch('/admin/vouchers', { cookie: admin });
  ctx.check('vouchers list renders', vouchers.status === 200 && vouchers.text.includes('DEV5'));
  const voucherBody = {
    csrf, code: 'e2e-ops 10', kind: 'percent', value: '10', applies_to: 'term', max_uses: '5', valid_from: '',
    valid_until: ctx.sydneyDate(30), note: 'E2E', active: '1',
  };
  const newVoucher = await ctx.fetch('/admin/vouchers/new', { method: 'POST', cookie: admin, body: voucherBody });
  const [voucher] = ctx.sql(`SELECT code, kind, value, applies_to, max_uses, active, valid_until FROM vouchers WHERE code = 'E2E-OPS10'`);
  ctx.check('voucher created, code upper-cased', newVoucher.location.endsWith('ok=created') && voucher && voucher.kind === 'percent'
    && voucher.value === 10 && voucher.applies_to === 'term' && voucher.max_uses === 5 && voucher.active === 1 && voucher.valid_until, JSON.stringify(voucher));
  const dupVoucher = await ctx.fetch('/admin/vouchers/new', { method: 'POST', cookie: admin, body: voucherBody });
  ctx.check('a duplicate code is refused', dupVoucher.status === 400 && dupVoucher.text.includes('already a voucher'));
  const badVoucher = await ctx.fetch('/admin/vouchers/new', { method: 'POST', cookie: admin, body: { ...voucherBody, code: 'BIG', value: '150' } });
  ctx.check('a percentage over 100 is refused', badVoucher.status === 400);
  const editVoucher = await ctx.fetch('/admin/vouchers/E2E-OPS10/edit', {
    method: 'POST', cookie: admin, body: { csrf, kind: 'percent', value: '15', applies_to: 'any', max_uses: '', valid_from: '', valid_until: '', note: 'E2E' },
  });
  const [edited] = ctx.sql(`SELECT value, applies_to, max_uses, active, valid_until FROM vouchers WHERE code = 'E2E-OPS10'`);
  ctx.check('voucher edited and switched off', editVoucher.location.endsWith('ok=updated') && edited.value === 15 && edited.applies_to === 'any'
    && edited.max_uses === null && edited.active === 0 && edited.valid_until === null, JSON.stringify(edited));
  const deleted = await ctx.fetch('/admin/vouchers/E2E-OPS10/delete', { method: 'POST', cookie: admin, body: { csrf } });
  ctx.check('an unused voucher can be deleted', deleted.location.endsWith('ok=deleted')
    && ctx.sql(`SELECT COUNT(*) AS n FROM vouchers WHERE code = 'E2E-OPS10'`)[0].n === 0);
  await ctx.fetch('/admin/vouchers/new', { method: 'POST', cookie: admin, body: { ...voucherBody, code: 'E2E-USED' } });
  ctx.sqlWrite(`UPDATE vouchers SET uses = 1 WHERE code = 'E2E-USED'`);
  const keep = await ctx.fetch('/admin/vouchers/E2E-USED/delete', { method: 'POST', cookie: admin, body: { csrf } });
  ctx.check('a used voucher is kept (switch it off instead)', keep.location.endsWith('ok=in-use')
    && ctx.sql(`SELECT COUNT(*) AS n FROM vouchers WHERE code = 'E2E-USED'`)[0].n === 1);

  ctx.section('Customers and children');
  const search = await ctx.fetch(`/admin/customers?q=${encodeURIComponent('admin-e')}`, { cookie: admin });
  ctx.check('customer search finds the family', search.text.includes(PARENT) && search.text.includes(`/admin/customers/${evie.user_id}`));
  const customer = await ctx.fetch(`/admin/customers/${evie.user_id}`, { cookie: admin });
  ctx.check('family page shows children, bookings and credits', customer.status === 200 && customer.text.includes('Evie')
    && customer.text.includes(`/admin/bookings/${paidId}`));
  ctx.sqlWrite(`INSERT INTO users (id, email, created_at) VALUES ('e2e-ops-dup', 'e2e-ops-dup@example.com', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`);
  const dupEmail = await ctx.fetch(`/admin/customers/${evie.user_id}/edit`, {
    method: 'POST', cookie: admin, body: { csrf, name: 'Erin Example', email: 'E2E-OPS-DUP@example.com', phone: '' },
  });
  ctx.check('an email used by another account is refused', dupEmail.status === 400 && dupEmail.text.includes('already uses that email'));
  const ownerEmail = await ctx.fetch(`/admin/customers/${evie.user_id}/edit`, {
    method: 'POST', cookie: admin, body: { csrf, name: 'Erin Example', email: 'facilitator@example.com', phone: '' },
  });
  ctx.check("a family account can't be given a facilitator's address", ownerEmail.status === 400 && ownerEmail.text.includes('belongs to the owner or a facilitator'));
  const editParent = await ctx.fetch(`/admin/customers/${evie.user_id}/edit`, {
    method: 'POST', cookie: admin, body: { csrf, name: 'Erin Example', email: ' E2E-Admin-E2@Example.com ', phone: '0400 123 456' },
  });
  const [parentRow] = ctx.sql(`SELECT name, email, phone FROM users WHERE id = '${evie.user_id}'`);
  ctx.check('parent details saved (email normalised)', editParent.location.endsWith('ok=customer-updated') && parentRow.name === 'Erin Example'
    && parentRow.email === 'e2e-admin-e2@example.com' && parentRow.phone === '0400123456', JSON.stringify(parentRow));
  const signedOut = await ctx.fetch('/account', { cookie: parent });
  ctx.check('a new sign-in email signs the family out everywhere', signedOut.status === 303 && signedOut.location.includes('/auth/request-magic-link'));
  const addChild = await ctx.fetch(`/admin/customers/${evie.user_id}/children/new`, {
    method: 'POST', cookie: admin, body: { csrf, name: 'Ezra', dob: ctx.sydneyDate(-60), medical: '', photo_consent: 'no' },
  });
  const [ezra] = ctx.sql(`SELECT id, photo_consent FROM children WHERE user_id = '${evie.user_id}' AND name = 'Ezra'`);
  ctx.check('a child is added', addChild.location.endsWith('ok=child-added') && ezra && ezra.photo_consent === 0);
  await ctx.fetch(`/admin/children/${evie.id}/edit`, {
    method: 'POST', cookie: admin, body: { csrf, name: 'Evie', dob: '2025-09-20', medical: 'Asthma — inhaler in bag', photo_consent: 'no' },
  });
  const roster = await ctx.fetch(`/admin/sessions/${sessions[0]}/roster`, { cookie: admin });
  ctx.check('the roster shows the current notes and the stricter consent',
    roster.text.includes('Asthma — inhaler in bag') && roster.text.includes('changed since booking'));
  await ctx.fetch(`/admin/children/${ezra.id}/archive`, { method: 'POST', cookie: admin, body: { csrf } });
  ctx.check('a child can be archived', ctx.sql(`SELECT archived_at FROM children WHERE id = '${ezra.id}'`)[0].archived_at !== null);
  await ctx.fetch(`/admin/children/${ezra.id}/restore`, { method: 'POST', cookie: admin, body: { csrf } });
  ctx.check('and restored', ctx.sql(`SELECT archived_at FROM children WHERE id = '${ezra.id}'`)[0].archived_at === null);
  await ctx.fetch(`/admin/customers/${evie.user_id}/notes`, { method: 'POST', cookie: admin, body: { csrf, notes: 'Prefers text messages' } });
  ctx.check('customer notes saved', ctx.sql(`SELECT admin_notes FROM users WHERE id = '${evie.user_id}'`)[0].admin_notes === 'Prefers text messages');

  ctx.section('Credits');
  const issued = await ctx.fetch(`/admin/customers/${evie.user_id}/credit`, {
    method: 'POST', cookie: admin, body: { csrf, amount: '12.50', child: '', reason: 'Goodwill for the late start', expires: '' },
  });
  const [credit] = ctx.sql(`SELECT id, amount_cents, child_id FROM credits WHERE user_id = '${evie.user_id}' AND reason = 'Goodwill for the late start'`);
  ctx.check('a credit is issued from the family page', issued.location.endsWith('ok=credit-issued') && credit && credit.amount_cents === 1250 && credit.child_id === null);
  const credits = await ctx.fetch('/admin/credits', { cookie: admin });
  ctx.check('credits list shows it', credits.text.includes('Goodwill for the late start') && credits.text.includes('$12.50'));
  const voided = await ctx.fetch(`/admin/credits/${credit.id}/void`, { method: 'POST', cookie: admin, body: { csrf } });
  ctx.check('a credit can be voided', voided.location.endsWith('ok=voided')
    && ctx.sql(`SELECT voided_at FROM credits WHERE id = '${credit.id}'`)[0].voided_at !== null);
  ctx.check('voided credits drop off the usable list', !(await ctx.fetch('/admin/credits', { cookie: admin })).text.includes('Goodwill for the late start')
    && (await ctx.fetch('/admin/credits?show=all', { cookie: admin })).text.includes('Voided'));

  ctx.section('Bookings filters and CSV');
  const byTerm = await ctx.fetch(`/admin/bookings?term=${term.id}&kind=casual`, { cookie: admin });
  ctx.check('filter by term and kind', byTerm.text.includes(`/admin/bookings/${paidId}`) && byTerm.text.includes(`/admin/bookings/${unpaidId}`));
  const expiredOnly = await ctx.fetch(`/admin/bookings?term=${term.id}&status=expired`, { cookie: admin });
  ctx.check('filter by status', expiredOnly.text.includes(`/admin/bookings/${unpaidId}`) && !expiredOnly.text.includes(`/admin/bookings/${paidId}"`));
  const termOnly = await ctx.fetch(`/admin/bookings?term=${term.id}&kind=term`, { cookie: admin });
  ctx.check('filter by kind excludes casual bookings', !termOnly.text.includes(`/admin/bookings/${paidId}`));
  const csv = await ctx.fetch('/admin/bookings.csv', { method: 'POST', cookie: admin, body: { csrf, term: term.id } });
  ctx.check('bookings CSV carries the ledger totals', csv.status === 200 && csv.text.startsWith('"Created"')
    && csv.text.includes('"Received"') && csv.text.includes('"Owing"') && csv.text.includes('"Evie"'));

  await ctx.fetch(`/admin/terms/${term.id}/status`, { method: 'POST', cookie: admin, body: { csrf, status: 'closed' } });
  ctx.check('test term closed again', ctx.sql(`SELECT status FROM terms WHERE id = '${term.id}'`)[0].status === 'closed');
}

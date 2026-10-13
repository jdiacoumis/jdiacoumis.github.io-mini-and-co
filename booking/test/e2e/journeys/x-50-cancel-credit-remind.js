// Cross-feature (Phase 3): the owner cancels a class (2B) — every booked
// family gets a credit and a notice (2C), the owner a summary — and each
// family's credit is taken off their next checkout automatically (2A): in
// full for one, part-paying for the other. Then the day-before reminder job
// (cron) sends exactly one reminder per family for a class 24 hours out, and
// none to a family who never finished paying.

import {
  ADMIN, ownerSession, family, createTerm, checkout, bookAndPay, payHosted, cronRunner, bookingRow, ledger,
  inHours, inDays, NOW, q,
} from '../support.js';

export const title = 'Cross-feature: cancel a class → credits + notices → credit at next checkout; reminders';

export async function run(ctx) {
  const term = createTerm(ctx, 'cx', { className: 'X Cancel Class', weeks: 4, startInDays: 3, termPriceCents: 12000 });
  const [, s2, s3, s4] = term.sessionIds;
  const oneOff = (id, when) => ctx.sqlWrite(`INSERT INTO class_sessions (id, class_id, term_id, starts_at, duration_mins, capacity,
      casual_price_cents, status, created_at) VALUES (${q(id)}, ${q(term.classId)}, NULL, ${when}, 45, 12, 3000, 'scheduled', ${NOW})`);
  oneOff('x-cx-extra', inDays(9));
  oneOff('x-cx-soon', inHours(24));
  const cron = cronRunner(ctx, 'cx');
  const { cookie: admin, csrf } = await ownerSession(ctx);
  const tess = await family(ctx, 'x-cx-tess@example.com', 'Tess');
  const uri = await family(ctx, 'x-cx-uri@example.com', 'Uri');
  const wren = await family(ctx, 'x-cx-wren@example.com', 'Wren');

  ctx.section('Two families booked into week 2');
  const termBooking = await bookAndPay(ctx, tess, { kind: 'term', termId: term.termId });
  const casualBooking = await bookAndPay(ctx, uri, { kind: 'casual', termId: term.termId, sessionIds: [s2] });
  ctx.check('both are confirmed and paid', bookingRow(ctx, termBooking).paid_cents === 12000 && bookingRow(ctx, casualBooking).paid_cents === 3000);

  ctx.section('The owner cancels week 2');
  const confirmPage = await ctx.fetch(`/admin/sessions/${s2}/cancel`, { cookie: admin });
  ctx.check('the confirm page lists each family and the credits', confirmPage.status === 200 && confirmPage.text.includes('Tess')
    && confirmPage.text.includes('Uri') && confirmPage.text.includes('$60.00 in total'));
  const cancelled = await ctx.fetch(`/admin/sessions/${s2}/cancel`, { method: 'POST', cookie: admin, body: { csrf, reason: 'Venue closed' } });
  ctx.check('cancelled with two credits', cancelled.status === 200 && cancelled.text.includes('2 credits issued'));
  const credits = ctx.sql(`SELECT user_id, child_id, amount_cents, remaining_cents, source_booking_id FROM credits WHERE source_session_id = ${q(s2)} ORDER BY amount_cents`);
  ctx.check('the term family is credited one week of the term, the casual family what they paid',
    credits.length === 2 && credits.every((c) => c.amount_cents === 3000 && c.remaining_cents === 3000)
      && credits.some((c) => c.source_booking_id === termBooking && c.child_id === tess.childId)
      && credits.some((c) => c.source_booking_id === casualBooking && c.child_id === uri.childId), JSON.stringify(credits));
  ctx.check('their week-2 places are cancelled', ctx.sql(`SELECT status FROM booking_sessions WHERE session_id = ${q(s2)}`).every((r) => r.status === 'cancelled'));
  for (const fam of [tess, uri]) {
    const notices = ctx.sql(`SELECT body_text, reply_to FROM dev_emails WHERE to_email = ${q(fam.email)} AND subject LIKE 'Class cancelled:%'`);
    ctx.check(`${fam.childName}'s family gets one notice with the credit and the reason`, notices.length === 1
      && notices[0].body_text.includes('Venue closed') && notices[0].body_text.includes('a credit of $30.00') && notices[0].reply_to === ADMIN);
  }
  const summary = ctx.sql(`SELECT body_text FROM dev_emails WHERE to_email = ${q(ADMIN)} AND subject LIKE '%Class cancelled — X Cancel Class%'`);
  ctx.check('the owner gets a summary', summary.length === 1 && summary[0].body_text.includes('Families emailed: 2 of 2')
    && summary[0].body_text.includes('Credits given: $60.00'));
  const grid = await ctx.fetch(`/admin/terms/${term.termId}`, { cookie: admin });
  ctx.check('the grid shows the cancelled week', grid.text.includes('grid-week-cancelled'));

  ctx.section('Credits are used at the next checkout');
  const tessReview = await ctx.fetch(`/book/checkout?kind=casual&session=x-cx-extra&child=${tess.childId}`, { cookie: tess.cookie });
  ctx.check("Tess's checkout takes the credit off", tessReview.status === 200 && tessReview.text.includes('Account credit applied'));
  const tessNext = await checkout(ctx, tess, { kind: 'casual', sessionIds: ['x-cx-extra'] });
  const tessNextId = /booking=([A-Za-z0-9-]+)/.exec(tessNext.location)?.[1];
  ctx.check('fully covered by the credit: confirmed with nothing to pay',
    tessNext.location.startsWith('/book/confirm') && bookingRow(ctx, tessNextId).status === 'confirmed'
      && bookingRow(ctx, tessNextId).credit_cents === 3000 && bookingRow(ctx, tessNextId).amount_cents === 0);
  const tessMail = ctx.sql(`SELECT body_text FROM dev_emails WHERE to_email = ${q(tess.email)} AND subject LIKE 'Booking confirmed%' ORDER BY id DESC`)[0];
  ctx.check('the confirmation says the credit covered it', tessMail && tessMail.body_text.includes('Covered by your account credit ($30.00)'));

  const uriNext = await checkout(ctx, uri, { kind: 'casual', termId: term.termId, sessionIds: [s3, s4] });
  const uriHosted = await ctx.fetch(uriNext.location, { cookie: uri.cookie });
  ctx.check("Uri's two classes cost $60, the credit takes $30 off, $30 to pay", uriNext.status === 303 && uriHosted.text.includes('Total: $30.00 AUD'));
  await payHosted(ctx, uri, uriNext.location);
  const uriNextId = /booking=([A-Za-z0-9-]+)/.exec(uriNext.location)?.[1];
  const uriLedger = ledger(ctx, uriNextId).map((r) => `${r.kind}:${r.amount_cents}`).sort();
  ctx.check('the ledger holds the credit and the card payment; paid in full', JSON.stringify(uriLedger) === JSON.stringify(['checkout:3000', 'credit_applied:3000'])
    && bookingRow(ctx, uriNextId).payment_status === 'paid', JSON.stringify(uriLedger));
  ctx.check('both credits are used up', ctx.sql(`SELECT SUM(remaining_cents) AS left FROM credits WHERE source_session_id = ${q(s2)}`)[0].left === 0);

  ctx.section('Day-before reminders');
  await bookAndPay(ctx, tess, { kind: 'casual', sessionIds: ['x-cx-soon'] });
  await bookAndPay(ctx, uri, { kind: 'casual', sessionIds: ['x-cx-soon'] });
  const unpaid = await checkout(ctx, wren, { kind: 'casual', sessionIds: ['x-cx-soon'] }); // never pays
  ctx.check('a third family is still paying', unpaid.status === 303 && unpaid.location.includes('/dev/mock-checkout'));
  await cron();
  await cron();
  const reminders = (fam) => ctx.sql(`SELECT reply_to FROM dev_emails WHERE to_email = ${q(fam.email)} AND subject LIKE 'Reminder:%'`);
  for (const fam of [tess, uri]) {
    ctx.check(`${fam.childName}'s family gets exactly one reminder after two runs`, reminders(fam).length === 1 && reminders(fam)[0].reply_to === ADMIN,
      JSON.stringify(reminders(fam)));
  }
  ctx.check('the family who never paid gets none', reminders(wren).length === 0);
  ctx.check('each reminder is logged once with its dedupe key',
    ctx.sql(`SELECT COUNT(*) AS n FROM email_log WHERE session_id = 'x-cx-soon' AND template = 'reminder' AND status = 'sent'`)[0].n === 2);
  const [mail] = await ctx.mailbox(tess.email);
  ctx.check('it is the reminder for that class', mail.subject.startsWith("Reminder: Tess's class on") && mail.body.includes('X Cancel Class'));

  // Leave nothing that later cron runs could remind about.
  ctx.sqlWrite(`UPDATE class_sessions SET starts_at = ${inHours(-48)} WHERE id = 'x-cx-soon'`);
}

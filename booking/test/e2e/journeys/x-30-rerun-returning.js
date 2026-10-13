// Cross-feature (Phase 3): term rollover. A family books this term; the owner
// re-runs it (2B) with a public opening a fortnight away and auto-enrols the
// family, who is emailed the re-enrol invitation (2C template) at the
// returning-family price, sees Pay now on the account (2A) and pays. The
// owner opens the new term: the returning family may book another child
// early at the returning price; a family new to Mini & Co. sees "Bookings
// open …" and cannot book before then.

import {
  ADMIN, ownerSession, family, createTerm, checkout, bookAndPay, payHosted, hosted, bookingRow, q,
} from '../support.js';

export const title = 'Cross-feature: re-run a term → auto-enrol → returning family pays; new family waits';

export async function run(ctx) {
  const source = createTerm(ctx, 'rr', {
    className: 'X Rerun Class', weeks: 2, startInDays: 4, termPriceCents: 6000, returningPriceCents: 5000, termName: 'X Term 3 2031',
  });
  const { cookie: admin, csrf } = await ownerSession(ctx);
  const ret = await family(ctx, 'x-rr-returning@example.com', 'Remy');
  const fresh = await family(ctx, 'x-rr-new@example.com', 'Nova');

  ctx.section('This term');
  const sourceBooking = await bookAndPay(ctx, ret, { kind: 'term', termId: source.termId });
  ctx.check('the family is booked and paid this term', bookingRow(ctx, sourceBooking).status === 'confirmed'
    && bookingRow(ctx, sourceBooking).paid_cents === 6000);

  ctx.section('Re-run');
  const form = await ctx.fetch(`/admin/terms/${source.termId}/rerun`, { cookie: admin });
  ctx.check('the re-run form is prefilled', form.status === 200 && ctx.field(form.text, 'name') === 'X Term 4 2031'
    && ctx.field(form.text, 'returning_price') === '50.00');
  const fields = ['name', 'starts_on', 'weeks', 'term_price', 'casual_price', 'trial_price', 'returning_price', 'returning_opens_at',
    'previous_term_id', 'plan_instalments'];
  const publicOpens = `${ctx.sydneyDate(14)}T09:00`;
  const rerun = await ctx.fetch(`/admin/terms/${source.termId}/rerun`, {
    method: 'POST', cookie: admin,
    body: { ...Object.fromEntries(fields.map((f) => [f, ctx.field(form.text, f)])), csrf, ends_on: '', holidays: '',
      public_opens_at: publicOpens, plan_interval: 'week' },
  });
  ctx.check('the new term is created, then auto-enrol', rerun.status === 303 && rerun.location.includes('/auto-enrol?ok=rerun-created'), rerun.location);
  const [next] = ctx.sql(`SELECT * FROM terms WHERE name = 'X Term 4 2031' AND class_id = ${q(source.classId)}`);
  ctx.check('a draft linked to this term, opening to everyone in a fortnight',
    next && next.status === 'draft' && next.previous_term_id === source.termId && next.returning_price_cents === 5000
      && next.public_opens_at > new Date().toISOString(), JSON.stringify(next));

  ctx.section('Auto-enrol and the invitation');
  const enrolPage = await ctx.fetch(`/admin/terms/${next.id}/auto-enrol`, { cookie: admin });
  ctx.check('the term family is ticked', enrolPage.text.includes(`name="child" value="${ret.childId}" checked`));
  const enrolled = await ctx.fetch(`/admin/terms/${next.id}/auto-enrol`, { method: 'POST', cookie: admin, body: { csrf, child: ret.childId } });
  ctx.check('a place is held and the invitation sent', enrolled.status === 200 && enrolled.text.includes('invitation sent'));
  const [held] = ctx.sql(`SELECT * FROM bookings WHERE term_id = ${q(next.id)} AND child_id = ${q(ret.childId)}`);
  ctx.check('held at the returning price until the public opening',
    held && held.status === 'pending' && held.list_amount_cents === 5000 && held.amount_cents === 5000
      && held.expires_at === next.public_opens_at, JSON.stringify(held));
  const [invite] = ctx.sql(`SELECT subject, body_text, reply_to FROM dev_emails WHERE to_email = ${q(ret.email)} AND subject LIKE '%is saved — pay by%'`);
  ctx.check('the invitation names the returning price and replies reach the owner', Boolean(invite)
    && invite.subject.startsWith("Remy's place in X Term 4 2031 is saved") && invite.body_text.includes('Your returning-family price is $50.00')
    && invite.reply_to === ADMIN, JSON.stringify(invite));

  ctx.section('The owner opens the term');
  const opened = await ctx.fetch(`/admin/terms/${next.id}/status`, { method: 'POST', cookie: admin, body: { csrf, status: 'open' } });
  ctx.check('term opened', opened.location.includes('ok=status-open'), opened.location);

  ctx.section('A new family must wait for the public opening');
  const freshList = await ctx.fetch('/book', { cookie: fresh.cookie });
  ctx.check('the class list says when bookings open', freshList.text.includes('X Term 4 2031') && freshList.text.includes('Bookings open'));
  const freshCheckout = await ctx.fetch(`/book/checkout?kind=term&term=${next.id}&child=${fresh.childId}`, { cookie: fresh.cookie });
  ctx.check('checkout explains it is not open yet', freshCheckout.status === 409 && freshCheckout.text.includes('Not open yet'));
  const freshPost = await checkout(ctx, fresh, { kind: 'term', termId: next.id });
  ctx.check('and refuses to book', freshPost.status === 409
    && ctx.sql(`SELECT COUNT(*) AS n FROM bookings WHERE term_id = ${q(next.id)} AND user_id = ${q(fresh.userId)}`)[0].n === 0);

  ctx.section('The returning family pays at the returning price');
  const account = await ctx.fetch('/account', { cookie: ret.cookie });
  ctx.check('the account shows the held place with Pay now', account.text.includes('To pay: $50.00')
    && account.text.includes(`href="/account/bookings/${held.id}/pay"`));
  const review = await ctx.fetch(`/account/bookings/${held.id}/pay`, { cookie: ret.cookie });
  ctx.check('Pay now shows $50.00', review.status === 200 && review.text.includes('$50.00 AUD'));
  const pay = await ctx.fetch(`/account/bookings/${held.id}/pay`, {
    method: 'POST', cookie: ret.cookie, body: { csrf: ret.csrf, payment: 'full', photo_consent: 'yes', medical: '', waiver: 'accepted' },
  });
  ctx.check('the hosted checkout opens', pay.status === 303 && Boolean(hosted(pay.location).ref), pay.location);
  await payHosted(ctx, ret, pay.location);
  const paid = bookingRow(ctx, held.id);
  ctx.check('paid at the returning price and confirmed', paid.status === 'confirmed' && paid.paid_cents === 5000 && paid.payment_status === 'paid',
    JSON.stringify(paid));

  ctx.section('Returning families book early');
  await ctx.fetch('/account/children/new', {
    method: 'POST', cookie: ret.cookie, body: { csrf: ret.csrf, name: 'Rio', dob: '2026-03-03', medical: '', photo_consent: 'no' },
  });
  const [rio] = ctx.sql(`SELECT id FROM children WHERE user_id = ${q(ret.userId)} AND name = 'Rio'`);
  const sibling = await ctx.fetch(`/book/checkout?kind=term&term=${next.id}&child=${rio.id}`, { cookie: ret.cookie });
  ctx.check('a sibling may book before the public opening, at the returning price',
    sibling.status === 200 && sibling.text.includes('$50.00') && !sibling.text.includes('Not open yet'));
  const retList = await ctx.fetch('/book', { cookie: ret.cookie });
  ctx.check('the class list tells them the early window', retList.text.includes('Returning families only until'));

  ctx.sqlWrite(`UPDATE terms SET status = 'closed' WHERE id IN (${q(source.termId)}, ${q(next.id)})`);
}

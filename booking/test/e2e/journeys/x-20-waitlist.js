// Cross-feature (Phase 3): the waitlist end to end — the parent pages (2A),
// the owner's waitlist (2C), the guarded booking domain and the scheduled
// jobs together. A term fills up; two families join; the owner adds a seat
// and offers the rest of the term; the family sees Pay now on their account,
// pays, and the entry is booked (and stays booked through the cron). The
// second family's offer lapses through the cron (the owner is told), is
// offered again and declined from the account — each time the seat is
// released.

import {
  ADMIN, ownerSession, family, createTerm, checkout, bookAndPay, hosted, payHosted, cronRunner, bookingRow,
  seatsHeld, inMinutes, q,
} from '../support.js';

export const title = 'Cross-feature: waitlist join → offer → Pay now → cron; lapse and decline';

export async function run(ctx) {
  const term = createTerm(ctx, 'wl', { className: 'X Waitlist Class', weeks: 3, startInDays: 5, termPriceCents: 9000 });
  const cron = cronRunner(ctx, 'wl');
  const { cookie: admin, csrf } = await ownerSession(ctx);
  const filler = await family(ctx, 'x-wl-filler@example.com', 'Fred');
  const ada = await family(ctx, 'x-wl-ada@example.com', 'Ada');
  const bo = await family(ctx, 'x-wl-bo@example.com', 'Bo');
  const entry = (fam) => ctx.sql(`SELECT * FROM waitlist WHERE term_id = ${q(term.termId)} AND child_id = ${q(fam.childId)}`)[0];
  const capacity = (n) => ctx.sqlWrite(`UPDATE class_sessions SET capacity = ${n} WHERE term_id = ${q(term.termId)}`);
  const allWeeks = (n) => term.sessionIds.every((s) => seatsHeld(ctx, s) === n);

  ctx.section('The term fills up');
  await bookAndPay(ctx, filler, { kind: 'term', termId: term.termId });
  capacity(1); // the owner closes it at one family (as Edit session would)
  ctx.check('every week is full', allWeeks(1));
  const list = await ctx.fetch('/book', { cookie: ada.cookie });
  ctx.check('the class list offers the waitlist', list.text.includes(`href="/book/waitlist?term=${term.termId}"`));
  const blocked = await checkout(ctx, ada, { kind: 'term', termId: term.termId });
  ctx.check('booking a full term is refused with the waitlist offered', blocked.status === 409 && blocked.text.includes('waitlist'));

  ctx.section('Two families join');
  for (const fam of [ada, bo]) {
    const joined = await ctx.fetch('/book/waitlist', { method: 'POST', cookie: fam.cookie, body: { csrf: fam.csrf, term: term.termId, child: fam.childId } });
    ctx.check(`${fam.childName} joins`, joined.status === 303 && joined.location.endsWith('ok=joined'), joined.location);
  }
  ctx.check('Bo is second in line on his own page',
    (await ctx.fetch(`/book/waitlist?term=${term.termId}`, { cookie: bo.cookie })).text.includes('Bo</strong> is on the waitlist — number 2 in line'));
  const waitlistPage = await ctx.fetch(`/admin/waitlist?term=${term.termId}`, { cookie: admin });
  const line = waitlistPage.text.indexOf('<strong>Ada</strong>') < waitlistPage.text.indexOf('<strong>Bo</strong>');
  ctx.check("the owner's list has the same order", waitlistPage.status === 200 && line && waitlistPage.text.includes('2 families waiting'));

  ctx.section('The owner adds a seat and offers it to Ada');
  capacity(2);
  const adaEntry = entry(ada);
  const quote = await ctx.fetch(`/admin/waitlist/${adaEntry.id}/offer?kind=term`, { cookie: admin });
  ctx.check('the offer is priced from the term', quote.status === 200 && quote.text.includes('$90.00') && quote.text.includes('Send the offer'));
  const offered = await ctx.fetch(`/admin/waitlist/${adaEntry.id}/offer`, { method: 'POST', cookie: admin, body: { csrf, kind: 'term', price: '90.00' } });
  ctx.check('the offer is sent', offered.status === 303 && offered.location.endsWith('ok=offered'), offered.location);
  const adaOffer = entry(ada);
  const held = bookingRow(ctx, adaOffer.offer_booking_id);
  ctx.check('a 48-hour pending booking holds every remaining week',
    adaOffer.status === 'offered' && held.status === 'pending' && held.amount_cents === 9000
      && Math.round((Date.parse(held.expires_at) - Date.parse(held.created_at)) / 3600e3) === 48 && allWeeks(2), JSON.stringify(held));
  const [mail] = ctx.sql(`SELECT subject, body_text, reply_to FROM dev_emails WHERE to_email = ${q(ada.email)} AND subject LIKE 'A place has opened up%'`);
  ctx.check('Ada is emailed, and a reply reaches the owner', Boolean(mail) && mail.body_text.includes('press Pay now ($90.00)')
    && mail.reply_to === ADMIN, JSON.stringify(mail));

  ctx.section('Ada pays from her account');
  const account = await ctx.fetch('/account', { cookie: ada.cookie });
  ctx.check('the account shows the held place with Pay now', account.text.includes('A place is being held for Ada')
    && account.text.includes(`href="/account/bookings/${held.id}/pay"`));
  const pay = await ctx.fetch(`/account/bookings/${held.id}/pay`, {
    method: 'POST', cookie: ada.cookie, body: { csrf: ada.csrf, payment: 'full', photo_consent: 'yes', medical: '', waiver: 'accepted' },
  });
  ctx.check('Pay now opens the hosted checkout for $90', pay.status === 303 && hosted(pay.location).ref, pay.location);
  await payHosted(ctx, ada, pay.location);
  ctx.check('the offer is paid: booking confirmed', bookingRow(ctx, held.id).status === 'confirmed' && bookingRow(ctx, held.id).paid_cents === 9000);
  await cron();
  ctx.check('after the scheduled jobs the entry is booked', entry(ada).status === 'booked');
  ctx.check('she holds every remaining week', allWeeks(2));
  const after = await ctx.fetch(`/admin/waitlist?term=${term.termId}`, { cookie: admin });
  ctx.check("the owner's list shows Ada as booked and Bo first", after.text.includes('Earlier entries (1)') && after.text.includes('1 family waiting'));

  ctx.section("Bo's offer lapses");
  capacity(3);
  const boEntry = entry(bo);
  await ctx.fetch(`/admin/waitlist/${boEntry.id}/offer`, { method: 'POST', cookie: admin, body: { csrf, kind: 'term', price: '90.00' } });
  const firstOffer = entry(bo).offer_booking_id;
  ctx.check('the seat is held for Bo', entry(bo).status === 'offered' && allWeeks(3));
  ctx.sqlWrite(`UPDATE waitlist SET offer_expires_at = ${inMinutes(-1)} WHERE id = ${q(boEntry.id)}`); // 48 hours pass
  await cron();
  const lapsed = entry(bo);
  ctx.check('the offer lapses: back to waiting in his place, seat released',
    lapsed.status === 'waiting' && lapsed.note.includes('Offer lapsed') && bookingRow(ctx, firstOffer).status === 'expired' && allWeeks(2),
    JSON.stringify(lapsed));
  const alert = ctx.sql(`SELECT dedupe_key FROM email_log WHERE template = 'owner_offer_lapsed' AND booking_id = ${q(firstOffer)}`);
  ctx.check('the owner is told, once', alert.length === 1 && alert[0].dedupe_key === `offer_lapsed:${boEntry.id}:${firstOffer}:${ADMIN}`,
    JSON.stringify(alert));

  ctx.section('Offered again, and declined from the account');
  await ctx.fetch(`/admin/waitlist/${boEntry.id}/offer`, { method: 'POST', cookie: admin, body: { csrf, kind: 'term', price: '90.00' } });
  const secondOffer = entry(bo).offer_booking_id;
  ctx.check('a new hold for the second offer', secondOffer && secondOffer !== firstOffer && allWeeks(3));
  const declined = await ctx.fetch('/book/waitlist/leave', {
    method: 'POST', cookie: bo.cookie, body: { csrf: bo.csrf, entry: boEntry.id, from: 'account' },
  });
  ctx.check('declining returns to the account', declined.status === 303 && declined.location === '/account?ok=offer-declined#waitlist');
  ctx.check('the entry is declined and the seat released',
    entry(bo).status === 'declined' && bookingRow(ctx, secondOffer).status === 'expired' && allWeeks(2));
  ctx.check('the owner is told the place is free again',
    ctx.sql(`SELECT COUNT(*) AS n FROM email_log WHERE template = 'owner_waitlist_declined' AND term_id = ${q(term.termId)}`)[0].n === 1);
  const log = await ctx.fetch(`/admin/email/log?term=${term.termId}`, { cookie: admin });
  ctx.check('the email log names each email in plain words',
    log.text.includes('Waitlist place declined — alert to you') && log.text.includes('Waitlist offer lapsed — alert to you')
      && log.text.includes('Waitlist offer') && !log.text.includes('owner waitlist declined'));
}

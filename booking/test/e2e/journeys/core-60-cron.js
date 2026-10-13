// Scheduled jobs (D10) through the real scheduled() handler: lapsed holds are
// swept (credit given back), lapsed waitlist offers return to waiting and
// release their seat, and old records are purged.

export const title = 'Cron: sweep, offer expiry, purge';

const EMAIL = 'e2e-cron@example.com';

export async function run(ctx) {
  const cookie = await ctx.signIn(EMAIL);
  const csrf = await ctx.csrfFor(cookie);
  await ctx.fetch('/account/children/new', {
    method: 'POST', cookie, body: { csrf, name: 'Cleo', dob: '2025-10-10', medical: '', photo_consent: 'yes' },
  });
  const [user] = ctx.sql(`SELECT id FROM users WHERE email = '${EMAIL}'`);
  const [child] = ctx.sql(`SELECT id FROM children WHERE user_id = '${user.id}'`);
  ctx.sqlWrite(`INSERT INTO credits (id, user_id, amount_cents, remaining_cents, reason, issued_by, issued_at)
                VALUES ('e2e-cron-credit', '${user.id}', 1000, 1000, 'Test', 'admin', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`);

  // A checkout that is abandoned (never paid, never cancelled).
  const book = (session) => ctx.fetch('/book/checkout', {
    method: 'POST', cookie,
    body: { csrf, kind: 'casual', term: 'term-dev-11', session, child: child.id, photo_consent: 'yes', medical: '', waiver: 'accepted' },
  });
  const started = await book('ses-11-w5');
  const bookingId = /booking=([a-f0-9-]+)/.exec(started.location)?.[1];
  const [credit] = ctx.sql(`SELECT remaining_cents FROM credits WHERE id = 'e2e-cron-credit'`);
  ctx.check('the pending booking redeemed the credit', credit.remaining_cents === 0);

  // A waitlist offer whose 48-hour hold has lapsed.
  const offer = await book('ses-11-w6');
  const offerId = /booking=([a-f0-9-]+)/.exec(offer.location)?.[1];
  ctx.sqlWrite(`INSERT INTO waitlist (id, term_id, user_id, child_id, status, joined_at, offered_at, offer_expires_at, offer_booking_id)
                VALUES ('e2e-wait-1', 'term-dev-11', '${user.id}', '${child.id}', 'offered',
                        strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 days'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 days'),
                        strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 minutes'), '${offerId}')`);
  // Time passes: the first hold lapses; the offer's booking still has time on its own clock.
  ctx.sqlWrite(`UPDATE bookings SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 minutes') WHERE id = '${bookingId}'`);
  ctx.sqlWrite(`UPDATE bookings SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+1 days') WHERE id = '${offerId}'`);
  // Old records for the purge.
  ctx.sqlWrite(`INSERT INTO auth_tokens (token_hash, email, expires_at, created_at)
                VALUES ('e2e-old-token', 'old@example.com', '2020-01-01T00:20:00Z', '2020-01-01T00:00:00Z')`);
  ctx.sqlWrite(`INSERT INTO webhook_events (event_id, status, received_at) VALUES ('evt_e2e_old', 'done', '2020-01-01T00:00:00Z')`);

  const status = await ctx.runCron();
  ctx.check('the scheduled handler runs', status === 200, `HTTP ${status}`);
  await new Promise((r) => setTimeout(r, 1500)); // scheduled() work runs in waitUntil

  const [swept] = ctx.sql(`SELECT status FROM bookings WHERE id = '${bookingId}'`);
  ctx.check('the lapsed hold is expired', swept.status === 'expired');
  const [returned] = ctx.sql(`SELECT remaining_cents FROM credits WHERE id = 'e2e-cron-credit'`);
  ctx.check('its credit is given back', returned.remaining_cents === 1000);

  const [entry] = ctx.sql(`SELECT status, note, offer_expires_at FROM waitlist WHERE id = 'e2e-wait-1'`);
  ctx.check('the lapsed offer is back to waiting with the lapse noted',
    entry.status === 'waiting' && entry.note.includes('Offer lapsed') && entry.offer_expires_at === null, JSON.stringify(entry));
  const [offerRow] = ctx.sql(`SELECT status FROM bookings WHERE id = '${offerId}'`);
  ctx.check("the offer's held booking is released", offerRow.status === 'expired');

  ctx.check('old sign-in tokens are purged', ctx.sql(`SELECT COUNT(*) AS n FROM auth_tokens WHERE token_hash = 'e2e-old-token'`)[0].n === 0);
  ctx.check('old webhook events are purged', ctx.sql(`SELECT COUNT(*) AS n FROM webhook_events WHERE event_id = 'evt_e2e_old'`)[0].n === 0);

  const second = await ctx.runCron();
  await new Promise((r) => setTimeout(r, 1000));
  const [stillWaiting] = ctx.sql(`SELECT status FROM waitlist WHERE id = 'e2e-wait-1'`);
  ctx.check('running the jobs again changes nothing', second === 200 && stillWaiting.status === 'waiting');
}

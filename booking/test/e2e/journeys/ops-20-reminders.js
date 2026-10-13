// Day-before reminders through the real scheduled() handler (parent-comms
// spec: "Cron runs twice in an hour → each booked family receives exactly one
// reminder"). A session five days out gets nothing; moved to +24 h it gets one
// reminder per confirmed booking, never a second; unpaid holds, cancelled
// weeks and cancelled sessions get none. Uses its own draft term.

import { createHash, randomBytes } from 'node:crypto';

export const title = 'Ops: day-before reminders';

const ADMIN = 'miniandco.classes@gmail.com';

// The owner's address may request only 3 sign-in links an hour (auth rate
// limit) and other journeys sign in as the owner too, so this journey mints
// the owner's web session directly. Sign-in itself is covered by core-20/50.
function ownerSession(ctx) {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  ctx.sqlWrite(`INSERT OR IGNORE INTO users (id, email, name, role, created_at)
                VALUES ('${randomBytes(16).toString('hex')}', '${ADMIN}', 'Owner', 'admin', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`);
  ctx.sqlWrite(`INSERT INTO web_sessions (session_hash, user_id, csrf_token, created_at, expires_at)
                SELECT '${hash}', id, '${csrf}', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+1 days')
                FROM users WHERE email = '${ADMIN}'`);
  return { cookie: `session=${token}`, csrf };
}
const PAID = 'e2e-ops-rem@example.com';
const UNPAID = 'e2e-ops-rem-unpaid@example.com';
const SKIPPED_WEEK = 'e2e-ops-rem-skip@example.com';
const TERM = 'ops-term-rem';
const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`;
const inHours = (h) => `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '${h >= 0 ? '+' : ''}${h} hours')`;

async function waitFor(ready, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await ready()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return ready();
}

export async function run(ctx) {
  ctx.sqlWrite(`INSERT INTO terms (id, class_id, name, starts_on, ends_on, term_price_cents, casual_price_cents, status, created_at)
                VALUES ('${TERM}', 'cls-wed-11', 'Ops Reminder Term', date('now', '+1 days'), date('now', '+5 days'), 9000, 3000, 'draft', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO class_sessions (id, class_id, term_id, starts_at, duration_mins, capacity, casual_price_cents, status, created_at) VALUES
                ('ops-rem-s1', 'cls-wed-11', '${TERM}', ${inHours(120)}, 45, 10, 3000, 'scheduled', ${NOW}),
                ('ops-rem-cx', 'cls-wed-11', '${TERM}', ${inHours(23)}, 45, 10, 3000, 'cancelled', ${NOW})`);
  const families = [[PAID, 'ops-rem-paid', 'Remy', 'confirmed'], [UNPAID, 'ops-rem-unpaid', 'Uma', 'pending'], [SKIPPED_WEEK, 'ops-rem-skip', 'Sol', 'confirmed']];
  for (const [email, id, child, status] of families) {
    ctx.sqlWrite(`INSERT INTO users (id, email, name, created_at) VALUES ('${id}-u', '${email}', 'Parent of ${child}', ${NOW})`);
    ctx.sqlWrite(`INSERT INTO children (id, user_id, name, dob, created_at) VALUES ('${id}-c', '${id}-u', '${child}', '2026-03-03', ${NOW})`);
    ctx.sqlWrite(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, list_amount_cents, amount_cents, payment_status, created_at, expires_at)
                  VALUES ('${id}-b', '${id}-u', '${id}-c', 'casual', '${TERM}', '${status}', 3000, 3000,
                          '${status === 'confirmed' ? 'paid' : 'unpaid'}', ${NOW}, ${status === 'pending' ? inHours(72) : 'NULL'})`);
    ctx.sqlWrite(`INSERT INTO booking_sessions (booking_id, session_id, status) VALUES
                  ('${id}-b', 'ops-rem-s1', '${id === 'ops-rem-skip' ? 'cancelled' : 'booked'}'),
                  ('${id}-b', 'ops-rem-cx', 'booked')`);
  }
  const reminders = (email) => ctx.sql(`SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = '${email}' AND subject LIKE 'Reminder:%'`)[0].n;

  // scheduled() runs its jobs in waitUntil, after the HTTP response. To know a
  // run has finished, plant a waitlist entry whose offer is already paid:
  // reconcileWaitlist — the last job — marks it booked. (The sentinel booking
  // has no sessions, so it never gets a reminder itself.)
  ctx.sqlWrite(`INSERT INTO users (id, email, created_at) VALUES ('ops-rem-sentinel-u', 'e2e-ops-rem-sentinel@example.com', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO children (id, user_id, name, dob, created_at) VALUES
                ('ops-rem-sentinel-c1', 'ops-rem-sentinel-u', 'Sentinel 1', '2026-03-03', ${NOW}),
                ('ops-rem-sentinel-c2', 'ops-rem-sentinel-u', 'Sentinel 2', '2026-03-03', ${NOW}),
                ('ops-rem-sentinel-c3', 'ops-rem-sentinel-u', 'Sentinel 3', '2026-03-03', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, amount_cents, created_at)
                VALUES ('ops-rem-sentinel-b', 'ops-rem-sentinel-u', 'ops-rem-sentinel-c1', 'casual', '${TERM}', 'confirmed', 0, ${NOW})`);
  let runs = 0;
  const cronRun = async () => {
    runs += 1;
    const id = `ops-rem-sentinel-${runs}`;
    ctx.sqlWrite(`INSERT INTO waitlist (id, term_id, user_id, child_id, status, joined_at, offer_booking_id)
                  VALUES ('${id}', '${TERM}', 'ops-rem-sentinel-u', 'ops-rem-sentinel-c${runs}', 'offered', ${NOW}, 'ops-rem-sentinel-b')`);
    const status = await ctx.runCron();
    const finished = await waitFor(() => ctx.sql(`SELECT status FROM waitlist WHERE id = '${id}'`)[0].status === 'booked');
    return { status, finished };
  };

  ctx.section('Five days out: nothing yet');
  const first = await cronRun();
  ctx.check('the scheduled jobs run to the end', first.status === 200 && first.finished, `HTTP ${first.status}`);
  ctx.check('no reminder five days ahead', reminders(PAID) === 0);

  ctx.section('Moved to tomorrow');
  ctx.sqlWrite(`UPDATE class_sessions SET starts_at = ${inHours(24)} WHERE id = 'ops-rem-s1'`);
  const second = await cronRun();
  ctx.check('the scheduled jobs run again', second.status === 200 && second.finished, `HTTP ${second.status}`);
  ctx.check('the paid family gets one reminder', reminders(PAID) === 1, `${reminders(PAID)} reminders`);
  const [mail] = await ctx.mailbox(PAID);
  ctx.check("the reminder names the child, the venue and the class time",
    mail.subject.startsWith("Reminder: Remy's class on") && mail.body.includes('Oran Park Library — Sandown Room')
      && mail.body.includes('Sensory Play — Wednesday 11:00 am') && /\d{1,2}:\d{2}\s?(am|pm)/.test(mail.body), mail.subject);
  ctx.check('it is logged with its dedupe key',
    ctx.sql(`SELECT COUNT(*) AS n FROM email_log WHERE dedupe_key = 'reminder:ops-rem-s1:ops-rem-paid-b' AND status = 'sent'`)[0].n === 1);

  const third = await cronRun();
  ctx.check('running the job again sends nothing new', third.finished && reminders(PAID) === 1);
  ctx.check('an unpaid hold gets no reminder', reminders(UNPAID) === 0);
  ctx.check('a cancelled week gets no reminder', reminders(SKIPPED_WEEK) === 0);
  ctx.check('a cancelled session gets no reminder',
    ctx.sql(`SELECT COUNT(*) AS n FROM email_log WHERE session_id = 'ops-rem-cx'`)[0].n === 0);

  ctx.section('In the email log');
  const { cookie: admin } = ownerSession(ctx);
  const log = await ctx.fetch(`/admin/email/log?template=reminder&q=${encodeURIComponent('e2e-ops-rem@')}`, { cookie: admin });
  ctx.check('the owner sees the reminder in the log', log.status === 200 && log.text.includes(PAID)
    && log.text.includes('Class reminder (day before)') && !log.text.includes(UNPAID));

  // Leave nothing that later journeys' cron runs could pick up.
  ctx.sqlWrite(`UPDATE class_sessions SET starts_at = ${inHours(-48)} WHERE term_id = '${TERM}'`);
}

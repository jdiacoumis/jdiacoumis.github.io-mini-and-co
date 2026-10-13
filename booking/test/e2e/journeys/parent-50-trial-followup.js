// Trial follow-up (parent-comms spec, D10) through the real scheduled()
// handler: the day after a trial class the family gets ONE email offering
// the rest of the term at the pro-rata price, with a link that opens that
// checkout. The trial booking is inserted directly because its class is
// already in the past.

export const title = 'Parent: trial follow-up the day after';

const EMAIL = 'e2e-pf-trial-followup@example.com';
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";
const at = (days) => `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '${days} days')`;
const TERM = 'term-pf-trial';

async function waitForMail(ctx, predicate, tries = 10) {
  for (let i = 0; i < tries; i += 1) {
    const mail = (await ctx.mailbox(EMAIL)).filter(predicate);
    if (mail.length) return mail;
    await new Promise((r) => setTimeout(r, 500));
  }
  return [];
}

export async function run(ctx) {
  // Six weekly classes; the first (the trial) was two days ago.
  ctx.sqlWrite(`INSERT INTO classes (id, name, description, venue, age_range, weekday, start_time, default_duration_mins,
                                     default_capacity, active, created_at)
                VALUES ('cls-pf-trial', 'PF Trial Class', 'An e2e class.', 'Test Hall', '3–12 months', 1, '10:00', 45, 12, 1, ${NOW})`);
  ctx.sqlWrite(`INSERT INTO terms (id, class_id, name, starts_on, ends_on, term_price_cents, casual_price_cents, trial_price_cents,
                                   plan_instalments, plan_interval, status, created_at)
                VALUES ('${TERM}', 'cls-pf-trial', 'Trial Term', date('now', '-2 days'), date('now', '33 days'), 16800, 3000, 2000,
                        6, 'week', 'open', ${NOW})`);
  const rows = Array.from({ length: 6 }, (_, i) => `('${TERM}-w${i + 1}', 'cls-pf-trial', '${TERM}', ${at(-2 + 7 * i)},
    45, 12, 3000, 'scheduled', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO class_sessions (id, class_id, term_id, starts_at, duration_mins, capacity, casual_price_cents, status, created_at)
                VALUES ${rows.join(', ')}`);

  const cookie = await ctx.signIn(EMAIL);
  const csrf = await ctx.csrfFor(cookie);
  await ctx.fetch('/account/children/new', {
    method: 'POST', cookie, body: { csrf, name: 'Tess', dob: '2025-09-30', medical: '', photo_consent: 'yes' },
  });
  const [user] = ctx.sql(`SELECT id FROM users WHERE email = '${EMAIL}'`);
  const [child] = ctx.sql(`SELECT id FROM children WHERE user_id = '${user.id}'`);
  ctx.sqlWrite(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, list_amount_cents, amount_cents, paid_cents,
                                      payment_method, payment_status, created_at)
                VALUES ('e2e-pf-trial-1', '${user.id}', '${child.id}', 'trial', '${TERM}', 'confirmed', 2000, 2000, 2000,
                        'full', 'paid', ${at(-5)})`);
  ctx.sqlWrite(`INSERT INTO booking_sessions (booking_id, session_id, status) VALUES ('e2e-pf-trial-1', '${TERM}-w1', 'booked')`);

  ctx.section('The day after the trial');
  ctx.check('the scheduled handler runs', (await ctx.runCron()) === 200);
  const isFollowUp = (m) => m.subject === "How was Tess's trial class? Join the rest of Trial Term";
  const mail = await waitForMail(ctx, isFollowUp);
  ctx.check('the family is offered the rest of the term', mail.length === 1, JSON.stringify((await ctx.mailbox(EMAIL)).map((m) => m.subject)));
  const body = mail[0] ? mail[0].body : '';
  ctx.check('at the pro-rata price for the weeks left',
    body.includes('the remaining 5 weeks of Trial Term for $140.00') && body.includes('5 weekly instalments'), body);
  const link = /http:\/\/[^\s]+\/book\/checkout\?kind=term&term=term-pf-trial&child=[A-Za-z0-9-]+/.exec(body)?.[0];
  ctx.check('with a link to book it and one to the class list', Boolean(link) && /See all our classes: http:\/\/\S+\/book\n/.test(body));
  const log = ctx.sql(`SELECT template, status FROM email_log WHERE dedupe_key = 'trial_followup:e2e-pf-trial-1'`);
  ctx.check('the send is logged once under its dedupe key', log.length === 1 && log[0].template === 'trial_followup' && log[0].status === 'sent');

  await ctx.runCron();
  await new Promise((r) => setTimeout(r, 1500));
  ctx.check('running the jobs again sends nothing more', (await ctx.mailbox(EMAIL)).filter(isFollowUp).length === 1);

  if (link) {
    const checkout = await ctx.fetch(link.replace(/^http:\/\/[^/]+/, ''), { cookie });
    ctx.check('the link opens the checkout for the remaining weeks',
      checkout.status === 200 && checkout.text.includes('Remaining 5 of 6 weeks') && checkout.text.includes('$140.00 AUD'));
  }

  ctx.sqlWrite(`UPDATE terms SET status = 'closed' WHERE id = '${TERM}'`);
}

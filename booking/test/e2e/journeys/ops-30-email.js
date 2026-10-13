// Owner-composed bulk email (parent-comms spec: "each parent receives it
// addressed only to them and the log shows every recipient"): compose for a
// term's families, preview (count + sample), send, a double-submit sends
// nothing more, the log lists each recipient; the waitlist audience; only
// the owner. Uses its own closed term so nothing appears on the class list.

import { createHash, randomBytes } from 'node:crypto';

export const title = 'Ops: bulk email and the email log';

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
const TERM = 'ops-term-bulk';
const TWO_KIDS = 'e2e-ops-bulk-1@example.com';
const ONE_KID = 'e2e-ops-bulk-2@example.com';
const LAPSED = 'e2e-ops-bulk-x@example.com';
const WAITING = 'e2e-ops-bulk-w@example.com';
const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`;

export async function run(ctx) {
  ctx.sqlWrite(`INSERT INTO terms (id, class_id, name, starts_on, ends_on, term_price_cents, casual_price_cents, status, created_at)
                VALUES ('${TERM}', 'cls-wed-13', 'Ops Bulk Term', date('now', '+60 days'), date('now', '+67 days'), 6000, 3000, 'closed', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO class_sessions (id, class_id, term_id, starts_at, duration_mins, capacity, casual_price_cents, status, created_at) VALUES
                ('ops-bulk-s1', 'cls-wed-13', '${TERM}', strftime('%Y-%m-%dT03:00:00Z', 'now', '+60 days'), 45, 12, 3000, 'scheduled', ${NOW}),
                ('ops-bulk-s2', 'cls-wed-13', '${TERM}', strftime('%Y-%m-%dT03:00:00Z', 'now', '+67 days'), 45, 12, 3000, 'scheduled', ${NOW})`);
  const people = [
    // [email, user id, parent name, [[child id, child name, booking status | null]]]
    [TWO_KIDS, 'ops-bulk-1', 'Bea', [['ops-bulk-1a', 'Ivy', 'confirmed'], ['ops-bulk-1b', 'Ned', 'confirmed']]],
    [ONE_KID, 'ops-bulk-2', 'Cal', [['ops-bulk-2a', 'Pip', 'confirmed']]],
    [LAPSED, 'ops-bulk-x', 'Dot', [['ops-bulk-xa', 'Rue', 'expired']]],
    [WAITING, 'ops-bulk-w', 'Eve', [['ops-bulk-wa', 'Tam', null]]],
  ];
  for (const [email, userId, name, children] of people) {
    ctx.sqlWrite(`INSERT INTO users (id, email, name, created_at) VALUES ('${userId}', '${email}', '${name}', ${NOW})`);
    for (const [childId, childName, status] of children) {
      ctx.sqlWrite(`INSERT INTO children (id, user_id, name, dob, created_at) VALUES ('${childId}', '${userId}', '${childName}', '2026-04-04', ${NOW})`);
      if (!status) {
        ctx.sqlWrite(`INSERT INTO waitlist (id, term_id, user_id, child_id, status, joined_at) VALUES ('${childId}-w', '${TERM}', '${userId}', '${childId}', 'waiting', ${NOW})`);
        continue;
      }
      ctx.sqlWrite(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, list_amount_cents, amount_cents, payment_status, created_at)
                    VALUES ('${childId}-b', '${userId}', '${childId}', 'term', '${TERM}', '${status}', 6000, 6000, 'paid', ${NOW})`);
      ctx.sqlWrite(`INSERT INTO booking_sessions (booking_id, session_id) VALUES ('${childId}-b', 'ops-bulk-s1'), ('${childId}-b', 'ops-bulk-s2')`);
    }
  }
  const subject = 'Ops bulk: theme change <this week>';
  const inbox = (email) => ctx.sql(`SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = '${email}' AND subject = '${subject.replace(/'/g, "''")}'`)[0].n;
  const message = { audience: 'term', term: TERM, subject, body: 'This week is all about <b>bubbles</b>.\n\nSee you on Wednesday!' };

  const { cookie: admin, csrf } = ownerSession(ctx);

  ctx.section('Compose and preview');
  const compose = await ctx.fetch(`/admin/email?audience=term&term=${TERM}`, { cookie: admin });
  ctx.check('the compose page preselects the term', compose.status === 200 && compose.text.includes(`value="${TERM}" selected`));
  const empty = await ctx.fetch('/admin/email/preview', { method: 'POST', cookie: admin, body: { csrf, ...message, subject: '' } });
  ctx.check('a message without a subject is sent back', empty.status === 400 && empty.text.includes('Please write a subject line.'));
  const preview = await ctx.fetch('/admin/email/preview', { method: 'POST', cookie: admin, body: { csrf, ...message } });
  ctx.check('the preview counts one email per family', preview.status === 200 && preview.text.includes('<strong>2 families</strong>')
    && preview.text.includes('Send to 2 families'));
  ctx.check('the preview greets a real family and escapes the text',
    /<p>Hi (Bea|Cal),<\/p>/.test(preview.text) && preview.text.includes('&lt;b&gt;bubbles&lt;/b&gt;') && !preview.text.includes('<b>bubbles</b>'));
  ctx.check('the preview lists who gets it', preview.text.includes(TWO_KIDS) && /Ivy, Ned|Ned, Ivy/.test(preview.text)
    && !preview.text.includes(LAPSED) && !preview.text.includes(WAITING));
  ctx.check('a preview sends nothing', inbox(TWO_KIDS) === 0 && inbox(ONE_KID) === 0);
  const batch = ctx.field(preview.text, 'batch');

  ctx.section('Send');
  const sent = await ctx.fetch('/admin/email/send', { method: 'POST', cookie: admin, body: { csrf, ...message, batch } });
  ctx.check('the email goes to each family', sent.status === 200 && sent.text.includes('Sent to 2 families.'));
  ctx.check('each parent gets exactly one copy, addressed to them', inbox(TWO_KIDS) === 1 && inbox(ONE_KID) === 1
    && (await ctx.mailbox(ONE_KID))[0].body.startsWith('Hi Cal,\n\nThis week is all about <b>bubbles</b>.'));
  ctx.check('families outside the term get nothing', inbox(LAPSED) === 0 && inbox(WAITING) === 0);
  const twice = await ctx.fetch('/admin/email/send', { method: 'POST', cookie: admin, body: { csrf, ...message, batch } });
  ctx.check('pressing Send again emails nobody twice', twice.text.includes('2 already had this email') && inbox(TWO_KIDS) === 1);

  ctx.section('The email log');
  const log = await ctx.fetch(`/admin/email/log?template=bulk&term=${TERM}`, { cookie: admin });
  ctx.check('the log shows every recipient', log.status === 200 && log.text.includes(TWO_KIDS) && log.text.includes(ONE_KID)
    && log.text.includes('Ops bulk: theme change &lt;this week&gt;') && !log.text.includes(LAPSED));
  ctx.check('logged once per parent with the term',
    ctx.sql(`SELECT COUNT(*) AS n FROM email_log WHERE template = 'bulk' AND term_id = '${TERM}' AND status = 'sent'`)[0].n === 2);

  ctx.section("The term's waitlist");
  const waitlist = await ctx.fetch('/admin/email/preview', { method: 'POST', cookie: admin, body: { csrf, ...message, audience: 'waitlist' } });
  ctx.check('the waitlist audience is the families waiting', waitlist.text.includes('<strong>1 family</strong>') && waitlist.text.includes(WAITING));

  ctx.section('Only the owner');
  const parent = await ctx.signIn(ONE_KID);
  const parentCsrf = await ctx.csrfFor(parent);
  ctx.check('a parent cannot open the email pages',
    (await ctx.fetch('/admin/email', { cookie: parent })).status === 403
      && (await ctx.fetch('/admin/email/log', { cookie: parent })).status === 403);
  const sneaky = await ctx.fetch('/admin/email/send', { method: 'POST', cookie: parent, body: { csrf: parentCsrf, ...message, batch: crypto.randomUUID() } });
  ctx.check('a parent cannot send', sneaky.status === 403 && inbox(TWO_KIDS) === 1);
  const forged = await ctx.fetch('/admin/email/send', { method: 'POST', cookie: admin, body: { csrf: 'forged', ...message, batch: crypto.randomUUID() } });
  ctx.check('sending needs the CSRF token', forged.status === 403 && inbox(TWO_KIDS) === 1);
}

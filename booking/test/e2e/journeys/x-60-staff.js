// Cross-feature (Phase 3): the facilitator's roster-only role across the
// whole admin area. A STAFF_EMAILS user opening /admin lands on the rosters
// page with a Rosters-only menu, opens a roster, marks a child present (who
// and when recorded), and is refused every other admin page and action; the
// owner's own menu lists Rosters, Credits and Vouchers.

import {
  STAFF, ownerSession, mintedSession, createTerm, NOW, q,
} from '../support.js';

export const title = 'Cross-feature: facilitator — rosters and attendance only';

export async function run(ctx) {
  const term = createTerm(ctx, 'st', { className: 'X Staff Class', weeks: 2, startInDays: 2 });
  const [session] = term.sessionIds;
  ctx.sqlWrite(`INSERT INTO users (id, email, name, phone, created_at) VALUES ('x-st-u', 'x-st-parent@example.com', 'Sam Parent', '0400000001', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO children (id, user_id, name, dob, medical_notes, photo_consent, created_at)
                VALUES ('x-st-c', 'x-st-u', 'Stevie', '2026-02-02', 'Dairy free', 0, ${NOW})`);
  ctx.sqlWrite(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, list_amount_cents, amount_cents, paid_cents,
                                      payment_status, photo_consent_snapshot, medical_notes_snapshot, created_at)
                VALUES ('x-st-b', 'x-st-u', 'x-st-c', 'term', ${q(term.termId)}, 'confirmed', 12000, 12000, 12000, 'paid', 0, 'Dairy free', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO booking_sessions (booking_id, session_id, status) SELECT 'x-st-b', id, 'booked' FROM class_sessions WHERE term_id = ${q(term.termId)}`);
  const staff = mintedSession(ctx, STAFF);
  const { cookie: admin } = await ownerSession(ctx);

  ctx.section('Lands on the rosters');
  const home = await ctx.fetch('/admin', { cookie: staff.cookie });
  ctx.check('/admin sends a facilitator to /admin/rosters', home.status === 303 && home.location === '/admin/rosters', home.location);
  const rosters = await ctx.fetch('/admin/rosters', { cookie: staff.cookie });
  ctx.check('the rosters page lists the class', rosters.status === 200 && rosters.text.includes('X Staff Class')
    && rosters.text.includes(`/admin/sessions/${session}/roster`));
  ctx.check('with a Rosters-only menu', rosters.text.includes('class="staff-nav"') && !rosters.text.includes('admin-nav')
    && !rosters.text.includes('href="/admin/credits"') && !rosters.text.includes('href="/admin/terms"') && !rosters.text.includes('>Admin<')
    && rosters.text.includes('<a class="site-nav__link" href="/admin/rosters">Rosters</a>'));

  ctx.section('Marks attendance');
  const roster = await ctx.fetch(`/admin/sessions/${session}/roster`, { cookie: staff.cookie });
  ctx.check('the roster shows the child, the notes and the buttons, but no booking links or export',
    roster.status === 200 && roster.text.includes('Stevie') && roster.text.includes('Dairy free') && roster.text.includes('attendance-form')
      && !roster.text.includes('/admin/bookings/') && !roster.text.includes('roster.csv') && roster.text.includes('class="staff-nav"'));
  const marked = await ctx.fetch(`/admin/sessions/${session}/attendance`, {
    method: 'POST', cookie: staff.cookie, body: { csrf: staff.csrf, booking: 'x-st-b', mark: 'present' },
  });
  ctx.check('Stevie is marked present', marked.status === 303 && marked.location.includes('ok=attendance-saved'), marked.location);
  const [mark] = ctx.sql(`SELECT bs.attendance, bs.attendance_marked_at, u.email FROM booking_sessions bs
                          LEFT JOIN users u ON u.id = bs.attendance_marked_by
                          WHERE bs.booking_id = 'x-st-b' AND bs.session_id = ${q(session)}`);
  ctx.check('who marked it and when are recorded', mark.attendance === 'present' && mark.email === STAFF && Boolean(mark.attendance_marked_at));
  const forged = await ctx.fetch(`/admin/sessions/${session}/attendance`, {
    method: 'POST', cookie: staff.cookie, body: { csrf: 'forged', booking: 'x-st-b', mark: 'absent' },
  });
  ctx.check('attendance needs the CSRF token', forged.status === 403);
  ctx.check('the owner sees the mark on the grid', (await ctx.fetch(`/admin/terms/${term.termId}`, { cookie: admin })).text.includes('grid-cell grid-present'));

  ctx.section('Everything else is refused');
  for (const path of ['/admin/terms', '/admin/bookings', '/admin/customers', `/admin/terms/${term.termId}`, '/admin/bookings/x-st-b',
    '/admin/credits', '/admin/vouchers', '/admin/attention', '/admin/waitlist', '/admin/email', '/admin/email/log', '/admin/import',
    '/admin/classes', `/admin/sessions/${session}/edit`]) {
    const res = await ctx.fetch(path, { cookie: staff.cookie });
    ctx.check(`GET ${path.replace('x-st-b', ':id').replace(session, ':session').replace(term.termId, ':term')} → 403`, res.status === 403, `HTTP ${res.status}`);
  }
  for (const [path, body] of [
    [`/admin/sessions/${session}/cancel`, { reason: 'x' }],
    ['/admin/bookings/x-st-b/record-payment', { amount: '5', nonce: crypto.randomUUID(), method: 'cash' }],
    [`/admin/sessions/${session}/roster.csv`, {}],
  ]) {
    const res = await ctx.fetch(path, { method: 'POST', cookie: staff.cookie, body: { csrf: staff.csrf, ...body } });
    ctx.check(`POST ${path.replace('x-st-b', ':id').replace(session, ':session')} → 403`, res.status === 403, `HTTP ${res.status}`);
  }
  ctx.check('nothing was paid or cancelled', ctx.sql(`SELECT COUNT(*) AS n FROM payments WHERE booking_id = 'x-st-b'`)[0].n === 0
    && ctx.sql(`SELECT status FROM class_sessions WHERE id = ${q(session)}`)[0].status === 'scheduled');

  ctx.section("The owner's menu");
  const ownerRosters = await ctx.fetch('/admin/rosters', { cookie: admin });
  ctx.check('lists Rosters, Credits and Vouchers with the rest', ownerRosters.text.includes('class="admin-nav"')
    && ['/admin/rosters', '/admin/credits', '/admin/vouchers', '/admin/terms', '/admin/attention'].every((p) => ownerRosters.text.includes(`href="${p}"`))
    && !ownerRosters.text.includes('class="staff-nav"'));
}

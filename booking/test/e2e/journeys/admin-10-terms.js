// Admin journey (Phase 2B): create a term for two classes at once — a
// Wednesday and a Monday class (review finding 7: the Monday sessions fall
// in the same weeks, and the holiday week is skipped for both) → manual
// bookings (offline, pay-later, complimentary, casual) →
// the term grid and its CSV → attendance by the owner and by a facilitator
// (staff) → consent withdrawn mid-term shows on the roster → move a week to
// the other class → cancel one week with a credit → cancel a session (credits
// for paid families) → edit the term, add/remove a week, open/close → re-run
// the term and auto-enrol the returning family (held booking + email).
//
// Self-contained: its own classes, terms and families, so the seed's Dev
// Terms (used by the core journeys) are untouched.

export const title = 'Admin: terms, grid, attendance, manual bookings, transfers, credits, re-run';

const ADMIN = 'miniandco.classes@gmail.com'; // ADMIN_EMAILS in .dev.vars
const STAFF = 'facilitator@example.com'; // STAFF_EMAILS in .dev.vars
const TERM_NAME = 'Admin Term 3 2030';

// One admin sign-in per run: the magic-link limit is 3 per address per hour.
export async function adminSession(ctx) {
  if (!ctx.adminCookie) ctx.adminCookie = await ctx.signIn(ADMIN);
  return ctx.adminCookie;
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// The first `weekday` (0 = Sunday) at least `minDays` from today (Sydney).
export function nextWeekday(ctx, weekday, minDays) {
  for (let n = minDays; n < minDays + 7; n += 1) {
    const date = ctx.sydneyDate(n);
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === weekday) return date;
  }
  throw new Error('no weekday found');
}

function sydneyClock(iso) {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(iso));
}

function sydneyDay(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

// Book a family in through the two-step manual booking form.
async function manualBooking(ctx, admin, csrf, { email, parentName, childName, dob, consent = 'yes', medical = '', kind, term, sessions = [], mode, received = '' }) {
  await ctx.fetch(`/admin/bookings/new?email=${encodeURIComponent(email)}`, { cookie: admin });
  const step1 = await ctx.fetch('/admin/bookings/new', {
    method: 'POST', cookie: admin,
    body: {
      csrf, email, parent_name: parentName, parent_phone: '0400111222', child: 'new', child_name: childName,
      child_dob: dob, medical, photo_consent: consent, kind, term,
    },
  });
  if (step1.status !== 303) throw new Error(`manual booking step 1 failed (HTTP ${step1.status}) ${step1.text.slice(0, 300)}`);
  const details = await ctx.fetch(step1.location, { cookie: admin });
  const params = new URL(step1.location, ctx.base).searchParams;
  const created = await ctx.fetch('/admin/bookings/new/details', {
    method: 'POST', cookie: admin,
    body: {
      csrf, user: params.get('user'), child: params.get('child'), kind, term, nonce: ctx.field(details.text, 'nonce'),
      session: sessions, mode, received, method: 'cash', note: '', intent: 'create',
    },
  });
  const bookingId = /\/admin\/bookings\/([a-f0-9-]{36})/.exec(created.location)?.[1];
  return { step1, details, created, bookingId, userId: params.get('user'), childId: params.get('child') };
}

export async function run(ctx) {
  const admin = await adminSession(ctx);
  const csrf = await ctx.csrfFor(admin);

  ctx.section('Two classes, one term form');
  // c10: Wednesdays 10:00 am (the class the form is for); c1130: Mondays
  // 11:30 am, created alongside it — an earlier weekday in the week.
  for (const [name, weekday, time] of [['Admin Test — Wednesday 10:00 am', '3', '10:00'], ['Admin Test — Monday 11:30 am', '1', '11:30']]) {
    await ctx.fetch('/admin/classes/new', {
      method: 'POST', cookie: admin,
      body: { csrf, name, description: 'E2E', venue: 'Test Hall', age_range: '3–12 months', weekday, start_time: time, default_duration_mins: '45', default_capacity: '8' },
    });
  }
  const classRows = ctx.sql(`SELECT id, name FROM classes WHERE name LIKE 'Admin Test — %'`);
  const c10 = classRows.find((r) => r.name.includes('Wednesday'))?.id;
  const c1130 = classRows.find((r) => r.name.includes('Monday'))?.id;
  ctx.check('two weekly-slot classes created', classRows.length === 2 && Boolean(c10) && Boolean(c1130));

  const start = nextWeekday(ctx, 3, 14);
  const holiday = addDays(start, 14); // the Wednesday of week 3
  const notInTerm = addDays(start, 70);
  const newForm = await ctx.fetch(`/admin/terms/new?class=${c10}`, { cookie: admin });
  ctx.check('new term form offers "also create for"', newForm.status === 200 && newForm.text.includes('Also create the same term for'));
  const termBody = {
    csrf, class_id: c10, also: c1130, name: TERM_NAME, starts_on: start, weeks: '6', ends_on: '', holidays: `${holiday}\n${notInTerm}`,
    term_price: '150', casual_price: '30', trial_price: '', returning_price: '135', returning_opens_at: '',
    public_opens_at: '', previous_term_id: 'auto', plan_instalments: '0', plan_interval: 'week',
  };
  const wrongDay = await ctx.fetch('/admin/terms/new', { method: 'POST', cookie: admin, body: { ...termBody, starts_on: addDays(start, 1) } });
  ctx.check('a first date on the wrong weekday is explained', wrongDay.status === 400 && wrongDay.text.includes('must be a Wednesday'));
  const created = await ctx.fetch('/admin/terms/new', { method: 'POST', cookie: admin, body: termBody });
  ctx.check('terms created for both classes', created.status === 303 && created.location.includes('ok=terms-created'), created.location);
  ctx.check('the holiday outside the term is reported, not silently used', created.location.endsWith(`&unused=${notInTerm}`)
    && (await ctx.fetch(created.location, { cookie: admin })).text.includes('not in any week of the term'), created.location);
  const terms = ctx.sql(`SELECT id, class_id, status, starts_on, ends_on, previous_term_id FROM terms WHERE name = '${TERM_NAME}' ORDER BY class_id = '${c10}' DESC`);
  const t10 = terms.find((t) => t.class_id === c10);
  const t1130 = terms.find((t) => t.class_id === c1130);
  ctx.check('one draft term per class', terms.length === 2 && terms.every((t) => t.status === 'draft'), JSON.stringify(terms));
  const s10 = ctx.sql(`SELECT id, starts_at FROM class_sessions WHERE term_id = '${t10.id}' ORDER BY starts_at`);
  const s1130 = ctx.sql(`SELECT id, starts_at FROM class_sessions WHERE term_id = '${t1130.id}' ORDER BY starts_at`);
  ctx.check('six weeks with a holiday make five sessions per class', s10.length === 5 && s1130.length === 5);
  ctx.check('the holiday week has no session in either class',
    !s10.some((s) => sydneyDay(s.starts_at) === holiday) && !s1130.some((s) => sydneyDay(s.starts_at) === addDays(holiday, -2)));
  const mondays = [0, 7, 21, 28, 35].map((d) => addDays(start, d - 2));
  ctx.check('the Monday class runs in the same weeks — two days before each Wednesday, not the week after',
    JSON.stringify(s1130.map((s) => sydneyDay(s.starts_at))) === JSON.stringify(mondays)
      && t1130.starts_on === addDays(start, -2) && t1130.ends_on === addDays(start, 33), JSON.stringify(s1130.map((s) => sydneyDay(s.starts_at))));
  ctx.check('every session starts at the class time in Sydney',
    s10.every((s) => sydneyClock(s.starts_at) === '10:00') && s1130.every((s) => sydneyClock(s.starts_at) === '11:30'));
  ctx.check('term dates are the first and last class', t10.starts_on === start && t10.ends_on === addDays(start, 35));
  const [w1, w2, , w5, w6] = s10.map((s) => s.id);

  ctx.section('Manual bookings');
  const missing = await ctx.fetch('/admin/bookings/new?email=e2e-admin-a%40example.com', { cookie: admin });
  ctx.check('an unknown email offers to create the family', missing.text.includes('No account uses'));
  const a = await manualBooking(ctx, admin, csrf, {
    email: 'e2e-admin-a@example.com', parentName: 'Alex Able', childName: 'Ada', dob: '2025-12-01', medical: 'Egg allergy',
    kind: 'term', term: t10.id, mode: 'offline',
  });
  ctx.check('step 2 shows the term price', a.details.status === 200 && a.details.text.includes('$150.00'));
  ctx.check('offline booking confirmed', a.created.status === 303 && a.created.location.includes('ok=created-offline'), a.created.location);
  const [aRow] = ctx.sql(`SELECT status, payment_status, payment_method, paid_cents, amount_cents,
                            (SELECT COUNT(*) FROM booking_sessions WHERE booking_id = b.id AND status = 'booked') AS weeks
                          FROM bookings b WHERE id = '${a.bookingId}'`);
  ctx.check('it covers all five weeks and is paid', aRow && aRow.status === 'confirmed' && aRow.payment_status === 'paid'
    && aRow.payment_method === 'offline' && aRow.paid_cents === 15000 && aRow.weeks === 5, JSON.stringify(aRow));
  const aMail = ctx.sql(`SELECT template FROM email_log WHERE booking_id = '${a.bookingId}'`).map((r) => r.template);
  ctx.check('the family gets a receipt and a confirmation', aMail.includes('offline_receipt') && aMail.includes('booking_confirmed'), aMail.join());

  const b = await manualBooking(ctx, admin, csrf, {
    email: 'e2e-admin-b@example.com', parentName: 'Bea Bright', childName: 'Ben', dob: '2025-11-11', kind: 'term', term: t10.id, mode: 'paylater',
  });
  ctx.check('pay-later booking held', b.created.location.includes('ok=created-paylater'), b.created.location);
  const [bRow] = ctx.sql(`SELECT status, amount_cents, CAST((julianday(expires_at) - julianday(created_at)) AS INTEGER) AS hold_days FROM bookings WHERE id = '${b.bookingId}'`);
  ctx.check('it is pending with a 7-day hold', bRow && bRow.status === 'pending' && bRow.amount_cents === 15000 && bRow.hold_days === 7, JSON.stringify(bRow));
  const bMail = await ctx.mailbox('e2e-admin-b@example.com');
  ctx.check('the parent is asked to sign in and press Pay now',
    bMail.some((m) => m.subject.includes('please pay by') && m.body.includes('Pay now') && m.body.includes('/account')));

  const c = await manualBooking(ctx, admin, csrf, {
    email: 'e2e-admin-c@example.com', parentName: 'Cal Cole', childName: 'Cleo', dob: '2025-10-10', kind: 'term', term: t10.id, mode: 'comp',
  });
  const [cRow] = ctx.sql(`SELECT kind, status, payment_status, amount_cents FROM bookings WHERE id = '${c.bookingId}'`);
  ctx.check('complimentary booking confirmed with nothing owed',
    cRow && cRow.kind === 'complimentary' && cRow.status === 'confirmed' && cRow.payment_status === 'waived' && cRow.amount_cents === 0, JSON.stringify(cRow));

  const d = await manualBooking(ctx, admin, csrf, {
    email: 'e2e-admin-d@example.com', parentName: 'Dee Dunn', childName: 'Dev', dob: '2026-01-05', kind: 'casual', term: t10.id,
    sessions: [w6], mode: 'offline',
  });
  ctx.check('the casual step lists the term weeks to choose from', d.details.text.includes(`value="${w6}"`));
  const [dRow] = ctx.sql(`SELECT kind, status, paid_cents FROM bookings WHERE id = '${d.bookingId}'`);
  ctx.check('casual booking confirmed and paid', dRow && dRow.kind === 'casual' && dRow.status === 'confirmed' && dRow.paid_cents === 3000, JSON.stringify(dRow));
  const preview = await ctx.fetch('/admin/bookings/new/details', {
    method: 'POST', cookie: admin,
    body: { csrf, user: d.userId, child: d.childId, kind: 'casual', term: t10.id, session: [w5], mode: 'offline', price: '25', intent: 'preview' },
  });
  ctx.check('"Update price" previews an override without booking', preview.status === 200 && preview.text.includes('$25.00')
    && ctx.sql(`SELECT COUNT(*) AS n FROM bookings WHERE child_id = '${d.childId}'`)[0].n === 1);
  const found = await ctx.fetch('/admin/bookings/new?email=E2E-Admin-D%40example.com', { cookie: admin });
  ctx.check('an existing family is found by email (any case)', found.text.includes('Found') && found.text.includes(`value="${d.childId}"`));
  const reuse = await ctx.fetch('/admin/bookings/new', {
    method: 'POST', cookie: admin, body: { csrf, email: ' E2E-Admin-D@example.com', child: d.childId, kind: 'casual', term: t10.id },
  });
  ctx.check('an existing parent and child are reused (no duplicates)',
    reuse.status === 303 && new URL(reuse.location, ctx.base).searchParams.get('user') === d.userId
      && ctx.sql(`SELECT COUNT(*) AS n FROM users WHERE email = 'e2e-admin-d@example.com'`)[0].n === 1
      && ctx.sql(`SELECT COUNT(*) AS n FROM children WHERE user_id = '${d.userId}'`)[0].n === 1);

  ctx.section('Term grid');
  const grid = await ctx.fetch(`/admin/terms/${t10.id}`, { cookie: admin });
  ctx.check('grid lists every family', grid.status === 200 && ['Ada', 'Ben', 'Cleo', 'Dev'].every((n) => grid.text.includes(n)));
  ctx.check('grid shows payment states', grid.text.includes('>Paid<') && grid.text.includes('Unpaid $150.00 — pay-later until') && grid.text.includes('>Comp<'));
  ctx.check('grid shows seats left per week', /Seats left<\/th>\s*<td class="grid-seats">5<\/td>/.test(grid.text));
  ctx.check('grid links each week to its roster', grid.text.includes(`/admin/sessions/${w1}/roster`));
  const gridCsv = await ctx.fetch(`/admin/terms/${t10.id}/grid.csv`, { method: 'POST', cookie: admin, body: { csrf } });
  ctx.check('grid CSV exports', gridCsv.status === 200 && gridCsv.text.startsWith('"Child"') && gridCsv.text.includes('"Ada"'));

  ctx.section('Attendance: owner and facilitator');
  const roster = await ctx.fetch(`/admin/sessions/${w1}/roster`, { cookie: admin });
  ctx.check('roster shows attendance buttons and the medical note', roster.text.includes('attendance-form') && roster.text.includes('Egg allergy'));
  const markA = await ctx.fetch(`/admin/sessions/${w1}/attendance`, { method: 'POST', cookie: admin, body: { csrf, booking: a.bookingId, mark: 'present' } });
  ctx.check('owner marks a child present', markA.status === 303 && markA.location.includes('ok=attendance-saved'), markA.location);
  const staff = await ctx.signIn(STAFF);
  const staffCsrf = await ctx.csrfFor(staff);
  const staffHome = await ctx.fetch('/admin', { cookie: staff });
  ctx.check('a facilitator opening /admin lands on the rosters page', staffHome.status === 303 && staffHome.location === '/admin/rosters', staffHome.location);
  const rosters = await ctx.fetch('/admin/rosters', { cookie: staff });
  ctx.check('the rosters page lists the coming sessions', rosters.status === 200 && rosters.text.includes('Admin Test — Wednesday 10:00 am') && !rosters.text.includes('admin-nav'));
  const staffRoster = await ctx.fetch(`/admin/sessions/${w1}/roster`, { cookie: staff });
  ctx.check('the facilitator roster has buttons but no admin links or export',
    staffRoster.status === 200 && staffRoster.text.includes('attendance-form') && !staffRoster.text.includes('admin-nav') && !staffRoster.text.includes('roster.csv'));
  const markB = await ctx.fetch(`/admin/sessions/${w1}/attendance`, { method: 'POST', cookie: staff, body: { csrf: staffCsrf, booking: b.bookingId, mark: 'absent' } });
  ctx.check('the facilitator marks a child absent', markB.status === 303 && markB.location.includes('ok=attendance-saved'));
  const marks = ctx.sql(`SELECT b.id, bs.attendance, u.email AS by_email, bs.attendance_marked_at FROM booking_sessions bs
                         JOIN bookings b ON b.id = bs.booking_id LEFT JOIN users u ON u.id = bs.attendance_marked_by
                         WHERE bs.session_id = '${w1}' AND bs.attendance IS NOT NULL ORDER BY bs.attendance DESC`);
  ctx.check('who marked and when are recorded',
    marks.length === 2 && marks[0].attendance === 'present' && marks[0].by_email === ADMIN && marks[1].attendance === 'absent'
      && marks[1].by_email === STAFF && marks.every((m) => m.attendance_marked_at), JSON.stringify(marks));
  const gridAfter = await ctx.fetch(`/admin/terms/${t10.id}`, { cookie: admin });
  ctx.check('the grid shows ✓ and ✗', gridAfter.text.includes('grid-cell grid-present') && gridAfter.text.includes('grid-cell grid-absent'));
  for (const path of ['/admin/terms', `/admin/terms/${t10.id}`, '/admin/bookings/new', '/admin/credits', `/admin/bookings/${a.bookingId}`, '/admin/vouchers']) {
    ctx.check(`a facilitator is denied ${path.replace(/[a-f0-9-]{36}/, ':id')}`, (await ctx.fetch(path, { cookie: staff })).status === 403);
  }
  const staffCancel = await ctx.fetch(`/admin/sessions/${w6}/cancel`, { method: 'POST', cookie: staff, body: { csrf: staffCsrf, reason: 'x' } });
  ctx.check('a facilitator cannot cancel a session', staffCancel.status === 403);

  ctx.section('Consent withdrawn mid-term');
  await ctx.fetch(`/admin/children/${a.childId}/edit`, {
    method: 'POST', cookie: admin, body: { csrf, name: 'Ada', dob: '2025-12-01', medical: 'Egg allergy', photo_consent: 'no' },
  });
  const consentRoster = await ctx.fetch(`/admin/sessions/${w5}/roster`, { cookie: admin });
  const adaRow = /<tr id="b-[^"]+"[^>]*>[\s\S]*?Ada[\s\S]*?<\/tr>/.exec(consentRoster.text)?.[0] || '';
  ctx.check('the roster shows No although the booking snapshot said Yes', adaRow.includes('consent-no') && adaRow.includes('changed since booking'));

  ctx.section('Move a week to the other class');
  const [w2b] = s1130.slice(1).map((s) => s.id);
  const transferPage = await ctx.fetch(`/admin/bookings/${a.bookingId}/transfer?session=${w2}`, { cookie: admin });
  ctx.check('the move page lists the Monday class that week', transferPage.status === 200 && transferPage.text.includes(`value="${w2b}"`));
  const moved = await ctx.fetch(`/admin/bookings/${a.bookingId}/transfer`, { method: 'POST', cookie: admin, body: { csrf, from: w2, to: w2b } });
  ctx.check('week moved', moved.status === 303 && moved.location.includes('ok=transferred'), moved.location);
  const rows = ctx.sql(`SELECT session_id, status FROM booking_sessions WHERE booking_id = '${a.bookingId}' AND session_id IN ('${w2}', '${w2b}')`);
  ctx.check('the Wednesday seat is released and the Monday seat taken',
    rows.find((r) => r.session_id === w2)?.status === 'transferred_out' && rows.find((r) => r.session_id === w2b)?.status === 'booked', JSON.stringify(rows));
  ctx.check('the Monday roster lists the child', (await ctx.fetch(`/admin/sessions/${w2b}/roster`, { cookie: admin })).text.includes('Ada'));
  ctx.check('no money changed', ctx.sql(`SELECT paid_cents FROM bookings WHERE id = '${a.bookingId}'`)[0].paid_cents === 15000);
  const dupMove = await ctx.fetch(`/admin/bookings/${a.bookingId}/transfer`, { method: 'POST', cookie: admin, body: { csrf, from: w5, to: w2b } });
  ctx.check('a move into a class the child already has is refused', dupMove.status === 409 && dupMove.text.includes('already booked'));

  ctx.section('Cancel one week with a credit');
  const weekPage = await ctx.fetch(`/admin/bookings/${a.bookingId}/cancel-week?session=${w5}`, { cookie: admin });
  ctx.check('one week of the term is offered as the credit', weekPage.status === 200 && ctx.field(weekPage.text, 'credit') === '30.00');
  const weekCancelled = await ctx.fetch(`/admin/bookings/${a.bookingId}/cancel-week`, {
    method: 'POST', cookie: admin, body: { csrf, session: w5, credit: '30.00', reason: 'Away', expires: '' },
  });
  ctx.check('week cancelled with a credit', weekCancelled.location.includes('ok=week-cancelled-credit'), weekCancelled.location);
  const weekCredit = ctx.sql(`SELECT amount_cents, remaining_cents, child_id FROM credits WHERE source_booking_id = '${a.bookingId}' AND source_session_id = '${w5}'`);
  ctx.check('the credit is on the family account for that child', weekCredit.length === 1 && weekCredit[0].amount_cents === 3000 && weekCredit[0].child_id === a.childId);

  ctx.section('Cancel a session');
  const cancelPage = await ctx.fetch(`/admin/sessions/${w6}/cancel`, { cookie: admin });
  ctx.check('the confirm page lists each family and credit', cancelPage.status === 200 && cancelPage.text.includes('Ben')
    && cancelPage.text.includes('No credit') && cancelPage.text.includes('$60.00 in total')
    && cancelPage.text.includes('Price reduced by $30.00') && cancelPage.text.includes(`name="credit_${a.bookingId}" value="30.00"`));
  const noReason = await ctx.fetch(`/admin/sessions/${w6}/cancel`, { method: 'POST', cookie: admin, body: { csrf, reason: '' } });
  ctx.check('a reason is required', noReason.status === 400);
  const cancelled = await ctx.fetch(`/admin/sessions/${w6}/cancel`, { method: 'POST', cookie: admin, body: { csrf, reason: 'Venue closed' } });
  ctx.check('session cancelled with two credits', cancelled.status === 200 && cancelled.text.includes('2 credits issued'));
  const [sess] = ctx.sql(`SELECT status, cancelled_reason FROM class_sessions WHERE id = '${w6}'`);
  ctx.check('the session is cancelled with the reason', sess.status === 'cancelled' && sess.cancelled_reason === 'Venue closed');
  const w6Rows = ctx.sql(`SELECT status FROM booking_sessions WHERE session_id = '${w6}'`);
  ctx.check('every family place in it is cancelled', w6Rows.length === 4 && w6Rows.every((r) => r.status === 'cancelled'), JSON.stringify(w6Rows));
  const w6Credits = ctx.sql(`SELECT source_booking_id, amount_cents FROM credits WHERE source_session_id = '${w6}' ORDER BY source_booking_id`);
  ctx.check('paid families are credited (term per week, casual what they paid)',
    w6Credits.length === 2 && w6Credits.every((cr) => cr.amount_cents === 3000)
      && w6Credits.some((cr) => cr.source_booking_id === a.bookingId) && w6Credits.some((cr) => cr.source_booking_id === d.bookingId), JSON.stringify(w6Credits));
  const notices = ctx.sql(`SELECT booking_id FROM email_log WHERE session_id = '${w6}' AND template = 'session_cancelled' ORDER BY booking_id`);
  ctx.check('each of the four families got the class-cancelled notice (the owner summary is separate)',
    notices.length === 4 && [a, b, c, d].every((x) => notices.some((n) => n.booking_id === x.bookingId)), JSON.stringify(notices));
  ctx.check('the owner got the summary', ctx.sql(`SELECT COUNT(*) AS n FROM email_log WHERE session_id = '${w6}' AND template = 'owner_session_cancelled'`)[0].n === 1);
  const [benHold] = ctx.sql(`SELECT status, list_amount_cents, amount_cents FROM bookings WHERE id = '${b.bookingId}'`);
  ctx.check("the unpaid hold costs a week less, and Ben's family is told (review finding 8)",
    benHold.status === 'pending' && benHold.amount_cents === 12000 && benHold.list_amount_cents === 12000
      && (await ctx.mailbox('e2e-admin-b@example.com')).some((m) => m.subject.startsWith('Class cancelled') && m.body.includes("it's now $120.00")),
    JSON.stringify(benHold));
  const gridCancelled = await ctx.fetch(`/admin/terms/${t10.id}`, { cookie: admin });
  ctx.check('the grid marks the cancelled week', gridCancelled.text.includes('grid-week-cancelled') && gridCancelled.text.includes('grid-cell grid-moved'));

  ctx.section('Edit the term, add and remove weeks, open and close');
  const edit = await ctx.fetch(`/admin/terms/${t1130.id}/edit`, { cookie: admin });
  ctx.check('edit page lists the weeks', edit.status === 200 && edit.text.includes('Add week'));
  const saved = await ctx.fetch(`/admin/terms/${t1130.id}/edit`, {
    method: 'POST', cookie: admin,
    body: {
      csrf, name: TERM_NAME, term_price: '160', casual_price: '32', trial_price: '', returning_price: '135',
      returning_opens_at: '', public_opens_at: '', previous_term_id: '', plan_instalments: '0', plan_interval: 'week', apply_casual: '1',
    },
  });
  ctx.check('term saved', saved.status === 303 && saved.location.includes('ok=term-updated'));
  const [t1130Row] = ctx.sql(`SELECT term_price_cents FROM terms WHERE id = '${t1130.id}'`);
  const casualPrices = ctx.sql(`SELECT DISTINCT casual_price_cents AS p FROM class_sessions WHERE term_id = '${t1130.id}'`);
  ctx.check('new prices apply to the term and its upcoming weeks', t1130Row.term_price_cents === 16000 && casualPrices.length === 1 && casualPrices[0].p === 3200);
  ctx.check('existing bookings keep their price', ctx.sql(`SELECT amount_cents FROM bookings WHERE id = '${a.bookingId}'`)[0].amount_cents === 15000);
  const extra = addDays(start, 40); // a Monday, for the Monday class
  const added = await ctx.fetch(`/admin/terms/${t1130.id}/add-week`, { method: 'POST', cookie: admin, body: { csrf, date: extra } });
  const [extraSession] = ctx.sql(`SELECT id, starts_at FROM class_sessions WHERE term_id = '${t1130.id}' ORDER BY starts_at DESC LIMIT 1`);
  ctx.check('a week is added at the class time', added.location.includes('ok=week-added') && sydneyDay(extraSession.starts_at) === extra
    && sydneyClock(extraSession.starts_at) === '11:30');
  ctx.check('the term end date follows', ctx.sql(`SELECT ends_on FROM terms WHERE id = '${t1130.id}'`)[0].ends_on === extra);
  const removed = await ctx.fetch(`/admin/terms/${t1130.id}/remove-week`, { method: 'POST', cookie: admin, body: { csrf, session: extraSession.id } });
  ctx.check('an unbooked week can be removed', removed.location.includes('ok=week-removed')
    && ctx.sql(`SELECT COUNT(*) AS n FROM class_sessions WHERE id = '${extraSession.id}'`)[0].n === 0);
  const refused = await ctx.fetch(`/admin/terms/${t1130.id}/remove-week`, { method: 'POST', cookie: admin, body: { csrf, session: w2b } });
  ctx.check('a week with bookings cannot be removed', refused.location.includes('err=week-has-bookings'));
  const opened = await ctx.fetch(`/admin/terms/${t10.id}/status`, { method: 'POST', cookie: admin, body: { csrf, status: 'open' } });
  ctx.check('term opened', opened.location.includes('ok=status-open') && (await ctx.fetch('/book')).text.includes(TERM_NAME));
  await ctx.fetch(`/admin/terms/${t10.id}/status`, { method: 'POST', cookie: admin, body: { csrf, status: 'closed' } });
  ctx.check('term closed', !(await ctx.fetch('/book')).text.includes(TERM_NAME));
  const list = await ctx.fetch('/admin/terms', { cookie: admin });
  ctx.check('terms list shows both classes', list.status === 200 && list.text.includes('Admin Test — Monday 11:30 am') && list.text.includes(TERM_NAME));

  ctx.section('Re-run the term and auto-enrol');
  const rerunForm = await ctx.fetch(`/admin/terms/${t10.id}/rerun`, { cookie: admin });
  const nextStart = addDays(start, 56);
  ctx.check('re-run is prefilled with the next name and shifted dates',
    ctx.field(rerunForm.text, 'name') === 'Admin Term 4 2030' && ctx.field(rerunForm.text, 'starts_on') === nextStart
      && ctx.field(rerunForm.text, 'weeks') === '6' && ctx.field(rerunForm.text, 'returning_price') === '135.00');
  const publicOpens = `${ctx.sydneyDate(9)}T09:00`;
  const fields = ['name', 'starts_on', 'weeks', 'term_price', 'casual_price', 'trial_price', 'returning_price', 'returning_opens_at', 'previous_term_id', 'plan_instalments'];
  const rerunBody = Object.fromEntries(fields.map((f) => [f, ctx.field(rerunForm.text, f)]));
  const rerun = await ctx.fetch(`/admin/terms/${t10.id}/rerun`, {
    method: 'POST', cookie: admin, body: { ...rerunBody, csrf, ends_on: '', holidays: '', public_opens_at: publicOpens, plan_interval: 'week' },
  });
  ctx.check('new draft term created, then the auto-enrol page', rerun.status === 303 && rerun.location.includes('/auto-enrol?ok=rerun-created'), rerun.location);
  const [next] = ctx.sql(`SELECT id, status, previous_term_id, public_opens_at, starts_on,
                            (SELECT COUNT(*) FROM class_sessions WHERE term_id = t.id) AS weeks
                          FROM terms t WHERE name = 'Admin Term 4 2030' AND class_id = '${c10}'`);
  ctx.check('the copy is a draft linked to the source', next && next.status === 'draft' && next.previous_term_id === t10.id
    && next.starts_on === nextStart && next.weeks === 6, JSON.stringify(next));
  const enrolPage = await ctx.fetch(`/admin/terms/${next.id}/auto-enrol`, { cookie: admin });
  ctx.check('the term family is ticked', enrolPage.text.includes(`name="child" value="${a.childId}" checked`));
  ctx.check('complimentary and casual families are listed but not ticked',
    enrolPage.text.includes(`name="child" value="${c.childId}" `) && !enrolPage.text.includes(`value="${c.childId}" checked`)
      && enrolPage.text.includes(`name="child" value="${d.childId}" `) && !enrolPage.text.includes(`value="${d.childId}" checked`));
  ctx.check('an unpaid hold is not a returning family', !enrolPage.text.includes(`value="${b.childId}"`));
  const enrolled = await ctx.fetch(`/admin/terms/${next.id}/auto-enrol`, { method: 'POST', cookie: admin, body: { csrf, child: a.childId } });
  ctx.check('a place is held and the invitation sent', enrolled.status === 200 && enrolled.text.includes('invitation sent'));
  const held = ctx.sql(`SELECT status, kind, list_amount_cents, credit_cents, amount_cents, expires_at FROM bookings WHERE term_id = '${next.id}' AND child_id = '${a.childId}'`);
  ctx.check('pending at the returning price, account credit applied, held until public opening',
    held.length === 1 && held[0].status === 'pending' && held[0].kind === 'term' && held[0].list_amount_cents === 13500
      && held[0].credit_cents === 6000 && held[0].amount_cents === 7500 && held[0].expires_at === next.public_opens_at, JSON.stringify(held));
  const invitations = () => ctx.sql(`SELECT to_email, status FROM email_log WHERE template = 'reenrol_invitation' AND term_id = '${next.id}'`);
  const sent = invitations();
  ctx.check('the re-enrol invitation went to the parent', sent.length === 1 && sent[0].to_email === 'e2e-admin-a@example.com' && sent[0].status === 'sent',
    JSON.stringify(sent));
  const repeat = await ctx.fetch(`/admin/terms/${next.id}/auto-enrol`, { method: 'POST', cookie: admin, body: { csrf, child: a.childId } });
  ctx.check('running it again holds nothing twice and sends no second email', repeat.text.includes('already has a place')
    && ctx.sql(`SELECT COUNT(*) AS n FROM bookings WHERE term_id = '${next.id}'`)[0].n === 1 && invitations().length === 1);
  ctx.check('the seat is held in the new term', (await ctx.fetch(`/admin/terms/${next.id}`, { cookie: admin })).text.includes('Ada'));
}

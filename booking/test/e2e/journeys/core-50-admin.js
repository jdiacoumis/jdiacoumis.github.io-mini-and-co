// Admin journey on the term model: dashboard and new admin pages, class with
// a weekly slot, weekly-repeat sessions in a term (Sydney wall clock),
// rosters, record an offline payment, cancel, import enrolments by term,
// exports.

export const title = 'Admin: schedule, sessions, payments, import';

const ADMIN = 'miniandco.classes@gmail.com'; // ADMIN_EMAILS in .dev.vars
const OFFLINE_PARENT = 'e2e-offline@example.com';

export async function run(ctx) {
  const admin = await ctx.signIn(ADMIN);
  const csrf = await ctx.csrfFor(admin);

  ctx.section('Dashboard and navigation');
  const dash = await ctx.fetch('/admin', { cookie: admin });
  ctx.check('dashboard lists sessions with fullness', dash.status === 200 && /\d+\/\d+/.test(dash.text) && dash.text.includes('Dev Term'));
  for (const link of ['/admin/terms', '/admin/attention', '/admin/waitlist', '/admin/email']) {
    ctx.check(`admin nav links ${link}`, dash.text.includes(`href="${link}"`));
  }
  for (const path of ['/admin/terms', '/admin/bookings/new', '/admin/attention', '/admin/waitlist', '/admin/email']) {
    const page = await ctx.fetch(path, { cookie: admin });
    ctx.check(`${path} renders`, page.status === 200);
  }
  ctx.check('admin pages never load the pixel', !dash.text.includes('booking-pixel.js'));

  ctx.section('Classes and sessions');
  const newClass = await ctx.fetch('/admin/classes/new', {
    method: 'POST', cookie: admin,
    body: { csrf, name: 'E2E Class', description: 'Test', venue: 'Test Hall', age_range: '0-1', weekday: '3', start_time: '09:30', default_duration_mins: '45', default_capacity: '8' },
  });
  ctx.check('class created', newClass.status === 303);
  const classes = await ctx.fetch('/admin/classes', { cookie: admin });
  ctx.check('classes page shows the weekly slot and terms', classes.text.includes('Wednesdays at 09:30') && classes.text.includes('Dev Term'));

  const sessionsPage = await ctx.fetch('/admin/sessions/new', { cookie: admin });
  const classId = /<option value="([^"]+)"[^>]*>E2E Class/.exec(sessionsPage.text)?.[1];
  const wrongTerm = await ctx.fetch('/admin/sessions/new', {
    method: 'POST', cookie: admin,
    body: { csrf, class_id: classId, term_id: 'term-dev-11', date: ctx.sydneyDate(30), time: '09:30', duration: '45', capacity: '8', price: '30', repeat: '1' },
  });
  ctx.check("a session can't join another class's term", wrongTerm.status === 400 && wrongTerm.text.includes('belongs to a different class'));
  const repeat = await ctx.fetch('/admin/sessions/new', {
    method: 'POST', cookie: admin,
    body: { csrf, class_id: classId, term_id: '', date: ctx.sydneyDate(30), time: '09:30', duration: '45', capacity: '8', price: '30', repeat: '4' },
  });
  ctx.check('weekly repeat created', repeat.status === 303);
  const filtered = await ctx.fetch(`/admin?class=${classId}`, { cookie: admin });
  const nineThirty = (filtered.text.match(/9:30\s?am/gi) || []).length;
  ctx.check('4 repeated sessions render at 9:30 am Sydney', nineThirty === 4, `found ${nineThirty}`);

  ctx.section('Rosters');
  const roster = await ctx.fetch('/admin/sessions/ses-11-w1/roster', { cookie: admin });
  ctx.check('roster lists the term family with the snapshot and payment',
    roster.text.includes('Edie') && roster.text.includes('Dairy intolerance') && roster.text.includes('Paid'));
  const rosterCsv = await ctx.fetch('/admin/sessions/ses-11-w1/roster.csv', { method: 'POST', cookie: admin, body: { csrf } });
  ctx.check('roster CSV exports', rosterCsv.status === 200 && rosterCsv.text.includes('"Edie"'));

  ctx.section('Record an offline payment');
  const parent = await ctx.signIn(OFFLINE_PARENT);
  const parentCsrf = await ctx.csrfFor(parent);
  await ctx.fetch('/account/children/new', {
    method: 'POST', cookie: parent, body: { csrf: parentCsrf, name: 'Ollie', dob: '2025-09-09', medical: '', photo_consent: 'yes' },
  });
  const review = await ctx.fetch('/book/checkout?kind=casual&term=term-dev-13&session=ses-13-w5', { cookie: parent });
  const started = await ctx.fetch('/book/checkout', {
    method: 'POST', cookie: parent,
    body: { csrf: parentCsrf, kind: 'casual', term: 'term-dev-13', session: 'ses-13-w5', child: ctx.field(review.text, 'child'), photo_consent: 'yes', medical: '', waiver: 'accepted' },
  });
  const bookingId = /booking=([a-f0-9-]+)/.exec(started.location)?.[1];
  const list = await ctx.fetch('/admin/bookings?status=pending', { cookie: admin });
  ctx.check('pending booking listed with an offline-payment form', list.text.includes(`/admin/bookings/${bookingId}/record-payment`));
  const nonce = new RegExp(`/admin/bookings/${bookingId}/record-payment"[\\s\\S]*?name="nonce" value="([^"]+)"`).exec(list.text)?.[1];
  const record = () => ctx.fetch(`/admin/bookings/${bookingId}/record-payment`, {
    method: 'POST', cookie: admin, body: { csrf, nonce, amount: '30', method: 'cash', note: 'Paid at the door' },
  });
  const recorded = await record();
  ctx.check('recording the payment confirms the booking', recorded.status === 303 && recorded.location.includes('payment-confirmed'), recorded.location);
  await record(); // a double submit
  const [row] = ctx.sql(`SELECT status, payment_status, paid_cents FROM bookings WHERE id = '${bookingId}'`);
  ctx.check('booking confirmed and paid once', row.status === 'confirmed' && row.payment_status === 'paid' && row.paid_cents === 3000,
    JSON.stringify(row));
  const ledger = ctx.sql(`SELECT kind, method, note FROM payments WHERE booking_id = '${bookingId}'`);
  ctx.check('the ledger has one offline row', ledger.length === 1 && ledger[0].kind === 'offline' && ledger[0].method === 'cash', JSON.stringify(ledger));
  const bookings = await ctx.fetch('/admin/bookings', { cookie: admin });
  const ownRow = new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?/admin/bookings/${bookingId}"(?:(?!</tr>)[\\s\\S])*</tr>`).exec(bookings.text)?.[0] || '';
  ctx.check("the booking's own row in the list shows owed $30.00, received $30.00 and Paid",
    ownRow.includes('Ollie') && /<td>\$30\.00<\/td>\s*<td>\$30\.00<\/td>\s*<td>Paid/.test(ownRow), ownRow.slice(0, 600));

  const cancel = await ctx.fetch(`/admin/bookings/${bookingId}/cancel`, { method: 'POST', cookie: admin, body: { csrf } });
  ctx.check('admin cancels the booking', cancel.status === 303);
  ctx.check('the cancelled booking is no longer on the roster',
    !(await ctx.fetch('/admin/sessions/ses-13-w5/roster', { cookie: admin })).text.includes('Ollie'));

  ctx.section('Import by term');
  const csv = 'parent_name,parent_email,parent_phone,child_name,child_dob,medical_notes,photo_consent,enrol_class,enrol_term\n'
    + 'Import Parent,e2e-import@example.com,0400000000,Remy,2025-07-07,,yes,Sensory Play — Wednesday 1:00 pm,Dev Term\n'
    + 'Family Only,e2e-import2@example.com,,Ivy,2025-08-01,,no,,\n'
    + 'Bad Row,not-an-email,,Kid,2025-07-07,,yes,,\n';
  const fd = new FormData();
  fd.set('csrf', csrf);
  fd.set('file', new File([csv], 'import.csv', { type: 'text/csv' }));
  const preview = await ctx.fetch('/admin/import/preview', { method: 'POST', cookie: admin, body: fd });
  ctx.check('import preview: 2 valid, 1 invalid', preview.text.includes('2 of 3 row'));
  ctx.check('preview shows the term enrolment', preview.text.includes('Dev Term (6 session(s))'));
  const payload = ctx.field(preview.text, 'payload');
  const commit = await ctx.fetch('/admin/import/commit', { method: 'POST', cookie: admin, body: { csrf, payload } });
  ctx.check('import commit reports outcomes', commit.text.includes('Imported') && commit.text.includes('enrolled in Dev Term'));
  const imported = ctx.sql(`SELECT b.kind, b.status, b.payment_status, b.term_id,
                                   (SELECT COUNT(*) FROM booking_sessions bs WHERE bs.booking_id = b.id) AS weeks
                            FROM bookings b JOIN children c ON c.id = b.child_id WHERE c.name = 'Remy'`);
  ctx.check('the enrolment is a confirmed, externally paid term booking',
    imported.length === 1 && imported[0].kind === 'term' && imported[0].status === 'confirmed'
      && imported[0].payment_status === 'paid' && imported[0].term_id === 'term-dev-13' && imported[0].weeks === 6,
    JSON.stringify(imported));
  const familyOnly = ctx.sql(`SELECT COUNT(*) AS n FROM bookings b JOIN children c ON c.id = b.child_id WHERE c.name = 'Ivy'`);
  ctx.check('a row without enrolment imports the family only', familyOnly[0].n === 0);
  await ctx.fetch('/admin/import/commit', { method: 'POST', cookie: admin, body: { csrf, payload } });
  const again = ctx.sql(`SELECT COUNT(*) AS n FROM bookings b JOIN children c ON c.id = b.child_id WHERE c.name = 'Remy'`);
  ctx.check('re-importing is idempotent', again[0].n === 1);
  const invites = await ctx.fetch('/admin/import/invites', { method: 'POST', cookie: admin, body: { csrf, payload } });
  ctx.check('invites sent to imported parents', invites.text.includes('e2e-import@example.com') && invites.text.includes('Invite sent'));

  ctx.section('Exports');
  const bookingsCsv = await ctx.fetch('/admin/bookings.csv', { method: 'POST', cookie: admin, body: { csrf } });
  ctx.check('bookings CSV exports with payment columns', bookingsCsv.status === 200 && bookingsCsv.text.startsWith('"Created"')
    && bookingsCsv.text.includes('"Payment status"'));
  const template = await ctx.fetch('/admin/import/template.csv', { cookie: admin });
  ctx.check('import template uses enrol_class/enrol_term', template.text.includes('"enrol_term"'));
  const customers = await ctx.fetch('/admin/customers', { cookie: admin });
  ctx.check('customers lists the imported family', customers.text.includes('e2e-import2@example.com'));
}

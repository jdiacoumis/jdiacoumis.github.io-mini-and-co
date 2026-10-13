// Security smoke: owner-scoped reads (identical 404s), CSRF, admin and staff
// rights from the live allowlists, open-redirect protection, pixel scoping.

export const title = 'Isolation, CSRF, roles, redirects, pixel scope';

const OWNER = 'e2e-iso-owner@example.com';
const STRANGER = 'e2e-iso-stranger@example.com';
const STAFF = 'facilitator@example.com'; // STAFF_EMAILS in .dev.vars

export async function run(ctx) {
  // An owner with a pending booking of their own.
  const owner = await ctx.signIn(OWNER);
  const ownerCsrf = await ctx.csrfFor(owner);
  await ctx.fetch('/account/children/new', {
    method: 'POST', cookie: owner, body: { csrf: ownerCsrf, name: 'Otto', dob: '2025-08-08', medical: 'Peanut allergy', photo_consent: 'no' },
  });
  const review = await ctx.fetch('/book/checkout?kind=casual&term=term-dev-11&session=ses-11-w2', { cookie: owner });
  const childId = ctx.field(review.text, 'child');
  const started = await ctx.fetch('/book/checkout', {
    method: 'POST', cookie: owner,
    body: { csrf: ownerCsrf, kind: 'casual', term: 'term-dev-11', session: 'ses-11-w2', child: childId, photo_consent: 'no', medical: 'Peanut allergy', waiver: 'accepted' },
  });
  const bookingId = /booking=([a-f0-9-]+)/.exec(started.location)?.[1];
  ctx.check('owner booking started', Boolean(bookingId), started.location);

  ctx.section('Another account sees nothing');
  const stranger = await ctx.signIn(STRANGER);
  const strangerCsrf = await ctx.csrfFor(stranger);
  const notFoundPage = await ctx.fetch('/book/confirm?booking=00000000-0000-4000-8000-000000000000', { cookie: stranger });
  const idor = await ctx.fetch(`/book/confirm?booking=${bookingId}`, { cookie: stranger });
  ctx.check("another account can't read the booking (same 404 as a missing one)",
    idor.status === 404 && notFoundPage.status === 404 && idor.text === notFoundPage.text);
  const idorApi = await ctx.fetch(`/api/bookings/${bookingId}/status`, { cookie: stranger });
  ctx.check("another account can't read the booking status", idorApi.status === 404);
  const idorMock = await ctx.fetch(`/dev/mock-checkout?booking=${bookingId}`, { cookie: stranger });
  ctx.check("another account can't open the booking's checkout", idorMock.status === 404);
  const idorCancel = await ctx.fetch(`/book/cancelled?booking=${bookingId}`, { cookie: stranger });
  const [still] = ctx.sql(`SELECT status FROM bookings WHERE id = '${bookingId}'`);
  ctx.check("another account can't release the booking's seats", idorCancel.status === 200 && still.status === 'pending');
  const idorChild = await ctx.fetch('/book/checkout', {
    method: 'POST', cookie: stranger,
    body: { csrf: strangerCsrf, kind: 'casual', term: 'term-dev-11', session: 'ses-11-w3', child: childId, photo_consent: 'no', waiver: 'accepted' },
  });
  ctx.check("another account can't book someone else's child", idorChild.status === 404);

  ctx.section('CSRF');
  const forged = await ctx.fetch('/account/children/new', {
    method: 'POST', cookie: stranger, body: { csrf: 'forged', name: 'X', dob: '2025-11-20', photo_consent: 'no' },
  });
  ctx.check('forged CSRF token rejected', forged.status === 403);
  const crossSite = await ctx.fetch('/account/profile', {
    method: 'POST', cookie: stranger, body: { csrf: strangerCsrf, name: 'Mallory' }, headers: { Origin: 'https://evil.example' },
  });
  ctx.check('cross-site Origin rejected', crossSite.status === 403);

  ctx.section('Admin and staff rights');
  ctx.check('a parent is denied the admin area', (await ctx.fetch('/admin', { cookie: stranger })).status === 403);
  ctx.check('a parent is denied rosters', (await ctx.fetch('/admin/sessions/ses-11-w2/roster', { cookie: stranger })).status === 403);
  ctx.check('a parent is denied the new admin pages', (await ctx.fetch('/admin/attention', { cookie: stranger })).status === 403);

  const staff = await ctx.signIn(STAFF);
  const staffCsrf = await ctx.csrfFor(staff);
  const roster = await ctx.fetch('/admin/sessions/ses-11-w2/roster', { cookie: staff });
  ctx.check('staff can open a roster', roster.status === 200 && roster.text.includes('Otto') && roster.text.includes('Peanut allergy'));
  ctx.check('the staff roster has no admin links or export', !roster.text.includes('admin-nav') && !roster.text.includes('roster.csv'));
  const attendance = await ctx.fetch('/admin/sessions/ses-11-w2/attendance', { method: 'POST', cookie: staff, body: { csrf: staffCsrf } });
  ctx.check('staff may post attendance', attendance.status === 303);
  const attendanceNoCsrf = await ctx.fetch('/admin/sessions/ses-11-w2/attendance', { method: 'POST', cookie: staff, body: { csrf: 'x' } });
  ctx.check('attendance requires CSRF', attendanceNoCsrf.status === 403);
  ctx.check('a parent may not post attendance',
    (await ctx.fetch('/admin/sessions/ses-11-w2/attendance', { method: 'POST', cookie: stranger, body: { csrf: strangerCsrf } })).status === 403);
  for (const path of ['/admin', '/admin/bookings', '/admin/terms', '/admin/customers']) {
    ctx.check(`staff denied ${path}`, (await ctx.fetch(path, { cookie: staff })).status === 403);
  }
  const csv = await ctx.fetch('/admin/sessions/ses-11-w2/roster.csv', { method: 'POST', cookie: staff, body: { csrf: staffCsrf } });
  ctx.check('staff cannot export the roster', csv.status === 403);

  ctx.section('Open redirects');
  for (const next of ['//evil.example', '/\\evil.example', '/.//evil.example', 'https://evil.example', '/\tevil']) {
    const page = await ctx.fetch(`/auth/request-magic-link?next=${encodeURIComponent(next)}`);
    ctx.check(`next=${JSON.stringify(next)} is dropped`, ctx.field(page.text, 'next') === '');
  }
  const ok = await ctx.fetch(`/auth/request-magic-link?next=${encodeURIComponent('/book/checkout?kind=term&term=term-dev-11')}`);
  ctx.check('a same-site next path is kept', ctx.field(ok.text, 'next') === '/book/checkout?kind=term&term=term-dev-11');

  ctx.section('Pixel only on the booking funnel');
  const pages = {
    '/book': true, '/account': false, '/account/children': false, '/admin/sessions/ses-11-w2/roster': false,
  };
  for (const [path, expected] of Object.entries(pages)) {
    const cookie = path.startsWith('/admin') ? staff : owner;
    const page = await ctx.fetch(path, { cookie });
    ctx.check(`${path} ${expected ? 'loads' : 'does not load'} the pixel`, page.text.includes('booking-pixel.js') === expected);
  }
  const csp = (await ctx.fetch('/book')).headers.get('Content-Security-Policy') || '';
  ctx.check('CSP has no inline scripts and allows the Billing Portal redirect',
    !csp.includes('unsafe-inline') && csp.includes('https://billing.stripe.com'));
}

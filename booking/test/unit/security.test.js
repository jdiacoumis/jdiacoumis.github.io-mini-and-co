// Security follow-ups (task 1.7): redirects, live role allowlists, pixel
// scoping in the layout, fail-closed email driver, CAPI payload fields.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNextPath } from '../../src/lib/http.js';
import { roleFor } from '../../src/lib/middleware.js';
import { layout, html } from '../../src/lib/html.js';
import { sendEmail } from '../../src/lib/email-driver.js';
import { purchaseEventPayload, normalisePhoneForMeta, GRAPH_API_VERSION } from '../../src/lib/capi-driver.js';
import { sha256Hex } from '../../src/lib/crypto.js';

test('safeNextPath keeps same-site paths', () => {
  assert.equal(safeNextPath('/account'), '/account');
  assert.equal(safeNextPath('/book/checkout?kind=term&term=t1'), '/book/checkout?kind=term&term=t1');
  assert.equal(safeNextPath('/x#frag'), '/x#frag');
  assert.equal(safeNextPath('/a/../b'), '/b', 'dot segments are normalised');
});

test('safeNextPath rejects anything that could leave the origin', () => {
  for (const bad of [
    '//evil.example', '/\\evil.example', '/.//evil.example', '/./\\evil', 'https://evil.example', 'javascript:alert(1)',
    'evil.example', '', null, undefined, 42, `/${'a'.repeat(600)}`,
    '/\tevil', '/\nevil', '/\revil', '/\u0000x', '/\u001fx', '/\u007fx', '\t//evil.example',
  ]) {
    assert.equal(safeNextPath(bad, 'FALLBACK'), 'FALLBACK', JSON.stringify(bad));
  }
});

test('roles come from the allowlists only, case-insensitively, and removal is immediate', () => {
  const env = { ADMIN_EMAILS: 'Owner@Example.com, second@example.com', STAFF_EMAILS: 'helper@example.com' };
  assert.equal(roleFor(env, 'owner@example.com'), 'admin');
  assert.equal(roleFor(env, ' SECOND@example.com '), 'admin');
  assert.equal(roleFor(env, 'helper@example.com'), 'staff');
  assert.equal(roleFor(env, 'parent@example.com'), 'parent');
  assert.equal(roleFor({ ...env, STAFF_EMAILS: '' }, 'helper@example.com'), 'parent');
  assert.equal(roleFor({ ADMIN_EMAILS: 'a@example.com', STAFF_EMAILS: 'a@example.com' }, 'a@example.com'), 'admin');
  assert.equal(roleFor({}, 'x@example.com'), 'parent');
});

test('the layout loads the pixel only when asked, and the admin nav only for admin pages', () => {
  const plain = String(layout('Account', html`<p>x</p>`));
  assert.ok(!plain.includes('booking-pixel.js'));
  assert.ok(!plain.includes('admin-nav'));
  const funnel = String(layout('Book', html`<p>x</p>`, { pixel: true }));
  assert.ok(funnel.includes('<script src="/js/booking-pixel.js" defer></script>'));
  const owner = { role: 'admin', csrfToken: 'tok' };
  const admin = String(layout('Admin', html`<p>x</p>`, { admin: true, user: owner }));
  for (const link of ['/admin/terms', '/admin/attention', '/admin/waitlist', '/admin/email', '/admin/rosters',
    '/admin/credits', '/admin/vouchers']) {
    assert.ok(admin.includes(`href="${link}"`), link);
  }
  assert.ok(!/<script>/.test(funnel), 'no inline scripts');
});

test('a facilitator gets the roster-only nav; a parent never sees an admin nav', () => {
  const staff = String(layout('Rosters', html`<p>x</p>`, { admin: true, user: { role: 'staff', csrfToken: 'tok' } }));
  assert.ok(staff.includes('class="staff-nav"') && staff.includes('href="/admin/rosters"'));
  assert.ok(!staff.includes('admin-nav'));
  for (const link of ['/admin/terms', '/admin/bookings', '/admin/customers', '/admin/credits', '"/admin"']) {
    assert.ok(!staff.includes(`href=${link.startsWith('"') ? link : `"${link}"`}`), link);
  }
  const parent = String(layout('Oops', html`<p>x</p>`, { admin: true, user: { role: 'parent', csrfToken: 'tok' } }));
  assert.ok(!parent.includes('admin-nav') && !parent.includes('staff-nav') && !parent.includes('href="/admin'));
  assert.ok(!String(layout('Oops', html`<p>x</p>`, { admin: true })).includes('admin-nav'), 'no user, no nav');
});

test('email driver fails closed: unknown driver throws, console only in development', async () => {
  await assert.rejects(sendEmail({ EMAIL_DRIVER: 'smtp' }, 'a@example.com', 's', 't'), /Unknown EMAIL_DRIVER/);
  await assert.rejects(sendEmail({}, 'a@example.com', 's', 't'), /Unknown EMAIL_DRIVER/);
  await assert.rejects(
    sendEmail({ EMAIL_DRIVER: 'console', ENVIRONMENT: 'production' }, 'a@example.com', 's', 't'),
    /outside development/,
  );
  await assert.rejects(sendEmail({ EMAIL_DRIVER: 'resend' }, 'a@example.com', 's', 't'), /RESEND_API_KEY/);
});

test('CAPI Purchase payload carries the website fields and hashed identifiers', async () => {
  const payload = await purchaseEventPayload({
    bookingId: 'b-1', email: ' Jane@Example.com ', phone: '0412 345 678', amountCents: 16800,
    eventSourceUrl: 'https://miniandcosensoryclasses.com/book/confirm', clientUserAgent: 'Mozilla/5.0 test',
    clientIpAddress: '203.0.113.9', eventTime: 1800000000,
  });
  const [event] = payload.data;
  assert.equal(event.event_name, 'Purchase');
  assert.equal(event.event_id, 'b-1');
  assert.equal(event.action_source, 'website');
  assert.equal(event.event_source_url, 'https://miniandcosensoryclasses.com/book/confirm');
  assert.equal(event.user_data.client_user_agent, 'Mozilla/5.0 test');
  assert.equal(event.user_data.client_ip_address, '203.0.113.9');
  assert.deepEqual(event.user_data.em, [await sha256Hex('jane@example.com')]);
  assert.deepEqual(event.user_data.ph, [await sha256Hex('61412345678')]);
  assert.deepEqual(event.custom_data, { value: 168, currency: 'AUD' });
  assert.equal(normalisePhoneForMeta('+61 412 345 678'), '61412345678');
  assert.match(GRAPH_API_VERSION, /^v2[2-9]\.0$/);
});

// Admin operations (Phase 2B — admin-portal spec, design D6/D8): manual
// bookings, the Needs attention list with "Check with Stripe", transfers,
// single-week cancellation, credits and vouchers, and attendance on the
// roster. Phase 1 registers the routes (placeholder pages) and wires the
// staff permission for attendance, so later work never touches index.js.

import { html, pageResponse } from '../lib/html.js';
import { requireAdmin, requireStaff, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect } from '../lib/http.js';

function comingSoon(user, title, what) {
  const body = html`
    <h1>${title}</h1>
    <p class="lede">Coming soon: ${what}</p>
  `;
  return pageResponse(title, body, { user, admin: true });
}

// GET /admin/bookings/new — manual / phone bookings.
export async function handleAdminNewBooking(req, env) {
  const user = await requireAdmin(req, env);
  return comingSoon(user, 'New booking', 'book a family in by phone, with an offline payment, a pay-later link or as complimentary.');
}

// GET /admin/attention — bookings flagged for the owner.
export async function handleAdminAttention(req, env) {
  const user = await requireAdmin(req, env);
  return comingSoon(user, 'Needs attention', 'every booking with a payment or seat mismatch, with "Check with Stripe" and fixes.');
}

// POST /admin/sessions/:id/attendance — staff and admins (the ONLY write a
// facilitator may make). Placeholder until Phase 2B records attendance.
export async function handleAttendancePost(req, env, params) {
  const user = await requireStaff(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  return redirect(`/admin/sessions/${params.id}/roster?ok=attendance-soon`, 303);
}

export function registerRoutes(route) {
  route('GET', '/admin/bookings/new', handleAdminNewBooking);
  route('GET', '/admin/attention', handleAdminAttention);
  route('POST', '/admin/sessions/:id/attendance', handleAttendancePost);
}

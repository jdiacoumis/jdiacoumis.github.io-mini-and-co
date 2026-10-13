// Admin operations (Phase 2B — admin-portal spec, designs D3/D5/D6/D8/D9):
//
//   * manual / phone bookings (/admin/bookings/new): find or create the
//     parent and child, choose the kind, term or sessions and an optional
//     price, then record an offline payment now, hold the place for a week
//     with a pay-later email, or book it complimentary;
//   * Needs attention (/admin/attention) with "Check with Stripe" (the
//     provider's record is replayed through the SAME webhook handler, so the
//     confirmation is capacity-guarded and the ledger row idempotent),
//     resolve-with-note, and links to record a payment or cancel;
//   * attendance on the roster — the one write a facilitator (staff) may make;
//   * credits (list, issue, void) and vouchers (create, edit, disable, delete).
//
// Security: requireAdmin everywhere except attendance (requireStaff); CSRF
// on every POST; ids validated; all HTML auto-escaped; logs carry truncated
// ids only (no emails, phones or medical notes).

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAdmin, requireStaff, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect, notFound } from '../lib/http.js';
import { uuid, nowIso, isoFromMs } from '../lib/db.js';
import {
  isValidId, cleanText, normaliseEmail, isValidEmail, normalisePhone, isValidName, validateDob, isYesNo,
  parseIntInRange,
} from '../lib/validate.js';
import { formatSydney, sydneyFields, sydneyToUtc } from '../lib/time.js';
import {
  getBooking, loadTerm, listSessionsWithFullness, listOneOffSessions, prepareBooking, abandonCheckout,
  formatAud, KIND_LABELS, NEEDS_ATTENTION_LABELS, effectiveStatus,
} from '../lib/domain.js';
import { issueCredit, voidCredit } from '../lib/ledger.js';
import { normaliseVoucherCode } from '../lib/pricing.js';
import { getPaymentsDriver } from '../lib/payments-driver.js';
import { sendTemplate, notifyBookingConfirmed } from '../lib/notify.js';
import { offlineReceipt, payLaterHold } from '../lib/emails/ops.js';
import { processStripeEvent } from './webhooks.js';
import { logEvent, logError } from '../lib/log.js';
import {
  createAdminBooking, findOrCreateParent, createChild, listAttention, resolveAttention, clearFlagIf,
  markAttendance, listCredits, creditState, listVouchers, voucherInUse, VOUCHER_CODE_PATTERN, paymentSummary,
  describeBooking, noticeFor, errorBlock, centsToInput, optionalDollars, addDays, isDateStr, shortDate,
} from '../lib/admin-ops.js';

const OFFLINE_METHODS = ['cash', 'bank transfer', 'card (in person)', 'other'];
const MAX_SESSIONS = 20;

// --- Manual bookings ---------------------------------------------------------------

const BOOKING_ERRORS = {
  invalid_kind: 'That kind of booking is not possible here.',
  not_found: 'That term or class could not be found — please start again.',
  closed: 'That term is closed.',
  finished: 'That term has finished — there are no weeks left to book.',
  no_sessions: 'Please choose at least one class.',
  trial_one_session: 'A trial is exactly one class — please choose one.',
  trial_used: 'This child has already had a trial class.',
  unavailable: 'One of the chosen classes is cancelled or has already started.',
  full: 'One of the chosen classes is full.',
  capacity: 'One of the chosen classes filled up just now — please choose again.',
  already_booked: 'This child is already booked into one of those classes.',
  plan_unavailable: 'An instalment plan is not available for this booking.',
  voucher_invalid: 'That voucher can no longer be used.',
  credit_changed: 'The family’s account credit changed — please try again.',
  child: 'Please choose the child again.',
};
const VOUCHER_ERRORS = {
  not_found: "There's no voucher with that code.",
  inactive: 'That voucher is switched off.',
  not_started: "That voucher can't be used yet.",
  expired: 'That voucher has expired.',
  used_up: 'That voucher has been fully used.',
  not_applicable: "That voucher can't be used for this kind of booking.",
};

async function bookableTerms(env, now) {
  return (await env.DB.prepare(
    `SELECT t.id, t.name, t.status, t.starts_on, c.name AS class_name
     FROM terms t JOIN classes c ON c.id = t.class_id
     WHERE t.status != 'closed' AND c.active = 1
       AND EXISTS (SELECT 1 FROM class_sessions s WHERE s.term_id = t.id AND s.status = 'scheduled' AND s.starts_at > ?1)
     ORDER BY t.starts_on, c.name`,
  ).bind(now).all()).results || [];
}

const KIND_CHOICES = [
  ['term', 'Whole term (the weeks still to come)'],
  ['casual', 'Casual classes (choose the dates)'],
  ['trial', 'Trial class (one class)'],
];

// GET /admin/bookings/new[?email=…] — step 1: who is it for, and what kind.
export async function handleAdminNewBooking(req, env) {
  const user = await requireAdmin(req, env);
  const url = new URL(req.url);
  const email = normaliseEmail(url.searchParams.get('email'));
  return newBookingStep1(env, user, { email, searched: url.searchParams.has('email') });
}

async function newBookingStep1(env, user, { email = '', searched = false, values = {}, error = '', status = 200 }) {
  const now = nowIso();
  let parent = null;
  let children = [];
  if (isValidEmail(email)) {
    parent = await env.DB.prepare(`SELECT id, name, email, phone FROM users WHERE email = ?1`).bind(email).first();
    if (parent) {
      children = (await env.DB.prepare(
        `SELECT id, name, dob FROM children WHERE user_id = ?1 AND archived_at IS NULL ORDER BY created_at`,
      ).bind(parent.id).all()).results || [];
    }
  }
  const terms = await bookableTerms(env, now);
  const v = { child: children.length ? children[0].id : 'new', kind: 'term', term: terms[0] ? terms[0].id : '', ...values };

  const finder = html`
    <form method="get" action="/admin/bookings/new" class="booking-form inline-search">
      <div class="form-group">
        <label for="find_email">Parent's email</label>
        <input type="email" id="find_email" name="email" value="${email}" required autocomplete="off">
      </div>
      <button type="submit" class="button-secondary">Find family</button>
    </form>`;

  let details = html``;
  if (searched && !isValidEmail(email)) {
    details = html`<p class="form-error">Please enter a full email address.</p>`;
  } else if (isValidEmail(email)) {
    const childChoices = children.map((c) => html`
      <label><input type="radio" name="child" value="${c.id}" ${v.child === c.id ? 'checked' : ''}> ${c.name}
        <span class="muted">(born ${c.dob})</span></label>`);
    details = html`
      <form method="post" action="/admin/bookings/new" class="booking-form">
        ${csrfField(user.csrfToken)}
        <input type="hidden" name="email" value="${email}">
        ${parent ? html`
          <p class="form-notice">Found <strong>${parent.name || parent.email}</strong> (${parent.email}${parent.phone ? `, ${parent.phone}` : ''}).
            <a href="/admin/customers/${parent.id}">Customer page</a></p>
        ` : html`
          <p class="form-notice">No account uses ${email} yet — one will be created (they can sign in with this email later).</p>
          <div class="form-row">
            <div class="form-group">
              <label for="parent_name">Parent's name</label>
              <input type="text" id="parent_name" name="parent_name" value="${values.parent_name || ''}" required maxlength="100">
            </div>
            <div class="form-group">
              <label for="parent_phone">Phone <span class="muted">(optional)</span></label>
              <input type="tel" id="parent_phone" name="parent_phone" value="${values.parent_phone || ''}" maxlength="20">
            </div>
          </div>
        `}
        <fieldset class="form-group check-list">
          <legend>Child</legend>
          ${joinHtml(childChoices)}
          <label><input type="radio" name="child" value="new" ${v.child === 'new' ? 'checked' : ''}> A new child</label>
        </fieldset>
        <fieldset class="form-group new-child-fields">
          <legend>New child <span class="muted">(only if “A new child” is chosen)</span></legend>
          <div class="form-row">
            <div class="form-group">
              <label for="child_name">Child's name</label>
              <input type="text" id="child_name" name="child_name" value="${values.child_name || ''}" maxlength="100">
            </div>
            <div class="form-group">
              <label for="child_dob">Date of birth</label>
              <input type="date" id="child_dob" name="child_dob" value="${values.child_dob || ''}">
            </div>
          </div>
          <div class="form-group">
            <label for="medical">Medical conditions or allergies <span class="muted">(optional)</span></label>
            <textarea id="medical" name="medical" rows="2" maxlength="2000">${values.medical || ''}</textarea>
          </div>
          <div class="form-group consent-group">
            <span>Photo consent (ask the parent):</span>
            <label><input type="radio" name="photo_consent" value="yes" ${values.photo_consent === 'yes' ? 'checked' : ''}> Yes</label>
            <label><input type="radio" name="photo_consent" value="no" ${values.photo_consent === 'no' ? 'checked' : ''}> No</label>
          </div>
        </fieldset>
        <fieldset class="form-group check-list">
          <legend>What are they booking?</legend>
          ${joinHtml(KIND_CHOICES.map(([value, label]) => html`
            <label><input type="radio" name="kind" value="${value}" ${v.kind === value ? 'checked' : ''}> ${label}</label>`))}
        </fieldset>
        <div class="form-group">
          <label for="term">Term</label>
          <select id="term" name="term">
            ${joinHtml(terms.map((t) => html`<option value="${t.id}" ${v.term === t.id ? 'selected' : ''}>${t.class_name} — ${t.name}${t.status === 'draft' ? ' (draft)' : ''}</option>`))}
            <option value="" ${v.term === '' ? 'selected' : ''}>One-off classes (not part of a term)</option>
          </select>
        </div>
        <p class="form-hint">Complimentary places are chosen on the next step.</p>
        <button type="submit">Next: choose classes and payment</button>
      </form>`;
  }

  const body = html`
    <h1>New booking</h1>
    <p class="lede">Book a family in by phone or in person. Start with the parent's email.</p>
    ${errorBlock(error)}
    ${finder}
    ${details}
  `;
  return pageResponse('New booking', body, { user, admin: true, status });
}

// POST /admin/bookings/new — step 1: reuse or create the parent and child,
// then go to step 2 for the classes and payment.
export async function handleAdminNewBookingPost(req, env) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const email = normaliseEmail(form.get('email'));
  const values = {
    parent_name: cleanText(form.get('parent_name'), 100),
    parent_phone: normalisePhone(form.get('parent_phone')).slice(0, 20),
    child: String(form.get('child') || ''),
    child_name: cleanText(form.get('child_name'), 100),
    child_dob: String(form.get('child_dob') || '').trim(),
    medical: cleanText(form.get('medical'), 2000),
    photo_consent: String(form.get('photo_consent') || ''),
    kind: String(form.get('kind') || ''),
    term: String(form.get('term') || ''),
  };
  const again = (error) => newBookingStep1(env, user, { email, searched: true, values, error, status: 400 });
  if (!isValidEmail(email)) return again('Please enter the parent’s full email address.');
  if (!KIND_CHOICES.some(([k]) => k === values.kind)) return again('Please choose what they are booking.');
  let term = null;
  if (values.term) {
    if (!isValidId(values.term)) return again('Please choose the term again.');
    term = await loadTerm(env, values.term);
    if (!term) return again('Please choose the term again.');
  }
  if (values.kind === 'term' && !term) return again('Please choose the term for a whole-term booking.');

  const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ?1`).bind(email).first();
  if (!existing && !isValidName(values.parent_name)) return again('Please enter the parent’s name.');
  const newChild = values.child === 'new' || !values.child;
  if (newChild) {
    if (!isValidName(values.child_name)) return again('Please enter the child’s name.');
    const dobError = validateDob(values.child_dob);
    if (dobError) return again(dobError);
    if (!isYesNo(values.photo_consent)) return again('Please ask the parent about photo consent and choose yes or no.');
  } else if (!isValidId(values.child)) {
    return again('Please choose the child again.');
  }

  const now = nowIso();
  const parent = await findOrCreateParent(env, { email, name: values.parent_name, phone: values.parent_phone, now });
  let childId = values.child;
  if (newChild) {
    childId = await createChild(env, {
      userId: parent.id, name: values.child_name, dob: values.child_dob, medicalNotes: values.medical,
      photoConsent: values.photo_consent === 'yes', now,
    });
  } else {
    const child = await env.DB.prepare(
      `SELECT id FROM children WHERE id = ?1 AND user_id = ?2 AND archived_at IS NULL`,
    ).bind(childId, parent.id).first();
    if (!child) return again('Please choose the child again.');
  }
  if (parent.created || newChild) {
    logEvent('admin_family_created', { user_id: parent.id.slice(0, 8), parent: parent.created, child: newChild });
  }
  const query = new URLSearchParams({ user: parent.id, child: childId, kind: values.kind, term: term ? term.id : '' });
  return redirect(`/admin/bookings/new/details?${query}`, 303);
}

// Step 2 context from the query (GET) or the form (POST).
async function loadStep2(env, get) {
  const userId = String(get('user') || '');
  const childId = String(get('child') || '');
  const kind = String(get('kind') || '');
  const termId = String(get('term') || '');
  if (!isValidId(userId) || !isValidId(childId) || !KIND_CHOICES.some(([k]) => k === kind)) return null;
  if (termId && !isValidId(termId)) return null;
  const parent = await env.DB.prepare(`SELECT id, name, email, phone FROM users WHERE id = ?1`).bind(userId).first();
  const child = parent ? await env.DB.prepare(
    `SELECT id, name, dob, photo_consent, medical_notes FROM children WHERE id = ?1 AND user_id = ?2 AND archived_at IS NULL`,
  ).bind(childId, userId).first() : null;
  if (!parent || !child) return null;
  const term = termId ? await loadTerm(env, termId) : null;
  if (termId && !term) return null;
  if (kind === 'term' && !term) return null;
  return { parent, child, kind, term };
}

function readStep2Choices(form) {
  return {
    sessionIds: [...new Set(form.getAll('session').map(String).filter((id) => isValidId(id)))].slice(0, MAX_SESSIONS),
    price: String(form.get('price') || '').trim().slice(0, 12),
    voucher: normaliseVoucherCode(form.get('voucher')),
    mode: ['offline', 'paylater', 'comp'].includes(form.get('mode')) ? form.get('mode') : 'offline',
    received: String(form.get('received') || '').trim().slice(0, 12),
    method: OFFLINE_METHODS.includes(form.get('method')) ? form.get('method') : 'cash',
    note: cleanText(form.get('note'), 200),
    nonce: isValidId(String(form.get('nonce') || '')) ? String(form.get('nonce')) : uuid(),
  };
}

async function previewQuote(env, ctx, choices, now) {
  if (ctx.kind !== 'term' && !choices.sessionIds.length) return null;
  const override = optionalDollars(choices.price, 1000000);
  if (!override.ok) return { error: 'Price must be blank or an amount like 150.' };
  const kind = choices.mode === 'comp' ? 'complimentary' : ctx.kind;
  const prepared = await prepareBooking(env, {
    userId: ctx.parent.id, childId: ctx.child.id, kind, termId: ctx.term ? ctx.term.id : null,
    sessionIds: kind === 'term' ? [] : choices.sessionIds, voucherCode: choices.mode === 'comp' ? '' : choices.voucher,
    paymentChoice: 'full', now, admin: true, priceOverrideCents: choices.mode === 'comp' ? null : override.cents,
  });
  if (!prepared.ok) return { error: BOOKING_ERRORS[prepared.error] || 'That booking is not possible.' };
  return { quote: prepared.quote, sessions: prepared.sessions };
}

async function newBookingStep2(env, user, ctx, choices, { error = '', status = 200 } = {}) {
  const now = nowIso();
  let sessions = [];
  if (ctx.kind !== 'term') {
    sessions = ctx.term
      ? (await listSessionsWithFullness(env, { upcomingOnly: true, termId: ctx.term.id, now })).filter((s) => s.status === 'scheduled')
      : await listOneOffSessions(env, { now });
  }
  const preview = await previewQuote(env, ctx, choices, now);
  const quote = preview && preview.quote;
  const inputType = ctx.kind === 'trial' ? 'radio' : 'checkbox';
  const sessionItems = sessions.map((s) => html`
    <li><label>
      <input type="${inputType}" name="session" value="${s.id}" ${choices.sessionIds.includes(s.id) ? 'checked' : ''} ${s.seats_left > 0 ? '' : 'disabled'}>
      ${formatSydney(s.starts_at)} · ${s.class_name || ''} · ${formatAud(s.casual_price_cents)}
      <span class="muted">${s.seats_left > 0 ? `${s.seats_left} seat${s.seats_left === 1 ? '' : 's'} left` : 'full'}</span>
    </label></li>`);

  const breakdown = quote ? html`
    <table class="price-breakdown">
      <tr><td>${quote.kind === 'term' || quote.kind === 'complimentary' && ctx.kind === 'term'
        ? `${quote.weeks} week${quote.weeks === 1 ? '' : 's'}${quote.isProRata ? ` of ${quote.totalWeeks} (joining part-way)` : ''}${quote.isReturning ? ' · returning-family price' : ''}`
        : `${quote.weeks} class${quote.weeks === 1 ? '' : 'es'}`}${quote.priceOverridden ? ' · your price' : ''}</td>
        <td>${formatAud(quote.listCents)}</td></tr>
      ${quote.discountCents ? html`<tr><td>Voucher ${quote.voucherCode}</td><td>−${formatAud(quote.discountCents)}</td></tr>` : ''}
      ${quote.creditCents ? html`<tr><td>Account credit</td><td>−${formatAud(quote.creditCents)}</td></tr>` : ''}
      <tr class="price-total"><td>To pay</td><td>${formatAud(quote.amountCents)}</td></tr>
    </table>
    ${quote.voucherError ? html`<p class="form-error">${VOUCHER_ERRORS[quote.voucherError] || 'That voucher cannot be used.'}</p>` : ''}
  ` : '';

  const what = ctx.term ? `${ctx.term.class_name} — ${ctx.term.name}` : 'One-off classes';
  const body = html`
    <p class="breadcrumb"><a href="/admin/bookings/new?email=${encodeURIComponent(ctx.parent.email)}">New booking</a></p>
    <h1>Book ${ctx.child.name}</h1>
    <p class="lede">${KIND_LABELS[ctx.kind]} · ${what} · parent ${ctx.parent.name || ctx.parent.email}</p>
    ${errorBlock(error)}
    ${preview && preview.error ? errorBlock(preview.error) : ''}
    <form method="post" action="/admin/bookings/new/details" class="booking-form">
      ${csrfField(user.csrfToken)}
      <input type="hidden" name="user" value="${ctx.parent.id}">
      <input type="hidden" name="child" value="${ctx.child.id}">
      <input type="hidden" name="kind" value="${ctx.kind}">
      <input type="hidden" name="term" value="${ctx.term ? ctx.term.id : ''}">
      <input type="hidden" name="nonce" value="${choices.nonce}">
      ${ctx.kind === 'term' ? html`<p>Covers every week of ${ctx.term.name} still to come.</p>` : html`
        <fieldset class="form-group check-list">
          <legend>${ctx.kind === 'trial' ? 'Choose the trial class' : 'Choose the classes'}</legend>
          ${sessionItems.length ? html`<ul class="plain-list">${joinHtml(sessionItems)}</ul>` : html`<p>No upcoming classes to choose from.</p>`}
        </fieldset>`}
      ${breakdown}
      <div class="form-row">
        <div class="form-group">
          <label for="price">Charge a different price <span class="muted">(optional, AUD)</span></label>
          <input type="text" id="price" name="price" value="${choices.price}" inputmode="decimal">
        </div>
        <div class="form-group">
          <label for="voucher">Voucher code <span class="muted">(optional)</span></label>
          <input type="text" id="voucher" name="voucher" value="${choices.voucher}" maxlength="40">
        </div>
      </div>
      <button type="submit" name="intent" value="preview" class="button-secondary">Update price</button>
      <fieldset class="form-group check-list payment-modes">
        <legend>Payment</legend>
        <label><input type="radio" name="mode" value="offline" ${choices.mode === 'offline' ? 'checked' : ''}>
          Paid now (cash, bank transfer…) — confirm the booking and email a receipt</label>
        <div class="form-row nested-fields">
          <div class="form-group">
            <label for="received">Amount received <span class="muted">(blank = the full amount)</span></label>
            <input type="text" id="received" name="received" value="${choices.received}" inputmode="decimal">
          </div>
          <div class="form-group">
            <label for="method">Method</label>
            <select id="method" name="method">${joinHtml(OFFLINE_METHODS.map((m) => html`<option value="${m}" ${choices.method === m ? 'selected' : ''}>${m}</option>`))}</select>
          </div>
          <div class="form-group">
            <label for="note">Note <span class="muted">(optional)</span></label>
            <input type="text" id="note" name="note" value="${choices.note}" maxlength="200">
          </div>
        </div>
        <label><input type="radio" name="mode" value="paylater" ${choices.mode === 'paylater' ? 'checked' : ''}>
          Pay later — hold the place for 7 days and email the parent to sign in and press Pay now</label>
        <label><input type="radio" name="mode" value="comp" ${choices.mode === 'comp' ? 'checked' : ''}>
          Complimentary — nothing to pay (giveaways, make-ups)</label>
      </fieldset>
      <button type="submit" name="intent" value="create">Create booking</button>
    </form>
  `;
  return pageResponse('New booking', body, { user, admin: true, status });
}

// GET /admin/bookings/new/details?user=…&child=…&kind=…&term=… — step 2.
export async function handleAdminNewBookingDetails(req, env) {
  const user = await requireAdmin(req, env);
  const url = new URL(req.url);
  const ctx = await loadStep2(env, (name) => url.searchParams.get(name));
  if (!ctx) throw notFound();
  return newBookingStep2(env, user, ctx, readStep2Choices(url.searchParams));
}


// The family's emails after an owner-made booking: a receipt for money
// received, the confirmation for a confirmed booking, the Pay now request
// for a pay-later hold. Email problems never undo the booking.
async function emailFamilyAboutNewBooking(env, bookingId, outcome) {
  const booking = await getBooking(env, bookingId);
  if (!booking) return;
  const accountUrl = `${env.PUBLIC_BASE_URL}/account`;
  try {
    if (outcome.mode === 'paylater' && !outcome.confirmed) {
      const message = payLaterHold({
        parentName: booking.parent_name, childName: booking.child_name, what: describeBooking(booking),
        amountCents: outcome.owedCents, expiresAt: booking.expires_at, accountUrl,
      });
      await sendTemplate(env, {
        template: 'pay_later_hold', to: booking.parent_email, userId: booking.user_id, bookingId,
        termId: booking.term_id, dedupeKey: `pay_later:${bookingId}`, ...message,
      });
      return;
    }
    if (outcome.confirmed) await notifyBookingConfirmed(env, bookingId);
    if (outcome.payment) {
      await sendOfflineReceipt(env, booking, outcome.payment);
    }
  } catch (err) {
    logError('admin_booking_email_failed', err, { booking_id: bookingId.slice(0, 8) });
  }
}

export async function sendOfflineReceipt(env, booking, payment) {
  const message = offlineReceipt({
    parentName: booking.parent_name, childName: booking.child_name, amountCents: payment.amountCents,
    method: payment.method || 'payment', paidAt: payment.paidAt || nowIso(), summary: describeBooking(booking),
    accountUrl: `${env.PUBLIC_BASE_URL}/account`,
  });
  return sendTemplate(env, {
    template: 'offline_receipt', to: booking.parent_email, userId: booking.user_id, bookingId: booking.id,
    termId: booking.term_id, dedupeKey: `offline_receipt:${payment.providerRef}`, ...message,
  });
}

// POST /admin/bookings/new/details — intent=preview re-prices; intent=create
// makes the booking (lib/admin-ops.js createAdminBooking).
export async function handleAdminNewBookingDetailsPost(req, env) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const ctx = await loadStep2(env, (name) => form.get(name));
  if (!ctx) throw notFound();
  const choices = readStep2Choices(form);
  if (form.get('intent') !== 'create') return newBookingStep2(env, user, ctx, choices);

  const again = (error, status = 400) => newBookingStep2(env, user, ctx, choices, { error, status });
  if (ctx.kind !== 'term' && !choices.sessionIds.length) return again('Please choose at least one class.');
  const override = optionalDollars(choices.price, 1000000);
  if (!override.ok) return again('Price must be blank or an amount like 150.');
  const received = optionalDollars(choices.received, 1000000);
  if (!received.ok) return again('Amount received must be blank or an amount like 168.');

  const outcome = await createAdminBooking(env, {
    userId: ctx.parent.id, childId: ctx.child.id, kind: ctx.kind, termId: ctx.term ? ctx.term.id : null,
    sessionIds: choices.sessionIds, voucherCode: choices.voucher, priceOverrideCents: override.cents,
    mode: choices.mode, receivedCents: received.cents, method: choices.method, note: choices.note,
    nonce: choices.nonce, by: user.userId,
  });
  if (!outcome.ok) {
    if (outcome.error === 'voucher') return again(VOUCHER_ERRORS[outcome.voucherError] || 'That voucher cannot be used.');
    return again(BOOKING_ERRORS[outcome.error] || 'That booking is not possible.', 409);
  }
  logEvent('admin_booking_created', {
    booking_id: outcome.bookingId.slice(0, 8), mode: outcome.mode, by: user.userId.slice(0, 8),
  });
  await emailFamilyAboutNewBooking(env, outcome.bookingId, outcome);
  let ok = 'created-paylater';
  if (outcome.mode === 'comp') ok = 'created-comp';
  else if (outcome.mode === 'offline') ok = outcome.confirmed ? 'created-offline' : 'created-unconfirmed';
  else if (outcome.confirmed) ok = 'created-free';
  return redirect(`/admin/bookings/${outcome.bookingId}?ok=${ok}`, 303);
}

// --- Needs attention and "Check with Stripe" -----------------------------------------------

export const CHECK_NOTICES = {
  'check-confirmed': 'Stripe says it is paid — the booking is confirmed and the payment is in the ledger.',
  'check-confirmed-plan': 'Stripe says the instalment plan started — the booking is confirmed. Instalments appear in the ledger as Stripe reports them; if one never appears, record it as an offline payment.',
  'check-paid-no-seat': 'Stripe says it is paid, but there is no free seat any more. Free a seat (or raise the session capacity) and check again — or cancel the booking and refund it in Stripe.',
  'check-paid-cancelled': 'Stripe says it is paid, but the booking was cancelled. The payment is recorded — refund it in Stripe, or restore the booking.',
  'check-open': 'Stripe says the family has not finished paying — the checkout is still open.',
  'check-expired': 'Stripe says the checkout ended without a payment — the held place has been released.',
  'check-detached': 'Stripe says that checkout ended without a payment. The place stays held until its pay-later date; the family can press Pay now again.',
  'check-unpaid': 'Stripe has no payment for this booking. Nothing was changed.',
  'check-failed': 'Stripe could not be reached just now (or did not recognise the payment) — please try again in a minute.',
  'check-no-checkout': 'This booking has no online payment to check.',
  'check-mismatch': 'That Stripe checkout belongs to a different booking — nothing was changed.',
  'check-plan-active': 'Stripe says the instalment plan is active.',
  'check-plan-past-due': 'Stripe says the instalment plan is past due — it is retrying the card.',
  'check-plan-unpaid': 'Stripe says the instalment plan is unpaid — retries have run out.',
  'check-plan-ended': 'Stripe says the instalment plan has ended.',
  'check-plan-other': 'Stripe returned an unusual status for the instalment plan — please look in the Stripe dashboard.',
  resolved: 'Marked as sorted — the note is saved on the booking.',
  'not-flagged': 'That booking was already sorted.',
};

// Stripe subscription status → notice key.
const PLAN_STATUS_NOTICES = {
  active: 'check-plan-active', past_due: 'check-plan-past-due', unpaid: 'check-plan-unpaid', canceled: 'check-plan-ended',
};

async function checkPlanStatus(env, booking) {
  try {
    const sub = await getPaymentsDriver(env).retrieveSubscription(booking.stripe_subscription_id);
    return Object.hasOwn(PLAN_STATUS_NOTICES, sub.status) ? PLAN_STATUS_NOTICES[sub.status] : 'check-plan-other';
  } catch (err) {
    logError('check_plan_failed', err, { booking_id: booking.id.slice(0, 8) });
    return 'check-failed';
  }
}

// Ask the provider about a booking's checkout and reconcile (D6): a paid
// checkout is replayed through the webhook's own checkout.session.completed
// handler (guarded confirm, idempotent ledger row keyed like the webhook's,
// confirmation/attention emails, instalment end date); an ended unpaid
// checkout releases a checkout hold or detaches from a pay-later hold.
// Returns a CHECK_NOTICES key.
export async function checkWithStripe(env, booking) {
  if (!booking.payment_ref) {
    return booking.stripe_subscription_id ? checkPlanStatus(env, booking) : 'check-no-checkout';
  }
  if (booking.status === 'confirmed' && booking.payment_method === 'plan' && booking.stripe_subscription_id) {
    return checkPlanStatus(env, booking);
  }
  let checkout;
  try {
    checkout = await getPaymentsDriver(env).retrieveCheckout(booking.payment_ref);
  } catch (err) {
    logError('check_with_stripe_failed', err, { booking_id: booking.id.slice(0, 8) });
    return 'check-failed';
  }
  if (checkout.bookingId && checkout.bookingId !== booking.id) return 'check-mismatch';

  const paid = checkout.status === 'complete'
    && (checkout.paymentStatus === 'paid' || checkout.paymentStatus === 'no_payment_required');
  if (paid) {
    try {
      await processStripeEvent(env, {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: booking.payment_ref, object: 'checkout.session', mode: checkout.mode || 'payment', status: 'complete',
            payment_status: checkout.paymentStatus, payment_intent: checkout.paymentIntent,
            subscription: checkout.subscriptionId, customer: checkout.customerId, amount_total: checkout.amountTotal,
            client_reference_id: booking.id, metadata: { booking_id: booking.id },
          },
        },
      });
    } catch (err) {
      logError('check_with_stripe_reconcile_failed', err, { booking_id: booking.id.slice(0, 8) });
      return 'check-failed';
    }
    const after = await env.DB.prepare(`SELECT status FROM bookings WHERE id = ?1`).bind(booking.id).first();
    if (after.status === 'confirmed') {
      await clearFlagIf(env, booking.id, ['paid_no_seat'],
        `${formatSydney(nowIso(), 'date')}: Check with Stripe — paid; booking confirmed.`);
      return checkout.mode === 'subscription' ? 'check-confirmed-plan' : 'check-confirmed';
    }
    return after.status === 'cancelled' ? 'check-paid-cancelled' : 'check-paid-no-seat';
  }
  if (checkout.status === 'open') return 'check-open';
  if (booking.status === 'pending') {
    const outcome = await abandonCheckout(env, booking.id, booking.payment_ref);
    if (outcome === 'expired') return 'check-expired';
    if (outcome === 'detached') return 'check-detached';
  }
  return 'check-unpaid';
}

function attentionRow(b, user, { now, flagged }) {
  const payment = paymentSummary(b, now);
  const canCheck = Boolean(b.payment_ref || b.stripe_subscription_id);
  const status = effectiveStatus(b, now);
  return html`
    <tr class="${flagged ? 'row-attention' : ''}">
      <td><a href="/admin/bookings/${b.id}">${b.child_name}</a><br><span class="muted">${b.parent_name || b.parent_email}</span></td>
      <td>${KIND_LABELS[b.kind] || b.kind}${b.term_name ? html`<br><span class="muted">${b.term_name}</span>` : ''}</td>
      <td>${flagged ? html`<span class="attention-flag">${NEEDS_ATTENTION_LABELS[b.needs_attention] || b.needs_attention}</span><br>` : ''}
        <span class="status status-${status}">${status}</span> · started ${formatSydney(b.created_at)}</td>
      <td>${payment.label}<br><span class="muted">owed ${formatAud(b.amount_cents + b.credit_cents)} · received ${formatAud(b.received_cents)}</span></td>
      <td class="table-actions attention-actions">
        ${canCheck ? html`
          <form method="post" action="/admin/bookings/${b.id}/check" class="inline-form">
            ${csrfField(user.csrfToken)}
            <input type="hidden" name="back" value="attention">
            <button type="submit" class="button-small">Check with Stripe</button>
          </form>` : ''}
        <a href="/admin/bookings/${b.id}#record-payment">Record payment</a>
        ${b.status !== 'cancelled' ? html`<a href="/admin/bookings/${b.id}/cancel">Cancel</a>` : ''}
        ${flagged ? html`
          <details class="inline-details">
            <summary>Mark as sorted</summary>
            <form method="post" action="/admin/bookings/${b.id}/resolve" class="inline-form">
              ${csrfField(user.csrfToken)}
              <input type="hidden" name="back" value="attention">
              <label>What did you do? <input type="text" name="note" maxlength="300" required></label>
              <button type="submit" class="button-small">Save and clear the flag</button>
            </form>
          </details>` : ''}
      </td>
    </tr>`;
}

// GET /admin/attention
export async function handleAdminAttention(req, env) {
  const user = await requireAdmin(req, env);
  const now = nowIso();
  const { flagged, stale, ended } = await listAttention(env, now);
  const table = (rows, flaggedRows) => html`
    <div class="table-scroll">
      <table class="booking-table">
        <thead><tr><th>Child</th><th>Booking</th><th>What happened</th><th>Money</th><th>Actions</th></tr></thead>
        <tbody>${joinHtml(rows.map((b) => attentionRow(b, user, { now, flagged: flaggedRows })))}</tbody>
      </table>
    </div>`;
  const body = html`
    <div class="admin-wide">
      <h1>Needs attention</h1>
      ${noticeFor(req, CHECK_NOTICES)}
      <p class="lede">Bookings where the money and the places don't line up. “Check with Stripe” asks Stripe what really
        happened and fixes the booking to match; “Mark as sorted” clears the flag and keeps your note.</p>
      <h2>Flagged</h2>
      ${flagged.length ? table(flagged, true) : html`<p>Nothing flagged.</p>`}
      <h2>Payments to check</h2>
      <p class="form-hint">Families who started paying online more than 40 minutes ago but whose booking is still waiting.</p>
      ${stale.length ? table(stale, false) : html`<p>None.</p>`}
      <details class="attention-ended">
        <summary>Online payments that ended without a payment (last 3 days) — ${ended.length}</summary>
        <p class="form-hint">Usually a family who changed their mind. If one tells you they did pay, check it here.</p>
        ${ended.length ? table(ended, false) : html`<p>None.</p>`}
      </details>
    </div>
  `;
  return pageResponse('Needs attention', body, { user, admin: true });
}

function backTo(form, bookingId) {
  return form.get('back') === 'attention' ? '/admin/attention' : `/admin/bookings/${bookingId}`;
}

// POST /admin/bookings/:id/check — Check with Stripe.
export async function handleAdminCheckWithStripe(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const booking = await env.DB.prepare(
    `SELECT id, status, payment_ref, payment_method, stripe_subscription_id FROM bookings WHERE id = ?1`,
  ).bind(params.id).first();
  if (!booking) throw notFound();
  const result = await checkWithStripe(env, booking);
  logEvent('check_with_stripe', { booking_id: booking.id.slice(0, 8), result, by: user.userId.slice(0, 8) });
  return redirect(`${backTo(form, booking.id)}?ok=${result}`, 303);
}

// POST /admin/bookings/:id/resolve — clear the attention flag with a note.
export async function handleAdminResolve(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const exists = await env.DB.prepare(`SELECT id FROM bookings WHERE id = ?1`).bind(params.id).first();
  if (!exists) throw notFound();
  const note = cleanText(form.get('note'), 300);
  const resolved = await resolveAttention(env, exists.id, { note, by: user.userId });
  return redirect(`${backTo(form, exists.id)}?ok=${resolved ? 'resolved' : 'not-flagged'}`, 303);
}

// --- Attendance (staff and admins) ---------------------------------------------------

// POST /admin/sessions/:id/attendance — mark one child present / absent, or
// clear the mark; records who and when. The ONLY write a facilitator may make.
export async function handleAttendancePost(req, env, params) {
  const user = await requireStaff(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const back = `/admin/sessions/${params.id}/roster`;
  const bookingId = String(form.get('booking') || '');
  const mark = String(form.get('mark') || '');
  if (!isValidId(bookingId) || !['present', 'absent', 'clear'].includes(mark)) {
    return redirect(`${back}?err=attendance-missing`, 303);
  }
  const changed = await markAttendance(env, {
    sessionId: params.id, bookingId, mark: mark === 'clear' ? null : mark, by: user.userId,
  });
  logEvent('attendance_marked', {
    session_id: params.id.slice(0, 8), booking_id: bookingId.slice(0, 8), mark, changed, by: user.userId.slice(0, 8),
  });
  return redirect(changed ? `${back}?ok=attendance-saved#b-${bookingId}` : `${back}?err=attendance-not-booked`, 303);
}

// --- Credits ---------------------------------------------------------------------

const CREDIT_NOTICES = {
  voided: 'Credit voided — it can no longer be used (anything already spent stays spent).',
  'already-voided': 'That credit was already void.',
};

// GET /admin/credits[?show=all]
export async function handleAdminCredits(req, env) {
  const user = await requireAdmin(req, env);
  const now = nowIso();
  const all = new URL(req.url).searchParams.get('show') === 'all';
  const credits = await listCredits(env, { all, now });
  const total = credits.filter((c) => creditState(c, now) === 'Active').reduce((sum, c) => sum + c.remaining_cents, 0);
  const rows = credits.map((c) => {
    const state = creditState(c, now);
    return html`
      <tr class="${state === 'Active' ? '' : 'row-cancelled'}">
        <td>${formatSydney(c.issued_at, 'date')}</td>
        <td><a href="/admin/customers/${c.user_id}">${c.parent_name || c.parent_email}</a>${c.child_name ? html`<br><span class="muted">for ${c.child_name}</span>` : ''}</td>
        <td>${formatAud(c.amount_cents)}</td>
        <td>${formatAud(c.remaining_cents)}</td>
        <td>${c.reason || '—'}${c.source_booking_id ? html`<br><a href="/admin/bookings/${c.source_booking_id}" class="muted">From a booking</a>` : ''}</td>
        <td>${c.expires_at ? formatSydney(c.expires_at, 'date') : 'Never'}</td>
        <td>${state}</td>
        <td class="table-actions">${c.voided_at ? '' : html`
          <details class="inline-details">
            <summary>Void</summary>
            <form method="post" action="/admin/credits/${c.id}/void" class="inline-form">
              ${csrfField(user.csrfToken)}
              <button type="submit" class="button-small button-danger">Yes, void this credit</button>
            </form>
          </details>`}</td>
      </tr>`;
  });
  const body = html`
    <div class="admin-wide">
      <h1>Credits</h1>
      ${noticeFor(req, CREDIT_NOTICES)}
      <p class="lede">Account credit is applied automatically to the family's next booking.
        ${all ? html`Showing every credit — <a href="/admin/credits">only usable ones</a>.` : html`Showing usable credits (${formatAud(total)} in total) — <a href="/admin/credits?show=all">show all</a>.`}</p>
      <p class="form-hint">To give a family a credit, open their <a href="/admin/customers">customer page</a>.</p>
      ${rows.length ? html`
        <div class="table-scroll">
          <table class="booking-table">
            <thead><tr><th>Issued</th><th>Family</th><th>Amount</th><th>Left</th><th>Reason</th><th>Expires</th><th>Status</th><th></th></tr></thead>
            <tbody>${joinHtml(rows)}</tbody>
          </table>
        </div>` : html`<p>No credits.</p>`}
    </div>
  `;
  return pageResponse('Credits', body, { user, admin: true });
}

// POST /admin/credits/:id/void
export async function handleAdminVoidCredit(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const credit = await env.DB.prepare(`SELECT id FROM credits WHERE id = ?1`).bind(params.id).first();
  if (!credit) throw notFound();
  const voided = await voidCredit(env, credit.id, { by: user.userId });
  return redirect(`/admin/credits?ok=${voided ? 'voided' : 'already-voided'}`, 303);
}

// POST /admin/customers/:id/credit — issue a goodwill / make-up credit.
export async function handleAdminIssueCredit(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const parent = await env.DB.prepare(`SELECT id FROM users WHERE id = ?1`).bind(params.id).first();
  if (!parent) throw notFound();
  const back = `/admin/customers/${parent.id}`;
  const amount = optionalDollars(form.get('amount'), 100000);
  if (!amount.ok || !amount.cents) return redirect(`${back}?err=credit-amount`, 303);
  const childId = String(form.get('child') || '');
  if (childId) {
    const child = await env.DB.prepare(`SELECT id FROM children WHERE id = ?1 AND user_id = ?2`).bind(childId, parent.id).first();
    if (!child) return redirect(`${back}?err=credit-child`, 303);
  }
  const expires = String(form.get('expires') || '').trim();
  if (expires && !isDateStr(expires)) return redirect(`${back}?err=credit-expiry`, 303);
  await issueCredit(env, {
    userId: parent.id, childId: childId || null, amountCents: amount.cents,
    reason: cleanText(form.get('reason'), 300) || 'Credit from Mini & Co.', issuedBy: user.userId,
    expiresAt: expires ? sydneyToUtc(addDays(expires, 1), '00:00') : null,
  });
  return redirect(`${back}?ok=credit-issued`, 303);
}

// --- Vouchers ----------------------------------------------------------------------

const VOUCHER_NOTICES = {
  created: 'Voucher created.',
  updated: 'Voucher saved.',
  deleted: 'Voucher deleted.',
  'in-use': 'That voucher has been used, so it can only be switched off (untick “Active”), not deleted.',
};

const EMPTY_VOUCHER = {
  code: '', kind: 'amount', value: '', applies_to: 'any', max_uses: '', valid_from: '', valid_until: '', active: '1', note: '',
};

function voucherValues(v) {
  const lastDay = v.valid_until ? sydneyFields(isoFromMs(Date.parse(v.valid_until) - 60000)).date : '';
  return {
    code: v.code,
    kind: v.kind,
    value: v.kind === 'amount' ? centsToInput(v.value) : String(v.value),
    applies_to: v.applies_to,
    max_uses: v.max_uses === null ? '' : String(v.max_uses),
    valid_from: v.valid_from ? sydneyFields(v.valid_from).date : '',
    valid_until: lastDay,
    active: v.active ? '1' : '',
    note: v.note || '',
  };
}

function voucherForm({ action, values, csrfToken, error = '', isNew, submitLabel }) {
  const opt = (name, value, label) => html`<option value="${value}" ${values[name] === value ? 'selected' : ''}>${label}</option>`;
  return html`
    ${errorBlock(error)}
    <form method="post" action="${action}" class="booking-form">
      ${csrfField(csrfToken)}
      <div class="form-row">
        <div class="form-group">
          <label for="code">Code</label>
          ${isNew
            ? html`<input type="text" id="code" name="code" value="${values.code}" required maxlength="40" autocapitalize="characters" placeholder="WELCOME10">`
            : html`<input type="text" id="code" value="${values.code}" disabled>`}
        </div>
        <div class="form-group">
          <label for="kind">Type</label>
          <select id="kind" name="kind">${opt('kind', 'amount', 'Dollars off')}${opt('kind', 'percent', 'Percent off')}</select>
        </div>
        <div class="form-group">
          <label for="value">Value <span class="muted">($ or %)</span></label>
          <input type="text" id="value" name="value" value="${values.value}" required inputmode="decimal">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="applies_to">Can be used for</label>
          <select id="applies_to" name="applies_to">${opt('applies_to', 'any', 'Anything')}${opt('applies_to', 'term', 'Whole terms')}${opt('applies_to', 'casual', 'Casual and trial classes')}</select>
        </div>
        <div class="form-group">
          <label for="max_uses">Most times it can be used <span class="muted">(blank = no limit)</span></label>
          <input type="number" id="max_uses" name="max_uses" value="${values.max_uses}" min="1" max="100000">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="valid_from">Valid from <span class="muted">(optional)</span></label>
          <input type="date" id="valid_from" name="valid_from" value="${values.valid_from}">
        </div>
        <div class="form-group">
          <label for="valid_until">Last day it works <span class="muted">(optional)</span></label>
          <input type="date" id="valid_until" name="valid_until" value="${values.valid_until}">
        </div>
      </div>
      <div class="form-group">
        <label for="vnote">Note <span class="muted">(only you see this)</span></label>
        <input type="text" id="vnote" name="note" value="${values.note}" maxlength="200">
      </div>
      <div class="form-group">
        <label><input type="checkbox" name="active" value="1" ${values.active ? 'checked' : ''}> Active</label>
      </div>
      <button type="submit">${submitLabel}</button>
    </form>`;
}

function readVoucherForm(form, { isNew }) {
  const values = {
    code: isNew ? normaliseVoucherCode(form.get('code')) : '',
    kind: form.get('kind') === 'percent' ? 'percent' : 'amount',
    value: String(form.get('value') || '').trim().slice(0, 12),
    applies_to: ['any', 'term', 'casual'].includes(form.get('applies_to')) ? form.get('applies_to') : 'any',
    max_uses: String(form.get('max_uses') || '').trim().slice(0, 7),
    valid_from: String(form.get('valid_from') || '').trim().slice(0, 10),
    valid_until: String(form.get('valid_until') || '').trim().slice(0, 10),
    active: form.get('active') ? '1' : '',
    note: cleanText(form.get('note'), 200),
  };
  const fail = (error) => ({ values, error });
  if (isNew && !VOUCHER_CODE_PATTERN.test(values.code)) {
    return fail('Codes are 2–40 letters, numbers, dashes or underscores, like WELCOME10.');
  }
  let value;
  if (values.kind === 'percent') {
    value = parseIntInRange(values.value, 1, 100);
    if (value === null) return fail('A percentage must be a whole number from 1 to 100.');
  } else {
    const dollars = optionalDollars(values.value, 100000);
    if (!dollars.ok || !dollars.cents) return fail('Dollars off must be an amount like 10 or 12.50.');
    value = dollars.cents;
  }
  let maxUses = null;
  if (values.max_uses) {
    maxUses = parseIntInRange(values.max_uses, 1, 100000);
    if (maxUses === null) return fail('The use limit must be a whole number, or blank for no limit.');
  }
  if (values.valid_from && !isDateStr(values.valid_from)) return fail('“Valid from” is not a real date.');
  if (values.valid_until && !isDateStr(values.valid_until)) return fail('“Last day” is not a real date.');
  if (values.valid_from && values.valid_until && values.valid_until < values.valid_from) {
    return fail('The last day must be on or after the first day.');
  }
  return {
    values,
    error: null,
    parsed: {
      value,
      maxUses,
      validFrom: values.valid_from ? sydneyToUtc(values.valid_from, '00:00') : null,
      validUntil: values.valid_until ? sydneyToUtc(addDays(values.valid_until, 1), '00:00') : null,
    },
  };
}

async function vouchersPage(env, user, req, { values = EMPTY_VOUCHER, error = '', status = 200 } = {}) {
  const now = nowIso();
  const vouchers = await listVouchers(env);
  const rows = vouchers.map((v) => {
    const expired = v.valid_until && v.valid_until <= now;
    const usedUp = v.max_uses !== null && v.uses >= v.max_uses;
    const editable = VOUCHER_CODE_PATTERN.test(v.code);
    return html`
      <tr class="${v.active && !expired && !usedUp ? '' : 'row-cancelled'}">
        <td><strong>${v.code}</strong>${v.note ? html`<br><span class="muted">${v.note}</span>` : ''}</td>
        <td>${v.kind === 'percent' ? `${v.value}% off` : `${formatAud(v.value)} off`}</td>
        <td>${{ any: 'Anything', term: 'Whole terms', casual: 'Casual/trial' }[v.applies_to] || v.applies_to}</td>
        <td>${v.uses}${v.max_uses !== null ? ` of ${v.max_uses}` : ''}</td>
        <td>${v.valid_from ? `from ${shortDate(v.valid_from)} ` : ''}${v.valid_until ? `until ${formatSydney(isoFromMs(Date.parse(v.valid_until) - 60000), 'date')}` : (v.valid_from ? '' : 'Always')}</td>
        <td>${!v.active ? 'Off' : expired ? 'Expired' : usedUp ? 'Used up' : 'Active'}</td>
        <td class="table-actions">${editable ? html`<a href="/admin/vouchers/${v.code}/edit">Edit</a>` : ''}</td>
      </tr>`;
  });
  const body = html`
    <div class="admin-wide">
      <h1>Vouchers</h1>
      ${req ? noticeFor(req, VOUCHER_NOTICES) : ''}
      ${rows.length ? html`
        <div class="table-scroll">
          <table class="booking-table">
            <thead><tr><th>Code</th><th>Discount</th><th>For</th><th>Used</th><th>Valid</th><th>Status</th><th></th></tr></thead>
            <tbody>${joinHtml(rows)}</tbody>
          </table>
        </div>` : html`<p>No vouchers yet.</p>`}
      <h2>New voucher</h2>
      ${voucherForm({ action: '/admin/vouchers/new', values, csrfToken: user.csrfToken, error, isNew: true, submitLabel: 'Create voucher' })}
    </div>
  `;
  return pageResponse('Vouchers', body, { user, admin: true, status });
}

// GET /admin/vouchers
export async function handleAdminVouchers(req, env) {
  const user = await requireAdmin(req, env);
  return vouchersPage(env, user, req);
}

// POST /admin/vouchers/new
export async function handleAdminVoucherNew(req, env) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const { values, parsed, error } = readVoucherForm(form, { isNew: true });
  if (error) return vouchersPage(env, user, null, { values, error, status: 400 });
  const result = await env.DB.prepare(
    `INSERT INTO vouchers (code, kind, value, applies_to, max_uses, uses, valid_from, valid_until, active, note, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(code) DO NOTHING`,
  ).bind(values.code, values.kind, parsed.value, values.applies_to, parsed.maxUses, parsed.validFrom, parsed.validUntil,
    values.active ? 1 : 0, values.note, nowIso()).run();
  if (result.meta.changes === 0) {
    return vouchersPage(env, user, null, { values, error: `There is already a voucher called ${values.code}.`, status: 400 });
  }
  logEvent('voucher_created', { by: user.userId.slice(0, 8) });
  return redirect('/admin/vouchers?ok=created', 303);
}

async function loadVoucherRow(env, code) {
  if (!VOUCHER_CODE_PATTERN.test(code)) return null;
  return env.DB.prepare(`SELECT * FROM vouchers WHERE code = ?1`).bind(code).first();
}

async function voucherEditPage(env, user, voucher, values, { error = '', status = 200 } = {}) {
  const used = await voucherInUse(env, voucher.code);
  const body = html`
    <p class="breadcrumb"><a href="/admin/vouchers">Vouchers</a></p>
    <h1>Voucher ${voucher.code}</h1>
    <p class="lede">Used ${voucher.uses} time${voucher.uses === 1 ? '' : 's'}. Changes apply to future bookings only.</p>
    ${voucherForm({ action: `/admin/vouchers/${voucher.code}/edit`, values, csrfToken: user.csrfToken, error, isNew: false, submitLabel: 'Save voucher' })}
    ${used ? html`<p class="form-hint">This voucher has been used, so it can be switched off but not deleted.</p>` : html`
      <details class="inline-details">
        <summary>Delete this voucher</summary>
        <form method="post" action="/admin/vouchers/${voucher.code}/delete" class="inline-form">
          ${csrfField(user.csrfToken)}
          <button type="submit" class="button-small button-danger">Yes, delete ${voucher.code}</button>
        </form>
      </details>`}
  `;
  return pageResponse(`Voucher ${voucher.code}`, body, { user, admin: true, status });
}

// GET /admin/vouchers/:code/edit
export async function handleAdminVoucherEdit(req, env, params) {
  const user = await requireAdmin(req, env);
  const voucher = await loadVoucherRow(env, params.code);
  if (!voucher) throw notFound();
  return voucherEditPage(env, user, voucher, voucherValues(voucher));
}

// POST /admin/vouchers/:code/edit — everything except the code and use count.
export async function handleAdminVoucherEditPost(req, env, params) {
  const user = await requireAdmin(req, env);
  const voucher = await loadVoucherRow(env, params.code);
  if (!voucher) throw notFound();
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const { values, parsed, error } = readVoucherForm(form, { isNew: false });
  values.code = voucher.code;
  if (error) return voucherEditPage(env, user, voucher, values, { error, status: 400 });
  await env.DB.prepare(
    `UPDATE vouchers SET kind = ?2, value = ?3, applies_to = ?4, max_uses = ?5, valid_from = ?6, valid_until = ?7,
            active = ?8, note = ?9
     WHERE code = ?1`,
  ).bind(voucher.code, values.kind, parsed.value, values.applies_to, parsed.maxUses, parsed.validFrom,
    parsed.validUntil, values.active ? 1 : 0, values.note).run();
  logEvent('voucher_updated', { by: user.userId.slice(0, 8), active: Boolean(values.active) });
  return redirect('/admin/vouchers?ok=updated', 303);
}

// POST /admin/vouchers/:code/delete — only a voucher nobody has used.
export async function handleAdminVoucherDelete(req, env, params) {
  const user = await requireAdmin(req, env);
  const voucher = await loadVoucherRow(env, params.code);
  if (!voucher) throw notFound();
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const result = await env.DB.prepare(
    `DELETE FROM vouchers WHERE code = ?1 AND uses = 0 AND NOT EXISTS (SELECT 1 FROM bookings WHERE voucher_code = ?1)`,
  ).bind(voucher.code).run();
  if (result.meta.changes === 0) return redirect('/admin/vouchers?ok=in-use', 303);
  logEvent('voucher_deleted', { by: user.userId.slice(0, 8) });
  return redirect('/admin/vouchers?ok=deleted', 303);
}

export function registerRoutes(route) {
  route('GET', '/admin/bookings/new', handleAdminNewBooking);
  route('POST', '/admin/bookings/new', handleAdminNewBookingPost);
  route('GET', '/admin/bookings/new/details', handleAdminNewBookingDetails);
  route('POST', '/admin/bookings/new/details', handleAdminNewBookingDetailsPost);
  route('GET', '/admin/attention', handleAdminAttention);
  route('POST', '/admin/bookings/:id/check', handleAdminCheckWithStripe);
  route('POST', '/admin/bookings/:id/resolve', handleAdminResolve);
  route('POST', '/admin/sessions/:id/attendance', handleAttendancePost);
  route('GET', '/admin/credits', handleAdminCredits);
  route('POST', '/admin/credits/:id/void', handleAdminVoidCredit);
  route('POST', '/admin/customers/:id/credit', handleAdminIssueCredit);
  route('GET', '/admin/vouchers', handleAdminVouchers);
  route('POST', '/admin/vouchers/new', handleAdminVoucherNew);
  route('GET', '/admin/vouchers/:code/edit', handleAdminVoucherEdit);
  route('POST', '/admin/vouchers/:code/edit', handleAdminVoucherEditPost);
  route('POST', '/admin/vouchers/:code/delete', handleAdminVoucherDelete);
}

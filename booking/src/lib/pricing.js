// Pricing (design D3): pure functions only — no I/O, no clock reads — so every
// rule is unit-tested in isolation. Money is integer cents (AUD). Instants are
// UTC ISO strings with second precision ("2027-02-03T00:00:00Z"), so plain
// string comparison is time comparison.
//
// Inputs are database rows (snake_case), exactly as lib/domain.js loads them:
//   term:    terms row (term_price_cents, casual_price_cents, trial_price_cents,
//            returning_price_cents, returning_opens_at, public_opens_at,
//            plan_instalments, plan_interval, status, …)
//   session: class_sessions row (id, starts_at, status, casual_price_cents)
//   voucher: vouchers row;  credit: credits row (id, remaining_cents)

export const INTERVAL_DAYS = { week: 7, fortnight: 14 };

// Stripe's minimum charge in AUD. A plan whose instalments would be smaller
// is not offered.
export const MIN_CHARGE_CENTS = 50;

const byStart = (a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0);

function isoFromMs(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Can this family book this term at `now`? (D3 opening rules)
//   * the term must be 'open';
//   * everyone may book from public_opens_at (NULL = already open);
//   * a returning family may book from returning_opens_at (NULL = open).
// Returns { open: true, viaReturningWindow } or
//         { open: false, reason: 'closed' | 'not_open_yet', opensAt }.
export function canBookTerm({ term, now, returning = false }) {
  if (!term || term.status !== 'open') return { open: false, reason: 'closed', opensAt: null };
  const publicOpen = !term.public_opens_at || now >= term.public_opens_at;
  const returningOpen = Boolean(returning) && (!term.returning_opens_at || now >= term.returning_opens_at);
  if (publicOpen || returningOpen) return { open: true, viaReturningWindow: !publicOpen };
  const opensAt = returning && term.returning_opens_at && term.returning_opens_at < term.public_opens_at
    ? term.returning_opens_at
    : term.public_opens_at;
  return { open: false, reason: 'not_open_yet', opensAt };
}

// Does the returning-family price apply? Only with a returning price set, for
// a returning family, once the returning window has opened.
export function returningPriceApplies({ term, now, returning = false }) {
  return Boolean(returning)
    && term.returning_price_cents !== null && term.returning_price_cents !== undefined
    && (!term.returning_opens_at || now >= term.returning_opens_at);
}

// round(price × weeks / totalWeeks); the full price when nothing is missing.
export function proRata(priceCents, weeks, totalWeeks) {
  if (!totalWeeks || weeks >= totalWeeks) return priceCents;
  return Math.round((priceCents * weeks) / totalWeeks);
}

// Term booking quote. `sessions` are ALL the term's sessions (any status);
// cancelled ones are ignored. The booking covers every scheduled session that
// has not started, minus `excludeSessionIds` (weeks the child already holds,
// e.g. a trial). Price: term (or returning) price pro-rated on covered weeks
// over total scheduled weeks — the full price before the term starts.
export function quoteTerm({ term, sessions, now, returning = false, excludeSessionIds = [], ignoreOpening = false }) {
  if (!ignoreOpening) {
    const access = canBookTerm({ term, now, returning });
    if (!access.open) return { ok: false, reason: access.reason, opensAt: access.opensAt };
  }
  const scheduled = sessions.filter((s) => s.status === 'scheduled').sort(byStart);
  const upcoming = scheduled.filter((s) => s.starts_at > now);
  if (!upcoming.length) return { ok: false, reason: 'finished' };
  const exclude = new Set(excludeSessionIds);
  const covered = upcoming.filter((s) => !exclude.has(s.id));
  if (!covered.length) return { ok: false, reason: 'already_booked' };

  const isReturning = returningPriceApplies({ term, now, returning });
  const basePriceCents = isReturning ? term.returning_price_cents : term.term_price_cents;
  return {
    ok: true,
    kind: 'term',
    sessionIds: covered.map((s) => s.id),
    weeks: covered.length,
    totalWeeks: scheduled.length,
    basePriceCents,
    listCents: proRata(basePriceCents, covered.length, scheduled.length),
    isProRata: covered.length < scheduled.length,
    isReturning,
  };
}

// Casual booking: the sum of each chosen session's casual price.
export function quoteSessions({ sessions }) {
  if (!sessions || !sessions.length) return { ok: false, reason: 'no_sessions' };
  return {
    ok: true,
    kind: 'casual',
    sessionIds: sessions.map((s) => s.id),
    weeks: sessions.length,
    totalWeeks: null,
    listCents: sessions.reduce((sum, s) => sum + s.casual_price_cents, 0),
    isProRata: false,
    isReturning: false,
  };
}

// Trial: exactly one session at the term's trial price, else the casual price.
export function quoteTrial({ term = null, session }) {
  if (!session) return { ok: false, reason: 'no_sessions' };
  const hasTrialPrice = term && term.trial_price_cents !== null && term.trial_price_cents !== undefined;
  return {
    ok: true,
    kind: 'trial',
    sessionIds: [session.id],
    weeks: 1,
    totalWeeks: null,
    listCents: hasTrialPrice ? term.trial_price_cents : session.casual_price_cents,
    isProRata: false,
    isReturning: false,
  };
}

export function normaliseVoucherCode(code) {
  return String(code || '').toUpperCase().replace(/\s+/g, '').slice(0, 40);
}

// Validate a voucher for a booking and compute its discount (never more than
// the list price, never negative). Trials count as casual for `applies_to`;
// complimentary bookings take no voucher.
// Returns { ok: true, code, discountCents } or { ok: false, reason } with
// reason ∈ not_found | inactive | not_started | expired | used_up | not_applicable.
export function applyVoucher(voucher, { listCents, kind, now }) {
  if (!voucher) return { ok: false, reason: 'not_found' };
  if (!voucher.active) return { ok: false, reason: 'inactive' };
  if (voucher.valid_from && now < voucher.valid_from) return { ok: false, reason: 'not_started' };
  if (voucher.valid_until && now >= voucher.valid_until) return { ok: false, reason: 'expired' };
  if (voucher.max_uses !== null && voucher.max_uses !== undefined && voucher.uses >= voucher.max_uses) {
    return { ok: false, reason: 'used_up' };
  }
  const bucket = kind === 'term' ? 'term' : (kind === 'casual' || kind === 'trial') ? 'casual' : null;
  const appliesTo = voucher.applies_to || 'any';
  if (!bucket || (appliesTo !== 'any' && appliesTo !== bucket)) return { ok: false, reason: 'not_applicable' };

  const raw = voucher.kind === 'percent'
    ? Math.round((listCents * Math.min(voucher.value, 100)) / 100)
    : voucher.value;
  return { ok: true, code: voucher.code, discountCents: Math.max(0, Math.min(listCents, raw)) };
}

// Apply available credits (already filtered and ordered by the caller) to an
// amount due, up to the balance. Returns the total and per-credit allocations
// for credit_redemptions.
export function applyCredits(credits, dueCents) {
  const due = Math.max(0, dueCents);
  let left = due;
  const allocations = [];
  for (const credit of credits || []) {
    if (left <= 0) break;
    const take = Math.min(credit.remaining_cents, left);
    if (take > 0) {
      allocations.push({ creditId: credit.id, amountCents: take });
      left -= take;
    }
  }
  return { creditCents: due - left, allocations };
}

// List price → owed: voucher first, then credits (D3). An invalid voucher is
// reported (voucherError) and not applied, so the caller decides whether to
// refuse the booking or continue without it.
export function finaliseQuote(base, { voucher = null, voucherCode = '', credits = [], now }) {
  let discountCents = 0;
  let code = null;
  let voucherError = null;
  if (voucherCode) {
    const result = applyVoucher(voucher, { listCents: base.listCents, kind: base.kind, now });
    if (result.ok) {
      discountCents = result.discountCents;
      code = result.code;
    } else {
      voucherError = result.reason;
    }
  }
  const afterDiscount = base.listCents - discountCents;
  const { creditCents, allocations } = applyCredits(credits, afterDiscount);
  return {
    ...base,
    discountCents,
    voucherCode: code,
    voucherError,
    creditCents,
    allocations,
    amountCents: afterDiscount - creditCents,
  };
}

// The instalment plan a term booking may use: the term's instalment count,
// capped by the payment dates left (one per week, or per fortnight), and only
// when every instalment clears Stripe's minimum. null = pay in full only.
export function planFor(term, weeks, amountCents = null) {
  if (!term || !term.plan_instalments || term.plan_instalments < 2) return null;
  const interval = term.plan_interval === 'fortnight' ? 'fortnight' : 'week';
  const maxPayments = interval === 'fortnight' ? Math.ceil(weeks / 2) : weeks;
  const n = Math.min(term.plan_instalments, maxPayments);
  if (n < 2) return null;
  if (amountCents !== null && Math.floor(amountCents / n) < MIN_CHARGE_CENTS) return null;
  return { n, interval };
}

// n instalments: each = floor(total / n); the remainder goes on the first,
// first = total − each × (n − 1). Due dates: start, then every interval.
export function instalmentSchedule(totalCents, n, interval = 'week', startIso) {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new Error('total must be integer cents');
  if (!Number.isInteger(n) || n < 1) throw new Error('n must be a positive integer');
  const eachCents = Math.floor(totalCents / n);
  const firstCents = totalCents - eachCents * (n - 1);
  const stepMs = (INTERVAL_DAYS[interval] || 7) * 86400 * 1000;
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) throw new Error('startIso must be an ISO instant');
  const payments = Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    dueAt: isoFromMs(start + i * stepMs),
    amountCents: i === 0 ? firstCents : eachCents,
  }));
  return { n, interval, totalCents, eachCents, firstCents, payments };
}

// When to cancel a Stripe subscription so that EXACTLY n invoices are raised:
// the end of the n-th billing period (anchor + n × interval). Stripe bills each
// period at its start; a cancel_at INSIDE a future period "will always cause a
// proration for that period" (Stripe API reference), which would cut the last
// instalment short — so the boundary is used, never a mid-period instant.
export function planCancelAt(anchorUnix, n, interval = 'week') {
  return anchorUnix + n * (INTERVAL_DAYS[interval] || 7) * 86400;
}

// Money a plan should have collected by `now`: the instalments whose periods
// have started (first + each × (k − 1)), capped at the total.
export function planExpectedCents({ totalCents, n, eachCents, interval = 'week', anchorIso, now }) {
  if (!anchorIso || !n) return 0;
  const stepMs = (INTERVAL_DAYS[interval] || 7) * 86400 * 1000;
  const elapsed = Date.parse(now) - Date.parse(anchorIso);
  if (Number.isNaN(elapsed) || elapsed < 0) return 0;
  const started = Math.min(n, Math.floor(elapsed / stepMs) + 1);
  const firstCents = totalCents - eachCents * (n - 1);
  return Math.min(totalCents, firstCents + eachCents * (started - 1));
}

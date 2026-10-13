-- Mini & Co. booking system — schema.
-- Re-baselined 2026-10-13 (change booking-terms-plans-ops): no production
-- database existed, so the earlier 0001_init and 0002_term_labels were folded
-- into this one migration. From here on, add 000N_*.sql migrations.
--
-- Conventions:
--   * Primary keys are opaque random UUIDs (never sequential).
--   * Instants are UTC ISO-8601 with second precision and a 'Z' suffix
--     ("2027-02-03T00:00:00Z") so lexicographic order == time order.
--     Dates without a time are YYYY-MM-DD in Australia/Sydney.
--   * Money is integer cents in AUD.
--   * Foreign keys are enforced by D1.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,            -- stored normalised: trimmed + lowercased
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'parent' CHECK (role IN ('parent', 'staff', 'admin')),
  stripe_customer_id TEXT,               -- reused across checkouts and subscriptions
  admin_notes TEXT NOT NULL DEFAULT '',  -- owner-only free text
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE children (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  dob TEXT NOT NULL,                     -- date only: YYYY-MM-DD
  medical_notes TEXT NOT NULL DEFAULT '',
  photo_consent INTEGER NOT NULL DEFAULT 0 CHECK (photo_consent IN (0, 1)),
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX idx_children_user ON children(user_id);

-- A class is ONE weekly slot, e.g. "Sensory Play — Wednesday 11:00 am".
CREATE TABLE classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  venue TEXT NOT NULL DEFAULT '',
  age_range TEXT NOT NULL DEFAULT '',
  weekday INTEGER CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Sunday, Sydney local
  start_time TEXT,                                   -- "11:00", Sydney local
  default_duration_mins INTEGER NOT NULL DEFAULT 45 CHECK (default_duration_mins BETWEEN 5 AND 480),
  default_capacity INTEGER NOT NULL DEFAULT 12 CHECK (default_capacity BETWEEN 1 AND 500),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

-- A term is a dated, priced run of weekly sessions for one class.
CREATE TABLE terms (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id),
  name TEXT NOT NULL,                    -- "Term 1 2027"
  starts_on TEXT NOT NULL,               -- first class date, YYYY-MM-DD Sydney
  ends_on TEXT NOT NULL,                 -- last class date
  term_price_cents INTEGER NOT NULL CHECK (term_price_cents BETWEEN 0 AND 1000000),
  casual_price_cents INTEGER NOT NULL CHECK (casual_price_cents BETWEEN 0 AND 100000),
  trial_price_cents INTEGER CHECK (trial_price_cents BETWEEN 0 AND 100000),         -- NULL = casual price
  returning_price_cents INTEGER CHECK (returning_price_cents BETWEEN 0 AND 1000000), -- NULL = no returning offer
  returning_opens_at TEXT,               -- UTC instant from which returning families may book
  public_opens_at TEXT,                  -- UTC instant from which everyone may book (NULL = now)
  previous_term_id TEXT REFERENCES terms(id),   -- a confirmed term booking here makes a family "returning"
  plan_instalments INTEGER NOT NULL DEFAULT 0 CHECK (plan_instalments BETWEEN 0 AND 20), -- 0 = pay in full only
  plan_interval TEXT NOT NULL DEFAULT 'week' CHECK (plan_interval IN ('week', 'fortnight')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_terms_class ON terms(class_id);

CREATE TABLE class_sessions (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id),
  term_id TEXT REFERENCES terms(id),     -- NULL for a one-off session outside any term
  starts_at TEXT NOT NULL,               -- UTC instant (rendered in Australia/Sydney)
  duration_mins INTEGER NOT NULL DEFAULT 45 CHECK (duration_mins BETWEEN 5 AND 480),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 500),
  casual_price_cents INTEGER NOT NULL CHECK (casual_price_cents BETWEEN 0 AND 100000),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  cancelled_reason TEXT NOT NULL DEFAULT '',
  cancelled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_class ON class_sessions(class_id);
CREATE INDEX idx_sessions_term ON class_sessions(term_id);
CREATE INDEX idx_sessions_starts ON class_sessions(starts_at);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  child_id TEXT NOT NULL REFERENCES children(id),
  kind TEXT NOT NULL CHECK (kind IN ('term', 'casual', 'trial', 'complimentary')),
  term_id TEXT REFERENCES terms(id),     -- the term enrolled in, or the term the chosen sessions belong to
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired')),
  -- Money, AUD cents. amount_cents = list - discount - credit = what is owed.
  list_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (list_amount_cents >= 0),
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  voucher_code TEXT,
  credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  paid_cents INTEGER NOT NULL DEFAULT 0, -- cached SUM(payments.amount_cents); always recomputed from the ledger
  currency TEXT NOT NULL DEFAULT 'AUD',
  payment_method TEXT NOT NULL DEFAULT 'full'
    CHECK (payment_method IN ('full', 'plan', 'offline', 'none')),   -- none = nothing owed
  payment_status TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid', 'paid', 'plan_active', 'plan_overdue', 'plan_complete', 'waived')),
  payment_provider TEXT,                 -- 'stripe' | 'mock' | 'external' | 'free'
  payment_ref TEXT,                      -- Stripe Checkout Session id
  payment_intent TEXT,
  stripe_subscription_id TEXT,
  plan_instalments INTEGER,              -- snapshot of the plan chosen at checkout
  plan_instalment_cents INTEGER,
  plan_interval TEXT,
  plan_next_charge_at TEXT,
  paid_at TEXT,                          -- first successful payment
  -- Legal snapshot taken at booking time; survives later profile edits.
  waiver_version TEXT,
  waiver_accepted_at TEXT,
  photo_consent_snapshot INTEGER,
  medical_notes_snapshot TEXT,
  purchase_tracked_at TEXT,              -- pixel Purchase rendered once
  capi_sent INTEGER NOT NULL DEFAULT 0,  -- Meta Conversions API Purchase emitted
  needs_attention TEXT,                  -- NULL | paid_no_seat | paid_after_cancel | plan_overdue | plan_ended_short | webhook_mismatch
  admin_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT,                       -- pending bookings hold seats until this instant
  cancelled_at TEXT,
  cancelled_by TEXT,                     -- admin user id, 'parent' or 'system'
  cancel_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_bookings_user ON bookings(user_id);
CREATE INDEX idx_bookings_child ON bookings(child_id);
CREATE INDEX idx_bookings_term ON bookings(term_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_payment_ref ON bookings(payment_ref);
CREATE INDEX idx_bookings_subscription ON bookings(stripe_subscription_id);
CREATE INDEX idx_bookings_attention ON bookings(needs_attention);

-- One row per (booking, session). A row HOLDS A SEAT when status = 'booked'
-- and its booking is confirmed, or pending with an unexpired hold. That is the
-- only definition of a held seat; lib/domain.js implements it once.
CREATE TABLE booking_sessions (
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  session_id TEXT NOT NULL REFERENCES class_sessions(id),
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled', 'transferred_out')),
  attendance TEXT CHECK (attendance IN ('present', 'absent')),  -- NULL = not marked
  attendance_marked_at TEXT,
  attendance_marked_by TEXT,
  transferred_to_session_id TEXT REFERENCES class_sessions(id),
  changed_at TEXT,
  PRIMARY KEY (booking_id, session_id)
);
CREATE INDEX idx_booking_sessions_session ON booking_sessions(session_id);

-- Payment ledger: every movement of money (or credit) against a booking.
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  kind TEXT NOT NULL CHECK (kind IN ('checkout', 'instalment', 'offline', 'refund', 'credit_applied', 'adjustment')),
  amount_cents INTEGER NOT NULL,         -- negative for refunds and downward adjustments
  provider TEXT,                         -- 'stripe' | 'mock' | NULL for offline and credit rows
  provider_ref TEXT UNIQUE,              -- Stripe payment_intent / invoice / refund id: the idempotency key
  method TEXT NOT NULL DEFAULT '',       -- 'card', 'bank transfer', 'cash', ...
  note TEXT NOT NULL DEFAULT '',
  recorded_by TEXT,                      -- admin user id for offline entries and adjustments
  paid_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_payments_booking ON payments(booking_id);

CREATE TABLE credits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  child_id TEXT REFERENCES children(id), -- NULL = usable for any child of the account
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  reason TEXT NOT NULL DEFAULT '',
  source_booking_id TEXT REFERENCES bookings(id),
  source_session_id TEXT REFERENCES class_sessions(id),
  issued_by TEXT,                        -- admin user id or 'system'
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  voided_at TEXT
);
CREATE INDEX idx_credits_user ON credits(user_id);

CREATE TABLE credit_redemptions (
  credit_id TEXT NOT NULL REFERENCES credits(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  redeemed_at TEXT NOT NULL,
  PRIMARY KEY (credit_id, booking_id)
);

CREATE TABLE vouchers (
  code TEXT PRIMARY KEY,                 -- stored upper-case, no spaces
  kind TEXT NOT NULL CHECK (kind IN ('amount', 'percent')),
  value INTEGER NOT NULL CHECK (value > 0), -- cents for 'amount', 1–100 for 'percent'
  applies_to TEXT NOT NULL DEFAULT 'any' CHECK (applies_to IN ('any', 'term', 'casual')),
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  uses INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT,
  valid_until TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE waitlist (
  id TEXT PRIMARY KEY,
  term_id TEXT NOT NULL REFERENCES terms(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  child_id TEXT NOT NULL REFERENCES children(id),
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'offered', 'booked', 'declined', 'removed')),
  note TEXT NOT NULL DEFAULT '',
  joined_at TEXT NOT NULL,
  offered_at TEXT,
  offer_expires_at TEXT,
  offer_booking_id TEXT REFERENCES bookings(id),
  resolved_at TEXT,
  UNIQUE (term_id, child_id)
);
CREATE INDEX idx_waitlist_term ON waitlist(term_id, status);

-- Every email the system sends, with a dedupe key so scheduled jobs are idempotent.
CREATE TABLE email_log (
  id TEXT PRIMARY KEY,
  template TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,                -- e.g. 'reminder:<session_id>:<booking_id>'
  to_email TEXT NOT NULL,
  user_id TEXT,
  booking_id TEXT,
  session_id TEXT,
  term_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
  provider_ref TEXT,
  error TEXT,
  sent_at TEXT NOT NULL
);
CREATE INDEX idx_email_log_booking ON email_log(booking_id);

-- Magic-link tokens: only the SHA-256 hash of the token is ever stored.
CREATE TABLE auth_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login' CHECK (purpose IN ('login', 'invite')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_auth_tokens_email ON auth_tokens(email);

-- Web sessions: the cookie holds the raw 256-bit token; only its hash is stored.
CREATE TABLE web_sessions (
  session_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_web_sessions_user ON web_sessions(user_id);
CREATE INDEX idx_web_sessions_expires ON web_sessions(expires_at);

-- Fixed-window rate-limit counters (key already includes the window length).
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

-- Payment-webhook events. A retry is a replay ONLY when the stored row is
-- 'done'; a 'processing'/'failed' row older than two minutes is reprocessed.
CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'done', 'failed')),
  received_at TEXT NOT NULL,
  processed_at TEXT
);

-- Transaction guard: the only legal row id is 'ok', so inserting any other
-- value violates the CHECK and aborts (rolls back) the whole D1 batch.
CREATE TABLE txn_guards (
  id TEXT PRIMARY KEY CHECK (id = 'ok')
);

-- Outbox for the console email driver so local dev can read "sent" emails.
CREATE TABLE dev_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

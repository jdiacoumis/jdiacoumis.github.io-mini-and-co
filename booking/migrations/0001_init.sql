-- Mini & Co. booking system — initial schema.
-- Conventions:
--   * All primary keys are opaque random UUIDs (no enumerable sequential ids).
--   * All timestamps are UTC ISO-8601 strings with second precision and a 'Z'
--     suffix ("2026-07-22T01:00:00Z") so lexicographic comparison == time order.
--   * Foreign keys are enforced by D1 (PRAGMA foreign_keys is ON).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,            -- stored normalised: trimmed + lowercased
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'parent' CHECK (role IN ('parent', 'admin')),
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

CREATE TABLE classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  venue TEXT NOT NULL DEFAULT '',
  age_range TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE class_sessions (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id),
  starts_at TEXT NOT NULL,               -- UTC ISO-8601 (rendered in Australia/Sydney)
  duration_mins INTEGER NOT NULL DEFAULT 45 CHECK (duration_mins BETWEEN 5 AND 480),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 500),
  price_cents INTEGER NOT NULL CHECK (price_cents BETWEEN 0 AND 100000),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_class ON class_sessions(class_id);
CREATE INDEX idx_sessions_starts ON class_sessions(starts_at);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  child_id TEXT NOT NULL REFERENCES children(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'AUD',
  payment_provider TEXT,                 -- 'stripe' | 'mock' | 'external' (migrated/offline)
  payment_ref TEXT,                      -- e.g. Stripe Checkout Session id
  payment_intent TEXT,
  paid_at TEXT,
  -- Legal snapshot taken at the moment of booking; survives later profile edits.
  waiver_version TEXT,
  waiver_accepted_at TEXT,
  photo_consent_snapshot INTEGER,
  medical_notes_snapshot TEXT,
  capi_sent INTEGER NOT NULL DEFAULT 0,  -- Meta Conversions API Purchase emitted
  created_at TEXT NOT NULL,
  expires_at TEXT                        -- pending bookings hold seats until this instant
);
CREATE INDEX idx_bookings_user ON bookings(user_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_payment_ref ON bookings(payment_ref);

CREATE TABLE booking_sessions (
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  session_id TEXT NOT NULL REFERENCES class_sessions(id),
  PRIMARY KEY (booking_id, session_id)
);
CREATE INDEX idx_booking_sessions_session ON booking_sessions(session_id);

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

-- Web sessions: cookie holds the raw 256-bit token; only its hash is stored,
-- so a database leak does not yield usable session credentials.
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

-- Processed payment-webhook event ids (replay protection / idempotency).
CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

-- Transaction guard: the only legal row id is 'ok', so inserting any other value
-- violates the CHECK and aborts the whole D1 batch (poor-man's conditional
-- rollback — D1 has no interactive transactions). Used by capacity-safe booking.
CREATE TABLE txn_guards (
  id TEXT PRIMARY KEY CHECK (id = 'ok')
);

-- Outbox for the console email driver so local dev can read "sent" emails.
-- Unused in production (resend driver never writes here).
CREATE TABLE dev_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

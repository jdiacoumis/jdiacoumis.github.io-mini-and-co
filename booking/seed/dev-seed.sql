-- Development seed (idempotent: fixed ids, INSERT OR REPLACE).
-- Two weekly slots (classes), each with an OPEN six-week "Dev Term" starting
-- in three days plus a CLOSED previous term in the past (for returning-family
-- and re-run flows), and one capacity-1 one-off session for "full" tests.
-- Times are UTC: 01:00Z == 11:00 AEST (12:00 AEDT), 03:00Z == 1:00 pm AEST.
-- Run with: npm run seed:local

INSERT OR REPLACE INTO classes (id, name, description, venue, age_range, weekday, start_time, default_duration_mins, default_capacity, active, created_at) VALUES
  ('cls-wed-11', 'Sensory Play — Wednesday 11:00 am',
   'A calm, evidence-based sensory play class for little ones and their mums — gentle songs, simple play invitations, and intentional moments of connection.',
   'Oran Park Library — Sandown Room', '3–12 months', 3, '11:00', 45, 12, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('cls-wed-13', 'Sensory Play — Wednesday 1:00 pm',
   'A calm, evidence-based sensory play class for little ones and their mums — gentle songs, simple play invitations, and intentional moments of connection.',
   'Oran Park Library — Sandown Room', '3–12 months', 3, '13:00', 45, 12, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

INSERT OR REPLACE INTO terms (id, class_id, name, starts_on, ends_on, term_price_cents, casual_price_cents, trial_price_cents, returning_price_cents, returning_opens_at, public_opens_at, previous_term_id, plan_instalments, plan_interval, status, created_at) VALUES
  ('term-prev-11', 'cls-wed-11', 'Previous Term', date('now', '-52 days'), date('now', '-17 days'), 16800, 3000, NULL, NULL, NULL, NULL, NULL, 6, 'week', 'closed', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('term-prev-13', 'cls-wed-13', 'Previous Term', date('now', '-52 days'), date('now', '-17 days'), 16800, 3000, NULL, NULL, NULL, NULL, NULL, 6, 'week', 'closed', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('term-dev-11',  'cls-wed-11', 'Dev Term', date('now', '+3 days'), date('now', '+38 days'), 16800, 3000, 3000, 15000, NULL, NULL, 'term-prev-11', 6, 'week', 'open', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('term-dev-13',  'cls-wed-13', 'Dev Term', date('now', '+3 days'), date('now', '+38 days'), 16800, 3000, 3000, 15000, NULL, NULL, 'term-prev-13', 6, 'week', 'open', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

-- Open term sessions: six weekly, per slot.
INSERT OR REPLACE INTO class_sessions (id, class_id, term_id, starts_at, duration_mins, capacity, casual_price_cents, status, created_at) VALUES
  ('ses-11-w1', 'cls-wed-11', 'term-dev-11', strftime('%Y-%m-%dT01:00:00Z', 'now', '+3 days'),  45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-11-w2', 'cls-wed-11', 'term-dev-11', strftime('%Y-%m-%dT01:00:00Z', 'now', '+10 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-11-w3', 'cls-wed-11', 'term-dev-11', strftime('%Y-%m-%dT01:00:00Z', 'now', '+17 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-11-w4', 'cls-wed-11', 'term-dev-11', strftime('%Y-%m-%dT01:00:00Z', 'now', '+24 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-11-w5', 'cls-wed-11', 'term-dev-11', strftime('%Y-%m-%dT01:00:00Z', 'now', '+31 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-11-w6', 'cls-wed-11', 'term-dev-11', strftime('%Y-%m-%dT01:00:00Z', 'now', '+38 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-13-w1', 'cls-wed-13', 'term-dev-13', strftime('%Y-%m-%dT03:00:00Z', 'now', '+3 days'),  45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-13-w2', 'cls-wed-13', 'term-dev-13', strftime('%Y-%m-%dT03:00:00Z', 'now', '+10 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-13-w3', 'cls-wed-13', 'term-dev-13', strftime('%Y-%m-%dT03:00:00Z', 'now', '+17 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-13-w4', 'cls-wed-13', 'term-dev-13', strftime('%Y-%m-%dT03:00:00Z', 'now', '+24 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-13-w5', 'cls-wed-13', 'term-dev-13', strftime('%Y-%m-%dT03:00:00Z', 'now', '+31 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-13-w6', 'cls-wed-13', 'term-dev-13', strftime('%Y-%m-%dT03:00:00Z', 'now', '+38 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- Previous (closed) term sessions, all in the past.
  ('ses-p11-w1', 'cls-wed-11', 'term-prev-11', strftime('%Y-%m-%dT01:00:00Z', 'now', '-52 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-p11-w2', 'cls-wed-11', 'term-prev-11', strftime('%Y-%m-%dT01:00:00Z', 'now', '-45 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-p11-w3', 'cls-wed-11', 'term-prev-11', strftime('%Y-%m-%dT01:00:00Z', 'now', '-38 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-p11-w4', 'cls-wed-11', 'term-prev-11', strftime('%Y-%m-%dT01:00:00Z', 'now', '-31 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-p11-w5', 'cls-wed-11', 'term-prev-11', strftime('%Y-%m-%dT01:00:00Z', 'now', '-24 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-p11-w6', 'cls-wed-11', 'term-prev-11', strftime('%Y-%m-%dT01:00:00Z', 'now', '-17 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-p13-w1', 'cls-wed-13', 'term-prev-13', strftime('%Y-%m-%dT03:00:00Z', 'now', '-52 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-p13-w2', 'cls-wed-13', 'term-prev-13', strftime('%Y-%m-%dT03:00:00Z', 'now', '-45 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-p13-w3', 'cls-wed-13', 'term-prev-13', strftime('%Y-%m-%dT03:00:00Z', 'now', '-38 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-p13-w4', 'cls-wed-13', 'term-prev-13', strftime('%Y-%m-%dT03:00:00Z', 'now', '-31 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-p13-w5', 'cls-wed-13', 'term-prev-13', strftime('%Y-%m-%dT03:00:00Z', 'now', '-24 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-p13-w6', 'cls-wed-13', 'term-prev-13', strftime('%Y-%m-%dT03:00:00Z', 'now', '-17 days'), 45, 12, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- One tiny one-off session (no term) for testing the "class full" path.
  ('ses-full',  'cls-wed-11', NULL, strftime('%Y-%m-%dT01:00:00Z', 'now', '+5 days'), 45, 1, 3000, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

-- A voucher for checkout tests: $5 off anything, valid for a year.
INSERT OR REPLACE INTO vouchers (code, kind, value, applies_to, max_uses, uses, valid_from, valid_until, active, note, created_at) VALUES
  ('DEV5', 'amount', 500, 'any', NULL, 0, NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+365 days'), 1, 'Dev seed voucher', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

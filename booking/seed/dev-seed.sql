-- Development seed: one class with four weeks of twice-Wednesday-style sessions
-- at future offsets from "now" so the list always has bookable sessions locally.
-- Times are UTC; 01:00Z == 11:00 AEST, 03:00Z == 1:00 pm AEST.
-- Run with: npm run seed:local   (idempotent: fixed ids, INSERT OR REPLACE)

INSERT OR REPLACE INTO classes (id, name, description, venue, age_range, active, created_at) VALUES (
  'cls-sensory-play',
  'Mini & Co. Sensory Play',
  'A calm, evidence-based sensory play class for little ones and their mums — gentle songs, simple play invitations, and intentional moments of connection.',
  'Oran Park Library — Sandown Room',
  '3–12 months',
  1,
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
);

INSERT OR REPLACE INTO class_sessions (id, class_id, starts_at, duration_mins, capacity, price_cents, status, created_at) VALUES
  ('ses-w1-am', 'cls-sensory-play', strftime('%Y-%m-%dT01:00:00Z', 'now', '+3 days'),  45, 12, 2500, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-w1-pm', 'cls-sensory-play', strftime('%Y-%m-%dT03:00:00Z', 'now', '+3 days'),  45, 12, 2500, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-w2-am', 'cls-sensory-play', strftime('%Y-%m-%dT01:00:00Z', 'now', '+10 days'), 45, 12, 2500, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-w2-pm', 'cls-sensory-play', strftime('%Y-%m-%dT03:00:00Z', 'now', '+10 days'), 45, 12, 2500, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-w3-am', 'cls-sensory-play', strftime('%Y-%m-%dT01:00:00Z', 'now', '+17 days'), 45, 12, 2500, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-w3-pm', 'cls-sensory-play', strftime('%Y-%m-%dT03:00:00Z', 'now', '+17 days'), 45, 12, 2500, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-w4-am', 'cls-sensory-play', strftime('%Y-%m-%dT01:00:00Z', 'now', '+24 days'), 45, 12, 2500, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ses-w4-pm', 'cls-sensory-play', strftime('%Y-%m-%dT03:00:00Z', 'now', '+24 days'), 45, 12, 2500, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- One tiny session for testing the "class full" path locally.
  ('ses-full',  'cls-sensory-play', strftime('%Y-%m-%dT01:00:00Z', 'now', '+5 days'),  45, 1,  2500, 'scheduled', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

-- Development only (like 0002): the mock payments driver's subscriptions, so
-- the dev stand-in for Stripe remembers what it was told — the end date set
-- on a plan (cancel_at) and whether it was cancelled (Stop plan, a plan paid
-- in full, a cancelled booking). The dev checkout charges no instalment on a
-- cancelled one, as Stripe would not. Written only when
-- ENVIRONMENT=development; empty everywhere else.
CREATE TABLE dev_mock_subscriptions (
  id TEXT PRIMARY KEY,                   -- sub_mock_…
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled')),
  cancel_at INTEGER,                     -- unix seconds, like Stripe
  updated_at TEXT NOT NULL
);

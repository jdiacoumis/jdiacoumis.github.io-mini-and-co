-- Development-only additions (written only when ENVIRONMENT=development):
--
-- 1. The console email driver's outbox keeps the Reply-To each email was sent
--    with, so the dev mailbox (and the e2e suite) can show that families'
--    replies reach the owner (EMAIL_REPLY_TO, else the first ADMIN_EMAILS
--    address).
-- 2. The mock payments driver's invoices: every instalment the dev mock
--    checkout "charges" is written here, whether or not its webhook event is
--    delivered, so the mock's listInvoices() can answer "Check with Stripe"
--    the way Stripe would after a lost invoice.paid webhook.

ALTER TABLE dev_emails ADD COLUMN reply_to TEXT NOT NULL DEFAULT '';

CREATE TABLE dev_mock_invoices (
  id TEXT PRIMARY KEY,                   -- in_mock_…
  subscription_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('paid', 'open')),
  amount_paid INTEGER NOT NULL DEFAULT 0,
  amount_due INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  paid_at INTEGER,                       -- unix seconds, like Stripe
  created_at TEXT NOT NULL
);
CREATE INDEX idx_dev_mock_invoices_subscription ON dev_mock_invoices(subscription_id);

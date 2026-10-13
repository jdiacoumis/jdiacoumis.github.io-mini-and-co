-- Development outbox: keep the Reply-To each email was sent with, so the dev
-- mailbox (and the e2e suite) can show that families' replies reach the
-- owner (EMAIL_REPLY_TO, else the first ADMIN_EMAILS address). The table is
-- only written by the console email driver (ENVIRONMENT=development).
ALTER TABLE dev_emails ADD COLUMN reply_to TEXT NOT NULL DEFAULT '';

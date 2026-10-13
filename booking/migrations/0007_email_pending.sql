-- An email is logged as 'pending' while it is being sent, and becomes 'sent'
-- or 'failed' afterwards (adversarial review, task 3.2): it used to be
-- written as 'sent' BEFORE the send, so a send that died part-way (a
-- crashed request, a timeout) was never retried and the log claimed it had
-- gone. A 'pending' row older than ten minutes is retried by the next call
-- with its dedupe key. SQLite cannot alter a CHECK constraint, so the table
-- is rebuilt with the same columns, data and indexes.
CREATE TABLE email_log_new (
  id TEXT PRIMARY KEY,
  template TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,                -- e.g. 'reminder:<session_id>:<booking_id>'
  to_email TEXT NOT NULL,
  user_id TEXT,
  booking_id TEXT,
  session_id TEXT,
  term_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('pending', 'sent', 'failed')),
  provider_ref TEXT,
  error TEXT,
  sent_at TEXT NOT NULL                  -- when sent (or, while pending/failed, when last attempted)
);
INSERT INTO email_log_new (id, template, dedupe_key, to_email, user_id, booking_id, session_id, term_id, subject,
                           status, provider_ref, error, sent_at)
  SELECT id, template, dedupe_key, to_email, user_id, booking_id, session_id, term_id, subject,
         status, provider_ref, error, sent_at
  FROM email_log;
DROP TABLE email_log;
ALTER TABLE email_log_new RENAME TO email_log;
CREATE INDEX idx_email_log_booking ON email_log(booking_id);

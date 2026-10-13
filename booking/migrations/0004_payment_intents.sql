-- The card payment behind each ledger row (adversarial review, task 3.2).
-- Since Stripe API 2025-03-31.basil a charge no longer names its invoice, so
-- a refund of an instalment (charge.refunded carries the payment intent) can
-- only be matched to its booking through the instalment's payment intent:
-- invoice.paid stores it here (looked up through Invoice Payments), checkout
-- rows store the same id they are keyed on, and refund rows the one they
-- refunded.
ALTER TABLE payments ADD COLUMN payment_intent TEXT;
CREATE INDEX idx_payments_payment_intent ON payments(payment_intent);

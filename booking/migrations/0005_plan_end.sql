-- When an instalment plan's Stripe subscription ended — stopped by the
-- owner, stopped because everything owed had arrived, cancelled with the
-- booking, or ended by Stripe (customer.subscription.deleted). NULL while
-- the subscription may still take payments. Overdue reminders and "Stop
-- plan" look at it (adversarial review, task 3.2, findings 1, 5 and 11).
ALTER TABLE bookings ADD COLUMN plan_ended_at TEXT;

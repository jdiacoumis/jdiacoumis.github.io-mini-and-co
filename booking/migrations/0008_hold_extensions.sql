-- How many times Pay now has stretched a held place's deadline so a
-- checkout started near the end of the hold could finish (adversarial
-- review, task 3.2): at most twice per booking, so pressing Pay now again
-- and again cannot keep a place (or a waitlist offer) held for ever.
ALTER TABLE bookings ADD COLUMN hold_extensions INTEGER NOT NULL DEFAULT 0;

## MODIFIED Requirements

### Requirement: Term Grid
The admin portal SHALL show, per term, a grid of families (child and parent) against the term's sessions, marking each cell as present, absent, booked, cancelled or not booked, with a payment column derived from the ledger (paid, plan k of n with next charge date, overdue with amount, unpaid with amount, complimentary) and seats left per session, exportable as CSV.

#### Scenario: Owner checks who has paid before week one
- **WHEN** the owner opens the Term 1 2027 grid
- **THEN** every family's payment state and amount owing is visible without opening any roster

### Requirement: Attendance On The Roster
The roster SHALL let admins and staff mark each child present or absent with one tap per child, recording who marked and when, and SHALL show the child's current medical notes and photo consent beside the booking-time snapshot, with the stricter consent displayed.

#### Scenario: Consent withdrawn mid-term
- **WHEN** a parent changes photo consent to No in week three
- **THEN** the rosters for later weeks show "No" even though the booking snapshot says Yes

### Requirement: Manual Bookings, Transfers, Single-Week Cancellation And Credits
Admins SHALL be able to create bookings for an existing or new family (term, remaining weeks, chosen sessions, trial or complimentary) with an offline payment recorded now or a pay-later hold; transfer a booked week to another session with a seat; cancel a single week with an optional credit; cancel or restore a whole booking; issue, void and view credits; create and disable vouchers; edit parent and child details; and keep admin notes on bookings and customers.

#### Scenario: Family moves from 11 am to 1 pm for one week
- **WHEN** the admin transfers the child's 2027-03-03 11:00 am seat to the 1:00 pm session with a free seat
- **THEN** the 11:00 am seat is released, the 1:00 pm roster lists the child, and no money changes

### Requirement: Needs Attention And Check With Stripe
The admin portal SHALL list every booking flagged for attention or pending with a payment reference older than 40 minutes, with actions to check the provider's record and reconcile (confirm through the capacity-guarded path or expire), record an offline payment, cancel, or resolve with a note.

#### Scenario: Webhook secret was mistyped
- **WHEN** a parent paid but the booking is still pending
- **THEN** Check with Stripe finds the paid session, confirms the booking, records the payment and clears the flag

### Requirement: Re-Run A Term With Auto-Enrol
Admins SHALL be able to create a new term from an existing one with shifted dates and copied prices and options, then auto-enrol selected families (term families by default) as held pending bookings at the returning price with an emailed invitation, so their seats are protected until the window closes.

#### Scenario: Returning family does not pay in time
- **WHEN** the public opening instant passes without payment
- **THEN** the held booking expires and the seat becomes publicly bookable

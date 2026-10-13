## MODIFIED Requirements

### Requirement: Booking Kinds And Pricing
A booking SHALL be one of `term` (every remaining scheduled session of a term), `casual` (chosen sessions at the session's casual price), `trial` (exactly one session at the term's trial price, at most one per child per class) or `complimentary` (admin-only, nothing owed). A term booked before its first session SHALL cost the term price, or the returning price when the account holds a confirmed term booking in the previous term and the returning window has opened. A term booked after it has started SHALL cost the term price pro-rated to the remaining scheduled sessions. Nobody MAY book a term before its public opening instant unless they qualify for the returning window.

#### Scenario: Returning family books during the returning window
- **WHEN** a parent whose child was enrolled in the previous term opens the class list after the returning window opens and before public opening
- **THEN** the term shows the returning price and is bookable
- **AND** a parent without a previous-term booking sees "opens on <date>" and cannot book

#### Scenario: Family joins in week four of ten
- **WHEN** a parent books the term after three sessions have started
- **THEN** the booking covers the seven remaining sessions at seven tenths of the term price, rounded to the cent

#### Scenario: Second trial for the same child is refused
- **WHEN** a child already holds a trial booking for the class
- **THEN** the trial option is not offered for that child and a submitted trial is rejected

### Requirement: Vouchers And Credits At Checkout
Checkout SHALL accept a voucher code, validating activity, validity window, use limit and applicability, and SHALL apply the account's available credits automatically. The amount owed SHALL never be negative; a zero balance SHALL confirm the booking without a payment step.

#### Scenario: Credit covers the whole casual class
- **WHEN** a parent with a $30 credit books a $30 casual session
- **THEN** the booking confirms immediately, the credit is recorded as redeemed, and no payment session is created

### Requirement: Pay-Later Pending Bookings
A pending booking created by an admin (manual pay-later, waitlist offer, auto-enrol) SHALL appear on the parent's account with a Pay now action that starts checkout for the amount owed, until its hold expires.

#### Scenario: Parent pays an auto-enrol booking
- **WHEN** a parent signs in during the returning window and presses Pay now on the held booking
- **THEN** checkout starts at the booking's amount and, on payment, the booking is confirmed with the same seats

### Requirement: Reconciliation Guarantees
A payment that lands after a booking's hold lapsed SHALL be honoured only if every seat can still be taken; otherwise the payment SHALL be recorded, the booking flagged for attention and the owner notified. Backing out of the hosted checkout SHALL expire the provider's checkout session before releasing seats. A payment for a cancelled booking SHALL be recorded and flagged.

#### Scenario: Seat resold before a late payment arrives
- **WHEN** parent A's hold lapses, parent B books and pays for the last seat, and A's payment then arrives
- **THEN** B keeps the seat, A's booking is flagged "paid, no seat", A's payment is in the ledger, and the owner is emailed

#### Scenario: Parent backs out of checkout and the Stripe tab is reused
- **WHEN** a parent lands on the cancelled page and later submits the still-open Stripe page
- **THEN** the Stripe session has been expired and no payment can be taken

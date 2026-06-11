## ADDED Requirements

### Requirement: Session Selection
A signed-in parent SHALL be able to start a booking by selecting one of their own children and one or more upcoming class sessions that have seats available. The system MUST reject a booking attempt that selects a child belonging to another account, a session that has already started, or a session with no seats remaining, and MUST show the per-session price and the total amount in AUD before the parent proceeds.

#### Scenario: Parent selects a child and multiple upcoming sessions
- **WHEN** a signed-in parent with a registered child selects that child and two upcoming sessions that each have seats available
- **THEN** the booking proceeds to the waiver step
- **AND** the displayed total equals the sum of the selected sessions' prices in AUD

#### Scenario: Selecting another account's child is rejected
- **WHEN** a signed-in parent submits a booking that references a child id owned by a different account
- **THEN** the booking is rejected with an authorisation error
- **AND** no booking record or seat reservation is created

#### Scenario: Selecting a past or full session is rejected
- **WHEN** a parent submits a booking that includes a session that has already started or has no seats remaining
- **THEN** the booking is rejected with a message identifying the unavailable session
- **AND** no seats are reserved for any session in that submission

### Requirement: Waiver Acceptance With Consent Snapshot
A booking MUST NOT proceed to payment until the parent has accepted the current waiver/terms, answered the photo-consent question, and confirmed the child's medical notes. The system SHALL snapshot onto the booking record the waiver version, the acceptance timestamp, the photo-consent answer, and the medical notes as confirmed at the time of booking, and these snapshotted values MUST remain unchanged when the child's profile is later edited.

#### Scenario: Waiver acceptance is recorded on the booking
- **WHEN** a parent accepts the waiver, answers the photo-consent question, and confirms the child's medical notes during a booking
- **THEN** the booking stores the waiver version, an acceptance timestamp, the photo-consent answer, and the medical notes as given
- **AND** the booking proceeds to payment

#### Scenario: Booking without waiver acceptance is blocked
- **WHEN** a parent attempts to proceed to payment without accepting the waiver or without answering the photo-consent question
- **THEN** the request is rejected with a message stating the waiver and consent answers are required
- **AND** no payment session is created

#### Scenario: Snapshot survives later profile edits
- **WHEN** a parent edits the child's medical notes or photo consent after a booking has been made
- **THEN** the previously created booking still shows the waiver version, photo-consent answer, and medical notes captured at booking time

### Requirement: Capacity-Guarded Seat Reservation
The system SHALL reserve seats by creating a pending booking whose seats count against session capacity, and a pending booking MUST hold its seats for no longer than 35 minutes before being treated as expired. Seat reservation MUST be safe under concurrency: the number of seats held by confirmed and unexpired pending bookings for a session MUST never exceed that session's capacity.

#### Scenario: Pending booking holds seats
- **WHEN** a parent's booking enters payment for a session with one seat remaining
- **THEN** that session shows as full to other parents while the pending booking is within its 35-minute hold

#### Scenario: Concurrent bookings for the last seat
- **WHEN** two parents simultaneously attempt to reserve the last remaining seat in a session
- **THEN** exactly one reservation succeeds
- **AND** the other parent receives a friendly message that the session has just filled up, with no booking charged or seat double-allocated

#### Scenario: Expired hold frees the seat
- **WHEN** a pending booking passes its 35-minute hold without payment being confirmed
- **THEN** its seats no longer count against session capacity
- **AND** another parent can book the freed seat

### Requirement: Payment via Hosted Stripe Checkout
The system SHALL take payment through Stripe's hosted Checkout page, charging the booking total in AUD, and MUST associate the checkout session with the pending booking so payment can be reconciled. Card details MUST never be collected or stored by the system itself.

#### Scenario: Parent is sent to hosted checkout
- **WHEN** a parent completes the waiver step for a priced booking
- **THEN** the parent is redirected to a hosted Stripe Checkout page showing the booking total in AUD
- **AND** the checkout is linked to the pending booking's identifier

#### Scenario: No card data touches the system
- **WHEN** a parent pays for a booking
- **THEN** card details are entered only on the hosted payment page
- **AND** no card number or card verification data is received or stored by the booking system

### Requirement: Webhook-Verified Booking Confirmation
A booking SHALL be marked confirmed and paid only after the system receives a payment-completion webhook whose signature has been verified against the configured webhook secret. The system MUST reject webhook requests that are unsigned, carry an invalid or tampered signature, or fall outside the accepted timestamp tolerance, and rejected webhooks MUST NOT change any booking's status.

#### Scenario: Verified webhook confirms the booking
- **WHEN** a correctly signed payment-completion webhook arrives for a pending booking
- **THEN** the booking becomes confirmed with paid status, payment reference, and paid amount recorded
- **AND** a booking confirmation email is sent to the parent

#### Scenario: Unsigned or tampered webhook is rejected
- **WHEN** a webhook arrives with no signature, an invalid signature, or a payload that does not match its signature
- **THEN** the request is rejected with an error response
- **AND** no booking status changes and no confirmation email is sent

### Requirement: Booking Confirmation Page
After successful payment, the parent SHALL be shown a confirmation page that displays the booking's paid status, the booked sessions with their dates and times, and the amount paid in AUD. If confirmation has not yet been recorded when the parent returns from checkout, the page MUST continue to reflect the pending state and show the confirmed state once payment confirmation is recorded, without the parent needing to contact anyone.

#### Scenario: Confirmation page shows paid booking
- **WHEN** a parent lands on the confirmation page for a booking whose payment has been confirmed
- **THEN** the page shows a paid status, the child's name, and each booked session with its date and time
- **AND** the amount paid is displayed in AUD

#### Scenario: Confirmation page handles a lagging confirmation
- **WHEN** a parent returns from checkout before the payment confirmation has been recorded
- **THEN** the page shows the booking as awaiting confirmation
- **AND** it shows the paid status once the confirmation is recorded

### Requirement: Cancelled or Expired Checkout Releases Seats
When a checkout is cancelled by the parent or expires unpaid, the system SHALL release the booking's reserved seats so other parents can book them, and the booking MUST end in a cancelled or expired state that is never shown as paid.

#### Scenario: Parent cancels at checkout
- **WHEN** a parent abandons or cancels the hosted checkout for a pending booking
- **THEN** the booking does not become confirmed
- **AND** its seats become available to other parents once the hold lapses

#### Scenario: Expired booking is never shown as paid
- **WHEN** a booking's checkout expires without payment
- **THEN** the booking is recorded as expired
- **AND** it is never displayed to the parent or admin as paid

### Requirement: Parent Booking Dashboard With Account Isolation
A signed-in parent SHALL be able to view a list of their own bookings showing each booking's status (pending, confirmed, cancelled, or expired), the child, and the booked sessions. The system MUST restrict every booking read and every booking-related action to the account that owns the booking; requests referencing another account's booking MUST be denied without revealing whether that booking exists.

#### Scenario: Parent sees their own bookings
- **WHEN** a signed-in parent opens their booking dashboard
- **THEN** they see all bookings belonging to their account with status, child, and session details
- **AND** no bookings from any other account appear

#### Scenario: Access to another account's booking is denied
- **WHEN** a signed-in parent requests a booking page or booking action using another account's booking identifier
- **THEN** the request is denied
- **AND** the response does not disclose whether the booking identifier exists

#### Scenario: Unauthenticated access is refused
- **WHEN** a request without a valid signed-in session attempts to view the dashboard or create a booking
- **THEN** the request is refused and directed to sign in
- **AND** no booking data is returned

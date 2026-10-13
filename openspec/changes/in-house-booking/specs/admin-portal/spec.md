# Admin Portal

## ADDED Requirements

### Requirement: Admin Access Control
Every admin route, page, API endpoint, and export under the admin area SHALL require an authenticated session whose account holds the admin role, with the role re-checked server-side on every request. Anonymous requests SHALL be redirected to sign-in without revealing whether the requested resource exists. Requests from authenticated parent accounts SHALL be denied without exposing any admin data. Every authorisation denial SHALL be recorded in a structured log entry that excludes session tokens and full email addresses.

#### Scenario: Anonymous user requests an admin page
- **WHEN** a request with no authenticated session is made to any admin route
- **THEN** the response redirects to the sign-in page
- **AND** no admin data is included in the response body

#### Scenario: Authenticated parent requests an admin page
- **WHEN** a signed-in user with the parent role requests any admin route
- **THEN** the request is denied with an error response
- **AND** no roster, booking, or customer data is included in the response
- **AND** an authorisation denial is recorded in the logs

#### Scenario: Authenticated admin requests an admin page
- **WHEN** a signed-in user with the admin role requests an admin route
- **THEN** the requested admin page is returned successfully

#### Scenario: Role downgrade takes effect immediately
- **WHEN** a user whose role has been changed from admin to parent makes a request to an admin route using a session issued before the change
- **THEN** the request is denied

### Requirement: Admin Dashboard With Session Fullness
The admin area SHALL present a dashboard listing upcoming class sessions in chronological order, showing for each session its class name, date and time rendered in the Australia/Sydney timezone, and fullness expressed as seats taken out of capacity. Seats taken MUST count confirmed bookings and unexpired pending bookings; expired and cancelled bookings MUST NOT count towards fullness.

#### Scenario: Dashboard shows upcoming sessions with fullness
- **WHEN** an admin opens the dashboard and a future session with capacity 10 has 4 confirmed bookings and 1 unexpired pending booking
- **THEN** the session is listed showing 5 of 10 seats taken

#### Scenario: Expired and cancelled bookings do not count
- **WHEN** a future session with capacity 10 has 2 confirmed bookings, 1 cancelled booking, and 1 pending booking past its expiry window
- **THEN** the dashboard shows 2 of 10 seats taken for that session

### Requirement: Per-Session Roster
For any class session, the admin area SHALL display a roster listing every booking that holds a seat in that session. Each roster row SHALL show the parent's name, email address, and phone number; the child's name and age computed from the child's date of birth as at the session date; the photo consent answer snapshotted on the booking; the medical notes snapshotted on the booking; and the booking's payment status. Child medical notes SHALL be visible only within the parent's own account flow and this admin roster.

#### Scenario: Roster shows full attendee detail
- **WHEN** an admin opens the roster for a session containing a confirmed booking for a child born 8 months before the session date
- **THEN** the roster row shows the parent's name, email, and phone number
- **AND** the child's name and an age of 8 months computed from the date of birth
- **AND** the photo consent and medical notes recorded on the booking
- **AND** a payment status of paid

#### Scenario: Roster reflects consent at time of booking
- **WHEN** a parent changes a child's photo consent after a booking was made and an admin then views the roster for that booking's session
- **THEN** the roster shows the photo consent value snapshotted when the booking was made

### Requirement: Bookings List With Status Filtering
The admin area SHALL provide a bookings list showing each booking's parent, child, session(s), amount, payment provider, and status, and SHALL support filtering the list by booking status (pending, confirmed, cancelled, expired). A filter request naming an unrecognised status value SHALL be rejected or treated as no filter, and MUST NOT cause an unhandled error or expose internal details.

#### Scenario: Filter bookings by status
- **WHEN** an admin filters the bookings list by the confirmed status
- **THEN** only bookings whose status is confirmed are listed

#### Scenario: Unrecognised status filter value
- **WHEN** an admin submits a bookings list filter with a status value that is not one of the recognised statuses
- **THEN** the response is a normal page without internal error details
- **AND** no booking data outside the admin's view is exposed

### Requirement: Manual Payment Marking and Cancellation
An admin SHALL be able to mark a pending booking as paid for offline payment (recording the payment provider as an external or bank-transfer method and the time of payment) and SHALL be able to mark a booking as cancelled. These state changes MUST be performed via state-changing requests that verify a valid per-session CSRF token, and MUST validate the current booking state: a cancelled or expired booking MUST NOT be markable as paid, and repeating a mark-as-paid action on an already-confirmed booking MUST NOT alter the original payment record. A cancelled booking's seat MUST be released so it no longer counts towards session fullness.

#### Scenario: Mark a pending booking paid via bank transfer
- **WHEN** an admin marks a pending booking as paid offline
- **THEN** the booking status becomes confirmed
- **AND** the booking records an offline payment provider and the time payment was recorded
- **AND** the booking appears as paid on the session roster

#### Scenario: Cancel a confirmed booking
- **WHEN** an admin marks a confirmed booking as cancelled
- **THEN** the booking status becomes cancelled
- **AND** the session's fullness count decreases by the seats that booking held

#### Scenario: Mark-as-paid rejected without CSRF token
- **WHEN** a state-changing mark-as-paid request is submitted without a valid CSRF token for the admin's session
- **THEN** the request is rejected
- **AND** the booking status is unchanged

#### Scenario: Cannot mark a cancelled booking paid
- **WHEN** an admin attempts to mark a cancelled booking as paid
- **THEN** the request is rejected with a clear error message
- **AND** the booking remains cancelled

#### Scenario: Duplicate mark-as-paid does not overwrite payment record
- **WHEN** an admin submits mark-as-paid for a booking that has already been confirmed as paid
- **THEN** the booking's original payment provider, reference, and payment time are unchanged

#### Scenario: Mark-as-paid for a nonexistent booking
- **WHEN** an admin submits mark-as-paid with a booking identifier that does not exist
- **THEN** the request is rejected with an error response
- **AND** no booking record is created or modified

### Requirement: Customers List With Children
The admin area SHALL provide a customers list showing each parent account's name, email address, and phone number alongside that parent's children, with each child's name and age computed from their date of birth. The list SHALL include migrated customers and self-registered customers alike.

#### Scenario: Customers list shows parents and their children
- **WHEN** an admin opens the customers list and a parent account has two children on file
- **THEN** the parent's name, email, and phone number are listed
- **AND** both children appear under that parent with their names and ages computed from date of birth

### Requirement: CSV Export of Rosters and Bookings
The admin area SHALL allow an admin to export a session roster and the bookings list as CSV files containing the same fields visible on the corresponding admin pages. Export requests MUST be available only to authenticated admin sessions and MUST be protected against cross-site request forgery; a parent or anonymous request to an export endpoint SHALL be denied and SHALL return no CSV data. CSV field values originating from user input MUST be encoded so that values beginning with formula-triggering characters cannot execute when the file is opened in a spreadsheet application.

#### Scenario: Admin exports a session roster as CSV
- **WHEN** an admin requests the CSV export for a session's roster
- **THEN** a CSV file is returned containing one row per seat-holding booking with parent contact details, child name and age, photo consent, medical notes, and payment status

#### Scenario: Non-admin export request is denied
- **WHEN** a parent or anonymous request is made to a roster or bookings export endpoint
- **THEN** the request is denied
- **AND** no CSV content is returned

#### Scenario: Formula injection is neutralised in exports
- **WHEN** a roster is exported containing a medical note that begins with an equals sign
- **THEN** the corresponding CSV value is encoded so it is not interpreted as a formula by spreadsheet applications

### Requirement: Admin Action Rate Limiting and Abuse Resistance
Repeated failed attempts to access admin routes from the same source SHALL be rate limited, and rate-limit trips SHALL be logged. Responses to denied or rate-limited requests MUST be generic and MUST NOT reveal which admin routes, bookings, sessions, or customers exist.

#### Scenario: Repeated unauthorised admin requests are rate limited
- **WHEN** the same source makes repeated unauthorised requests to admin routes in a short window
- **THEN** subsequent requests from that source are rate limited
- **AND** a rate-limit event is recorded in the logs

#### Scenario: Denied responses do not leak resource existence
- **WHEN** an unauthorised request targets an admin route for a booking identifier that exists and another that does not
- **THEN** both responses are indistinguishable to the requester

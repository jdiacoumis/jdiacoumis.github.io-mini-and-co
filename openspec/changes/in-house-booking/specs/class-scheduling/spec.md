## ADDED Requirements

### Requirement: Class Management by Administrators
Administrators SHALL be able to create, edit, and deactivate classes. Each class MUST have a name, description, venue, and age range. Deactivating a class SHALL hide it from the public class list without deleting it or its historical sessions, so past bookings remain intact.

#### Scenario: Admin creates a class
- **WHEN** a signed-in administrator submits a new class with name "Sensory Explorers", a description, venue "Oran Park Community Centre", and age range "3–12 months"
- **THEN** the class is created in an active state
- **AND** the class appears in the admin schedule management view

#### Scenario: Admin edits an existing class
- **WHEN** a signed-in administrator changes the venue of an existing class and saves
- **THEN** the updated venue is shown everywhere the class is displayed
- **AND** existing bookings against that class's sessions are unaffected

#### Scenario: Admin deactivates a class
- **WHEN** a signed-in administrator deactivates a class that has upcoming sessions
- **THEN** the class no longer appears on the public class list
- **AND** the class and its sessions remain visible to administrators, marked as inactive

#### Scenario: Class creation with missing required fields is rejected
- **WHEN** an administrator submits a new class with an empty name
- **THEN** the class is not created
- **AND** a validation message identifies the missing field and the previously entered values are preserved for correction

### Requirement: Schedule Management Restricted to Administrators
All class and session management actions (create, edit, deactivate classes; create, edit, cancel sessions) MUST be restricted to authenticated users with the administrator role, verified on the server for every request. State-changing schedule requests MUST be rejected when they lack a valid anti-forgery token.

#### Scenario: Parent attempts to access schedule management
- **WHEN** a signed-in parent requests the admin schedule management area or submits a class-creation request directly
- **THEN** the request is denied without revealing admin data
- **AND** no class or session is created or modified
- **AND** the authorisation denial is recorded in the application logs

#### Scenario: Unauthenticated request to a schedule management endpoint
- **WHEN** a request with no valid session attempts to create or edit a session
- **THEN** the request is denied and the user is directed to sign in
- **AND** no data is changed

#### Scenario: Schedule change without a valid anti-forgery token
- **WHEN** an administrator's browser submits a session-creation request that is missing or carries an invalid anti-forgery token
- **THEN** the request is rejected
- **AND** no session is created

### Requirement: Session Creation with Validated Details
Administrators SHALL be able to create dated sessions for a class by entering a date and start time in Australia/Sydney local time, a duration in minutes, a seat capacity, and a price in Australian dollars. Inputs MUST be validated: the date/time MUST be a real calendar date and time, duration and capacity MUST be positive whole numbers, and the price MUST be a non-negative AUD amount. Invalid input MUST be rejected without creating a session.

#### Scenario: Admin creates a single session
- **WHEN** an administrator creates a session for an active class at a Sydney-local date and time in the future, with a 45-minute duration, capacity of 10, and price of $25.00 AUD
- **THEN** the session is created and appears in the admin schedule
- **AND** the session is offered to parents at exactly $25.00 AUD

#### Scenario: Session with invalid capacity is rejected
- **WHEN** an administrator submits a session with a capacity of 0, a negative capacity, or a non-numeric capacity
- **THEN** the session is not created
- **AND** a validation message explains that capacity must be a positive whole number

#### Scenario: Session with invalid date or price is rejected
- **WHEN** an administrator submits a session with a date that does not exist (such as 31 February) or a negative price
- **THEN** the session is not created
- **AND** a validation message identifies the invalid field

### Requirement: Weekly Repeat Session Creation
When creating a session, administrators SHALL be able to request weekly repetition for a specified number of weeks (N), producing N sessions on the same weekday at the same Sydney-local start time with identical duration, capacity, and price. Repetition MUST preserve the Sydney-local start time across daylight-saving transitions. The repeat count MUST be validated as a positive whole number within a sensible upper bound, and an out-of-range count MUST be rejected without creating any sessions.

#### Scenario: Admin creates a weekly repeating session
- **WHEN** an administrator creates a Wednesday 9:30 am session with capacity 10 and price $25.00 AUD, repeating weekly for 8 weeks
- **THEN** 8 sessions exist, one on each of the next 8 Wednesdays, each starting at 9:30 am Sydney time with the same duration, capacity, and price

#### Scenario: Weekly repeat spans a daylight-saving transition
- **WHEN** an administrator creates a weekly repeating session whose run crosses an AEST/AEDT changeover
- **THEN** every generated session still displays a 9:30 am start in Australia/Sydney local time on both sides of the changeover

#### Scenario: Invalid repeat count is rejected
- **WHEN** an administrator requests weekly repetition with a count of 0, a negative number, or a value above the permitted maximum
- **THEN** no sessions are created
- **AND** a validation message states the acceptable range

### Requirement: Sydney-Local Time Presentation
All session dates and times MUST be entered, displayed, and exported in Australia/Sydney local time, correctly reflecting AEST and AEDT, in every surface where sessions appear: the public class list, the booking flow, booking confirmations and emails, the admin schedule, and rosters/exports.

#### Scenario: Session times render in Sydney time for parents
- **WHEN** a parent views a session on the public class list or in the booking flow
- **THEN** the date and time shown match the Sydney-local time the administrator entered, regardless of the viewer's device timezone

#### Scenario: Daylight-saving boundary renders correctly
- **WHEN** a session falls in AEDT and another falls in AEST
- **THEN** each is displayed at its correct Sydney-local clock time with no one-hour drift in any view, confirmation, or export

### Requirement: Session Fullness Visible to Administrators
The admin schedule SHALL show, for every session, the number of seats taken against capacity (for example "7/10"). A seat counts as taken when it is held by a confirmed booking or by a pending booking whose payment window has not yet lapsed; lapsed pending bookings MUST NOT count towards fullness.

#### Scenario: Admin views fullness for a session
- **WHEN** a session with capacity 10 has 6 confirmed bookings and 1 unexpired pending booking
- **THEN** the admin schedule shows 7 of 10 seats taken for that session

#### Scenario: Lapsed pending booking releases its seat in the count
- **WHEN** a pending booking against a session passes its payment expiry window without being paid
- **THEN** the admin fullness count for that session decreases by one
- **AND** the freed seat becomes available to parents again

### Requirement: Full and Past Sessions Not Bookable
Parents MUST NOT be able to book a session that has no remaining seats or whose start time has already passed in Australia/Sydney time. This MUST hold both in the user interface (the session is shown as full or past and offers no booking action) and on the server (a direct booking request for such a session is rejected). Seat allocation MUST be race-safe: when concurrent requests contend for the last seat, at most one succeeds and capacity is never exceeded.

#### Scenario: Full session cannot be booked
- **WHEN** a parent views a session whose seats are all taken
- **THEN** the session is displayed as full with no booking action
- **AND** a direct booking request for that session is rejected with a message that the session is full, and no booking is created

#### Scenario: Past session cannot be booked
- **WHEN** a parent submits a booking request for a session whose Sydney-local start time has passed
- **THEN** the request is rejected
- **AND** no booking is created

#### Scenario: Two parents race for the last seat
- **WHEN** two parents submit booking requests for the same session's final remaining seat at effectively the same moment
- **THEN** exactly one request secures the seat
- **AND** the other receives a clear message that the session has just filled, with no booking created for it
- **AND** the total seats taken never exceeds the session's capacity

### Requirement: Public Class List Shows Only Active Classes with Upcoming Sessions
The public class list SHALL display only classes that are active and have at least one upcoming session with its Sydney-local start time in the future. Inactive classes, and active classes whose sessions have all passed, MUST NOT appear. For each listed class, only upcoming sessions SHALL be offered for booking.

#### Scenario: Active class with upcoming sessions is listed
- **WHEN** a visitor opens the public class list while an active class has two future sessions
- **THEN** the class is shown with both upcoming sessions, including Sydney-local date and time, price in AUD, and remaining availability

#### Scenario: Deactivated class is hidden from the public list
- **WHEN** a visitor opens the public class list after an administrator has deactivated a class that still has future sessions
- **THEN** that class does not appear on the public list

#### Scenario: Class with only past sessions is hidden
- **WHEN** all of an active class's sessions have start times in the past
- **THEN** the class does not appear on the public class list
- **AND** it reappears automatically once an administrator adds a future session

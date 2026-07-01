## ADDED Requirements

### Requirement: Child profile creation
A signed-in parent SHALL be able to create a child profile consisting of the child's name (required, non-empty after trimming, at most 100 characters), date of birth (required), medical conditions (optional free text, at most 2000 characters), and a photo consent choice. The photo consent choice MUST be an explicit yes or no — the form SHALL NOT pre-select a value, and a submission without a consent choice MUST be rejected with a message identifying the missing field. On successful creation the parent SHALL be redirected to a page listing their children, with the new child shown.

#### Scenario: Parent creates a valid child profile
- **WHEN** a signed-in parent submits a child profile with name "Ava", a date of birth 8 months in the past, no medical conditions, and photo consent set to "yes"
- **THEN** the profile is created and associated with the parent's account
- **AND** the parent is shown their children list containing "Ava" with the recorded consent choice

#### Scenario: Submission without a photo consent choice is rejected
- **WHEN** a signed-in parent submits a child profile with a valid name and date of birth but no photo consent selection
- **THEN** the profile is not created
- **AND** the parent is shown an error stating that a photo consent choice is required, with their other entered values preserved

#### Scenario: Blank or oversized name is rejected
- **WHEN** a signed-in parent submits a child profile whose name is empty, whitespace only, or longer than 100 characters
- **THEN** the profile is not created
- **AND** the parent is shown an error identifying the name field

### Requirement: Date of birth validation
The system SHALL validate the date of birth on every create and edit. The value MUST be a real calendar date (e.g. 31 February MUST be rejected), MUST NOT be in the future relative to the current date in Australia/Sydney, and MUST place the child within a plausible age range of 0 to 6 years at the time of submission. Invalid dates MUST be rejected with a message explaining the accepted range, and no profile MUST be created or changed.

#### Scenario: Future date of birth is rejected
- **WHEN** a parent submits a child profile with a date of birth one day in the future
- **THEN** the submission is rejected with an error stating the date of birth cannot be in the future
- **AND** no child profile is created

#### Scenario: Impossible calendar date is rejected
- **WHEN** a parent submits a child profile with the date of birth "2025-02-31"
- **THEN** the submission is rejected with an error stating the date is not a valid calendar date

#### Scenario: Child older than the plausible range is rejected
- **WHEN** a parent submits a child profile with a date of birth more than 6 years in the past
- **THEN** the submission is rejected with an error explaining that children must be aged between 0 and 6 years

#### Scenario: Newborn date of birth is accepted
- **WHEN** a parent submits a child profile with today's date as the date of birth
- **THEN** the submission is accepted

### Requirement: Ownership-scoped access with no cross-account disclosure
Every child profile SHALL be owned by exactly one parent account, and all read, edit, and delete operations on a child profile MUST verify on the server that the profile belongs to the signed-in account. A request that references a child profile belonging to another account MUST receive the same not-found response as a request for a non-existent profile identifier, so that neither the existence nor the contents of another account's child records can be confirmed. Child profile identifiers MUST be non-sequential opaque values that cannot be enumerated by incrementing.

#### Scenario: Parent attempts to view another account's child
- **WHEN** parent A is signed in and requests the child profile page using the identifier of a child owned by parent B
- **THEN** the response is a not-found response
- **AND** none of parent B's child details (name, date of birth, medical conditions, consent) appear in the response

#### Scenario: Parent attempts to edit another account's child
- **WHEN** parent A is signed in and submits an edit request against the identifier of a child owned by parent B
- **THEN** the response is a not-found response and parent B's child record is unchanged

#### Scenario: Response is indistinguishable for unknown identifiers
- **WHEN** parent A requests a child profile using a well-formed identifier that does not exist
- **THEN** the response status and body are indistinguishable from the response for another account's child

#### Scenario: Children list shows only the signed-in parent's children
- **WHEN** a signed-in parent views their children list
- **THEN** only child profiles owned by their own account are shown

### Requirement: Editing a child profile
A parent SHALL be able to edit the name, date of birth, medical conditions, and photo consent choice of a child profile they own. Edits MUST be re-validated under the same rules as creation, and a failed validation MUST leave the stored profile unchanged. Edits to a profile MUST NOT alter the consent or medical details snapshotted onto any existing booking.

#### Scenario: Parent updates medical conditions and consent
- **WHEN** a parent edits their own child's profile to add a medical condition and change photo consent from "yes" to "no"
- **THEN** the stored profile reflects the new medical condition and the "no" consent choice
- **AND** the consent and medical details recorded against the child's previously confirmed bookings remain as they were at the time of booking

#### Scenario: Invalid edit leaves the profile unchanged
- **WHEN** a parent edits their own child's profile and submits a date of birth in the future
- **THEN** the edit is rejected with a validation error
- **AND** the previously stored profile values are unchanged

### Requirement: Authentication required for all child profile operations
All child profile pages and state-changing operations MUST require an authenticated session. Unauthenticated requests to view, create, edit, or delete a child profile MUST be redirected to sign-in (or denied) without revealing any child data. State-changing child profile requests MUST be rejected when they lack a valid anti-forgery token bound to the session, leaving stored data unchanged.

#### Scenario: Unauthenticated request is denied
- **WHEN** a request without a valid session attempts to view or submit a child profile form
- **THEN** the request is redirected to sign-in or denied
- **AND** no child data is included in the response and no record is created or changed

#### Scenario: Cross-site forged submission is rejected
- **WHEN** a state-changing child profile request arrives with a valid session cookie but a missing or mismatched anti-forgery token
- **THEN** the request is rejected and the stored profile data is unchanged

### Requirement: Medical conditions and consent visibility restricted to owner and admins
A child's medical conditions and photo consent choice MUST be visible only to the owning parent and to signed-in administrators. These details MUST NOT appear in any page, response, or export available to other parents or to unauthenticated visitors, and they MUST NOT be written to application logs.

#### Scenario: Admin can view medical conditions and consent
- **WHEN** a signed-in administrator views a session roster containing a booked child
- **THEN** the child's medical conditions and photo consent choice are visible to the administrator

#### Scenario: Other parents cannot see medical details anywhere
- **WHEN** parent A is signed in and views any page or response available to a parent role
- **THEN** no medical conditions or consent details of children owned by parent B are present

#### Scenario: Medical details are excluded from logs
- **WHEN** a child profile containing medical conditions is created or edited
- **THEN** the emitted application logs contain no medical condition text

### Requirement: Child profile required before booking
A parent MUST have at least one child profile before a booking can be started, and every booking MUST be made for a specific child profile owned by the booking parent. A parent with no child profiles who attempts to book SHALL be directed to create a child profile first, and a booking submission that references a child not owned by the parent MUST be rejected without creating a booking.

#### Scenario: Parent with no children is directed to create one
- **WHEN** a signed-in parent with no child profiles attempts to start a booking
- **THEN** no booking is created
- **AND** the parent is directed to the child profile creation step before they can proceed

#### Scenario: Booking for another account's child is rejected
- **WHEN** a signed-in parent submits a booking that references a child identifier owned by a different account
- **THEN** the booking is rejected with a not-found response and no booking record is created

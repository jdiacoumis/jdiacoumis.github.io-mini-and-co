## ADDED Requirements

### Requirement: Admin-Only CSV Import Access
The customer import facility SHALL be available only to authenticated administrators. The system MUST deny access to anonymous visitors and to authenticated parents, and MUST record an authorisation denial event when a non-administrator attempts access.

#### Scenario: Administrator reaches the import screen
- **WHEN** a signed-in administrator navigates to the customer import area
- **THEN** the upload form for a migration CSV file is displayed

#### Scenario: Parent account is denied
- **WHEN** a signed-in parent attempts to open the customer import area or submit an import request
- **THEN** the request is refused with an authorisation error
- **AND** no import data is read or stored

#### Scenario: Anonymous visitor is denied
- **WHEN** an unauthenticated visitor requests any customer import route
- **THEN** the request is refused and the visitor is directed to sign in
- **AND** no import data is read or stored

### Requirement: CSV Upload and Parsing
The system SHALL accept an uploaded CSV file containing, per row: parent name, parent email, parent phone, child name, child date of birth, medical notes, photo consent, and optionally an enrolment (class and sessions) to recreate. The system MUST parse the file without committing any records and MUST reject files that are not parseable CSV or that omit required columns, with an error message stating what is wrong.

#### Scenario: Well-formed CSV is parsed
- **WHEN** an administrator uploads a CSV with the expected columns and ten valid rows
- **THEN** all ten rows are parsed and presented for preview
- **AND** no parent, child, or booking records are created at this point

#### Scenario: File with missing required columns is rejected
- **WHEN** an administrator uploads a CSV that lacks the parent email column
- **THEN** the upload is rejected with a message identifying the missing column
- **AND** no records are created

#### Scenario: Non-CSV upload is rejected
- **WHEN** an administrator uploads a file that cannot be parsed as CSV
- **THEN** the upload is rejected with a message explaining the file could not be parsed
- **AND** no records are created

### Requirement: Import Preview Before Commit
The system SHALL display a preview of every parsed row before any data is committed. The preview MUST show, for each row, whether it is valid or invalid, the reason for any invalidity, and whether the row would create new records or match existing ones. Committing the import MUST require an explicit, separate confirmation action by the administrator.

#### Scenario: Preview summarises valid and invalid rows
- **WHEN** an administrator uploads a CSV containing eight valid rows and two rows with errors
- **THEN** the preview lists all ten rows, marking eight as valid and two as invalid with a per-row reason
- **AND** nothing is written to the database until the administrator confirms the commit

#### Scenario: Administrator abandons the preview
- **WHEN** an administrator views a preview and navigates away without confirming
- **THEN** no parent, child, or booking records are created

### Requirement: Row Validation With Partial Import
The system SHALL validate each row independently: parent email MUST be a syntactically valid email address, child date of birth MUST be a real past date, and photo consent MUST be an unambiguous yes/no value. On commit, the system SHALL import all valid rows and skip all invalid rows, reporting each skipped row with its row number and the reason it was skipped.

#### Scenario: Mixed file imports only the valid rows
- **WHEN** an administrator commits an import containing six valid rows and one row with an invalid email address
- **THEN** six parent/child records are created
- **AND** the result report lists the invalid row with its row number and the reason "invalid email address" (or equivalent)

#### Scenario: Future date of birth is rejected
- **WHEN** a row contains a child date of birth later than today
- **THEN** that row is reported as invalid with a reason identifying the date of birth
- **AND** the row is not imported

#### Scenario: Ambiguous photo consent is rejected
- **WHEN** a row contains a photo consent value that is not recognisable as yes or no
- **THEN** that row is reported as invalid with a reason identifying the photo consent value
- **AND** the row is not imported

### Requirement: Idempotent Re-Import
The import SHALL be idempotent, keyed on the combination of normalised parent email and child name. Re-committing the same file, or a file containing rows already imported, MUST NOT create duplicate parent accounts, duplicate child records, or duplicate bookings; such rows MUST be reported as already-existing matches rather than errors.

#### Scenario: Same file committed twice creates no duplicates
- **WHEN** an administrator commits the same CSV file a second time
- **THEN** the record counts for parents, children, and bookings are unchanged from the first commit
- **AND** the result report identifies every row as matching an existing record

#### Scenario: Same parent with a second child adds only the new child
- **WHEN** a committed file contains two rows with the same parent email but different child names, and one child was imported previously
- **THEN** exactly one parent account exists for that email
- **AND** only the previously unseen child record is created

#### Scenario: Concurrent duplicate commits create no duplicates
- **WHEN** two commit requests for the same file are submitted at effectively the same time
- **THEN** at most one set of records exists afterwards for each email-and-child-name key
- **AND** no duplicate parent, child, or booking records exist

### Requirement: Recreated Enrolments Are Confirmed Externally-Paid Bookings
Where a row specifies an existing enrolment, the system SHALL create a confirmed booking for the named child against the specified sessions, recorded as paid through an external provider with no amount owing. The system MUST NOT initiate any payment, send any payment request, or emit any purchase conversion event for migrated enrolments. Migrated bookings MUST occupy capacity in the affected sessions.

#### Scenario: Enrolment row creates a confirmed booking
- **WHEN** an administrator commits a row that includes an enrolment for an existing class session
- **THEN** a confirmed booking exists for that child and session, marked as externally paid
- **AND** no payment is requested from the parent
- **AND** no purchase conversion event is emitted

#### Scenario: Migrated booking counts toward session capacity
- **WHEN** a migrated booking is created for a session
- **THEN** the session's remaining capacity is reduced by that booking

#### Scenario: Enrolment referencing an unknown session is rejected
- **WHEN** a row's enrolment references a class or session that does not exist
- **THEN** that row is reported as invalid with a reason identifying the unknown class or session
- **AND** the parent and child for that row are not silently enrolled in anything else

### Requirement: Invite Emails After Commit
After a committed import, the system SHALL allow the administrator to send invite emails to the imported parents. Each invite MUST contain a single-use magic sign-in link, MUST be sent only to email addresses imported in this system, and the administrator MUST be shown which invites were sent. Invite sending MUST be subject to rate limiting so that repeated triggering does not flood parents' inboxes.

#### Scenario: Administrator sends invites to imported parents
- **WHEN** an administrator triggers invite sending after a successful commit
- **THEN** each imported parent receives one invite email containing a magic sign-in link
- **AND** the administrator sees a confirmation of which addresses were sent invites

#### Scenario: Repeated invite triggering is rate limited
- **WHEN** an administrator triggers invite sending repeatedly in quick succession for the same parents
- **THEN** further sends to the same address within the limit window are refused or skipped
- **AND** the administrator is informed that the limit applied

### Requirement: Passwordless Sign-In for Migrated Parents
A migrated parent SHALL be able to sign in by following the magic link in their invite, without ever creating or entering a password. On first sign-in the parent MUST be able to see their imported details (their own profile, children, and any migrated bookings) and the link MUST be single-use and time-limited; an expired or already-used link MUST be refused with the option to request a fresh link.

#### Scenario: Invite link signs the parent in
- **WHEN** a migrated parent opens the magic link from their invite email before it expires
- **THEN** they are signed in without being asked for a password
- **AND** their imported profile, children, and migrated bookings are visible to them

#### Scenario: Expired invite link is refused
- **WHEN** a migrated parent opens an invite link after its expiry time
- **THEN** sign-in is refused with a message explaining the link has expired
- **AND** the parent is offered a way to request a fresh sign-in link

#### Scenario: Reused invite link is refused
- **WHEN** a magic link that has already been used for sign-in is opened again
- **THEN** sign-in is refused
- **AND** no new session is created from the reused link

## ADDED Requirements

### Requirement: Transactional Emails With An Idempotent Log
The system SHALL send: booking confirmation (with the instalment schedule when a plan was chosen), a reminder the day before each session, session-cancelled notices with any credit, trial follow-up offers, re-enrol invitations, waitlist offers, failed-instalment notices and offline-payment receipts. Every send SHALL be logged with a dedupe key so that re-running a job never sends a duplicate.

#### Scenario: Cron runs twice in an hour
- **WHEN** the reminder job runs twice for the same session
- **THEN** each booked family receives exactly one reminder

### Requirement: Owner-Composed Bulk Email
Admins SHALL be able to compose and send an email to all families of a term (or a term's waitlist), delivered individually and logged.

#### Scenario: Owner announces a theme change
- **WHEN** the admin sends a message to Term 1 2027 families
- **THEN** each parent receives it addressed only to them and the log shows every recipient

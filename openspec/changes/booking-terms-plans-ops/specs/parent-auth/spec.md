## MODIFIED Requirements

### Requirement: Staff Role And Live Allowlists
Accounts whose email is in `STAFF_EMAILS` SHALL have the staff role, limited to viewing rosters and marking attendance. Admin and staff rights SHALL be re-derived from the allowlists on every request so that removal takes effect immediately.

#### Scenario: Facilitator removed from the allowlist
- **WHEN** an email is removed from `STAFF_EMAILS` while that person is signed in
- **THEN** their next admin request is denied

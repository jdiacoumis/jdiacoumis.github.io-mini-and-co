## ADDED Requirements

### Requirement: Magic-Link Sign-In Request
The system SHALL allow a person to request a sign-in link by submitting an email address, and SHALL respond with the same generic confirmation message regardless of whether the email belongs to a known account, so that the endpoint cannot be used to enumerate accounts. The system SHALL send a sign-in email only when the submitted address corresponds to a registered account, and SHALL normalise the email address (trim, lower-case) before matching. Submitted values that are not syntactically valid email addresses MUST be rejected with a validation message and MUST NOT trigger any email send.

#### Scenario: Registered email receives a sign-in link
- **WHEN** a parent submits the email address of an existing account on the sign-in page
- **THEN** the response displays a generic "check your email" confirmation
- **AND** a sign-in email containing a single-use magic link is dispatched to that address

#### Scenario: Unknown email receives an indistinguishable response
- **WHEN** someone submits an email address that does not match any account
- **THEN** the response status, content, and timing behaviour are indistinguishable from the registered-email case
- **AND** no email is sent and no account is created

#### Scenario: Invalid email format is rejected
- **WHEN** someone submits a value that is not a syntactically valid email address
- **THEN** the form is re-presented with a validation message
- **AND** no sign-in email is dispatched

### Requirement: Magic-Link Expiry and Single Use
Each magic link SHALL be valid for at most 20 minutes from issue and SHALL be usable exactly once. The system MUST reject expired, already-used, unknown, or malformed tokens with the same generic failure page that offers to request a new link, without revealing which condition failed. Consuming a token MUST be atomic, so that two concurrent verification attempts with the same token cannot both succeed.

#### Scenario: Fresh link signs the parent in
- **WHEN** a parent opens their magic link within 20 minutes of it being issued
- **THEN** they are signed in to their account

#### Scenario: Expired link is rejected
- **WHEN** a parent opens a magic link more than 20 minutes after it was issued
- **THEN** sign-in is refused with a generic message offering to request a new link
- **AND** no session is established

#### Scenario: Reused link is rejected
- **WHEN** a magic link that has already been used to sign in is opened a second time
- **THEN** sign-in is refused with the same generic failure message
- **AND** the session established by the first use remains valid

#### Scenario: Concurrent use of one link yields a single sign-in
- **WHEN** two verification requests with the same valid token arrive at effectively the same time
- **THEN** at most one request succeeds in establishing a session
- **AND** the other receives the generic failure response

#### Scenario: Forged token is rejected
- **WHEN** someone opens a verification URL containing a guessed or tampered token
- **THEN** sign-in is refused with the generic failure message and no account information is disclosed

### Requirement: Session Cookie Security
On successful magic-link verification the system SHALL establish a web session identified by a cookie carrying the `HttpOnly`, `Secure`, and `SameSite=Lax` attributes scoped to the whole site. A fresh session identifier MUST be issued at every sign-in (never reusing a pre-authentication identifier), and the session identifier MUST be an unguessable value of at least 256 bits of entropy. Sessions SHALL expire absolutely 30 days after creation, after which the bearer MUST be treated as unauthenticated.

#### Scenario: Cookie attributes on sign-in
- **WHEN** a parent completes magic-link verification
- **THEN** the response sets a session cookie with `HttpOnly`, `Secure`, and `SameSite=Lax` attributes

#### Scenario: New session identifier per sign-in
- **WHEN** a parent signs in on two separate occasions
- **THEN** each sign-in issues a different session identifier

#### Scenario: Expired session treated as signed out
- **WHEN** a request presents a session cookie whose session is more than 30 days old
- **THEN** the request is handled as unauthenticated and the user is directed to sign in again

### Requirement: Sign-Out with Server-Side Revocation
The system SHALL provide a sign-out action that revokes the session on the server, so that any copy of the session cookie is unusable afterwards. Sign-out MUST be a state-changing request protected against cross-site request forgery, and the response MUST clear the session cookie in the browser.

#### Scenario: Replayed cookie after sign-out is rejected
- **WHEN** a parent signs out and a previously captured copy of their session cookie is then presented on a protected page
- **THEN** the request is treated as unauthenticated and redirected to the sign-in page

#### Scenario: Sign-out clears the browser cookie
- **WHEN** a parent triggers sign-out
- **THEN** the response instructs the browser to remove the session cookie
- **AND** the parent lands on a signed-out page

### Requirement: Rate Limiting of Authentication Endpoints
The system SHALL rate limit magic-link requests per normalised email address and per client IP address, and SHALL rate limit token verification attempts per client IP address. When a limit is exceeded the system MUST refuse further attempts for the remainder of the window with a generic "try again later" response that does not reveal whether the targeted email has an account. Rate-limit refusals on the link-request endpoint MUST present the same outward behaviour for registered and unregistered emails.

#### Scenario: Per-email link request limit
- **WHEN** repeated magic-link requests for the same email address exceed the per-email limit within the window
- **THEN** subsequent requests in that window do not dispatch email
- **AND** the requester sees a generic response asking them to try again later

#### Scenario: Per-IP link request limit
- **WHEN** one client IP submits magic-link requests for many different email addresses beyond the per-IP limit
- **THEN** further requests from that IP within the window are refused with the generic response

#### Scenario: Verification attempts are throttled
- **WHEN** a client IP submits repeated token verification attempts beyond the verification limit within the window
- **THEN** further verification attempts from that IP are refused for the remainder of the window
- **AND** the refusal does not indicate whether any attempted token was close to valid

### Requirement: Admin Role Restricted to Allowlisted Emails
The system SHALL grant the admin role only to accounts whose normalised email address appears on the configured admin allowlist; every other account SHALL hold the parent role. There MUST be no self-service path by which a parent account gains the admin role. Admin-only pages and admin-only operations MUST verify the requester's admin role on the server for every request, and MUST respond to non-admin requesters without disclosing admin content.

#### Scenario: Allowlisted email is recognised as admin
- **WHEN** a person whose email is on the admin allowlist signs in via magic link
- **THEN** their account holds the admin role
- **AND** they can open the admin area

#### Scenario: Parent denied access to admin area
- **WHEN** a signed-in parent whose email is not on the allowlist requests an admin page or admin operation
- **THEN** the request is denied without revealing any admin content
- **AND** the authorisation denial is recorded in the system's logs

#### Scenario: Role tampering attempt is ineffective
- **WHEN** a parent crafts a request attempting to set or claim the admin role (for example by submitting extra form fields or modified cookies)
- **THEN** their account remains a parent account and admin requests continue to be denied

### Requirement: Authentication Redirects for Protected Pages
The system SHALL redirect unauthenticated requests for protected pages to the sign-in page, preserving the originally requested destination so the user is returned there after successful sign-in. The post-sign-in destination MUST be restricted to same-site relative paths; any absolute URL or external destination MUST be ignored in favour of the default signed-in landing page, preventing open redirects.

#### Scenario: Unauthenticated visit is redirected to sign-in
- **WHEN** a visitor without a valid session requests a protected account page
- **THEN** they are redirected to the sign-in page

#### Scenario: Returned to original destination after sign-in
- **WHEN** a visitor is redirected from a protected page to sign-in and then completes magic-link sign-in
- **THEN** they are returned to the page they originally requested

#### Scenario: External redirect target is ignored
- **WHEN** the sign-in flow is initiated with a return destination pointing at an external site
- **THEN** after sign-in the user is taken to the default signed-in landing page instead of the external destination

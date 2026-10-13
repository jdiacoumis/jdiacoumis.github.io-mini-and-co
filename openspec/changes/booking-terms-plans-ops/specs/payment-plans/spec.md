## ADDED Requirements

### Requirement: Instalment Plans For Term Bookings
When a term allows payment plans, checkout SHALL offer paying in full or in the term's number of instalments at the term's interval, SHALL show the schedule (first amount, each amount, dates) before payment, and SHALL collect instalments automatically from the saved card through a provider subscription that ends after the final instalment. Instalment amounts SHALL be whole cents with any remainder on the first instalment.

#### Scenario: $168 over six weekly instalments
- **WHEN** a parent chooses the plan for a $168 term
- **THEN** six instalments of $28.00 are scheduled weekly, the first charged at checkout and the subscription set to end after the sixth

#### Scenario: $100 over three instalments
- **WHEN** the total does not divide evenly
- **THEN** the schedule is $33.34, $33.33, $33.33

### Requirement: Ledger-Backed Payment Status
Every payment, instalment, offline payment, refund, applied credit and adjustment SHALL be a ledger row with a unique provider reference where one exists. A booking's paid amount and payment status (unpaid, paid, plan active, plan overdue, plan complete, waived) SHALL be derived from the ledger. Duplicate provider events SHALL NOT create duplicate rows.

#### Scenario: Webhook retry after a transient failure
- **WHEN** the first delivery of an instalment event fails inside the handler and Stripe retries it
- **THEN** the retry is processed and exactly one ledger row exists for that invoice

### Requirement: Failed Instalments Never Silently Cancel A Place
A failed instalment SHALL mark the plan overdue, flag the booking for attention and email the parent with a way to update their card. The booking SHALL keep its seats until the owner acts.

#### Scenario: Card declines in week three
- **WHEN** the third instalment fails
- **THEN** the booking shows "Overdue" with the amount in the grid and the needs-attention list, the parent is emailed an Update card link, and the child remains on the roster

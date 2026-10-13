## MODIFIED Requirements

### Requirement: Classes Are Weekly Slots With Terms
A class SHALL represent one weekly slot (weekday, start time, default duration and capacity). A term SHALL belong to one class and carry start and end dates, a term price, a casual price, an optional trial price, an optional returning-family price with an opening instant, an optional public opening instant, a reference to the previous term, payment-plan options and a status of draft, open or closed. Creating a term SHALL generate one scheduled session per week between its dates at the class's weekday and time, skipping any holiday dates given, with the class defaults and the term's casual price.

#### Scenario: Admin creates a ten-week term with a holiday
- **WHEN** an admin creates "Term 1 2027" for "Wednesday 11:00 am" from 2027-02-03 to 2027-04-07 with 2027-03-10 as a holiday
- **THEN** nine scheduled sessions exist, one per Wednesday except 2027-03-10, each starting 11:00 Sydney time with the class defaults
- **AND** sessions before and after the daylight-saving change on 2027-04-04 still render as 11:00 am

#### Scenario: Term dates and prices are edited after creation
- **WHEN** an admin extends the term by one week and raises the term price
- **THEN** a new scheduled session is appended
- **AND** existing bookings keep their original amounts

### Requirement: Sessions Remain Individually Editable
A session's time, capacity, casual price and status SHALL remain editable after generation. Cancelling a session SHALL record a reason and timestamp, stop it holding or offering seats, and trigger the notices and credits defined in `parent-comms` and `admin-portal`.

#### Scenario: Admin cancels one week
- **WHEN** an admin cancels the 2027-03-17 session with reason "venue closed"
- **THEN** the session no longer appears as bookable, every affected family is emailed, and term families receive a credit for that week

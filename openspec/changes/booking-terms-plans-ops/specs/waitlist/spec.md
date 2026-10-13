## ADDED Requirements

### Requirement: Parents Join A Term's Waitlist
When a term has no seat available for a term booking, the class list SHALL offer to join the waitlist for a chosen child. One entry per child per term SHALL exist, ordered by join time, visible on the parent's account.

#### Scenario: Term is full
- **WHEN** every remaining session of a term is full and a signed-in parent views it
- **THEN** a Join waitlist action is shown instead of Book, and joining records the child with the join time

### Requirement: Owner Offers Seats With A Timed Hold
The owner SHALL see each term's waitlist in join order and SHALL be able to offer a seat as the remaining term, a trial or chosen weeks, at a price defaulting from the term. An offer SHALL create a held pending booking that expires after 48 hours and SHALL email the parent. A lapsed offer SHALL release the seat and return the entry to waiting; a paid offer SHALL mark the entry booked.

#### Scenario: Offer lapses
- **WHEN** 48 hours pass without payment
- **THEN** the pending booking is expired, the seat is free, and the entry is back to waiting with the lapse noted

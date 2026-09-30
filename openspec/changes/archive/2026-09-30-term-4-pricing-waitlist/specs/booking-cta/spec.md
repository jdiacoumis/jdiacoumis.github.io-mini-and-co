## MODIFIED Requirements

### Requirement: Page copy MUST NOT contradict the live booking flow

No body copy, lede paragraph, eyebrow text, or `<meta name="description">` content on any page MAY claim that customers must "register interest", or that customers should email the owner to book a class or join a waitlist. All booking-status copy MUST be consistent with booking through Class4Kids: when the current term has places, copy MAY say bookings are open; when the current term is full, copy SHALL say so and SHALL direct the customer to the "Book now" CTA to join the waitlist. Copy MUST NOT claim bookings are open for a term that is fully booked.

#### Scenario: Reader skims the site for booking status
- **WHEN** the customer reads any heading, lede, eyebrow, paragraph, or page meta description across the four HTML pages
- **THEN** the copy is consistent with the current term's status on Class4Kids (open, or full with a waitlist)
- **AND** no copy claims bookings are "opening soon", "not live yet", or that the customer should email to register

#### Scenario: Current term is fully booked
- **WHEN** the current term has no places left
- **THEN** no page says "Bookings are now open" or equivalent
- **AND** each booking CTA band states that the term is full and that "Book now" leads to the waitlist

#### Scenario: Search engine indexes the contact page
- **WHEN** a search engine reads `<meta name="description">` on `contact.html`
- **THEN** the description does not promise an "interest registration" flow that no longer exists

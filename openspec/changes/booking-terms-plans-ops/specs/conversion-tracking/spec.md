## MODIFIED Requirements

### Requirement: Pixel Scoped To The Funnel
The Meta pixel SHALL load only on pages under `/book`. The `Purchase` event SHALL render at most once per booking. Conversions API events SHALL include the action source, event source URL, client user agent and client IP alongside hashed identifiers, using a current Graph API version.

#### Scenario: Parent revisits a confirmation page
- **WHEN** a paid booking's confirmation page is opened a second time
- **THEN** no `Purchase` event fires

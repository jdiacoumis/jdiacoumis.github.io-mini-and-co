## MODIFIED Requirements

### Requirement: Marketing CTAs Unchanged Until Cutover
The marketing pages SHALL keep their `main`-branch content, including the ClassForKids Book now links, until the DNS cutover change replaces them with `/book/`.

#### Scenario: Branch merged before cutover
- **WHEN** this change is merged
- **THEN** every Book now button on the live site still opens ClassForKids

## MODIFIED Requirements

### Requirement: Import Enrolments By Term
The CSV import SHALL match an enrolment to a term by class and term name (`enrol_class`, `enrol_term`) and create a confirmed, externally paid term booking covering the term's remaining sessions, or create the family with no enrolment when the columns are blank.

#### Scenario: Term 1 2027 families imported without enrolments
- **WHEN** the owner imports the ClassForKids export with blank enrolment columns
- **THEN** every parent and child exists and no seats are held

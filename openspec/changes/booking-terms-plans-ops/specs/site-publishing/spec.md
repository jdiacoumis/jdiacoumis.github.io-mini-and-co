## ADDED Requirements

### Requirement: Allow-Listed Static Assets
The Worker SHALL serve static assets only from a staged folder built from an explicit allow-list of site files, never from the repository root on disk. Developer and deploy commands SHALL stage the folder first. Private paths SHALL return 404.

#### Scenario: Private file on disk
- **WHEN** the repo checkout contains a gitignored file outside the allow-list and the Worker is deployed from it
- **THEN** requesting that path returns 404

# Customer Migration — ClassForKids → in-house bookings

Moves the ~20 existing customers (parent contact details, children, and their
current paid enrolments) into the new system and invites every parent with a
passwordless sign-in link. The import is **idempotent** — re-running it with
the same file never creates duplicates — and nothing is written until you
explicitly commit a previewed file.

## 1. Create the term's schedule first

Enrolments in the CSV are matched against sessions that already exist. In
`/admin` create the class (if it isn't there) and its sessions — the weekly
repeat option makes a term one form submission.

## 2. Export from ClassForKids and prepare the CSV

Export the customer list from the ClassForKids dashboard, then massage it into
the template (download from `/admin/import` → "download the template"; for
~20 customers a spreadsheet edit is the quickest path).

Columns (header row required, one row per child):

| Column | Required | Notes |
| --- | --- | --- |
| `parent_name` | yes | |
| `parent_email` | yes | normalised automatically (trim/lowercase) |
| `parent_phone` | yes (may be blank) | digits kept, punctuation dropped |
| `child_name` | yes | import key together with the parent email |
| `child_dob` | yes | `YYYY-MM-DD`, a real past date, age 0–6 |
| `medical_notes` | no | free text, ≤ 2000 characters |
| `photo_consent` | yes | `yes`/`no` (`y`, `n`, `true`, `false`, `1`, `0` accepted) |
| `enrol_class` | no | exact class name as it appears in `/admin/classes` |
| `enrol_sessions` | with `enrol_class` | semicolon-separated Sydney-local starts, e.g. `2026-07-01 09:30; 2026-07-08 09:30` |

Two children of one parent = two rows with the same `parent_email`.
A parent with no current enrolment = leave both `enrol_*` columns empty.

## 3. Preview

`/admin/import` → choose the file → **Preview import**. Every row is shown as
valid (with whether it creates new records or matches existing ones) or
invalid with the reason (bad email, impossible date of birth, ambiguous
consent, unknown class/session, …). Nothing has been written at this point —
navigating away abandons the upload.

Fix invalid rows in the spreadsheet and re-upload, or proceed: committing
imports the valid rows and skips invalid ones, reporting each skipped row.

## 4. Commit

**Commit import** creates, for each valid row:

- the parent account (or matches the existing one by email — details of
  existing accounts are never overwritten),
- the child profile (or matches by parent + child name),
- for enrolment rows: a **confirmed, externally-paid** booking
  (`payment_provider=external`, nothing owing) that occupies seats in the
  listed sessions. No payment is requested and no conversion event is fired
  for migrated bookings.

Re-committing the same file (or a corrected version including already-imported
rows) reports those rows as already existing and changes nothing — safe to
iterate.

## 5. Send invites

From the commit report, **Send invite emails**. Each imported parent receives
a single-use, 20-minute magic sign-in link ("your account has moved — click to
sign in"); the report shows exactly which addresses were sent. Repeat sends to
the same address are rate limited (one per 10 minutes), so a double-click
can't flood inboxes; expired links are no problem — the sign-in page issues
fresh ones.

First sign-in shows the parent their imported details, children, and migrated
bookings. They accept the current waiver the first time they make a **new**
booking.

## 6. Verify and decommission

1. `/admin/customers` — every migrated parent with their children.
2. Per-session rosters — migrated bookings listed as Paid (`external`).
3. Spot-check one parent journey end to end (invite → sign-in → details).
4. Keep ClassForKids running read-only until the last migrated term finishes,
   then cancel the subscription.

**Escape hatch**: all data is exportable at any time — bookings CSV from
`/admin/bookings`, per-session roster CSVs, and full database backups via
`wrangler d1 export` (see DEPLOYMENT.md).

# Customer Migration — ClassForKids → in-house bookings

**The plan**: Term 4 2026 runs to the end on ClassForKids (last classes
Wednesday 18 November 2026). Term 1 2027 opens on this system. Before it
opens, the ~20 existing families (parent contact details and children) are
imported, every parent is invited with a passwordless sign-in link, and
returning families are invited to re-enrol.

The import is **idempotent** — re-running it with the same file never creates
duplicates — and nothing is written until you explicitly commit a previewed
file. Screen and button names are as in OWNER-GUIDE.md.

## 1. Create the terms first

Enrolment rows in the CSV are matched to a **term** by class name and term
name, so every term you import into must exist first, with classes still to
come.

1. `/admin/classes` — both weekly slots exist ("Sensory Play — Wednesday
   11:00 am" and "… 1:00 pm"); create them if not.
2. **Terms → New term** — create **Term 1 2027** for one class and tick the
   other under **Also create the same term for**: first class date and weeks
   (or last class date) and holiday dates, term/casual/trial prices, the
   returning price and its opening time, the public opening time, and
   instalments (OWNER-GUIDE.md §3). Leave it as a **Draft** (don't tick "Open
   for bookings straight away") until the invitations have gone out. (If you
   choose option A in step 6, create Term 1 2027 there instead, by re-running
   Term 4 2026.)

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
| `enrol_class` | no | the class's exact name as in `/admin/classes`, e.g. `Sensory Play — Wednesday 11:00 am` |
| `enrol_term` | with `enrol_class` | that class's term name, e.g. `Term 4 2026` |

Two children of one parent = two rows with the same `parent_email`.

**For Term 1 2027, leave `enrol_class` and `enrol_term` empty on every row**:
families are imported with no enrolments and hold no places (Term 4 stays on
ClassForKids). The enrolment columns are only for bringing current-term
places across — see option A in step 6.

## 3. Preview

`/admin/import` → choose the file → **Preview import**. Every row is shown as
valid (with whether it creates new records or matches existing ones, and any
enrolment) or invalid with the reason (bad email, impossible date of birth,
ambiguous consent, unknown class or term, a term with no classes left, …).
Nothing has been written at this point — navigating away abandons the upload.

Fix invalid rows in the spreadsheet and re-upload, or proceed: committing
imports the valid rows and skips invalid ones, reporting each skipped row.

## 4. Commit

**Commit import** creates, for each valid row:

- the parent account (or matches the existing one by email — details of
  existing accounts are never overwritten),
- the child profile (or matches by parent + child name),
- for a row with `enrol_class`/`enrol_term`: a **confirmed, externally paid
  term booking** (`payment_provider=external`, nothing owing) holding a seat
  in every remaining class of that term. No payment is requested, no
  confirmation email is sent and no conversion event is fired. Re-importing
  the same file never enrols a child twice.

Re-committing the same file (or a corrected version including already-imported
rows) reports those rows as already existing and changes nothing — safe to
iterate.

## 5. Send sign-in invites

From the commit report, **Send invite emails**. Each imported parent receives
"Your Mini & Co. account has moved — sign in to get started": a single-use,
20-minute sign-in link; the report shows exactly which addresses were sent.
Repeat sends to the same address are rate limited (one per 10 minutes), so a
double-click can't flood inboxes; expired links are no problem — the sign-in
page issues fresh ones. (Sign-in links are not kept in the email log.)

First sign-in shows the parent their details and children. They accept the
current waiver the first time they book.

## 6. Re-enrol invitations for Term 1 2027

Choose one:

### Option A — places held at the returning price

The system treats a family as **returning** when they hold a confirmed term
booking in the term before. To give Term 4 families that status:

1. **Before 18 November 2026**, create **Term 4 2026** for both classes with
   only the weeks still to come, and **close** it so nobody can book it online.
2. Import a CSV of the families enrolled now, with `enrol_class` and
   `enrol_term = Term 4 2026` — each becomes a confirmed, externally paid
   booking for the remaining weeks (nothing owed). Rosters for those weeks
   will list them. These families will also get this system's day-before
   reminder for those weeks, so import in the final week (or tell them to
   expect it).
3. **Terms → Term 4 2026 → Re-run term** to create Term 1 2027 from it. Set
   the **first class date** and **number of weeks** yourself: the copy starts
   two empty weeks after Term 4 and is only as long as the Term 4 you created
   (just its last weeks). Then set the prices, returning price and opening
   times → **Create the new term**,
   then **Hold places and send invitations** for the ticked families: each
   Term 4 family gets a place held at the returning price until public opening
   (or 7 days) and the email "<child>'s place in Term 1 2027 is saved — pay by
   <date>" (at "your returning-family price") with a Pay now link. Creating
   Term 1 2027 this way links it to Term 4 2026 as its previous term, which is
   what makes these families "returning". Do it for each class's Term 4.
4. **Open for bookings** on Term 1 2027. Returning families book from the
   returning window; everyone else sees "Bookings open …" until public
   opening, when unpaid held places are released automatically.

### Option B — families book themselves (simplest)

1. Open Term 1 2027 and tell families — the invite email, Instagram, a last
   message through ClassForKids.
2. Optionally give returning families their discount with a voucher code
   limited to terms, by dates and number of uses.
3. For a family who asks you to hold a place, make a **pay-later manual
   booking** (held 7 days, emailed a Pay now link) — see OWNER-GUIDE.md §7.

Either way, families who can't get a place can join the waitlist, and you
offer places from `/admin/waitlist` (OWNER-GUIDE.md §10).

## 7. Verify and decommission

1. `/admin/customers` — every migrated parent with their children.
2. Term 1 2027's grid — held or paid places as expected (option A).
3. Spot-check one parent journey end to end (invite → sign-in → details →
   Pay now or booking).
4. `/admin/email/log` — re-enrol invitations (option A) went out; failed
   addresses are listed with the reason.
5. Keep ClassForKids running read-only until Term 4 finishes, then cancel the
   subscription.

**Escape hatch**: all data is exportable at any time — bookings CSV from
`/admin/bookings`, per-session roster CSVs, and full database backups via
`wrangler d1 export` (see DEPLOYMENT.md).

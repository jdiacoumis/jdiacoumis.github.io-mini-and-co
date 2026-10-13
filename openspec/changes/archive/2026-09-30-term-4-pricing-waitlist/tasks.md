## 1. Pre-flight

- [x] 1.1 Re-grep the four HTML files for `$25`, `"25"`, `24 June`, `22 July`, `Launch`, `launch`, `Term 3`, `now open`, `open to book` and `InStock` to confirm the inventory in `proposal.md`

## 2. index.html

- [x] 2.1 `<meta name="description">`: replace "Launching Wednesday 24 June 2026." with the weekly schedule ("Wednesdays at 11am and 1pm.")
- [x] 2.2 LocalBusiness JSON-LD: `priceRange` → `"$30–$168"`; replace the single `$25` catalogue offer with two offers (6-week term 168 AUD, casual class 30 AUD), no `availability`
- [x] 2.3 Event JSON-LD: replace both launch events with Term 4 (Morning/Afternoon) events per design Decision 4 (`+11:00`, `eventSchedule`, 168 AUD, `SoldOut`)
- [x] 2.4 Detail grid: Investment → Price, `$168` / "per 6-week term · casual $30"; "Launch class" → "Term 4" / "14 Oct – 18 Nov 2026" / "Fully booked · waitlist open"; "Term 3 enrolments" → "Term 1 2027" / "Details coming soon"
- [x] 2.5 Closing CTA band: `h2` "Save your spot at the launch class." → Term 4 full wording; lede → waitlist wording

## 3. classes.html

- [x] 3.1 Event JSON-LD: same replacement as 2.3
- [x] 3.2 Schedule grid: "Launch class" → "Term 4" tile; "Term 3 — first class" → "Term 1 2027" tile; Investment → Price, `$168` / "per 6-week term · casual $30"
- [x] 3.3 Closing CTA band lede → waitlist wording (keep "Ready to come along?")

## 4. about.html and contact.html

- [x] 4.1 `about.html` CTA band lede ("Wednesday classes are open to book…") → waitlist wording
- [x] 4.2 `contact.html` "Book a class" paragraph ("Bookings are now open…") → waitlist wording

## 5. sitemap.xml

- [x] 5.1 Set `lastmod` to 2026-09-30 for the four pages

## 6. Verification

- [x] 6.1 Re-run the 1.1 grep — no stale hits remain
- [x] 6.2 Parse every JSON-LD block with `python3 -m json.tool` (or equivalent) — all valid
- [x] 6.3 Confirm all "Book now" CTAs are byte-identical to before (text, `href`, `target`, `rel`, `onclick`)
- [x] 6.4 Serve locally and check the detail grids and CTA bands on each page at desktop and phone widths

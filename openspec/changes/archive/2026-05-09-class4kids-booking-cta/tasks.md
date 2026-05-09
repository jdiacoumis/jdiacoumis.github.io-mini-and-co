## 1. Pre-flight checks

- [x] 1.1 Confirm `https://mini-co-sensory.classforkids.io` is publicly visible (no sign-in required) and shows at least one bookable class
- [x] 1.2 Re-grep all four HTML pages for `Register your interest`, `register interest`, `register your interest`, `mailto:miniandco`, `bookings open`, and `booking system` to confirm the inventory in `proposal.md` / `design.md` is still accurate before editing

## 2. index.html

- [x] 2.1 Replace the hero CTA at L52: change anchor text from "Register your interest" to "Book now", `href` to `https://mini-co-sensory.classforkids.io`, add `target="_blank" rel="noopener"`, keep `class="button"`
- [x] 2.2 Replace the closing CTA at L182 with the same swap (text, href, target, rel, class)
- [x] 2.3 Sanity-check the rest of the page: term dates, dt/dd blocks, headings — flag any phrasing that implies bookings aren't yet live

## 3. about.html

- [x] 3.1 Rewrite the lede at L156: it currently reads "Register your interest for the launch class — Wednesday 24 June 2026." — replace with copy framed around booking now (do not embed the launch-class date in the lede unless the date still applies; defer date-specific phrasing to the term-info blocks elsewhere)
- [x] 3.2 Replace the CTA at L157 (text, href, target, rel, class) per §2.1
- [x] 3.3 Sanity-check the rest of the page for any leftover "register" / "interest" phrasing

## 4. classes.html

- [x] 4.1 Rewrite the lede at L133: currently "Bookings open soon. In the meantime, let us know which class you'd like and we'll save you a spot." — replace with copy that confirms bookings are open via Class4Kids
- [x] 4.2 Replace the CTA at L134 (text, href, target, rel, class) per §2.1
- [x] 4.3 Verify the dt/dd block at L89 ("Wed 22 July 2026 / Full-term enrolments open") and the address paragraph at L124 ("Full address details and what to look for on arrival are sent to everyone who registers") — adjust the L124 wording so it no longer says "registers" since customers now book via C4K
- [x] 4.4 Sanity-check the rest of the page for any leftover "register" / "interest" phrasing

## 5. contact.html

- [x] 5.1 Update `<meta name="description">` at L7: remove the "register interest for the launch class" phrasing; rewrite to reflect that bookings are live and the page is for general contact
- [x] 5.2 Rewrite the lede at L44: currently "Register your interest for the launch class, ask a question, or just say hello — Camila reads every message." — rephrase so it no longer leads with "register your interest"
- [x] 5.3 Update the introduction paragraph at L55 ("For class enquiries, registrations, and anything else.") — drop "registrations" since bookings are now via C4K
- [x] 5.4 Replace the eyebrow at L80: currently `<span class="eyebrow">Register interest</span>` — change to "Book a class" (or similar booking-aligned label)
- [x] 5.5 Replace the paragraph at L82: currently "We don't have a booking system live just yet — so for now, the easiest way to register is a quick email…" — replace with a short paragraph directing customers to Class4Kids for bookings
- [x] 5.6 Remove the "what to include" instructions block at L85: it lists baby's age / preferred class time / launch class on 24 June or term 3 from 22 July — all of which Class4Kids collects. Either delete this block entirely or replace with one short sentence suitable for the new flow
- [x] 5.7 Replace the CTA at L88 (text, href, target, rel, class) per §2.1
- [x] 5.8 Confirm no "or email Camila directly" secondary link is added — email remains only in the duplicated footer (per design D5)
- [x] 5.9 Sanity-check the rest of the page for any leftover "register" / "interest" phrasing

## 6. Sitewide consistency sweep

- [x] 6.1 Re-grep all four HTML files for `register`, `interest`, `mailto:`, `book a class`, `bookings open soon`, `booking system` (case-insensitive) — confirm zero unexpected hits remain
- [x] 6.2 Verify all five "Book now" CTAs use the exact same href, target, rel, and class attributes (consistency across pages, since header/footer are duplicated by hand)
- [x] 6.3 Verify the duplicated footer's email link is unchanged across all four pages

## 7. Local verification

- [x] 7.1 Serve the site locally (`python3 -m http.server 8080`) and load each of the four pages
- [x] 7.2 Click every "Book now" CTA — confirm each opens `https://mini-co-sensory.classforkids.io` in a new tab and the original tab remains open
- [x] 7.3 Visually scan each page for any awkward copy artefacts left over from the rewrite (orphaned commas, leftover "and" / "or" connectors, mid-sentence references to email)
- [x] 7.4 Confirm no CSS, JS, asset, or script changes were introduced (`git diff --stat` should show only `*.html` and `openspec/` files)

## 8. Validate against the spec

- [x] 8.1 Run `openspec validate class4kids-booking-cta --strict` and confirm it passes
- [x] 8.2 Walk through each requirement in `specs/booking-cta/spec.md` and confirm the implementation satisfies every scenario (especially §6 of the spec — no new build step, no new files outside HTML + openspec)

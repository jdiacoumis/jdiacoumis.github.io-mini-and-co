## Context

Mini & Co's marketing site is intentionally a hand-authored static site (`index.html`, `about.html`, `classes.html`, `contact.html`) sharing one stylesheet and one JS file — see [CLAUDE.md](../../../CLAUDE.md) for the "no frameworks, no build step" stance. Until now, every primary CTA on the site has been a `mailto:miniandco.classes@gmail.com?...` link labelled "Register your interest", because no booking system was live.

The owner has now provisioned a Class4Kids tenant at `https://mini-co-sensory.classforkids.io` and published the Term 3 Wednesday 11:00–11:45 class. Class4Kids is a SaaS booking platform purpose-built for kids' classes (term enrolment, age cohorts, sibling discounts, registers, allergy notes) and is widely used in AU/UK for sensory, swim, and dance schools.

This change wires the static site into that booking flow.

## Goals / Non-Goals

**Goals:**
- Replace every primary "Register your interest" CTA with a "Book now" link to the C4K tenant.
- Remove copy that contradicts the new reality (e.g. "We don't have a booking system live just yet…").
- Establish a `booking-cta` capability spec so future booking work has a baseline.
- Preserve the static, no-build-step architecture and the existing visual design.

**Non-Goals:**
- Building a custom booking system or any backend.
- Embedding Class4Kids via iframe — link only.
- Adding a "Book now" button to the global header navigation.
- Adding analytics or click tracking.
- Touching CSS, JS, the asset pipeline, or any file outside the four HTML pages.
- Deep-linking to a specific class — landing page only, so the link survives Term 4 and beyond without edits.

## Decisions

### D1. SaaS embed (Class4Kids), not a self-built booking system

**Choice:** Link out to Class4Kids; do not build.

**Alternatives considered:**
- *Build in-house* (Stripe Checkout + custom backend + DB + email + admin tools). Feasible to build but introduces permanent ops burden: PCI scope (even with Stripe-hosted checkout, SAQ-A applies), Privacy Act 1988 / APP 11 compliance for storing children's names, DOB and allergy notes, email deliverability (SPF/DKIM/DMARC), backups, on-call for Saturday morning failures. Conflicts with the project's "no frameworks, no build step" stance.
- *Stripe Payment Links only* (no scheduling). Cheap, but no capacity management or class roster — owner would still maintain a manual spreadsheet.
- *Generic schedulers* (Calendly, Acuity, Eventbrite). Workable but not tailored to recurring term enrolment, sibling discounts, age cohorts.

**Rationale:** Class4Kids is purpose-built for this exact business shape; cost is roughly per-booking, no monthly minimum; it offloads PCI and PII handling entirely. For a single-location term-based class business, SaaS fees are not meaningfully more expensive than self-hosting once owner time is priced in.

### D2. CTA wording: "Book now"

**Choice:** "Book now" everywhere.

**Alternatives considered:** "Book a class", "Book online", "Enrol now".

**Rationale:** "Book now" is short, standard, and unambiguous. It reads naturally in every position the existing CTAs occupy (hero, mid-page, closing). User-confirmed during scoping.

### D3. Link target: tenant landing page, not deep link

**Choice:** `https://mini-co-sensory.classforkids.io` for every CTA.

**Alternatives considered:** Deep link directly to the Wednesday 11:00–11:45 class booking page.

**Rationale:** While there is currently only one class, future Term 4 classes and additional time slots are expected. Deep-linking would require a CTA edit every time the catalogue grows. The extra click on the C4K landing page is acceptable UX cost. Trade-off accepted.

### D4. Link attributes: `target="_blank" rel="noopener"`

**Choice:** Open Class4Kids in a new tab.

**Alternatives considered:** Same-tab navigation.

**Rationale:** Standard pattern for external booking flows — keeps the Mini & Co tab open so the customer returns easily after booking. `rel="noopener"` is required for security (prevents the new tab from manipulating `window.opener`). `rel="noreferrer"` is **not** added because Class4Kids' analytics legitimately benefit from seeing the referrer, and there's no privacy reason to strip it.

### D5. Drop the email fallback on contact.html

**Choice:** No "or email Camila directly" secondary link on contact.html. Camila's email remains in the duplicated footer on every page.

**Alternatives considered:** Keep email as a demoted secondary path on contact.html for parents who prefer email.

**Rationale:** A single clear path is better than two competing paths on the same page. The footer already exposes the email globally for genuinely off-process enquiries (questions, complaints, partnerships) — that's the right channel for those. The contact page itself becomes unambiguously about booking.

### D6. New capability spec: `booking-cta`

**Choice:** Create `specs/booking-cta/spec.md` to document the contract.

**Rationale:** The repo currently has no specs at all. Establishing a small, focused spec for the booking-CTA contract gives future changes (provider switch, header CTA, deep-linking strategy, analytics) a clean delta target instead of inferring intent from HTML diffs.

## Risks / Trade-offs

- **Class4Kids tenant outage** → CTA dead-ends. *Mitigation:* same blast radius as the current `mailto:` failing — acceptable. Footer email remains as a backstop for any customer who wants to reach the owner directly.
- **Class4Kids rebrand or URL change** → all five CTAs break in lockstep. *Mitigation:* the URL is duplicated across five places by design (no shared layout). A find-and-replace fixes it; this is a known cost of the static, no-templating architecture and not specific to this change.
- **Stale class-specific copy** → contact.html L85 currently lists "baby's age, preferred class time, launch class on 24 June or full-term enrolments from 22 July". Class4Kids collects all of this. If the replacement copy retains any of those specifics, it'll go stale the moment Term 4 is added. *Mitigation:* the tasks list explicitly enumerates each occurrence; replacement copy is generic ("what to bring", not "what to email").
- **Cutover risk** → shipping CTAs that point at a placeholder C4K page would be worse than the current state. *Mitigation:* the owner has confirmed the Term 3 class is publicly visible on `mini-co-sensory.classforkids.io`. Implementation is unblocked.
- **Footer vs header CTA inconsistency** → adding a header "Book now" later will require touching all four pages because the header is duplicated. Out of scope here, but worth flagging for the next change.

## Migration Plan

1. Edit the four HTML files in a single change. No staged rollout — the site is small enough to land atomically.
2. Open each page locally (`python3 -m http.server 8080`) and click every "Book now" CTA to confirm it opens C4K in a new tab.
3. Skim each page for any remaining mention of "register your interest", "registrations", or the old mailto template — these will all be in the four HTML files since there is no templating layer.
4. Commit and deploy. No DNS, build, or asset changes.

**Rollback:** revert the single commit. Because no CSS, JS, or asset pipeline changes, revert is clean.

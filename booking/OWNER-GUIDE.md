# Mini & Co. bookings — owner guide

This guide is for Camila: how to run classes, bookings, payments and emails
from the admin pages, screen by screen. It is written in plain language — no
technical knowledge needed.

A few things to know first:

- Everything lives at **miniandcosensoryclasses.com/admin** (until the website
  switches over, at the test address James gives you).
- Every time and date is **Sydney time**, including daylight saving.
- Button and menu names below are the ones on the screens. If a screen ever
  looks different, trust the screen and tell James so this guide can be fixed.
- Families see the booking pages at **/book** and their own account at
  **/account**. They can't cancel bookings themselves — they reply to an email
  or message you, and you make the change.

## Contents

1. [Signing in](#1-signing-in)
2. [The dashboard (Schedule)](#2-the-dashboard-schedule)
3. [Classes, terms and what each price means](#3-classes-terms-and-what-each-price-means)
4. [Opening a term](#4-opening-a-term)
5. [The term grid and the payment column](#5-the-term-grid-and-the-payment-column)
6. [Rosters and attendance on your phone](#6-rosters-and-attendance-on-your-phone)
7. [Manual bookings and pay-later](#7-manual-bookings-and-pay-later)
8. [Transfers, cancelling a week, cancelling a class](#8-transfers-cancelling-a-week-cancelling-a-class)
9. [Credits and vouchers](#9-credits-and-vouchers)
10. [The waitlist and offers](#10-the-waitlist-and-offers)
11. [Needs attention and Check with Stripe](#11-needs-attention-and-check-with-stripe)
12. [Emails and the email log](#12-emails-and-the-email-log)
13. [When a payment fails](#13-when-a-payment-fails)
14. [When a family wants a refund](#14-when-a-family-wants-a-refund)
15. [Term rollover: re-run and auto-enrol](#15-term-rollover-re-run-and-auto-enrol)
16. [The facilitator's roster-only login](#16-the-facilitators-roster-only-login)
17. [Quick answers](#17-quick-answers)

---

## 1. Signing in

There are no passwords.

1. Go to **/admin**. You'll be asked to sign in.
2. Type **miniandco.classes@gmail.com** and press the button.
3. Open the email "Your Mini & Co. sign-in link" and tap the link. It works
   **once** and only for **20 minutes**.
4. You're in. You stay signed in on that phone or computer for 30 days, or
   until you press **Sign out** in the menu.

If the email doesn't come: check Spam/Promotions, then ask for a new link.
You can ask for 3 links an hour.

Only the addresses on the admin list can open the admin pages. Adding or
removing an admin is a quick change James makes (the `ADMIN_EMAILS` setting);
it takes effect straight away.

## 2. The dashboard (Schedule)

The admin menu along the top has: **Schedule · Rosters · Terms · Classes ·
Bookings · Needs attention · Waitlist · Customers · Credits · Vouchers · Email
· Import**.

Above the list of classes, four tiles show what needs doing: bookings that
need attention, pay-later places waiting for payment, terms open for booking
and families on waitlists — tap one to open its list. **New booking**, **New
term**, **Rosters**, **Credits** and **Vouchers** are one tap away below them.

**Schedule** (the first page) lists every upcoming class, soonest first:

| Column | What it means |
| --- | --- |
| When | Date and start time. Tap it to open the **roster**. |
| Class / Term | Which weekly slot and which term ("One-off" for a class outside a term). |
| Seats | Places taken out of the capacity, e.g. **9/12**. It includes families who are paying right now (their place is held for up to 35 minutes) and places held for a waitlist offer or a pay-later booking. |
| Casual price | The price of that one class on its own. |
| Status | Scheduled or Cancelled. |
| Edit | Change the time, capacity, price, or cancel that class. |

**Add sessions** adds one-off classes or a run of weekly ones. For terms, use
**Terms** instead (section 3) — it creates the weekly classes for you.

## 3. Classes, terms and what each price means

### A class is one weekly slot

A class is a regular time, for example **"Sensory Play — Wednesday 11:00 am"**:
its day, start time, usual length, usual number of places, venue and age
range. You'll rarely change these. **Classes → Edit class** if you need to;
untick **Active** to hide a class from families (bookings are kept).

The 11:00 am and 1:00 pm classes are two classes, so each term is created for
both (there's an option to create them together).

### Creating a term

**Terms → New term** (or **New term for this class** under a class):

1. **Class (weekly slot)** — choose the class, and under **Also create the
   same term for** tick the other Wednesday class to create both at once (each
   gets its own term, with its own places).
2. **Term name**, e.g. **Term 1 2027**.
3. **First class date** (it must be on the class's day, e.g. a Wednesday),
   then either the **Number of weeks** (count holiday weeks too) **or the last
   class date**, and any **Holiday dates to skip**. A class is created for
   every week in between, at the class's usual time.
4. Enter the prices and options below. Tick **Open for bookings straight
   away** if families may book now; otherwise the term is a **Draft** that
   families can't see yet (section 4). Press **Create term**.

What each price and option means:

| Setting | What it does | Example |
| --- | --- | --- |
| **Term price** | The whole term, for a family who books before the first class. | $168 for 6 weeks |
| **Joining late** | Worked out for you: the term price shared over the weeks left. Families see "Join for the remaining 4 weeks". | 4 of 6 weeks left → $112 |
| **Casual price** | One class on its own. Each week starts with this price. | $30 |
| **Trial price** | One trial class per child — ever, across both classes. Leave blank to use the casual price. | $25 |
| **Returning price** | A lower term price for families who had a term booking in the previous term. Leave blank for no returning offer. | $150 |
| **Returning families can book from** | When returning families can start booking (at the returning price). | Mon 10 Jan, 9:00 am |
| **Everyone can book from** | When everyone else can book. Leave blank to open as soon as the term is open. | Mon 17 Jan, 9:00 am |
| **Instalments** | How many automatic weekly payments a family may choose instead of paying in full. 0 = pay in full only. Any odd cents go on the first payment. | 6 → $28 a week; $100 in 3 → $33.34, $33.33, $33.33 |

Things to know:

- **Changing a price never changes bookings already made.** Only new bookings
  use the new price.
- Each week can still be changed on its own later — time, number of places,
  price, or cancelled (Schedule → Edit). To add or remove weeks: **Terms →**
  the term → **Edit term & weeks** → **Add a week on** a date → **Add week**,
  or **Remove week** next to a week nobody has booked (a week with bookings
  is cancelled instead — section 8).
- No sibling discount is applied automatically; use a voucher (section 9) if
  you want one.
- Babies outside the age range get a warning, not a block.

## 4. Opening a term

A new term is a **Draft**: nobody can see or book it. When you're ready:

1. **Terms →** the term → **Open for bookings**.
2. From the "returning families can book from" time, returning families see the
   returning price and can book. Everyone else sees "Bookings open …" until the
   "everyone can book from" time.
3. **Close term** stops new bookings and takes the term off the booking page.
   Existing bookings stay. A closed term can go **Back to draft**.

The **Book now** buttons on the marketing pages keep pointing at ClassForKids
until the website switches over; until then, send families the **/book** link.

## 5. The term grid and the payment column

**Terms →** tap a term's name: the whole term on one screen, one row per
child, one column per week (tap a week's date for its roster, a child's name
for the booking).

| Mark | Meaning |
| --- | --- |
| ✓ | Came (present) |
| ✗ | Booked but didn't come (absent) |
| · | Booked, attendance not marked yet |
| – | That week was cancelled |
| → | That week was moved to another class |
| blank | Not booked that week |

The **Payment** column shows who owes what (and **Owing** the amount):

- **Paid** — all paid.
- **Plan 3 of 6 · next 12 Feb** — paying weekly; 3 payments in, the next is
  taken automatically on 12 Feb.
- **Overdue $56** — an automatic payment failed (section 13).
- **Unpaid $168 — pay-later until 12 Feb** — a place you're holding until the
  family presses Pay now; **Part paid — owes $40** after a part-payment.
- **Paying now** — the family is on the payment page this minute.
- **Comp** — complimentary, nothing to pay.

The bottom row shows how many places are left each week, and **Download grid
CSV** gives you the grid as a spreadsheet.

## 6. Rosters and attendance on your phone

Open a roster from **Schedule** (tap the date) or from the term grid. It shows
each child with their age on the day, the parent's name, email and phone,
photo consent, medical notes, booking type and payment.

- **Photo consent** shows the stricter answer: if a parent said Yes when booking
  but has since changed it to No, you'll see **No** with "changed since booking".
- **Medical notes** show the child's notes as they are now; if they've changed
  since booking, what the parent said at booking is shown underneath.

**Marking attendance**: tap **✓ Here** or **✗ Away** next to each child (and
**Clear** to undo) — the buttons are big enough for a thumb. It records who
marked it and when, and the term grid shows ✓ or ✗. Your facilitator can do
this too (section 16). **Rosters** in the menu lists last week's and the coming
weeks' classes, each linking to its roster.

**Download roster CSV** gives you a spreadsheet of the class (admins only).

## 7. Manual bookings and pay-later

For a family who rings, messages or pays in cash.

**New booking** (on the Schedule page, or **/admin/bookings/new**):

1. Type the **parent's email** → **Find family**. An existing family shows
   their children; for someone new, fill in the parent's name (and phone) and
   the child's name, date of birth, any medical notes and photo consent — the
   account is created for them (they can sign in with that email later).
2. **What are they booking?** — **Whole term** (the weeks still to come),
   **Casual classes** (you tick the dates next) or a **Trial class** (one
   class); and which term. → **Next: choose classes and payment**.
3. The price fills in from the term (with any account credit taken off).
   **Charge a different price** or add a **Voucher code** if you've agreed
   something else, and press **Update price** to see it.
4. Choose the **Payment**:
   - **Paid now (cash, bank transfer…)** — the amount received (blank = the
     full amount) and how. The booking is confirmed straight away and the
     family is emailed a receipt and the confirmation.
   - **Pay later** — the place is held for **7 days** and the family is emailed
     to sign in and press **Pay now** (in full, or by instalments if the term
     has them). If they don't pay in time, the place is released automatically.
   - **Complimentary** — nothing to pay (giveaways, make-ups); confirmed
     straight away.
5. **Create booking**.

**Recording a payment on an existing booking**: **Bookings →** open the booking →
**Record offline payment** → amount, method (cash, bank transfer, card in
person, other) and a note → **Record payment**. If the booking was waiting for
payment, it becomes confirmed — as long as the place is still free — and an
online payment the family had started is stopped so they can't pay twice. The
family is emailed a receipt. Pressing the button twice by accident only
records the payment once.

## 8. Transfers, cancelling a week, cancelling a class

All of these are on the booking (**Bookings →** open the booking; each week is
listed under **Weeks**):

- **Move to another class** (next to a week): move that week to another class
  with a free place, e.g. from 11:00 am to 1:00 pm on 3 March. No money changes
  hands; the term grid shows → for the old week and the child appears on the
  new class's roster.
- **Cancel this week**: frees that place. You can give a **credit** at the same
  time; it's filled in as that week's share of what they paid (e.g. $28 of a
  $168 six-week term) and you can change it (0 for none).
- **Cancel booking…** → **Yes, cancel the booking**: all their places are freed.
  If they were paying by instalments, the plan is stopped so no more payments
  are taken. Any refund is done in Stripe (section 14). **Restore booking**
  brings a cancelled booking back — only if every week still to come has a
  free place.

**Cancelling a whole class** (venue closed, you're unwell): **Cancel** next to
it on the Schedule, **Cancel this session…** on its Edit page, or **Cancel
session** on its roster:

1. The page lists every family booked into it and the credit each will get.
   Type a short **Reason (shown to families)**, e.g. "venue closed", and press
   **Yes, cancel the session**.
2. Every family who has paid for that class gets a credit automatically — a
   term family that week's share of the term, a casual or trial family what
   they paid — and their place in it is cancelled. (A place still waiting to be
   paid, or a complimentary one, gets no credit.)
3. Every family is emailed: "Class cancelled", with the reason and the credit
   they've been given. You get a summary email listing how many families were
   told and the total credit.
4. The class shows as Cancelled; nobody can book it and no reminder is sent.

## 9. Credits and vouchers

**Credits** are money on a family's account (**Credits** in the menu lists the
usable ones and their total; **show all** includes used, expired and voided
ones). They're used **automatically** the next time that family books — no
code needed — and the family sees their balance on their account page.
A credit can be for one child or for any child in the family. Credits come from
cancelled weeks and classes, or you can give one yourself (a make-up, a
goodwill gesture): **Customers →** the family → **Give a credit** → amount,
which child (or any), an optional expiry date and the reason → **Add credit**.
**Void** stops a credit being used; anything already spent stays spent.

**Vouchers** are codes families type at checkout (**Vouchers** in the menu), e.g.
**GIVEAWAY10**. **New voucher**:

- **Dollars off** or **Percent off**, and the value.
- **Can be used for**: anything, whole terms only, or casual and trial classes only.
- Optional **Valid from** and **Last day it works**, and the **Most times it
  can be used**.
- Untick **Active** (Edit) to switch it off when the promotion is over. A
  voucher nobody has used can be deleted; a used one can only be switched off.

At checkout the voucher comes off first, then any credit. The price never goes
below $0, and a booking that comes to $0 is confirmed straight away.

## 10. The waitlist and offers

**Waitlist** shows each open (and draft) term's waitlist in the order families
joined, with the child's age, the parent's contact details, any note, and the
status. Use **Show:** at the top to look at one term.

Families add themselves from the booking page when a term is full ("This term
is full. Join the waitlist") and see their place in line there and on their
account. For
a family who rings or messages, use **Add a family to this waitlist** under the
term: their email and child's name — and for a family you don't know yet, the
child's date of birth, the parent's name and mobile. An existing family's
details are never changed here. A family who was removed or declined joins
again at the end of the line.

### When a place comes up

A place comes up when someone cancels, or when you decide to add one (raise the
number of places on that week: **Schedule → Edit**, or **Raise capacity** on the
offer page).

1. Press **Offer a place** next to the family.
2. Choose what you're offering:
   - **The rest of the term** — every week left, at the term price (shared over
     the weeks left if the term has started; the returning price if they qualify);
   - **A trial class** — tick one week; trial price;
   - **Chosen weeks** — tick the weeks; casual price for each.
3. Press **Work out the price**. You'll see the price, any account credit that
   will come off, and what the family will pay. **Change the price** if you've
   agreed something different.
4. Press **Send the offer**.

The place is now **held for 48 hours** and the family gets an email: "A place
has opened up for …", asking them to sign in and press **Pay now**.

### What happens next

| What happens | What the system does |
| --- | --- |
| They pay | The booking is confirmed and the entry shows **Booked**. |
| 48 hours pass without payment | The offer **lapses by itself**: the place is released, the family goes back to **Waiting** in their original spot, and the note says "Offer lapsed …". Offer it to the next family. |
| They say no | Press **Mark declined** — the held place is released. |
| You offered the wrong thing | Press **Withdraw offer** — the place is released and they're back in line in the same spot. Then offer again. |
| They no longer want to wait | Press **Remove**. |

Declined and removed families are listed under **Earlier entries**; **Put back on
the list** returns them to their original spot.

You're emailed when an offer lapses ("Waitlist offer lapsed — …") and when a
family turns one down from their account ("Waitlist place declined — …"), so
you know the place can go to the next family. **Message this waitlist** opens
the Email page with that waitlist chosen, e.g. to let everyone know where they
stand.

## 11. Needs attention and Check with Stripe

**Needs attention** (in the menu, and the first tile on the Schedule page) lists
every booking where the money and the places don't match, and you're emailed
when one appears:

| Flag | What happened |
| --- | --- |
| Paid, but no seat was free | The family paid after their hold ran out and someone else took the last place. Their money is recorded; they are not double-booked. |
| Paid after the booking was cancelled | Money arrived for a booking you'd cancelled. |
| Instalment overdue | An automatic payment failed (section 13). |
| Instalment plan ended before the full amount was paid | Stripe stopped trying; money is still owed. |
| Payment doesn't match the booking | Stripe reported an amount that isn't what the booking owes. |
| Account credit was no longer available | A late payment confirmed a booking but some credit had already been used elsewhere. |

Under **Payments to check** it also lists bookings that have been waiting for an
online payment for more than 40 minutes, and (folded away) online payments
that ended without a payment in the last three days — the place to look when a
family says "but I paid".

What you can do on each:

- **Check with Stripe** — asks Stripe what really happened. If the family paid
  and the place is free, the booking is confirmed and the payment recorded
  (never twice). If they didn't pay, the held place is released. For a family
  paying by instalments it also adds any instalment Stripe collected that is
  missing here, and tells you how the plan stands.
- **Record payment** (on the booking), **Cancel**, or **Mark as sorted** with a
  short note of what you did (for example after a phone call) — the note is
  kept on the booking.

For **Paid, but no seat**: raise the number of places and press **Check with
Stripe** again (it confirms the booking once a place is free), move them to
another class, give them a credit (section 9), or refund them in Stripe
(section 14).

## 12. Emails and the email log

### Emails families get automatically

- **Booking confirmed** — with the dates, and the instalment dates if paying weekly.
- **Reminder** — the day before each class (sent 20–28 hours before), to every
  family with a confirmed place. Never twice for the same class.
- **Class cancelled** — with the reason and any credit.
- **Waitlist offer** — with the price and the 48-hour deadline.
- **Payment didn't go through** — once for each failed payment, with a link to
  update their card; then a reminder at most once a week while it's still
  overdue.
- **Place saved for next term** — the re-enrol invitation (section 15).
- **Place held — please pay** — when you make a pay-later booking (section 7).
- **Receipt** — when you record a cash, bank-transfer or in-person card payment.
- **Trial follow-up** — the day after a trial, offering the rest of the term at
  the price for the weeks left (or its waitlist if it's full). Not sent if the
  child was marked away, the class was cancelled, or they've already booked.

When a family **replies** to any of these emails, the reply comes to your inbox
(miniandco.classes@gmail.com), even though the emails are sent from
bookings@miniandcosensoryclasses.com.

You get alerts too: anything under Needs attention, a summary when you cancel a
class, each failed instalment, and a waitlist offer that lapsed or was declined.

### Emailing families yourself

**Email**:

1. Choose who gets it: **families booked into a term**, **families on a term's
   waitlist**, or **all current families** (everyone booked into a class that's
   still to come). For the first two, choose the term.
2. Write a subject and your message. Leave an empty line between paragraphs.
   Each family's copy starts "Hi <their name>," and ends with your sign-off, so
   just write the message itself.
3. Press **Preview**. You'll see how many families will get it, who they are,
   and exactly how it looks. Nothing is sent yet.
4. Press **Send to N families**. Each family gets their own copy — nobody sees
   anyone else's address. Pressing Send twice is safe: nobody gets it twice.

Use this for news about the classes families are booked into or waiting for.
For promotions (a new term to past families, say), use a mailing-list tool with
an unsubscribe link — that's the law for marketing emails (Spam Act).

### The email log

On the **Email** page, follow the **email log** link (or go to
**/admin/email/log**). It lists every email
the system has sent, newest first, with who it went to, what it was, the term
and whether it was sent or failed. Filter by type, term, part of an email
address, or failed only. When a family says "I never got it", search their
address here. Sign-in links aren't listed (they're private). A failed reminder
is tried again automatically.

## 13. When a payment fails

When a family pays by instalments and a payment doesn't go through (expired
card, not enough money):

1. **Stripe tries the card again automatically** over the following days.
2. **The family is emailed** with a link to update their card (their account →
   **Update card**, which opens Stripe's secure page). While it's still overdue
   they get a gentle reminder at most once a week.
3. **You're emailed**, and the booking shows **Overdue $…** in the term grid and
   under **Needs attention**.
4. **The child keeps their place.** Nothing is cancelled automatically — you decide.

What to do:

- Usually nothing for a few days — most failed payments go through on a retry,
  and the flag clears itself.
- If they pay you another way, **Record offline payment** on the booking.
- If Stripe stops trying ("plan ended before the full amount was paid"), contact
  the family: take the rest by bank transfer and record it, or cancel the weeks
  left, or keep them on — your call.

## 14. When a family wants a refund

Refunds are made in **Stripe**, not in the booking pages:

1. Sign in to the **Stripe dashboard** → **Payments**.
2. Find the payment (search the parent's email or the amount).
3. **Refund** → full or partial amount → reason → confirm.

The booking system hears about the refund automatically and records it in the
booking's payments. It does **not** cancel the booking — so if they're leaving,
also **cancel the booking** (or the weeks) in the admin so the places are freed.
If they're on instalments, cancel the booking first: that stops the plan, so
no more payments are taken (cancelling single weeks does not).

Rather give a credit than a refund? Give a credit (section 9) — no Stripe needed.
Your Terms & Conditions set out the policy (48 hours' notice for a credit or
transfer, and so on).

## 15. Term rollover: re-run and auto-enrol

To set up next term for the families you already have:

1. **Terms →** this term → **Re-run term** (or **Re-run** in the terms list). A
   new term is filled in from this one: the name moved on (Term 2 → Term 3),
   the dates moved on (leaving two empty weeks after this term), the
   same prices and options, and this term as its previous term. Change anything
   you need, set the returning price and the two opening times, and press
   **Create the new term**. It's created as a **Draft** with its weekly classes.
2. You go straight to **Hold places for returning families**: this term's
   families (term bookings ticked; trial, casual and complimentary families
   listed unticked). Untick anyone who isn't coming back, then press **Hold
   places and send invitations**. (Later: **Auto-enrol returning families** on
   the new term's page.)
3. Each family gets a **place held at the returning price** (less any account
   credit) until the "everyone can book from" time (or 7 days if there isn't
   one, or it's less than an hour away), and an email: "<child>'s place in
   <term> is saved — pay by <date>". They sign in and press **Pay now** (in
   full or by instalments). Running it again never holds a place twice.
4. **Open for bookings** on the new term when you're ready. Returning families
   can then book other children early at the returning price; everyone else
   sees "Bookings open …" until the public opening. Held places that aren't
   paid for by the deadline are released automatically and anyone can book them.

## 16. The facilitator's roster-only login

A casual facilitator can open rosters and mark attendance — nothing else: no
payments, no family list, no emails, no other admin pages.

- **To give access**: ask James to add their email to the staff list
  (`STAFF_EMAILS`). They sign in the same way as everyone (an emailed link).
- **To take access away**: ask James to remove it; it takes effect on their very
  next tap.
- They sign in and go to **/admin** (or tap **Rosters** in the menu): they land
  on **Rosters** — last week's and the coming weeks' classes, each with its
  roster — and their menu has nothing else. On a roster they see the children,
  parents' phone numbers, photo consent and medical notes, and tap **✓ Here** /
  **✗ Away**. Every other admin page says "Not allowed".

## 17. Quick answers

- **Add one more place to a class** → Schedule → Edit → raise the capacity.
- **Change one week's time** → Schedule → Edit.
- **Who still owes money?** → the term grid's payment column, or Bookings.
- **A family didn't get an email** → Email log → search their address. If it
  failed, tell James; you can also resend the information yourself.
- **A family says the class is full** → add them to the waitlist; offer a place
  when one comes up.
- **Something looks wrong with a payment** → Needs attention → Check with Stripe.
- **Download everything** → Bookings → Download bookings CSV; each term grid
  and each roster has its own CSV. James can take a full backup at any time.

# founder-bio Specification

## Purpose
TBD - created by archiving change add-camila-bio. Update Purpose after archive.
## Requirements
### Requirement: The about page SHALL present Camila's bio in place of the existing placeholder

The "Meet Camila" section of `about.html` SHALL contain Camila's biographical prose and her photograph. The placeholder copy "Camila's bio coming soon" and the surrounding `.placeholder-note` element SHALL be removed.

#### Scenario: Reader scrolls to the bio section on the about page

- **WHEN** a reader scrolls to the "Meet Camila" section on `about.html`
- **THEN** they see Camila's photograph and her biographical prose
- **AND** they do not see the "Camila's bio coming soon" placeholder text
- **AND** they do not see the `.placeholder-note` element

#### Scenario: Source HTML inspection confirms placeholder removal

- **WHEN** a reviewer inspects the source of `about.html`
- **THEN** no occurrence of the string "Camila's bio coming soon" exists
- **AND** no `<div class="placeholder-note">` exists in the bio section

### Requirement: The bio prose SHALL be written in first person and cover four narrative beats

The bio copy SHALL be authored in first person ("I'm Camila…") and SHALL cover, in order: (1) Camila's professional background and area of focus; (2) the arc of her path from Brazil to Australia and into early childhood education; (3) the personal motivation behind starting Mini & Co. — specifically the loneliness of early motherhood and the desire to connect mums through learning about child development; (4) what she hopes mums and little ones take home from each class.

#### Scenario: Reader reads the bio top to bottom

- **WHEN** a reader reads the bio section on `about.html`
- **THEN** the prose is in first person (uses "I", "my", not "Camila is", "her")
- **AND** the four beats appear in the order: background → Brazil-to-Australia arc → why Mini & Co. → what she hopes attendees take home

#### Scenario: Bio explicitly names the loneliness motivation

- **WHEN** a reader reads paragraph three of the bio
- **THEN** the prose names early motherhood loneliness (or equivalent) as the personal experience that motivated Mini & Co.
- **AND** the prose does not stop at "I wanted to help mums" without naming why

### Requirement: The bio prose SHALL match the canonical four-paragraph text exactly

The bio section SHALL contain exactly the following four paragraphs, in this order, with no em-dashes, no additional paragraphs, and no rewording. This text is the canonical source of truth; any future edit (e.g. after Camila reviews it in her own voice) MUST be made by updating this requirement, not by drifting the rendered HTML out of sync with the spec.

> I'm Camila, an early childhood educator with seven years' experience across community preschools and centres rated Exceeding under the National Quality Standard. My focus is early learning and brain development in the first years of life, when so much of what shapes a child is quietly being built.
>
> I was born in Brazil, where I studied political science and worked as a coordinator at the Rio 2016 Olympic Games. After moving to Australia ten years ago, I discovered early childhood education, fell in love with it, and trained as an educator.
>
> Then I had my own children, a four-year-old and a baby, and learned how lonely and isolating early motherhood can quietly be. That's the real reason Mini & Co. exists. I wanted a space where mums could connect with each other through something genuine, learning about how their little ones grow and develop, alongside a calm, positive sensory experience for the little ones.
>
> What I hope you take home from each class is a sense of belonging: to a community, to other mums, to the small daily work of helping a little one grow. You shouldn't have to do any of that alone.

When the prose is rendered into `about.html`, the ampersand in "Mini & Co." MUST be HTML-escaped as `&amp;` per the rest of the site; no other character substitutions are required.

The phrase "a four-year-old and a baby" in paragraph three is deliberately preserved (rather than softened to "a little one") because "a baby" carries an age-contrast against "a four-year-old" that "a little one" would lose; both Camila's children are little ones, but only one was a baby at the time of the narrative.

#### Scenario: Rendered page text matches the canonical prose word-for-word

- **WHEN** a reviewer extracts the visible text content of the bio section on the rendered `about.html`
- **AND** strips leading/trailing whitespace from each paragraph
- **THEN** the result is exactly the four paragraphs above, in order
- **AND** no em-dash character (`—`) appears anywhere in the bio section's text

#### Scenario: Bio is rendered as exactly four paragraphs

- **WHEN** a reviewer counts `<p>` elements inside the bio body container
- **THEN** there are exactly four paragraphs
- **AND** no paragraph is split, merged, or re-ordered relative to the canonical text

#### Scenario: Camila edits the prose during review

- **WHEN** Camila reviews the rendered bio and requests a change to the wording
- **THEN** this requirement (the canonical text above) is updated first
- **AND** `about.html` is updated to match the new canonical text
- **AND** both updates land in the same commit so the spec and the rendered page never diverge

### Requirement: The bio photograph SHALL use a `<picture>` element with responsive `srcset` and WebP-first ordering

The photograph SHALL be served via a `<picture>` element. The element SHALL contain a `<source type="image/webp">` listing all three WebP widths (600, 1200, 1600) in `srcset`. It SHALL contain a fallback `<img>` whose `srcset` lists the corresponding JPG widths and whose `src` is the 1200w JPG. Both `<source>` and `<img>` SHALL declare the same `sizes` attribute matching the layout (`(min-width: 768px) 40vw, 100vw` or equivalent reflecting the implemented breakpoint).

#### Scenario: Modern browser receives WebP

- **WHEN** a reader on a current Chrome / Firefox / Safari loads `about.html`
- **THEN** the browser fetches a WebP variant from `<source>`'s `srcset`
- **AND** the variant's width is appropriate for the viewport (per `sizes`)

#### Scenario: Older browser falls back to JPG

- **WHEN** a reader on a browser without WebP support loads `about.html`
- **THEN** the browser ignores the `<source type="image/webp">` and uses the `<img>` element
- **AND** the `<img>` resolves to one of the JPG variants per its own `srcset`

#### Scenario: Reviewer audits the photo markup

- **WHEN** a reviewer inspects the bio's `<picture>` element in `about.html`
- **THEN** `<source>` precedes `<img>` (browsers pick the first matching `<source>`)
- **AND** both elements declare a `sizes` attribute
- **AND** the `<img>` has a non-empty `alt` attribute, intrinsic `width` and `height` attributes, and `loading="lazy"` and `decoding="async"`

### Requirement: The bio layout SHALL use an asymmetric two-column pattern on desktop and stack on mobile

The bio section SHALL display the photograph and prose side-by-side on viewports at or above the existing two-column breakpoint (~768px), with the photograph occupying roughly 40% of the column and the prose roughly 60%. Below that breakpoint, the photograph SHALL stack above the prose at full column width. The layout SHALL use only existing CSS custom properties from the top of `css/styles.css`; no new design tokens SHALL be introduced.

#### Scenario: Desktop reader sees side-by-side layout

- **WHEN** a reader loads `about.html` on a viewport ≥ 768px wide
- **THEN** the photograph appears to the left of the bio prose
- **AND** neither column dominates the section

#### Scenario: Mobile reader sees stacked layout

- **WHEN** a reader loads `about.html` on a viewport < 768px wide
- **THEN** the photograph appears above the bio prose
- **AND** both occupy the full width of the content column

#### Scenario: Reviewer audits CSS for new tokens

- **WHEN** a reviewer inspects the CSS additions for the bio layout
- **THEN** all colours, fonts, spacings, radii, and shadows reference existing custom properties from `:root` in `css/styles.css`
- **AND** no new `--colour-*`, `--font-*`, `--space-*`, `--radius-*`, or `--shadow-*` tokens are added

### Requirement: The bio image SHALL declare meaningful alternative text

The `<img>` element's `alt` attribute SHALL describe the visible content of the photograph (subject, expression, setting) rather than serving as a generic label. The `alt` attribute SHALL NOT be empty and SHALL NOT be a generic placeholder like "photo of Camila".

#### Scenario: Screen reader user encounters the bio photo

- **WHEN** a screen reader user reaches the bio photograph
- **THEN** the announced alt text describes what the photograph shows (subject, expression, setting)
- **AND** the alt text is not generic ("photo of Camila", "image", "headshot")

### Requirement: The bio change SHALL be confined to `about.html` and supporting CSS

This change SHALL only modify `about.html` and `css/styles.css` among site-content files. It SHALL NOT modify `index.html`, `classes.html`, `contact.html`, or `js/main.js`.

#### Scenario: Reviewer audits the diff

- **WHEN** a reviewer inspects the change's diff against site-content files
- **THEN** only `about.html` and `css/styles.css` show modifications
- **AND** `index.html`, `classes.html`, `contact.html`, and `js/main.js` are unchanged

## MODIFIED Requirements

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

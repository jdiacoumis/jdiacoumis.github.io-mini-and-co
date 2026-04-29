# Mini & Co — Baby Sensory Classes

A simple HTML website for **Mini & Co**, a baby sensory classes business run by Camila.

## About

Mini & Co offers evidence-based baby sensory classes for babies aged 3–12 months and their mums. Each session is designed using play-based, developmentally informed activities that support sensory exploration, early communication, curiosity, and connection — held in a calm, welcoming space at Oran Park Library, NSW.

Classes launch Wednesday 24 June 2026, with full-term enrolments opening for Term 3 from Wednesday 22 July 2026.

## Project Structure

```
mini-and-co/
├── index.html        # Home page
├── classes.html      # Class schedule and information
├── about.html        # About Camila and Mini & Co
├── contact.html      # Contact and register-interest details
├── css/
│   └── styles.css    # Site styles
├── js/
│   └── main.js       # Site scripts (mobile nav toggle)
└── images/
    └── logo.svg      # Brand logo (placeholder SVG; swap in logo.png when available)
```

## Design

- **Palette**: warm cream backgrounds, blush and sage accents, deep plum text — drawn from the brand logo and studio photography.
- **Typography**: Cormorant Garamond (display) and Outfit (body), loaded from Google Fonts.
- **Tone**: minimalist, nurturing, evidence-based — referencing Harvard's Center on the Developing Child, Australia's Early Years Learning Framework, and Raising Children Network.

## To-do before launch

- Replace `images/logo.svg` with the final brand logo file (PNG or higher-fidelity SVG) and update `<img>` references if needed.
- Add Camila's bio to the placeholder section on `about.html`.
- Add a real booking system (Class Manager, TryBooking, etc.) and replace the `mailto:` register-interest CTAs.
- Add an Open Graph / share image (`images/og-image.jpg`) and update the `og:image` meta tag on each page.

## Development

This is a static HTML website — no build tools or dependencies required. Open any `.html` file directly in a browser, or serve locally with any static file server.

### Quick start with Python

```bash
python3 -m http.server 8080
```

Then visit [http://localhost:8080](http://localhost:8080).

### Quick start with Node.js

```bash
npx serve .
```

## Deployment

The site can be hosted on any static hosting platform such as:

- GitHub Pages
- Netlify
- Vercel
- AWS S3 + CloudFront

## Contact

For business enquiries, contact Camila via the [Mini & Co website](index.html).

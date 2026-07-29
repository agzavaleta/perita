# Perita

Perita is a personal finance PWA — accounts, savings goals, income, fixed and
variable expenses, debts, and a monthly close/archive cycle. No build step,
no framework dependencies, no backend: it's a single static site plus a
small shared logic module.

## Project structure

```
Perita.jsx          canonical source — components, UI, and app wiring (React, JSX)
perita-core.js       pure financial state-transition & calculation logic,
                      shared by the browser app (window.PeritaCore) and the
                      test suite (require)
index.html            generated file — do not edit by hand, see below
sync_to_html.py       regenerates index.html from Perita.jsx
manifest.json         PWA manifest
service-worker.js     offline cache + update handling
icons/                PWA icons (apple-touch-icon 180 + 152/192/512), generated
                      from Perita.jsx's PERITA_LOGO — the same image as the
                      sidebar logo
tests/                regression test suite (Node's built-in test runner)
package.json          test script only — no runtime dependencies
```

## Making changes

`Perita.jsx` is the canonical source for all UI and behavior. `index.html` is
a generated artifact — after editing `Perita.jsx`, regenerate it:

```bash
python3 sync_to_html.py
```

This rebuilds only the app's `<script type="text/babel">` block inside
`index.html`; everything else — `<head>` (CDN scripts, PWA tags, styles) and
the static initial-load screen markup inside `<body>` — is preserved
byte-for-byte. None of that lives in `Perita.jsx`, so it can never be lost by
running the sync script; see `ARCHITECTURE.md`'s "Sync workflow" section for
exactly what's covered.

Financial calculations and state transitions live in `perita-core.js`, not
inline in `Perita.jsx`, so they can be exercised directly by the test suite
without duplicating logic.

## Testing

```bash
npm test
```

Runs the full regression suite (`tests/perita-core.test.js`) against
`perita-core.js` using Node's built-in test runner — no dependencies to
install.

## Running locally

This is a static site — no build, no server required. Serve the folder with
any static file server, e.g.:

```bash
python3 -m http.server 8000
```

then open `http://localhost:8000`.

## Deployment

Static, zero-config deployment (e.g. Vercel, GitHub Pages, Netlify). No
`vercel.json` is required — there's no build step and no routing beyond the
single `index.html` entry point. Verified: every asset path referenced by
`index.html`, `manifest.json`, and `service-worker.js` resolves correctly
when served from the repo root (no nested subfolder).

## More documentation

This README covers setup and day-to-day workflow. For everything else:

| Doc | Covers |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Tech stack, file structure, state shape, component map, responsive breakpoints, PWA setup |
| [`DATA_MODEL.md`](./DATA_MODEL.md) | Entity shapes and the full `perita-core.js` function reference |
| [`BUSINESS_RULES.md`](./BUSINESS_RULES.md) | Financial/UX rules — what must always be true, and why (several were bugs fixed along the way) |
| [`FEATURES.md`](./FEATURES.md) | Feature inventory per screen, what's done vs. pending |
| [`UI_GUIDELINES.md`](./UI_GUIDELINES.md) | Design tokens, breakpoint contract, reusable component patterns |
| [`CHANGELOG.md`](./CHANGELOG.md) | Session-by-session history, known issues, next recommended tasks |

Start with `CHANGELOG.md`'s "Next Recommended Tasks" section if you're
picking this project back up.

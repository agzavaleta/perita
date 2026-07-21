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
icons/                PWA icons (152/192/512)
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
`index.html`; the `<head>` (CDN scripts, PWA tags, styles) is left untouched.

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
single `index.html` entry point.

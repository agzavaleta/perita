# PROJECT_CHECKPOINT.md — Perita

> Use this file to resume development in a new chat session.

**Checkpoint date: 2026-07-29.**

---

## Functional state (current, real)

Perita is a working, static PWA with no build step. All financial
calculations are centralized in `perita-core.js` and covered by **79/79
passing tests** (`npm test`). The salary model is additive: total income =
configured salary (`settings.salary`, Configuración only) + additional
income transactions, always — see `BUSINESS_RULES.md`. The PWA install icon
shows the real Perita logo (not a placeholder), and the app shows a static
branded load screen instead of a blank/black screen while it boots.

This work exists only in Claude's local working copy. It has not been (and
will not be) committed or pushed to GitHub by Claude — GitHub has no write
tool available. The user updates GitHub manually using the delivered files
— see "Known risks" below.

---

## Latest completed changes (most recent first)

1. **Documentation consistency pass (this checkpoint).** Removed a
   duplicated header in `ARCHITECTURE.md`, refreshed `README.md`/
   `ARCHITECTURE.md`/`FEATURES.md` to match current code (test count, PWA
   icon fix, load screen, `CACHE_NAME` history), rewrote this checkpoint.
   No functional/UI/financial-logic changes.
2. **Initial load screen** (`index.html`, `service-worker.js`): fixes the
   black-screen-on-iPhone symptom. CDN `<script>` tags now use `defer`; a
   static `#F86C98` load screen (centered logo, "Cargando Perita…", discreet
   spinner, `prefers-reduced-motion` respected) shows immediately and is
   replaced automatically when React mounts; a watchdog shows an error +
   "Recargar" button if the app hasn't mounted within 15s. `CACHE_NAME`
   `v2` → `v3`.
3. **PWA install icon fixed** (`icons/*.png`, `index.html`, `manifest.json`,
   `service-worker.js`): the generic "P" icon was replaced with the real
   Perita logo (generated from `PERITA_LOGO`) at `apple-touch-icon.png`
   (180×180) + 152/192/512px; removed a duplicate/conflicting
   `apple-touch-icon` `<link>`; all PWA paths switched to root-absolute;
   `CACHE_NAME` `v1` → `v2`.
4. **Salary model separated from additional income** (`perita-core.js`,
   `Perita.jsx`, tests, docs) — the confirmed, currently-implemented rule:
   salary is configured once in Configuración, never entered as an income
   transaction, and is always added to additional-income transactions for
   every total. Archived months store their own salary snapshot
   (`archived.salary`), immune to later salary edits.
5. Earlier sessions (4–8): centralized dashboard/section-total calculations
   into `perita-core.js`, fixed debt-payment omission from "remaining",
   fixed the month-close double-submit/double-archive bug, standardized the
   month-closing UI text and rollover behavior. Full detail in
   `CHANGELOG.md`.

---

## Main files

| File | Role |
|---|---|
| `Perita.jsx` | Canonical source for all UI/behavior (React components, JSX) |
| `perita-core.js` | Canonical source for financial state-transition & calculation logic (pure functions, shared with tests) |
| `index.html` | **Generated** from `Perita.jsx` via `sync_to_html.py` for the `<script type="text/babel">` block only — `<head>`, the PWA `<link>`/`<meta>` tags, the `<style>` block, and the initial load-screen markup/CSS/watchdog script all live directly in `index.html` and are preserved byte-for-byte on every sync |
| `manifest.json`, `service-worker.js` (`CACHE_NAME = 'perita-cache-v3'`), `icons/` (`apple-touch-icon.png` 180×180 + 152/192/512px) | PWA files |
| `tests/perita-core.test.js` | 79 regression tests against `perita-core.js` |
| `package.json` | `npm test` only, zero runtime dependencies |
| `sync_to_html.py` | Regenerates `index.html`'s app script from `Perita.jsx` — portable, relative paths only |

**Rule:** all logic/behavior changes go into `Perita.jsx` or `perita-core.js`,
then run `python3 sync_to_html.py` to regenerate `index.html`. All CSS,
PWA `<head>` config, and load-screen changes go directly into `index.html`
(`Perita.jsx` has no CSS or load-screen markup of its own) — the sync script
preserves that region untouched. See `ARCHITECTURE.md`'s "Sync workflow" and
"Initial load screen" sections for exactly what's covered.

> This project previously went through file-management churn (a
> `mis-finanzas/` deployment subfolder, a stale deployment zip, non-canonical
> `perita-local/` derived files, sandbox-absolute paths like
> `/mnt/user-data/outputs/...`). **None of that exists anymore.** The working
> copy is a single flat structure, verified to deploy correctly as-is (every
> asset resolves via HTTP 200 from a real static server). If you encounter
> any reference to those old paths/files anywhere, they're stale — ignore
> them and treat this file + `ARCHITECTURE.md` as authoritative.

---

## Current Version

`APP_VERSION = '1.0.0'` (in-app "Acerca de" string — unchanged; not tied to
this file's checkpoint date or to `CHANGELOG.md`'s per-session version tags).

---

## Sync & test commands

```bash
python3 sync_to_html.py   # regenerate index.html's app script from Perita.jsx (idempotent)
npm test                  # tests/perita-core.test.js — must show 79/79 passing
```

Optional, done as part of any PWA/static-asset change:
```bash
python3 -m http.server 8000   # serve the repo root locally to sanity-check every asset (200 OK)
```

---

## Known risks

- **Not on GitHub yet.** All work described here and in `CHANGELOG.md`
  exists only in Claude's local working copy — Claude has no GitHub write
  access and does not commit or push. GitHub will not reflect this state
  until the user manually updates it using the delivered files.
- **Pre-existing "Sueldo" income transactions.** A user with an
  already-open month who, under the pre-Session-9 UI, manually logged their
  salary as a regular income transaction will double-count it against the
  new additive salary rule until they delete that transaction. Not
  auto-detected — see `CHANGELOG.md`/`BUSINESS_RULES.md`.
- **iOS icon caching.** Devices that already installed the PWA before the
  Session 10 icon fix will keep showing the old "P" icon until the user
  removes and re-adds the home-screen shortcut — `CACHE_NAME` bumps refresh
  the cached HTML/assets but cannot force iOS to redraw an already-placed
  home-screen icon.
- **No live-network browser verification available in this sandbox.** The
  initial load screen's "successful mount" and "timeout → error" paths were
  verified with simulated DOM mutations and a sped-up timeout (headless
  Chromium, no internet access to fetch the real CDN scripts here) — logic
  confirmed correct, but not end-to-end tested against the actual
  cdnjs-hosted React/Babel bundles.

---

## Next recommended task

See `CHANGELOG.md`'s "Next Recommended Tasks" section for the full
priority-ordered list (`FEATURES.md`'s "Not yet implemented" tracks the same
items). Immediate next step: the user updates GitHub manually with the
delivered files, then verifies the deployed site end-to-end (including the
load screen and PWA icon on a real iPhone) before starting new feature work.

---

## Full documentation set

This file is a short resume-pointer only. For everything else, read (in this
order if starting fresh):

1. `README.md` — setup, dev workflow, testing, deployment
2. `ARCHITECTURE.md` — tech stack, file structure, state shape, component
   map, responsive breakpoint contract, PWA setup, initial load screen
3. `DATA_MODEL.md` — entity shapes + full `perita-core.js` API reference
4. `BUSINESS_RULES.md` — financial/UX rules, including the current salary
   model (several entries are bugs that were fixed — each explains why the
   rule exists)
5. `FEATURES.md` — feature inventory per screen, what's done vs. pending
   (this repo's pending-tasks tracker — there is no separate `PENDING.md`)
6. `UI_GUIDELINES.md` — design tokens, breakpoint contract, reusable
   component patterns (`EmptyState` / `emptyStateProps`, modal/button/card
   conventions)
7. `CHANGELOG.md` — full session-by-session history, resolved/open known
   issues, and a priority-ordered "Next Recommended Tasks" list

---

## How to resume

In a new chat:
1. Point Claude at this project's working copy (an uploaded copy, or
   whatever local files are current — Claude does not read or write GitHub
   directly) — all docs above are present at the root.
2. Reference `Perita.jsx` (UI/behavior) and `perita-core.js` (financial
   logic) as the canonical sources.
3. After any change to either, run:
   ```bash
   python3 sync_to_html.py
   npm test
   ```
   All 79 tests must continue to pass before considering a change complete.
4. Start with `CHANGELOG.md`'s "Next Recommended Tasks" section, and check
   "Known risks" above for anything that needs addressing first.

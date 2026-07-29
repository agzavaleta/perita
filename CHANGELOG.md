# CHANGELOG.md — Perita

---

## [1.1.2] — Session 11: initial load screen added (fixes black screen on iPhone) (2026-07-29)

### Confirmed cause
`index.html`'s `<head>` had 5 render-blocking `<script src>` tags (React,
ReactDOM, Babel Standalone, Chart.js, `perita-core.js`) with no `defer`,
positioned before the `<style>` block and `<body>`. The browser cannot parse
or paint anything past them until each finishes downloading and executing —
on a slow connection this is exactly the blank/black window reported on
iPhone. Root cause confirmed, not assumed.

### Fix
- Added `defer` to the 5 blocking `<script src>` tags so HTML parsing (and
  first paint of `<body>`) is no longer blocked on them; execution order is
  preserved (defer scripts run in document order, before
  `DOMContentLoaded`), so `perita-core.js` and Babel Standalone still run
  before the inline `<script type="text/babel">` app script needs them.
- Added a static loading screen, rendered as the initial content of
  `<div id="root">` (full-viewport, `#F86C98` background, centered
  `/icons/apple-touch-icon.png` logo with no border-radius, "Cargando
  Perita…" text, a small spinner). It needs no JavaScript to appear — it's
  plain HTML/CSS parsed immediately once `<body>` is reached.
- `ReactDOM.createRoot(root).render(<App/>)` (unchanged) replaces
  `#root`'s children as a normal client render — this is what removes the
  loading screen automatically the moment the app mounts; no manual removal
  code was needed for the happy path.
- Added a small inline watchdog script (plain JS, no React dependency) right
  after the loading markup: a `MutationObserver` on `#root` detects the
  loading div's removal (app mounted) and clears a 15s timeout; if that
  timeout fires first (app never mounted — e.g. a CDN script failed), the
  loading text is replaced with an error message and a "Recargar" button
  (`location.reload()`) is added. No artificial minimum display duration —
  the screen disappears the instant the app mounts, however fast that is.
- `html.app-loading, html.app-loading body{background:#F86C98}`: the
  `app-loading` class starts on `<html>` and is removed by the same watchdog
  once the app mounts, so `html`/`body` share the loading background (no
  black flash) without permanently changing `body`'s normal
  `var(--gray-50)` background used by the rest of the app.
- `prefers-reduced-motion: reduce` disables the spinner's rotation
  (`opacity:.6` static state instead).
- `service-worker.js`: `CACHE_NAME` bumped `v2` → `v3` so already-installed
  users get the new `index.html` (with the loading screen) instead of a
  stale cached copy without it.

### Files modified
`index.html`, `service-worker.js`, `CHANGELOG.md`. `Perita.jsx` and
`perita-core.js` were not touched — no financial logic or other views were
modified; `sync_to_html.py` was re-run and confirmed a no-op (the new
markup lives entirely in the head/body wrapper `sync_to_html.py` already
preserves verbatim), so it stays compatible with future `Perita.jsx` edits.

### Verification
`sync_to_html.py` re-run, idempotent (byte-identical on repeat, and
confirmed a no-op against the pre-edit file, since `Perita.jsx` wasn't
touched). `service-worker.js` and the extracted watchdog script both parse
with `node -c`/`new Function(...)` with no syntax errors; `manifest.json`
still parses as valid JSON. Local static server: `/`, `/manifest.json`,
`/service-worker.js`, `/perita-core.js`, `/icons/apple-touch-icon.png` all
return HTTP 200. Full test suite: 79/79 passing.

Browser-verified with headless Chromium (no external network available in
this environment, so the real CDN scripts couldn't be fetched — verified
against that constraint, not despite it):
- The loading screen is present in the DOM and visible immediately on
  `commit` (before any script would have had a chance to load even with
  network access) — confirmed via screenshot at 390×844 (iPhone) and
  1024×768 (iPad); logo square, centered, no rounded corners.
- Simulated a successful app mount (replacing `#root`'s children, the same
  DOM operation `createRoot().render()` performs) — confirmed the loading
  screen is removed, the `app-loading` class is removed from `<html>`, the
  15s timeout is cleared, and no retry button appears.
- Simulated a failed/never-mounting app (watchdog timeout sped up for the
  test) — confirmed the text switches to the error message, the spinner is
  hidden, a working "Recargar" button appears, and `<html>` keeps the
  `app-loading` class (background stays pink, no flash to black/white while
  showing the error).
- Confirmed `prefers-reduced-motion: reduce` removes the spinner's rotation.

### Remaining / not in scope
Requested explicitly out of scope for this task and not touched.

---

## [1.1.1] — Session 10: PWA install icon fixed (generic "P" replaced) (2026-07-29)

### Confirmed cause
The four PNGs in `icons/` (`icon-152x152.png`, `icon-192x192.png`,
`icon-512x512.png`, and the missing `apple-touch-icon.png`) were a generic
rounded-corner "P" mark, unrelated to the actual Perita logo (the piggy-bank
mark stored as `PERITA_LOGO` in `Perita.jsx` and already used in the
sidebar). iOS "Add to Home Screen" reads `apple-touch-icon`, so it showed
the generic "P". `index.html` also had two conflicting `apple-touch-icon`
links (one unsized pointing at 152px, one `sizes="192x192"` pointing at a
192px file — non-standard for `apple-touch-icon`), and every icon/manifest
path was relative (`icons/...`) rather than root-absolute.

### Fix
All four icon PNGs (`apple-touch-icon.png` 180×180, `icon-152x152.png`,
`icon-192x192.png`, `icon-512x512.png`) regenerated directly from
`PERITA_LOGO` — a plain resize of the same square, opaque, brand-pink source
image already used by the sidebar, no cropping/deformation/added rounding.
`index.html`'s two conflicting `apple-touch-icon` links replaced with one:
`<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">`.
All PWA-related `<link>` hrefs in `index.html` and all `icons` `src` entries
in `manifest.json` switched from relative to root-absolute (`/...`) paths.
`service-worker.js`'s `CACHE_NAME` bumped `v1` → `v2` (so already-installed
users don't keep serving the old cached icon) and the four icon paths added
to `APP_SHELL` so they're cached on install.

### Files modified
`icons/apple-touch-icon.png` (new), `icons/icon-152x152.png`,
`icons/icon-192x192.png`, `icons/icon-512x512.png`, `index.html` (`<head>`
only), `manifest.json`, `service-worker.js`, `ARCHITECTURE.md`, `README.md`.

### Verification
All four PNGs confirmed 180/152/192/512px square, valid PNG. `manifest.json`
parses as valid JSON. Local static server: `/`, `/manifest.json`,
`/service-worker.js`, `/perita-core.js`, and all four `/icons/*.png` paths
return HTTP 200. `service-worker.js` parses as valid JS
(`new Function(source)`) and every `APP_SHELL` entry was confirmed fetchable
at 200 (simulating what `cache.addAll` needs to succeed on install). Full
test suite: 79/79 passing (no financial logic touched). `Perita.jsx` and
`perita-core.js` untouched — no changes to financial logic or unrelated UI.

### Remaining / manual step
None on the code side. The loading screen was explicitly out of scope for
this task and was not touched.

---

## [1.1.0] — Session 9: salary model separated from additional income (2026-07-22)

### Business-rule reversal
Explicitly overturns the Session 5 rule ("salary is already representable as
a normal income transaction, never summed with `settings.salary`"). The
confirmed rule as of this session:

1. There is only one configured salary.
2. The salary is managed only from Configuración.
3. Income transactions represent only additional income.
4. The salary is not an income transaction.
5. Monthly income = configured salary + additional income.
6. Closing a month stores the exact configured salary used for that month in
   the snapshot.
7. Changing the salary later never modifies archived months.
8. The current month always uses the current configured salary.
9. Archived months always use their stored salary snapshot.

See `BUSINESS_RULES.md`'s "Salary model — confirmed additive rule" for the
full rationale and the historical note explaining the reversal.

### Core changes (`perita-core.js`)
- `monthTotals(am, salary?)`: now accepts an optional `salary` argument and
  returns `{salary, additionalIncome, ingresos, variables, fijos, ahorros,
  deudas, sobrante}` (previously no `salary`/`additionalIncome` fields).
  `ingresos = resolvedSalary + additionalIncome`. Salary resolution:
  explicit argument → `am.salary` (archived snapshot) → `0` (backward-compat
  fallback for pre-Session-9 archives).
- `dashboardTotals(state)`: now calls `monthTotals(activeMonth,
  settings.salary)` explicitly and returns two new fields, `salary` and
  `additionalIncome`. `totalIncomeDash`/`remaining` now always include the
  configured salary, even on an otherwise-empty month. `incomeSrc` is
  simplified to equal `totalIncomeDash` directly (the old
  zero-income-fallback ternary is no longer needed under the additive rule).
- `closeMonth(state, closedAt?, expectedMonth?)`: now stamps
  `salary: settings.salary || 0` into the archived snapshot at close time,
  in addition to the existing Session 8 `expectedMonth` double-close guard.

### UI changes (`Perita.jsx`)
- `IngresosPanel`: placeholder text changed from `"Sueldo, freelance…"` to
  `"Freelance, bono, venta…"`; added a read-only informational card showing
  the configured salary (when `> 0`) above "Agregar ingreso", clarifying it's
  added automatically and should not also be logged as a transaction; the
  income total label changed to "Total ingresos adicionales".
- `Settings`' month-close summary modal: now shows "Sueldo configurado",
  "Ingresos adicionales", and "Ingresos totales" as three distinct rows
  (previously one combined "Ingresos" row); rewritten disclaimer text
  describing the additive rule and that the current salary will be saved
  into the month's archive at confirm time.
- `HistorialMensual`'s archived-month detail view: same three-row
  breakdown (Sueldo / Ingresos adicionales / Ingresos totales); added a
  caveat paragraph shown when `detail.salary == null`, for archives created
  before this session's snapshot mechanism existed.

### Data model (`DATA_MODEL.md`)
`ArchivedMonth` gains a `salary: number` field (absent on pre-Session-9
archives). `monthTotals`/`dashboardTotals`/`closeMonth` signatures and
behavior updated to match.

### Tests
Rewrote `tests/perita-core.test.js` sections 6 ("Dashboard calculations"), 7
("Salary vs. additional income" — full rewrite for the additive rule), 8
("Dashboard end-to-end validation matrix"), and 10 ("Month-closing flow",
including the `buildValidationMatrixMonth` helper, which no longer logs the
salary as an income transaction). Added coverage for all 10 required
scenarios: salary only; salary + one additional income; salary + multiple
additional incomes; salary modified before close; salary modified after
close; historical months unchanged across multiple later closes/edits;
Dashboard totals; monthly summary; month closing (including the stamped
snapshot); and archived-month visualization (including the legacy-archive,
no-stored-salary backward-compatibility case). 79/79 tests passing.

### Backward compatibility
Pre-existing archived months (no `salary` field) resolve to a `0` salary
contribution rather than a guessed value — `monthTotals` never backfills a
historical month with today's `settings.salary`. `HistorialMensual` shows an
explicit caveat on such archives.

### Remaining risk (flagged, not auto-fixed)
A user who, under the old rule, was in the habit of manually logging their
salary as an income transaction may still have one sitting in an
already-open month from before this change. Under the new additive rule that
transaction is now additional income, so it will double-count with the
configured salary until the user deletes it manually. Not automatically
detected/removed — there is no reliable way to distinguish an old habitual
salary entry from a legitimately-named additional-income transaction.

### Build
`index.html` regenerated via `sync_to_html.py` (idempotency verified via a
double-run diff); JSX verified with a full Babel transform
(`@babel/preset-react`); all static assets (`/`, `/manifest.json`,
`/service-worker.js`, `/perita-core.js`, icons) verified HTTP 200 via a local
static server.

---

## [1.0.0] — Session 8: month-closing flow audited, double-close guard added (2026-07-22)

### Audit finding
The month-close summary modal's five totals rows (Ingresos, Gastos fijos,
Gastos variables, Pagos de deuda, Ahorro mensual) were already complete and
already reused `PeritaCore.monthTotals(activeMonth)` — no omission there. The
real gap was in the **explanatory disclaimer text** below the totals, which
said only "los ingresos y gastos variables del mes actual se archivarán" —
underspecifying that debt payments, savings deposits, and fixed-expense
paid-status also reset every close. Rewritten to name all four monthly logs
explicitly and clarify that only the current month's *log* resets; permanent
balances/definitions (accounts, debt/wallet balances, fixed-expense
definitions) never do.

### Root cause found and fixed: no guard against double-close
`closeMes` had no protection against firing twice (a double-click, or two
queued confirms) — a second invocation would close the *already-closed*
(now-empty) month again, pushing a spurious empty archive entry and
skipping a calendar month. Fixed two ways: `PeritaCore.closeMonth` now
accepts an optional third argument, `expectedMonth`, and is a no-op if the
state's `activeMonth.month` no longer matches it (existing callers that omit
it are unaffected — fully backward compatible); and the UI now also disables
the confirm button for the duration of the close as a first line of defense.

### Data rollover — reviewed, not changed
Verified against `BUSINESS_RULES.md`/`DATA_MODEL.md` what carries over across
a close: income transactions, variable expenses, debt-payment logs,
savings-deposit logs, and fixed-expense paid-status all correctly reset (they
are this-month transactional records, permanently preserved instead inside
the archived snapshot); accounts, debts (with accumulated `paid`), wallets
(with accumulated `balance`), `budget[]` definitions, and `settings`
(including salary) are correctly left untouched. No conflict found between
implementation and documentation — see the new rollover table in
`BUSINESS_RULES.md`.

### UI text
Confirm button changed from "Cerrar mes e iniciar nuevo" to "Confirmar". The
"Ingresos" row relabeled "Ingresos totales del mes" for clarity that it's the
total, not a partial figure — the data model still has no dedicated "salary
transaction" flag (confirmed in Session 5), so salary and additional income
cannot be split into two separate rows; the existing informational note about
`settings.salary` covers that distinction instead.

### Tests
Added a new "10. Month-closing flow" group: the full required validation
matrix (1 salary-as-income, 2 additional incomes, 3 fixed, 3 variable, 1 debt
payment, 1 savings deposit) checked against the pre-close summary, the
archived snapshot, and the new active month; a salary-change-after-close
test; an edit-after-close test (accounts/debts/wallets/settings mutated,
archive unaffected); an older-archived-months-unchanged test; the
double-close no-op guard (with and without `expectedMonth`, confirming
backward compatibility); and an empty-month close safety test (no NaN, no
corrupted history, closing twice in a row on distinct months still works
normally). 74/74 tests passing.

---

## [1.0.0] — Session 7: remaining no longer estimates from salary; page-level totals centralized (2026-07-22)

### Detail 1 — empty-month inconsistency resolved
`dashboardTotals().remaining` previously fell back to `settings.salary` when
the active month had zero logged income, while `monthTotals().sobrante`
stayed at `0` — a confirmed but user-visible inconsistency (Session 6 had
documented it as intentional; this session removed it per an explicit product
decision). `remaining` is now computed as `mt.sobrante` directly (literally
the same value, not just the same formula), so it can never drift from the
section-total/month-close/archive calculation again. `settings.salary` is
never treated as available money until it's logged as an income transaction.
`incomeSrc` keeps its salary fallback, but only as the `savingsRate`
percentage denominator — an informational/reference use, not a balance.

Result: empty month with configured salary → income `0`, remaining `0`
(previously: remaining showed the configured salary). Once the salary is
logged as income, `remaining` updates normally and matches `sobrante`
immediately — this was already correct and unaffected by this change.

### Detail 2 — page-level totals centralized
`AccountsPage`, the Wallets/Ahorros page, and `DebtTracker` each recomputed
their own total with a local `reduce()` that happened to match the
Dashboard's formula exactly — correct, but a second (or third) place the
formula could silently drift if one copy was ever edited without the others.
Added three pure helpers to `perita-core.js` — `totalAccountBalance(accounts)`,
`totalWalletBalance(wallets)`, `totalActiveDebt(debts)` — and pointed
`dashboardTotals` and all three pages at them. One implementation of each
formula now, reused everywhere it's shown.

### Tests
Updated assertions that had encoded the old salary-fallback `remaining`
behavior (now `0` on an empty month, not the salary amount). Added a new
"9. Centralized page-level totals" test group: account/wallet/debt totals
after create, edit, and delete; a check that `dashboardTotals` uses the exact
same helpers; and a source-scan test asserting `Perita.jsx` calls the
centralized helpers and no longer contains the three old duplicated
formulas. 64/64 tests passing.

---

## [1.0.0] — Session 6: Dashboard audit — verification pass, no Dashboard code changes needed (2026-07-22)

Audited every Dashboard card/KPI/progress indicator against `perita-core.js`.
Result: the Dashboard component already destructures every value from a
single `PeritaCore.dashboardTotals(state)` call (Sessions 4–5 had already
centralized the two duplicated formulas that used to live in `Budget` and
`HistorialMensual` — neither is inside `Dashboard` itself). No inline
financial formulas exist in the `Dashboard` component; `settings.salary` is
used only as a percentage-bar denominator/reference (KPI subtitle,
"Distribución del Sueldo"), never summed into a total, consistent with the
confirmed salary rule. No memoization (`React.memo`/`useMemo`) wraps
`Dashboard`, so it re-renders — and re-reads `dashboardTotals` fresh — on
every `App` state change; nothing can go stale after add/edit/delete.
**No `Perita.jsx` or `perita-core.js` changes were required.**

Ran the full 10-step validation matrix (empty month → salary as income →
additional income → 3 fixed expenses → 3 variable expenses → debt payment →
savings deposit → edit → delete → close month) as a new regression test,
comparing `dashboardTotals` and `monthTotals` at every step. One confirmed,
intentional divergence surfaced and is now explicitly tested: on an **empty**
month (zero income logged), `dashboardTotals().remaining` optimistically
falls back to `settings.salary` (a live planning estimate), while
`monthTotals().sobrante` stays at the raw `0` (no estimate — it's the
function also used to archive months, and must never assume unlogged income).
The two converge exactly once any income is logged that month — see
`BUSINESS_RULES.md`.

58/58 tests passing (54 prior + 4 new: empty-month edge case, the full
10-step walk-through, and an archived-month-does-not-leak check).

---

## [1.0.0] — Session 5: salary/additional-income rule confirmed, month-close summary clarified (2026-07-22)

### Confirmed business rule: salary is not a second, additive income source
Inspected the data model (`Expense` entity, no salary-specific field or flag),
the `IngresosPanel` form (description placeholder is literally `"Sueldo,
freelance…"`), and `App`'s only other two `settings.salary` usages (percentage
denominators, budget-warning threshold). Conclusion: a salary payment is meant
to be logged as a normal income transaction when received, exactly like any
other income; `settings.salary` is a single reference number, not a second
source to sum in. `incomeSrc = totalIncomeDash > 0 ? totalIncomeDash :
settings.salary` was already the correct implementation of this rule — no
calculation code changed. See `BUSINESS_RULES.md`'s "Salary vs. additional
income — confirmed rule" section.

### Month-close summary fixed to stop implying salary is additive
Session 4 added "Sueldo mensual (referencia)" as its own row inside the
totals list, which looked like a component that should sum into "Sobrante
final" — it doesn't, and never did. Replaced with a plain "Ingresos" row
(logged transactions only) plus a contextual note, shown only when
`settings.salary > 0`, that explicitly says whether the configured salary is
already counted (already logged as an income transaction this month) or not
yet counted (no income logged yet) — removing the ambiguity around what
"Total income"/"Monthly result" actually include.

### No salary-snapshot mechanism added
Verified archived months are never recalculated from the current
`settings.salary` (neither `PeritaCore.monthTotals` nor `HistorialMensual`
ever reference it) — a dedicated test now locks this in (close a month,
change salary, confirm the archived month's totals don't move). Since salary
is never summed additively, no per-month salary snapshot was needed to keep
history accurate.

### Report arithmetic correction (no code/doc bug — a chat-response typo)
The prior session's final report stated the required-validation-matrix
scenario's post-deletion result as "−145" in one sentence before correcting
itself to "−135" in the same sentence. The test code was always correct
(`450 - 350 - 115 - 70 - 50`, evaluated by the JS engine, not hand-typed as a
literal) and asserts `-135`; `-145` is the correct value for an earlier stage
of the same scenario (before the edit and delete), not the final one. No file
in the repository ever contained the wrong figure — confirmed by search.

### Tests
Added a "6. Salary vs. additional income" test group (6 scenarios: salary
only, additional income only, both present with salary not yet logged as a
transaction, salary logged as a transaction — no duplication, salary changed
after month close doesn't alter the archive, and a standalone re-assertion of
the audit scenario's exact `-135` post-deletion result). 53/53 tests passing.

---

## [1.0.0] — Session 4: financial-calculation audit (2026-07-22)

### Debt payments were missing from every "money left" figure
- `PeritaCore.monthTotals().sobrante` and `PeritaCore.dashboardTotals().remaining`
  both omitted debt payments (`deudas`/`monthlyDebt`) from their subtraction —
  a month with debt payments overstated remaining money by exactly the
  payment amount. Both formulas now subtract debt payments; they agree with
  each other whenever the month has recorded income. Affects the Dashboard's
  "Sobrante Mensual" KPI, the month-close summary's "Sobrante final", and
  every `HistorialMensual` (archived month) view.

### Duplicated, drifted calculations centralized
- `Budget`'s "Disponible" KPI was computed from a completely separate, static
  formula (`settings.salary - totalBudget - totalSavings`, using *all* fixed
  expense definitions rather than just what was paid this month, and each
  wallet's suggested monthly contribution rather than actual deposits) —
  producing a different number than Dashboard's "Sobrante Mensual" for what
  is conceptually the same metric. Now reads
  `PeritaCore.dashboardTotals(state).remaining` directly.
- `HistorialMensual` re-derived income/expense/fixed/savings totals with an
  inline `reduce()` duplicate of `PeritaCore.monthTotals`, carrying the same
  debt-omission bug locally. Replaced with a direct call to
  `PeritaCore.monthTotals(m)`.

### Monthly summary now shows salary as its own line
- The month-close summary modal (Settings → "Iniciar nuevo mes") now shows
  "Sueldo mensual (referencia)" as an informational line, separate from
  "Ingresos adicionales" (the month's logged income transactions). It does
  not change what counts toward any total — see `BUSINESS_RULES.md` for why
  this is scoped to the *live* month-close preview only (archived months in
  `HistorialMensual` don't store a historical salary, so showing today's
  value there would misrepresent old data).

### Test suite
- Fixed a test that had enshrined the debt-omission bug
  (`dashboardTotals().remaining` assertion updated to include the debt
  payment). Added 3 new tests: a targeted debt-payment regression, a
  Dashboard/HistorialMensual consistency check (`remaining === sobrante`),
  and a full scenario matching this session's validation matrix (2 incomes,
  3 fixed expenses, 3 variable expenses, 1 debt payment, 1 savings deposit,
  one edit, one delete, one month close) — 47/47 tests passing.

### Not changed (flagged, not a bug)
- `incomeSrc`'s fallback (use logged income if any exists this month,
  otherwise `settings.salary`) is unchanged — combining salary additively
  with logged income every month would require snapshotting salary per
  archived month, a data-model change out of scope for this pass. See
  `BUSINESS_RULES.md`.
  → **Resolved in Session 5:** this fallback is confirmed correct, not a
  design gap — see Session 5's entry above and `BUSINESS_RULES.md`.

---

## [1.0.0] — Session 3: bug fixes, test suite, responsive stabilization, PWA hardening (2026-07-20/21)

### Runtime crash fix
- Fixed a fresh-install crash: `load()` only created the `state.expenses`
  compatibility alias when saved `localStorage` data existed; on a brand-new
  install `state.expenses` was `undefined`, and `ExpenseTracker`/
  `IngresosPanel` crashed on `.filter(...)`. Fixed at every code path that
  constructs a fresh/reset state (`load()`'s no-data and error-fallback
  branches, the "Reiniciar datos" button, `closeMes`).

### Monthly-cycle state synchronization fix
- `Wallets.deposit` updated wallet/account balances but never wrote to
  `activeMonth.aportesAhorro` — savings contributions were invisible to the
  monthly summary and Dashboard. Fixed.
- The `expenses` alias only synced into `activeMonth` at `localStorage`
  serialization time, not in React state — Dashboard/summary/`closeMes` all
  saw stale data within a session (needed a reload to update). Fixed by
  syncing on every `App.setState` transition.
- `closeMes` captured its snapshot from a component-scope variable set at
  render time rather than the freshest state inside the `setState` updater —
  unsafe under React 18 batching. Fixed.

### Regression test suite (extraction of `perita-core.js`)
- Extracted all financial state-transition and calculation logic out of
  `Perita.jsx` into a new, pure, framework-free module: `perita-core.js`.
  Shared verbatim by the browser app (`window.PeritaCore`) and the test
  suite (`require`) — zero duplicated logic.
- Added `tests/perita-core.test.js`: 44 tests using Node's built-in test
  runner (`node --test`), zero external dependencies. Covers transactions,
  monthly close, savings, debts, fixed expenses, dashboard math (including
  zero-value edge cases), and persistence/migration.
- Added edit support for Ingresos and Gastos variables (previously
  incomplete/missing — flagged as Known Issue #1 in the prior session).
  Editing an income transaction correctly reconciles account balances if the
  amount or destination account changes.
- **Bug caught by writing the tests:** debt overpayment wasn't actually
  fully prevented — `paid` was clamped to `total`, but the *logged* payment
  amount in `activeMonth.pagosDeuda` still reflected the requested (excess)
  amount. Fixed: the applied amount is clamped first, then both `paid` and
  the log entry use that same clamped value.
- Added `package.json` (`npm test` script) and `sync_to_html.py` (portable,
  relative-path version of the Perita.jsx → index.html build step —
  previously only documented as a sandbox-path Python snippet).
- **Bug found and fixed in `sync_to_html.py` itself:** it took "everything
  from the service-worker script to end of file" when splicing, so
  re-running it repeatedly appended duplicate `</body></html>` pairs. Fixed
  to bound the service-worker script at its own closing `</script>`; now
  verified idempotent (identical output on repeated runs).

### Responsive stabilization (desktop → tablet → mobile, three dedicated passes)
- **Desktop (≥1100px):** Dashboard's 3-card KPI row used a 4-column grid
  class, leaving an empty 4th column at desktop widths. Fixed by correcting
  that grid class's base column count (it had no other usages, so no
  side effects elsewhere).
- **Tablet (701–1099px):** found and fixed a real inconsistency — the
  sidebar/content-padding breakpoint was at 900px while the grid-downgrade
  breakpoint was at 1100px, so viewport 901px got *less* content width than
  900px (narrower screen = more room), and common tablet landscape widths
  (e.g. 1024px, standard iPad) fell in the gap and got desktop-density
  styling instead of tablet. Unified both into a single
  `@media(max-width:1099px)` breakpoint — see `ARCHITECTURE.md`'s
  "Responsive Breakpoints" section for the resulting contract.
- **Mobile (≤700px):** found and fixed a real overflow bug — the
  notification toast container was `right:16px` with `max-width:320px` and
  no `left` constraint, so on phones ≤336px wide, a sufficiently long
  message computed a *negative* left offset and got clipped off-screen.
  Fixed by anchoring both edges in the mobile breakpoint.
- Verified against 1440/1100 (desktop), 1024/768 (tablet), and
  700×900/430×932/390×844/375×667/320×568 (mobile) throughout.

### Empty-state fixes
- Fixed a layout bug: `EmptyState`, when rendered as a direct child of a
  multi-column grid (`AccountsPage`'s `.grid-3`), collapsed to 1/3 row width
  instead of spanning the full row. Fixed via the component's own
  (previously unattached) `.empty-state` CSS class, adding
  `grid-column:1/-1` — a single reusable fix, not a per-screen one. Also
  removed a stale `.empty-state svg` CSS rule that predated the current
  icon markup and would otherwise have shrunk/faded the icon the moment the
  class was actually wired up.
- Added a reusable `emptyStateProps()` helper and applied screen-specific
  "no records yet" copy to all 7 empty-state call sites, and — for the two
  screens that support filtering (Ingresos, Gastos variables) — distinct
  "Sin resultados" copy (no CTA button) when records exist but the active
  filters matched none.

### Infrastructure / PWA hardening
- Discovered `index.html` referenced `manifest.json` and two icon files,
  and registered a service worker at `/service-worker.js` — **none of which
  existed in the repository.** Created all three:
  - `manifest.json` (name, `start_url`/`scope: "/"`, `display: standalone`,
    theme/background colors matching existing CSS variables, 3 icon sizes).
  - `service-worker.js` (cache-first app shell, network-fallback-with-cache-
    fill, offline fallback to cached `index.html`, and the `SKIP_WAITING`
    message handler required by the update-prompt flow already present in
    `Perita.jsx`'s Settings component).
  - `icons/icon-152x152.png`, `icon-192x192.png`, `icon-512x512.png`
    (generated: simple on-brand pink rounded-square with a white "P" mark).
  - Added the missing `<link rel="icon">` favicon tag, reusing the 192px icon.
- Added `README.md` and `.gitignore` (both previously missing).
- **Packaging bug found and fixed:** an earlier delivery of the ZIP placed
  the icon PNGs at the repo root instead of inside `icons/`, and omitted
  `perita-core.js` entirely. Rebuilt and verified the complete flat
  repository (no nested folder), confirmed every path referenced by
  `index.html`/`manifest.json`/`service-worker.js` resolves, and confirmed —
  via an actual local static HTTP server, not just a file-existence check —
  that every asset returns HTTP 200, including from a freshly re-extracted
  copy of the delivered ZIP.

### Known issues resolved this session
See "Known Issues" table below — issues #1–#3 from the prior session are now
resolved; #4 remains by design.

---

## [1.0.0] — Session 2 (2026-07-20)

### Task 4.5 — Duplicate source cleanup
- Removed duplicate application copy from Perita.jsx (was ~3000 lines, now ~1900)
- Removed duplicate COLORS declaration
- Rebuilt index.html from canonical Perita.jsx
- Restored missing helpers: fmt, pct, today, monthsLeft, addMonths, APP_VERSION, COLORS, PERITA_LOGO
- Restored React hook destructuring (useState/useEffect/useRef/useCallback)
- Fixed showOtros useState hook order violation

### Task 4 — Dashboard fully month-driven
- Dashboard reads all monthly values from activeMonth:
  totalIncomeDash, totalVariable, monthlySavings, totalFixed, monthlyDebt
- Fallback: if no income entries, uses settings.salary as incomeSrc
- Removed budget/wallets config reads for monthly totals

### Task 3 — Historial Mensual view
- New HistorialMensual component (read-only)
- Added to PAGES, OTROS_PAGES, PAGE_TITLES, page render
- List + detail views; empty state; "Ver detalle" button

### Task 2.6 — Fixed expense paid status
- toggleFijoPagado + isPaid in Budget component
- Checkmark UI toggle; strikethrough on paid items
- Settings summary uses actual paid amounts

### Task 2.5 — Complete monthly data model
- activeMonth: {month, expenses, pagosDeuda, aportesAhorro, gastosFijosPagados}
- registerPayment logs to activeMonth.pagosDeuda
- deposit logs to activeMonth.aportesAhorro
- closeMes resets all monthly arrays

### Task 2 — Iniciar nuevo mes
- "Ciclo mensual" card in Settings
- Summary modal + closeMes() archives to monthlyHistory

### Task 1 — Monthly cycle data model
- activeMonth + monthlyHistory added to state
- Migration in load() for existing data

### Other improvements (Session 2)
- Ingresos as standalone page (removed from Settings)
- Variables + Ingresos: dialog-form pattern, filters, totals
- Navigation restructure: Otros group (desktop sidebar + mobile sheet)
- Sobrante mensual now deducts variable expenses
- EmptyState component applied to all views
- Total indicators: Cuentas, Ahorros
- Button centering: justify-content:center on .btn
- Chart.js guard in ChartCanvas
- Removed "Deuda Restante" KPI card
- App versioning + SW update modal

---

## [1.0.0] — Session 1 (2026-06-27)

### Initial build
- Complete single-file React 18 PWA (Perita)
- Dashboard, Cuentas, Ahorros, Fijos, Variables, Deudas, Ajustes
- LocalStorage perita_v1, Chart.js, PWA manifest + service worker
- Responsive layout, CLP formatting, pink #F86C98 theme

---

## Known Issues

| # | Issue | Severity | Status |
|---|---|---|---|
| 1 | Edit support for Ingresos/Variables incomplete | Medium | ✅ Resolved (Session 3) |
| 2 | Deployment ZIP stale / packaging inconsistencies | Low | ✅ Resolved (Session 3) |
| 3 | Non-canonical derived files (`perita-local/`, old `App.jsx`) floating around outputs | Low | ✅ Resolved (Session 3) — repo is now a single flat, canonical structure |
| 4 | `ChartCanvas` shows a placeholder in a raw JSX-only preview (Chart.js isn't loaded there) | Low | By design — not a bug, `Perita.jsx` is never meant to run standalone outside `index.html` |
| 5 | `Chart.js` doughnut chart (Budget page) legend position may look tight at the narrowest mobile widths (320–375px) | Low | Flagged, not fixed — visual density only, no overflow/clipping |
| 6 | iOS safe-area-inset padding for notched devices (bottom nav / bottom sheet) not explicitly handled | Low | Flagged, not fixed — untested on real notched hardware |
| 7 | A few genuinely-unused symbols exist (`ACCOUNT_TYPES` constant, `.grid-5` CSS class, two dead CSS selectors) | Very low | Flagged during infra audit, intentionally left as-is per explicit scope (no cosmetic-only refactors) |
| 8 | "Remaining"/"sobrante" omitted debt payments in `monthTotals`/`dashboardTotals`, and `Budget`'s "Disponible" used a separate stale formula | Medium | ✅ Resolved (Session 4) |
| 9 | `settings.salary` and logged income are mutually exclusive (fallback, not additive) in every total | Low | ⚠️ Superseded (Session 5 confirmed this as correct-by-design; Session 9 explicitly reversed it by direct user instruction — salary is now additive and never entered as an income transaction). Current rule: see `BUSINESS_RULES.md`'s "Salary model — confirmed additive rule." |
| 10 | `dashboardTotals().remaining` estimated from `settings.salary` on an empty month while `monthTotals().sobrante` stayed at 0 | Medium | ✅ Resolved (Session 7) — `remaining` no longer estimates; see `BUSINESS_RULES.md` |
| 11 | `AccountsPage`/Wallets/`DebtTracker` each recomputed their own total locally instead of calling a centralized helper | Low | ✅ Resolved (Session 7) — `PeritaCore.totalAccountBalance`/`totalWalletBalance`/`totalActiveDebt` |
| 12 | No guard against a double-click/repeated confirm closing the same month twice (duplicate archive entry, calendar skips a month) | Medium | ✅ Resolved (Session 8) — `closeMonth`'s `expectedMonth` no-op guard + disabled confirm button |
| 13 | Month-close disclaimer text underspecified what resets on close (named only income/variable expenses, omitted debt payments, savings deposits, fixed-expense paid status) | Low | ✅ Resolved (Session 8) — see `BUSINESS_RULES.md`'s rollover table |
| 14 | PWA install icon showed a generic "P" mark unrelated to the real Perita logo; `index.html` also had two conflicting `apple-touch-icon` links | Medium | ✅ Resolved (Session 10) — all 4 icon PNGs regenerated from `PERITA_LOGO`; single `apple-touch-icon` link; `CACHE_NAME` bumped |
| 15 | Blank/black screen on iPhone while React/Babel/Chart.js loaded — 5 render-blocking `<script src>` tags in `<head>` with no `defer` | Medium | ✅ Resolved (Session 11) — `defer` added, static load screen shows immediately, `CACHE_NAME` bumped |
| 16 | A user with an already-open month who previously logged salary as a regular income transaction (pre-Session-9 UI habit) will double-count it against the new additive `settings.salary` | Low | Flagged, not auto-fixed — see `BUSINESS_RULES.md`/`PROJECT_CHECKPOINT.md` "Known risks"; no reliable way to auto-detect this case |

---

## Next Recommended Tasks (priority order)

*(Updated as of the Session 11 documentation/checkpoint pass — see
`PROJECT_CHECKPOINT.md`'s "Known risks" for the same items with more
detail.)*

1. **Update GitHub manually with the delivered files** — everything through
   Session 11 (salary model, dashboard/month-close fixes, PWA icon fix,
   initial load screen, this documentation pass) exists only in Claude's
   local working copy. Claude has no GitHub write access; the user applies
   the delivered files to GitHub themselves.
2. **Real-device/real-network verification pass** — the initial load
   screen's happy path and 15s-timeout error path were verified with
   simulated DOM mutations and a sped-up timeout in headless Chromium (no
   internet access in that environment to fetch the real CDN scripts), and
   the PWA icon fix was verified by file dimensions/HTTP 200 only. Both need
   a manual pass on a real iPhone once deployed: confirm the load screen
   actually appears before React/Babel finish downloading over a real
   network, and confirm the home-screen icon shows the piggy-bank logo (a
   prior install may need to be removed and re-added first — see
   `PROJECT_CHECKPOINT.md`). Also covers the pre-existing responsive items
   (Chart.js legend density at 320px, iOS safe-area insets) that were
   verified by static analysis rather than an actual browser.
3. **Migration handling for pre-existing "Sueldo" income transactions** —
   under the Session 9 additive salary rule, a user with an already-open
   month who previously logged their salary as a regular income transaction
   (encouraged by the pre-Session-9 placeholder text) will have it
   double-counted against the newly-additive `settings.salary` until they
   delete it manually. Currently flagged as a known risk, not handled in
   code — there's no reliable way to auto-detect "old habitual salary
   entry" vs. a legitimately-named additional-income transaction.
4. **Export/Import JSON** — backup and restore all data. No existing code
   touches this at all; would need a new UI affordance in Ajustes plus a
   straightforward `JSON.stringify(state)`/`JSON.parse` pair (the state
   shape is already fully documented in `DATA_MODEL.md`).
5. **Per-account transaction history** — show which recorded expenses/income
   came from which account. `Expense.account` already exists on income
   transactions; this is a filtering/UI task, not a data-model change.
6. **Debt projection chart edge case** — handle the case where all debts are
   paid (chart currently has no defined behavior for an empty active-debts
   set).
7. *(Low priority, cosmetic only, explicitly deferred)* Remove the unused
   `ACCOUNT_TYPES` constant and dead CSS (`.grid-5`, `.flex.gap-3.mb-4`,
   `[style*="repeat(auto-fit"]`) if a future session wants a cosmetic
   cleanup pass — none of these cause bugs or deployment risk.


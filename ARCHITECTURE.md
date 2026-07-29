# ARCHITECTURE.md — Perita

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI | React 18 (CDN, `react.production.min.js`) |
| JSX | Babel Standalone 7.23.2 (in-browser transpile) |
| Charts | Chart.js 4.4 (CDN) |
| Typography | Inter (Google Fonts) |
| Styling | Custom CSS in `index.html`'s `<style>` (no framework, no CSS-in-JS) |
| State | React `useState`/`useCallback` (no Redux/Context) |
| Financial logic | `perita-core.js` — pure functions, framework-free, shared by app + tests |
| Persistence | `localStorage` key `perita_v1` |
| PWA | `manifest.json` + `service-worker.js` (cache-first, update-prompt flow), static initial-load screen in `index.html` (see "Initial load screen" below) |
| Tests | Node's built-in test runner (`node --test`), zero dependencies — 79/79 passing |
| Build | **None** — static files, no bundler, no transpile step for deployment |

---

## File Structure (flat repo, deploy-ready as-is)

```
/
├── index.html            ← GENERATED — do not hand-edit, see "Sync workflow" below
├── Perita.jsx             ← CANONICAL source for all UI/behavior (React components, JSX)
├── perita-core.js         ← CANONICAL source for financial logic (pure functions)
├── manifest.json          ← PWA manifest (name "Perita", theme #F86C98, standalone)
├── service-worker.js      ← Cache-first app shell + SKIP_WAITING message handler
├── icons/
│   ├── apple-touch-icon.png  ← 180×180, iOS home-screen icon
│   ├── icon-152x152.png
│   ├── icon-192x192.png
│   └── icon-512x512.png
├── tests/
│   └── perita-core.test.js   ← 79 tests against perita-core.js
├── package.json           ← `npm test` only, zero runtime dependencies
├── sync_to_html.py        ← Regenerates index.html from Perita.jsx (see below)
├── .gitignore
└── README.md
```

There is **no `mis-finanzas/` subfolder** and no sandbox-specific paths anywhere in
the repo — every reference (`perita-core.js`, `manifest.json`, `icons/...`,
`/service-worker.js`) is relative to, or rooted at, the repository root. The
repo has been verified to deploy correctly as a flat static site (Vercel,
GitHub Pages, or `python3 -m http.server`), with every asset returning HTTP 200.

> Historical note: earlier project docs (now superseded) described a
> `mis-finanzas/` deployment subfolder and referenced sandbox paths like
> `/mnt/user-data/outputs/...`. That structure was abandoned in favor of the
> flat repo above, which is what actually ships. If you see those old paths
> anywhere, they're stale — ignore them.

---

## Sync workflow (Perita.jsx → index.html)

**Rule: never hand-edit `index.html`'s `<script type="text/babel">` block.**
Edit `Perita.jsx`, then run:

```bash
python3 sync_to_html.py
```

This rebuilds only the `<script type="text/babel">` block; **everything
before that tag in `index.html` is preserved byte-for-byte** — not just
`<head>` (CDN `<script defer>` tags, PWA `<link>`/`<meta>` tags, the
`<style>` block), but also everything already written into `<body>` ahead of
the app script: the `<div id="root">` wrapper and the static initial-load
screen markup inside it, the load-screen watchdog `<script>`, and the
`window.PERITA_LOGO = "data:image/jpeg;base64,..."` script tag. None of that
lives in `Perita.jsx`, so re-running the sync script can never drop it. It is
idempotent — running it twice in a row produces byte-identical output.

**CSS lives only in `index.html`'s `<style>` block.** `Perita.jsx` has no CSS
injection of its own — if you need to change styling, edit `index.html`
directly, then re-run the sync script (it won't touch or revert your CSS
edit, since that lives in the preserved region). The same applies to the
initial-load screen: its markup, CSS, and watchdog script are hand-edited
directly in `index.html`, not generated from `Perita.jsx`.

If you ever need to change the sync script's own logic (rare), it lives in
`sync_to_html.py` at the repo root and uses only `__file__`-relative paths —
no sandbox or absolute paths.

---

## State Shape (`perita_v1` in `localStorage`)

```js
{
  // ── PERMANENT (cross-month, survives "Iniciar nuevo mes") ──────────────────
  settings: { salary: Number },
  accounts: Account[],        // {id, name, type:'bank'|'cash', balance}
  debts: Debt[],               // {id, name, total, paid, status:'activa'|'pagada'}
  wallets: Wallet[],           // {id, name, balance, goal, monthly}
  budget: BudgetItem[],        // {id, name, amount}  — fixed expense definitions
  varCategories: [],           // reserved, currently unused
  nextId: Number,               // global auto-increment, never resets

  // ── MONTHLY CYCLE (reset by closeMes) ────────────────────────────────────────
  activeMonth: {
    month: 'YYYY-MM',
    expenses: Expense[],              // income (type='income') + variable (type='expense')
    pagosDeuda: DebtPayment[],        // {debtId, debtName, amount, date}
    aportesAhorro: SavingsDeposit[],  // {walletId, walletName, amount, date}
    gastosFijosPagados: PaidFixed[],  // {budgetId, name, amount, date}
  },

  // ── ARCHIVE (read-only) ──────────────────────────────────────────────────────
  monthlyHistory: ArchivedMonth[],   // past closed activeMonths + {closedAt}

  // ── COMPATIBILITY ALIAS ──────────────────────────────────────────────────────
  expenses: Expense[],   // === activeMonth.expenses (same array reference).
                          // IngresosPanel/ExpenseTracker read/write this alias;
                          // App.setState re-syncs it into activeMonth on every
                          // transition. See perita-core.js's syncExpensesAlias.
}
```

See `DATA_MODEL.md` for full entity shapes and the `perita-core.js` function
reference.

---

## Component Map

```
App
├── Notifs
├── UpdateModal (SW update detection → postMessage SKIP_WAITING)
├── OtrosBottomSheet (mobile only, .mobile-only-sheet)
├── MobileNav (≤700px: Inicio·Cuentas·Ahorros·Otros·Ajustes)
├── Sidebar (>700px: with Otros collapsible group)
└── Main content (one page active at a time):
    ├── Dashboard
    ├── AccountsPage (Cuentas)
    ├── Wallets (Ahorros)
    ├── Budget (Gastos fijos) ← toggleFijoPagado
    ├── ExpenseTracker (Gastos variables) ← add/edit/delete
    ├── IngresosPanel (Ingresos) ← add/edit/delete
    ├── DebtTracker (Deudas)
    ├── HistorialMensual (read-only)
    └── Settings (Ajustes) ← closeMes / "Iniciar nuevo mes", reset
```

### Shared Components
`Icon`, `ProgressBar`, `EmptyState` (+ `emptyStateProps` helper — see
`UI_GUIDELINES.md`), `ConfirmDialog` + `useConfirm`, `useUnsavedGuard`,
`BankSelect`, `ChartCanvas`, `Notifs`

### Shared Helpers (in `Perita.jsx`)
`fmt(n)`, `pct(a,b)`, `today()`, `monthsLeft()`, `addMonths(n)`,
`APP_VERSION`, `COLORS`, `PERITA_LOGO`, `emptyStateProps(hasRecords, icon, props)`

### `perita-core.js` (pure logic — see `DATA_MODEL.md` for full API)
`makeDefault`, `load`, `serialize`, `syncExpensesAlias`, `resetToDefault`,
`addTransaction`, `deleteTransaction`, `editTransaction`, `deposit`,
`registerDebtPayment`, `toggleFijoPagado`, `closeMonth`, `monthTotals`,
`dashboardTotals`

---

## Navigation

```
PAGES = [
  dashboard, accounts, wallets,
  budget, expenses, income, debt,  ← under Otros
  history,                         ← under Otros
  settings
]
OTROS_PAGES = ['budget','expenses','income','debt','history']
```

- Desktop (≥1100px): sidebar, 240px, with collapsible "Otros" group (`showOtros` state)
- Tablet (701–1099px): sidebar, 200px (unified single breakpoint — see below)
- Mobile (≤700px): sidebar hidden; bottom nav shown; Otros → `.mobile-only-sheet` bottom drawer

---

## Responsive Breakpoints (stabilized this session — see CHANGELOG)

A single project-wide contract, verified consistent end-to-end:

| Range | Sidebar | Content padding | Grid columns |
|---|---|---|---|
| Desktop `≥1100px` | 240px | 24px/32px/48px | base rule (e.g. KPI row: 3 cols) |
| Tablet `701–1099px` | 200px | 16px | narrowed (e.g. KPI row: 2 cols) |
| Mobile `≤700px` | hidden (bottom nav instead) | 12px/12px/16px | 1 col |

All three breakpoints live in exactly two `@media` blocks in `index.html`'s
`<style>`: `@media(max-width:1099px)` (tablet-and-below overrides) and
`@media(max-width:700px)` (mobile-only overrides, which win via source order
since the block appears later in the stylesheet). **Do not reintroduce a
`900px` or `1100px` breakpoint** — both were previously present and caused a
non-monotonic layout bug (901px got *less* content width than 900px); see
CHANGELOG "Tablet stabilization" entry before changing these.

---

## Monthly Cycle Flow

```
User → Ajustes → "Iniciar nuevo mes"
  → Shows summary modal (reads live from state.activeMonth, not a stale render)
    all rows come from PeritaCore.monthTotals(activeMonth, settings.salary) — no inline math
    rows: Sueldo configurado | Ingresos adicionales | Ingresos totales | Gastos fijos |
          Gastos variables | Pagos de deuda | Ahorro mensual | Sobrante final
  → Confirm ("Confirmar") → closeMes():
      if (closing) return                 // guards a double-click
      setClosing(true)
      setState(s => PeritaCore.closeMonth(s, undefined, curMonth))
        if (expectedMonth && s.activeMonth.month !== expectedMonth) return s  // no-op: already closed
        salaryAtClose = settings.salary || 0                                 // (Session 9)
        snapshot = {...s.activeMonth, salary: salaryAtClose, closedAt: ISO string}
        monthlyHistory.push(snapshot)
        activeMonth = { month: nextMonth, expenses:[], pagosDeuda:[], aportesAhorro:[], gastosFijosPagados:[] }
        expenses = []  // alias reset in lockstep
```

`closeMonth` computes the snapshot and next-month date **inside** the
`setState` updater (from the freshest `s`), not from a component-scope
variable captured at render time — this was a real bug fixed in an earlier
session (see CHANGELOG). `closeMonth`'s third argument, `expectedMonth`
(Session 8), is the `curMonth` the confirmation summary was opened for; if a
second invocation ever fires (double-click, repeated confirm) after the
first one already advanced `activeMonth.month`, it's a safe no-op — no
duplicate archive entry, no double calendar advance. See `BUSINESS_RULES.md`'s
"Month-closing flow" section for the full rollover-by-category table.

**(Session 9)** `closeMonth` also stamps the configured salary in effect at
close time into the snapshot (`archived.salary`). This is the mechanism that
lets `monthTotals(archivedMonth)` (no second argument) resolve the correct
historical salary on its own, and it's what guarantees a later edit to
`settings.salary` can never rewrite an already-closed month's totals — see
`BUSINESS_RULES.md`'s "Salary model — confirmed additive rule".

### Monthly Event Writers (all via `perita-core.js`, all go through `App.setState`)

| Action | Core function | Target |
|---|---|---|
| Log income | `PeritaCore.addTransaction` | `activeMonth.expenses` (type='income'), adjusts account balance |
| Log variable expense | `PeritaCore.addTransaction` | `activeMonth.expenses` (type='expense') |
| Edit income/expense | `PeritaCore.editTransaction` | reconciles account balance if income |
| Delete income/expense | `PeritaCore.deleteTransaction` | reverses account balance if income |
| Pay fixed expense (toggle) | `PeritaCore.toggleFijoPagado` | `activeMonth.gastosFijosPagados` |
| Register debt payment | `PeritaCore.registerDebtPayment` | `activeMonth.pagosDeuda`, clamped to remaining balance |
| Deposit to savings | `PeritaCore.deposit` | `activeMonth.aportesAhorro` + wallet/account balance |
| Close month | `PeritaCore.closeMonth` | archives + resets `activeMonth` |

Every one of these is unit-tested in `tests/perita-core.test.js` (79 tests
total) — see `DATA_MODEL.md` for the full function reference and
`BUSINESS_RULES.md` for the business rules each one enforces.

---

## Dashboard Calculation

```js
// PeritaCore.dashboardTotals(state):
mt              = monthTotals(activeMonth, settings.salary)  // (Session 9) salary passed explicitly
salary          = mt.salary                                  // configured salary, always
additionalIncome = mt.additionalIncome                        // sum of type:'income' transactions only
totalIncomeDash = mt.ingresos                                 // salary + additionalIncome, always
totalVariable   = mt.variables
monthlySavings  = mt.ahorros
totalFixed      = mt.fijos
monthlyDebt     = mt.deudas
incomeSrc       = totalIncomeDash                             // no fallback needed — salary always counts
savingsRate     = incomeSrc ? round(monthlySavings / incomeSrc * 100) : 0
remaining       = mt.sobrante                                 // literally reused, not re-derived
totalDebt       = totalActiveDebt(debts)
totalAvailable  = totalAccountBalance(accounts)
totalSavings    = totalWalletBalance(wallets)
netWorth        = totalAvailable + totalSavings
```

`remaining` IS `monthTotals(am, salary).sobrante` (same reference, not just
the same formula) — they can never drift apart, on any month, including an
otherwise-empty one. **(Session 9)** the configured salary is now always
added into `totalIncomeDash`/`remaining` — an empty month with a configured
salary shows that salary as real, available income, not zero. The salary is
never read from the transaction list; it comes from `settings.salary` (live
month) or the archived snapshot's `salary` field (closed month). See
`BUSINESS_RULES.md`'s "Salary model — confirmed additive rule" for the full
history (this supersedes the Session 7 rule that `settings.salary` was never
treated as available money), and `totalActiveDebt`/`totalAccountBalance`/
`totalWalletBalance` — the same pure helpers `AccountsPage`, the
Wallets/Ahorros page, and `DebtTracker` call directly for their own totals.

Safe on zero/empty state — every field is guaranteed finite (no NaN/Infinity),
verified by dedicated tests.

---

## CSS Variables

```css
--green: #F86C98       /* primary theme color */
--green-light: #fde8ef
--green-mid: #d94f7a
--radius-sm: 8px
--gray-50 … --gray-900
```

---

## PWA

- `manifest.json`: `start_url: "/"`, `scope: "/"`, `display: "standalone"`,
  `theme_color: "#F86C98"`, `background_color: "#f9fafb"`, icons at
  152/192/512px, referenced by root-absolute `src` paths (`/icons/...`).
- `index.html`'s `<head>` PWA tags (`<link rel="icon">`, `<link
  rel="manifest">`, `<link rel="apple-touch-icon">`) all use root-absolute
  `/...` paths — not relative `icons/...` — so they resolve correctly
  regardless of the current route/path depth. There is exactly one
  `apple-touch-icon` link (`sizes="180x180"`, `/icons/apple-touch-icon.png`);
  do not add a second, differently-sized one — iOS uses only the first/best
  match it finds and a stale duplicate risks it picking the wrong icon.
- `service-worker.js`: cache-first app shell (`/`, `/index.html`,
  `/manifest.json`, `/perita-core.js`, and the four `/icons/*.png` files),
  network-fallback-with-cache-fill for everything else, offline fallback to
  cached `index.html` for navigation requests, and a `message` listener for
  `{type:'SKIP_WAITING'}` — required by the update-prompt flow already
  implemented in `Perita.jsx`'s Settings component
  (`updateWaiting.postMessage(...)` → `controllerchange` → reload).
- Registered at `/service-worker.js` (root-absolute) from `index.html`'s
  closing script.
- Bump `CACHE_NAME` in `service-worker.js` on each release to invalidate old
  caches. History: `v1` → `v2` when the icon PNGs were replaced (a stale
  cached icon would otherwise persist for already-installed users); `v2` →
  `v3` (current) when the initial-load screen was added to `index.html` (so
  already-installed users get the new HTML instead of a stale cached copy
  without it).
- **Icon source of truth:** all four PNGs in `icons/` (`apple-touch-icon.png`,
  `icon-152x152.png`, `icon-192x192.png`, `icon-512x512.png`) are generated
  directly from `PERITA_LOGO` (the same base64 image `Perita.jsx`'s sidebar
  uses) — a square, opaque, brand-pink image, so each is a plain resize with
  no cropping, deformation, or added corner-rounding. Regenerate all four
  together from `PERITA_LOGO` if the logo ever changes, rather than editing
  the PNGs directly, to keep every icon in sync with the in-app logo.

### Initial load screen

Solves a real symptom: the app used to show a blank/black screen on slower
connections (notably iPhone) while React/Babel/Chart.js loaded, because the
five CDN `<script src>` tags in `<head>` had no `defer` and blocked HTML
parsing — nothing past them, including `<body>`, could paint until each had
downloaded and run.

- All five CDN/library `<script>` tags (React, ReactDOM, Babel Standalone,
  Chart.js, `perita-core.js`) now carry `defer`. This unblocks parsing of
  `<body>` — the load screen below paints immediately — while still
  guaranteeing document-order execution before `DOMContentLoaded`, so
  `perita-core.js` and Babel Standalone are ready before the inline
  `<script type="text/babel">` app script needs them.
- `<div id="root">` starts with static markup (`#app-loading`): full-viewport
  fixed overlay, `#F86C98` background, centered `/icons/apple-touch-icon.png`
  logo (no `border-radius`), "Cargando Perita…" text, and a small spinner.
  It's plain HTML/CSS — visible the instant the browser reaches `<body>`, no
  JavaScript required to appear.
- `ReactDOM.createRoot(root).render(<App/>)` (unchanged) replaces
  `#root`'s children as a normal client render — this is what removes the
  load screen the moment the app mounts. No extra removal code was needed on
  the happy path, and no artificial minimum display duration was added.
- A small inline watchdog `<script>` (plain JS, positioned right after the
  load-screen markup, independent of React) uses a `MutationObserver` on
  `#root` to detect the load screen's removal (app mounted) and clears a 15s
  timeout. If that timeout fires first, it swaps the text for an error
  message and adds a "Recargar" button (`location.reload()`).
- `html.app-loading, html.app-loading body{background:#F86C98}`: the
  `app-loading` class starts on `<html>` and is removed by the same watchdog
  once the app mounts, so `<html>`/`<body>` share the load screen's
  background (no flash to black/white) without permanently changing
  `<body>`'s normal `var(--gray-50)` app background.
- `@media(prefers-reduced-motion:reduce)` disables the spinner's rotation.
- All of the above lives directly in `index.html` (markup, CSS, and the
  watchdog script), not in `Perita.jsx` — see "Sync workflow" above for why
  `sync_to_html.py` can never drop it.


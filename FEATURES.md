# FEATURES.md — Perita

User-facing feature inventory. `[x]` = complete and tested/verified; `[~]` =
implemented but with a known limitation noted; `[ ]` = not implemented (see
"Next Recommended Tasks" in `CHANGELOG.md`). This is Perita's pending/done
tracker — treat it as the canonical list of what's finished vs. outstanding;
don't add a separate pending-tasks file alongside it.

---

## Dashboard
- [x] Hero card (net worth / available balance)
- [x] KPI row: Ahorro Mensual, Gastos Fijos, Sobrante Mensual (3 cards)
- [x] Debts summary card, Savings summary card
- [x] All monthly figures derived live from `activeMonth` via
      `PeritaCore.dashboardTotals` (single source of truth, shared with
      tests), including the additive salary rule below
- [x] **Salary separated from additional income (Session 9).** Total income
      = configured salary (`settings.salary`, managed only in Configuración)
      + additional-income transactions, always — the salary is never itself
      an income transaction. `remaining`/`totalIncomeDash` include the
      configured salary even on an otherwise-empty month. See
      `BUSINESS_RULES.md`'s "Salary model — confirmed additive rule."

## Cuentas (Accounts)
- [x] CRUD accounts (bank/cash), adjust balance
- [x] Total-in-accounts indicator — centralized in
      `PeritaCore.totalAccountBalance`, one implementation shared with
      Dashboard
- [x] Empty state: "Aún no has agregado ninguna cuenta." (spans the full
      grid row)

## Ahorros (Savings)
- [x] CRUD savings goals (wallets), progress bars, goal/monthly meta
- [x] Deposit modal — deposits recorded in the monthly cycle
      (`activeMonth.aportesAhorro`)
- [x] Empty state: "Aún no has creado ningún ahorro."

## Ingresos (Income)
- [x] Add / edit / delete **additional-income** entries only — the Income
      page no longer implies salary belongs here (placeholder text and an
      informational read-only salary card were updated for this in Session
      9); reconciles account balances correctly on edit
- [x] Filter by month + text search
- [x] "Total ingresos adicionales" indicator (excludes the configured
      salary by design), deposits directly into a chosen account
- [x] Empty state distinguishes "no income yet" vs. "records exist but
      filters matched none" (Sin resultados)

## Gastos fijos (Fixed expenses)
- [x] CRUD fixed-expense definitions
- [x] Mark-as-paid toggle → `activeMonth.gastosFijosPagados`, strikethrough UI
- [x] Empty state: "Aún no has registrado gastos fijos."

## Gastos variables (Variable expenses)
- [x] Add / edit / delete variable expenses
- [x] Filter by month, category, text search
- [x] Total indicator
- [x] Empty state distinguishes "no expenses yet" vs. "Sin resultados"

## Deudas (Debts)
- [x] CRUD debts, payment registration
- [x] Overpayment prevention — payment clamped to the remaining balance;
      both `debt.paid` and the logged payment amount reflect only what was
      actually applied
- [x] Debt marked `pagada` automatically once fully paid; further payment
      attempts are a safe no-op
- [x] Projection chart
- [x] Total-active-debt indicator — centralized in
      `PeritaCore.totalActiveDebt`
- [x] Empty state: "Aún no has registrado deudas."

## Historial Mensual (Monthly history)
- [x] Read-only archive of closed months, newest first
- [x] Detail view per archived month — now shows Sueldo / Ingresos
      adicionales / Ingresos totales as three separate rows (Session 9),
      sourced from the same `monthTotals()` the live summary uses
- [x] Archived months created before Session 9 (no stored `salary`
      snapshot) render safely with salary shown as $0 and an explicit
      caveat, rather than guessing at today's configured salary
- [x] Empty state: "Aún no hay meses cerrados."

## Ajustes (Settings)
- [x] Salary configuration — the single source of truth for the configured
      salary, used additively everywhere income totals are shown (Session 9)
- [x] "Iniciar nuevo mes" — month-close flow archives the freshest state,
      stamps the configured salary in effect into the snapshot
      (`archived.salary`, Session 9), and guards against double-close
      (`expectedMonth`, Session 8); confirm button reads "Confirmar"
- [x] Data reset (full wipe, with confirmation)
- [x] About / version info
- [x] Service-worker "update available" prompt (skip-waiting → reload)

## Platform / PWA
- [x] Installable PWA — `manifest.json`, full icon set
      (`apple-touch-icon.png` 180×180 + 152/192/512px), all root-absolute
      paths
- [x] **PWA install icon fixed (Session 10).** The generic placeholder "P"
      icon was replaced — all four PNGs are now generated directly from
      `PERITA_LOGO` (the real Perita logo, the same image used in the
      sidebar), a plain resize with no cropping/deformation/added rounding.
      The two conflicting `apple-touch-icon` `<link>` tags were collapsed
      into one (`sizes="180x180"`).
- [x] **Initial load screen (Session 11).** Fixes the black-screen-on-iPhone
      symptom: the CDN `<script>` tags (React/ReactDOM/Babel/Chart.js/
      `perita-core.js`) now use `defer` instead of blocking HTML parsing, so
      a static, JS-independent load screen (`#F86C98` background, centered
      logo, "Cargando Perita…", a discreet spinner, `prefers-reduced-motion`
      respected) is visible immediately. React's own mount
      (`createRoot().render()`) replaces it automatically — no artificial
      minimum duration. A small watchdog script shows an error message and
      a "Recargar" button if the app hasn't mounted within 15 seconds.
- [x] `service-worker.js` — cache-first app shell (now including all four
      icon files), offline fallback, compatible with the update-prompt
      flow. `CACHE_NAME` currently `perita-cache-v3`.
- [x] Responsive layout verified at desktop (≥1100px), tablet
      (701–1099px), and mobile (≤700px, down to 320px width) — the load
      screen was additionally verified at iPhone (390×844) and iPad
      (1024×768) viewport sizes
- [x] 79 automated regression tests covering all financial logic
      (`npm test`), zero external dependencies

## Not yet implemented
- [ ] Export/Import JSON (backup & restore)
- [ ] Per-account transaction history (which expenses came from which account)
- [ ] Debt projection chart edge case when all debts are paid
- [ ] Automatic migration/warning for a pre-existing, already-open month that
      has an old-style manually-logged "Sueldo" income transaction (from
      before Session 9's Income-form placeholder change) — would currently
      double-count against the additive salary rule; flagged as a known risk
      in `CHANGELOG.md`, not auto-detected/fixed
- [ ] Any further UI/forms/responsive polish beyond what's listed as done
      above has not been scoped or implemented this session — this list is
      not a claim that every screen's interface, form validation, or
      responsive behavior has been fully audited end-to-end; only the
      specific items marked `[x]` above have been verified

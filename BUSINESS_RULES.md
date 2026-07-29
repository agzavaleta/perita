# BUSINESS_RULES.md — Perita

Rules governing financial correctness and user-facing behavior. Several of
these were bugs discovered and fixed this session — each entry below notes
that where relevant, since the *reason* a rule exists is as important as the
rule itself for whoever continues this project.

---

## Monthly cycle

- **`activeMonth` is the canonical container for the current month's
  activity.** Income, variable expenses, savings contributions, debt
  payments, and paid-fixed-expense records all live there. Only `accounts`,
  `debts`, `wallets`, `budget`, `settings`, and `nextId` persist across a
  month close.
- **`expenses` (top-level) is a compatibility alias for
  `activeMonth.expenses`**, not a second source of truth. `IngresosPanel` and
  `ExpenseTracker` read/write the alias; `App.setState` re-syncs it into
  `activeMonth` on *every* transition (see `PeritaCore.syncExpensesAlias`).
  → **Bug fixed this session:** the alias sync previously only happened at
  `localStorage` serialization time, not in React state, so Dashboard, the
  month-close summary, and `closeMes()` all saw a stale `activeMonth` within
  the same session (values only updated after a reload). Now synced on every
  `setState` call — no reload required.
- **Closing a month must snapshot the freshest state, not a stale render
  value.** `closeMonth` computes its snapshot and next-month date from the
  `s` inside its own `setState` updater.
  → **Bug fixed this session:** the previous `closeMes` captured
  `activeMonth` and `curMonth` as component-scope variables at render time,
  which is unsafe under React 18 batching and could archive an outdated
  snapshot.
- **Deposits must always be recorded in the monthly cycle.**
  → **Bug fixed this session:** `Wallets.deposit` updated the wallet/account
  balance but never wrote to `activeMonth.aportesAhorro` — savings
  contributions were invisible to the month-close summary and Dashboard.

## Month-closing flow — confirmed rollover rules (Session 8)

Audited what happens to every category of data across a month close, against
this file and `DATA_MODEL.md`. No conflict was found between the
implementation and the documentation — the following was verified correct,
not changed, except where noted:

| Category | Rolls over into the new month? | Why |
|---|---|---|
| Income transactions (`activeMonth.expenses`, type `income`) | **No** — reset to `[]` | Transactional record of what happened *this* month; lives on permanently in the archived snapshot instead. |
| Variable expenses (`activeMonth.expenses`, type `expense`) | **No** — reset to `[]` | Same reasoning. |
| Debt payments (`activeMonth.pagosDeuda`) | **No** — reset to `[]` | This month's payment log resets; the debt's accumulated `paid` total (on the permanent `Debt` record) is untouched and keeps accumulating. |
| Savings deposits (`activeMonth.aportesAhorro`) | **No** — reset to `[]` | This month's deposit log resets; the wallet's accumulated `balance` (permanent) is untouched. |
| Fixed-expense paid status (`activeMonth.gastosFijosPagados`) | **No** — reset to `[]` | A new month's rent hasn't been paid yet; the fixed-expense *definitions* (`budget[]`: name/amount) are untouched and reused every month. |
| Accounts, their balances | **Yes** — untouched | Permanent entities; `closeMonth` never writes to `accounts`. |
| Debts (definitions + accumulated `paid`) | **Yes** — untouched | Permanent entities. |
| Savings wallets (definitions + accumulated `balance`) | **Yes** — untouched | Permanent entities. |
| `settings.salary` | **Yes** — the live setting is untouched by close | It's a permanent, single configured value, edited only in Configuración. **Session 9 update:** unlike the other rows in this table, closing a month now *also* stamps the salary in effect at that moment into the archived snapshot (`archived.salary`) — see "Salary model — confirmed additive rule" below. This is additive to the table's original point: `settings.salary` itself still isn't reset or altered by a close; a *copy* of its current value is captured into history alongside it. |
| `budget[]` (fixed-expense definitions) | **Yes** — untouched | Permanent; only the *paid-this-month* flag resets. |

**Session 9 update:** the paragraph above described the pre-Session-9 model,
where there was no dedicated salary concept at all — see "Salary model —
confirmed additive rule" below for the current rule. As of Session 9, the
month-close summary **does** show salary and additional income as two
separate rows ("Sueldo configurado" and "Ingresos adicionales"), because the
salary is no longer just a reference number folded into a generic income
transaction list — it is a distinct, centrally-configured value that the
summary reads directly from `settings.salary` (live month) or the archived
snapshot's `salary` field (closed month), never from the transaction list.

**Double-close guard (Session 8):** `closeMonth(state, closedAt, expectedMonth)`
takes an optional `expectedMonth` — the `'YYYY-MM'` the closing UI captured
when the confirmation summary was opened. If the state's `activeMonth.month`
no longer matches (because a prior, successful close already advanced it —
e.g. from a double-click queuing two submits), `closeMonth` returns the state
unchanged: no duplicate archive entry, no second calendar advance. Settings'
`closeMes` passes `curMonth` as `expectedMonth` and also disables the confirm
button for the duration of the close as a first line of defense. Omitting
`expectedMonth` preserves the exact old behavior (used by all pre-existing
call sites/tests).

**Month-close summary UI (Session 8):** the confirm button now reads
"Confirmar" (was "Cerrar mes e iniciar nuevo"). The pre-close disclaimer
previously said only "los ingresos y gastos variables ... se archivarán",
which underspecified what happens to debt payments, savings deposits, and
fixed-expense paid status — misleading, since all four monthly logs actually
reset on close, not just two. It now names all four monthly logs explicitly
and clarifies that only the current month's *log* resets — permanent
balances/definitions never do. The "Ingresos" row was relabeled "Ingresos
totales del mes" to make explicit that it's the total, not a partial figure.

## Debts

- **A debt's `paid` amount can never exceed its `total`.** Overpayment is
  clamped: `applied = min(amount, total - paid)`.
- **The logged payment amount must equal what was actually applied**, not
  what the user typed. If a user tries to pay more than the remaining
  balance, only the remaining balance is logged in `activeMonth.pagosDeuda`
  — never the requested (excess) amount.
  → **Bug fixed this session:** the previous code clamped `paid` but still
  logged the full requested payment amount, so a debt's payment history
  could show more than was actually collectible.
- **Paying an already-fully-paid debt is a no-op.** `registerDebtPayment`
  returns the same state reference unchanged if `status === 'pagada'` (or
  effectively so) — no phantom payment record is created.
- A debt's `status` becomes `'pagada'` exactly when `paid >= total`.

## Financial audit (Session 4) — calculations corrected

- **"Remaining"/"sobrante"/final monthly balance must deduct debt payments.**
  Debt payments are real cash leaving an account, exactly like a variable
  expense or a savings deposit, so they must reduce the money left over for
  the month.
  → **Bug fixed this session:** `PeritaCore.monthTotals().sobrante` and
  `PeritaCore.dashboardTotals().remaining` both omitted `deudas`/`monthlyDebt`
  entirely — a month with debt payments showed more "money left" than
  actually existed. Both formulas now subtract debt payments; they agree with
  each other whenever the month has recorded income (see `ARCHITECTURE.md`).
- **A given metric must be computed from exactly one function, reused
  everywhere it's shown.** Several views recomputed the same total with a
  parallel, slightly different (and non-canonical) formula instead of calling
  the shared `PeritaCore` function.
  → **Bugs fixed this session:**
  - `Budget`'s "Disponible" KPI used `settings.salary - totalBudget -
    totalSavings` — a static plan-vs-plan number using ALL fixed-expense
    definitions (not just what was actually paid this month) and each
    wallet's suggested `monthly` contribution (not actual deposits), with no
    deduction for variable expenses or debt payments at all. It now reads
    `PeritaCore.dashboardTotals(state).remaining` directly, so it always
    matches Dashboard's "Sobrante Mensual" — the two labels describe the same
    concept and must show the same number.
  - `HistorialMensual` (both the archived-month list and its detail view)
    re-derived `ingresos/variables/fijos/ahorros` with an inline `reduce()`
    duplicate of `PeritaCore.monthTotals`, and then computed `sobrante`
    locally with the same debt-omission bug described above. Replaced with a
    direct call to `PeritaCore.monthTotals(m)`, which already returns a
    correct `sobrante` — no duplicated logic, no separate bug surface.
- **Never attribute the live `settings.salary` to a past (already-closed)
  month.** *(Session 9 update: `HistorialMensual` now DOES show a salary
  figure for archived months — but it is the value stored in that month's
  own `archived.salary` snapshot, captured at close time, never today's live
  `settings.salary`. See "Salary model — confirmed additive rule" above.
  Pre-Session-9 archives with no stored snapshot show `$0` for salary rather
  than a guessed value, with an explicit caveat in the UI.)*

## Salary model — confirmed additive rule (Session 9, supersedes Session 5)

**This is a deliberate reversal of the Session 5 rule below "Historical note",
kept in this file for context.** The user explicitly re-examined the
salary-vs-income relationship and confirmed a different, additive model.
Session 5's conclusion ("salary is already representable as a normal income
transaction, never summed with `settings.salary`") is no longer the rule in
effect anywhere in the app.

**Confirmed rules, in effect as of Session 9:**

1. There is only one configured salary.
2. The salary is managed only from **Configuración** — never moved to the
   Income section.
3. Income transactions (`IngresosPanel` / `activeMonth.expenses` with
   `type:'income'`) represent **only additional income** — freelance work,
   bonuses, sales, gifts, etc.
4. The salary is **not** an income transaction. It has no entry in
   `expenses`; it is read exclusively from `settings.salary` (live month) or
   the archived snapshot's `salary` field (closed month).
5. **Monthly income = configured salary + additional income transactions**,
   always, computed by `PeritaCore.monthTotals(am, salary)`:
   `ingresos = resolvedSalary + additionalIncome`, where `additionalIncome`
   sums only `expenses.filter(e => e.type === 'income')`.
6. When a month is closed, `PeritaCore.closeMonth` stores the exact
   configured salary in effect at that moment into the archived snapshot
   (`archived.salary`) — see `DATA_MODEL.md`'s `ArchivedMonth` shape.
7. Changing `settings.salary` later never modifies an already-archived
   month — `monthTotals(archivedMonth)` (no second argument) resolves salary
   from `archivedMonth.salary`, not from the live `settings.salary`.
8. The current (active, unclosed) month always uses the *current* configured
   salary — every caller that computes totals for `activeMonth` passes
   `settings.salary` explicitly as `monthTotals`'s second argument, so a
   salary edit is reflected immediately, with no stale value.
9. Archived months always use their own stored salary snapshot, never the
   live setting.

**Implementation, one source of truth:**

- `monthTotals(am, salary)` resolves the salary to use with this priority:
  an explicit `salary` argument (used by the live month) → `am.salary` if the
  month object already carries one (an archived snapshot) → `0` (a
  pre-Session-9 archive with no stored salary at all — see "Backward
  compatibility" below). It returns `{salary, additionalIncome, ingresos,
  ...}` so every caller can display salary and additional income as separate
  figures without re-deriving either.
- `dashboardTotals(state)` calls `monthTotals(activeMonth, settings.salary)`
  explicitly — the Dashboard's `totalIncomeDash` (and therefore `remaining`
  and `incomeSrc`) always includes the configured salary, even with zero
  additional-income transactions logged. This is an intentional behavior
  change from the Session 5-8 rule: an empty month with a configured salary
  now shows real income and a positive `remaining`, not zero.
- `closeMonth(state, closedAt, expectedMonth)` stamps
  `salary: (state.settings.salary || 0)` into the snapshot at close time,
  alongside the existing `expectedMonth` double-close guard from Session 8.
- The Income page (`IngresosPanel`) placeholder text was changed from
  `"Sueldo, freelance…"` to `"Freelance, bono, venta…"` to stop suggesting
  salary belongs there. When `settings.salary > 0`, a read-only informational
  card shows the configured salary above the "Agregar ingreso" button,
  explicitly stating it's added automatically and should not also be logged
  as a transaction. The income list's total label was relabeled "Total
  ingresos adicionales" to make clear it excludes the salary.
- The month-close summary modal (`Settings`) and `HistorialMensual`'s
  archived-month detail view both now show three income-related rows —
  "Sueldo configurado" / "Sueldo", "Ingresos adicionales", "Ingresos
  totales" — sourced from the same `monthTotals` return value, so the two
  views can never disagree.

**Backward compatibility:** an archived month created before Session 9 has
no `salary` field at all. `monthTotals` resolves that to `0` rather than
guessing at today's `settings.salary` — attributing a value that was never
actually in effect for that historical month would misrepresent history.
`HistorialMensual`'s detail view shows an explicit caveat when
`detail.salary == null`, explaining that the archive predates the
salary-snapshot mechanism and that its "Sueldo" figure is $0 by necessity.
There is no attempt to retroactively backfill a guessed salary into old
archives.

**Known migration risk (not automatically handled):** a user who, under the
old rule, was in the habit of logging their salary as a regular income
transaction (encouraged by the old `"Sueldo, freelance…"` placeholder) may
still have such a transaction sitting in an *already-open, not-yet-closed*
month from before this change shipped. Under the new additive rule, that
transaction is now treated as additional income, so their total for that
month would double-count the salary (once via `settings.salary`, once via
the leftover transaction) until they manually delete it. This is flagged as
a remaining risk rather than auto-fixed, because there is no reliable way to
distinguish "an old habitual salary entry" from a legitimately-intended
additional-income transaction that happens to also be named "Sueldo".

### Historical note (Session 5, superseded above)
Session 5 concluded the opposite: that salary should never be summed
additively, and was meant to be logged as a normal income transaction with
`incomeSrc` falling back to `settings.salary` only when no income was logged
yet. That conclusion was explicitly and deliberately overturned in Session 9
per direct user instruction. The rule above is the one currently implemented
and tested; this note is kept only so future sessions understand why the
code and tests once looked different.

## Dashboard / monthly totals

- **`remaining` includes the configured salary as real, available money
  (Session 9 — supersedes the Session 7 note below).** `dashboardTotals()`
  calls `monthTotals(activeMonth, settings.salary)` and reuses its
  `sobrante` directly (`remaining = mt.sobrante`) — configured salary plus
  real recorded additional income, minus real recorded
  fixed/variable/savings/debt activity. On an empty month with a configured
  salary, `remaining` now equals the salary itself, not `0` — the salary is
  real money from the first day of the month, per the confirmed additive
  rule (see "Salary model — confirmed additive rule" above).
- **`incomeSrc` always equals `totalIncomeDash`.** Under the additive model
  there is no longer a "zero income logged" case to fall back from — the
  configured salary always contributes, so `incomeSrc` needs no separate
  fallback logic. `savingsRate = incomeSrc ? round(monthlySavings /
  incomeSrc * 100) : 0`.
- **All dashboard math must be finite on empty state.** No NaN or Infinity,
  ever — verified by dedicated zero-value edge-case tests. This still holds
  even with `settings.salary = 0` (a fresh install with no salary configured
  yet).
- `totalDebt` (shown on Dashboard) excludes debts with `status: 'pagada'`.
- **`Dashboard` has zero inline financial formulas.** Every value it renders
  comes from a single `PeritaCore.dashboardTotals(state)` call, including the
  new `salary`/`additionalIncome` fields for any UI that wants to show them
  broken out.
- **Page-level totals (`AccountsPage`, the Wallets/Ahorros page,
  `DebtTracker`) are centralized (Session 7).** They previously each
  recomputed their own total with a local `reduce()` that happened to match
  the Dashboard's formula — same result, but a second place that formula
  could silently drift. They now call `PeritaCore.totalAccountBalance(accounts)`,
  `PeritaCore.totalWalletBalance(wallets)`, and `PeritaCore.totalActiveDebt(debts)`
  respectively — the exact same helpers `dashboardTotals` uses internally for
  `totalAvailable`/`totalSavings`/`totalDebt`. One implementation of each
  formula, reused everywhere it's shown.

### Historical note (Sessions 6-7, superseded above)
Session 6 documented an "intentional divergence" where `remaining` fell back
to `settings.salary` on an empty month while `sobrante` stayed at `0`.
Session 7 removed that fallback from `remaining` entirely, on the rule then
in effect that salary must never be treated as available money until logged
as an income transaction. Session 9 overturned that underlying rule: salary
is now additive and always counted, so `remaining` (and `sobrante`) include
it directly again — but through the new, explicit `salary` parameter to
`monthTotals`, not a same-value fallback. The net effect looks similar to
the pre-Session-7 behavior for an empty month, but the mechanism is
different and no longer a "fallback" — it's the primary, always-applied
calculation.

## Empty states

- Every list-style screen (Cuentas, Ahorros, Ingresos, Gastos fijos, Gastos
  variables, Deudas, Historial mensual) must render a screen-specific message
  when the user has **no records at all**, e.g. *"Aún no has agregado
  ninguna cuenta."*
- Screens that support filtering (currently: **Ingresos** and **Gastos
  variables** — month + text search) must distinguish that from **records
  exist but the current filters matched none**, which always shows the
  generic pair: title **"Sin resultados"**, description **"No se encontraron
  elementos que coincidan con los filtros aplicados."**, with no
  call-to-action button (there's nothing meaningful to "add" in that case —
  the user's data already exists).
- This distinction is made by checking the *unfiltered* collection for that
  transaction type (`expenses.some(e => e.type === 'income' | 'expense')`)
  before applying the screen's filters — not by checking a separate "was a
  filter touched" flag. See `emptyStateProps()` in `Perita.jsx` and
  `UI_GUIDELINES.md`.
- Screens without filtering (Cuentas, Ahorros, Gastos fijos, Deudas,
  Historial mensual) only ever need the single "no records" message — there
  is no filtered-zero-results case to handle there.
- An `EmptyState` rendered as a direct child of a CSS grid (`.grid-2`,
  `.grid-3`, etc.) must span the full row (`grid-column: 1/-1`), not collapse
  into a single narrow column.
  → **Bug fixed this session:** `AccountsPage`'s empty state was a direct
  child of `.grid-3` and rendered at 1/3 width. Fixed via the `.empty-state`
  CSS class (previously defined but never actually attached to the
  component), rather than a per-screen fix — see `UI_GUIDELINES.md`.

## Currency & formatting

- All money values are formatted via `fmt(n)` — `Intl.NumberFormat('es-CL',
  {style:'currency', currency:'CLP', maximumFractionDigits:0})`. Never
  hand-format a currency string elsewhere.
- Dates are stored as `YYYY-MM-DD` strings; `today()` produces the current
  date in that format.

## Editing transactions

- Editing an income transaction that changes the amount and/or destination
  account must reconcile account balances correctly: reverse the *old*
  amount from the *old* account, then apply the *new* amount to the
  (possibly different) *new* account — never just overwrite in place, which
  would silently corrupt account balances.
- Editing a variable expense never touches account balances (variable
  expenses aren't tied to a specific account in this model).

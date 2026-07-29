# DATA_MODEL.md — Perita

Full entity shapes and the `perita-core.js` function reference. This is the
single source of truth for financial state — all shape/behavior questions
should be answered from here + `tests/perita-core.test.js` (79 tests exercise
every function below), not by reading `Perita.jsx`'s UI code.

---

## Entities

```ts
Account = {
  id: number,
  name: string,
  type: 'bank' | 'cash',
  balance: number,
}

Debt = {
  id: number,
  name: string,
  total: number,
  paid: number,              // never exceeds total (see registerDebtPayment)
  status: 'activa' | 'pagada',
}

Wallet = {                    // a savings goal
  id: number,
  name: string,
  balance: number,
  goal: number,
  monthly: number,            // suggested monthly contribution (UI hint only)
}

BudgetItem = {                 // a fixed-expense definition
  id: number,
  name: string,
  amount: number,
}

Expense = {                    // a monthly transaction — additional income OR
                                // variable expense. type:'income' here means
                                // ONLY additional income (freelance, bonus,
                                // sale, gift, etc.) — the configured salary is
                                // never represented as an Expense record; see
                                // settings.salary above and BUSINESS_RULES.md.
  id: number,
  type: 'income' | 'expense',
  date: 'YYYY-MM-DD',
  description: string,
  amount: number,
  account?: number,           // Account.id — only meaningful when type='income'
  category?: string,
  notes?: string,
}

DebtPayment       = { debtId: number, debtName: string, amount: number, date: string }
SavingsDeposit     = { walletId: number, walletName: string, amount: number, date: string }
PaidFixed          = { budgetId: number, name: string, amount: number, date: string }

ActiveMonth = {
  month: 'YYYY-MM',
  expenses: Expense[],
  pagosDeuda: DebtPayment[],
  aportesAhorro: SavingsDeposit[],
  gastosFijosPagados: PaidFixed[],
}

ArchivedMonth = ActiveMonth & {
  closedAt: string,           // ISO timestamp
  salary: number,             // (Session 9) the configured salary in effect
                               // at the moment this month was closed — stamped
                               // by closeMonth, never re-derived from the live
                               // settings.salary. Absent (undefined) on months
                               // archived before Session 9; monthTotals treats
                               // a missing salary as 0, never a guess.
}

State = {
  settings: { salary: number }, // the ONE configured salary, managed only from
                                 // Configuración — never an income transaction
                                 // (see BUSINESS_RULES.md "Salary model —
                                 // confirmed additive rule").
  accounts: Account[],
  debts: Debt[],
  wallets: Wallet[],
  budget: BudgetItem[],
  varCategories: [],           // reserved, unused
  nextId: number,
  activeMonth: ActiveMonth,
  monthlyHistory: ArchivedMonth[],
  expenses: Expense[],         // compatibility alias === activeMonth.expenses
}
```

---

## `perita-core.js` API

All functions are pure: `(state, ...args) => newState` (or a plain
calculation result). No React, no DOM, no `localStorage` access inside this
module — that's the entire point of extracting it (testable without a
browser, shared verbatim between the app and the test suite).

### State construction / persistence

| Function | Signature | Behavior |
|---|---|---|
| `makeDefault()` | `() => State` | Fresh state, all collections empty, `activeMonth.month` = current month |
| `withExpensesAlias(s)` | `(State) => State` | Sets `expenses` to point at `activeMonth.expenses` |
| `syncExpensesAlias(next)` | `(State) => State` | Re-points `activeMonth.expenses` at `expenses` if they've diverged. **This is the choke point** — called by `App.setState` on every single transition, so any writer that only touches the top-level `expenses` alias (income/expense add-edit-delete) stays in sync automatically. No-op (returns the same reference) if already in sync. |
| `resetToDefault()` | `() => State` | `withExpensesAlias(makeDefault())` — used by the "Reiniciar datos" button |
| `load(raw)` | `(string\|null) => State` | Parses `localStorage.getItem('perita_v1')`. Never throws — falls back to a fresh state on `null`, missing, or malformed JSON. Migrates legacy data with no `activeMonth` (folds old top-level `expenses` into a new `activeMonth`) and backfills any missing `activeMonth` sub-arrays. |
| `serialize(state)` | `(State) => string` | Produces the JSON string for `localStorage.setItem`. Keeps `activeMonth.expenses` synced from the alias at write time. |

### Monthly transactions (income + variable expenses)

| Function | Signature | Behavior |
|---|---|---|
| `addTransaction(state, txData)` | `txData: {date, description, amount, type, account?}` | Assigns `id = state.nextId`, prepends to `expenses`, increments `nextId`. If `type==='income'` and `account` is set, credits that account's balance. |
| `deleteTransaction(state, tx)` | `tx`: the full transaction object being removed | Removes by `id`. If it was an income tied to an account, debits that account's balance back. |
| `editTransaction(state, id, patch)` | `patch`: partial fields to merge | Merges `patch` into the existing transaction. Reconciles account balances if the transaction is (or was) an income: reverses the old amount from the old account, applies the new amount to the (possibly different) new account. |

### Savings

| Function | Signature | Behavior |
|---|---|---|
| `deposit(state, walletId, amount, fromAccountId, date)` | `fromAccountId` optional | Credits the wallet balance; if `fromAccountId` given, debits that account. Always appends a record to `activeMonth.aportesAhorro`. |

### Debts

| Function | Signature | Behavior |
|---|---|---|
| `registerDebtPayment(state, debtId, amount, date)` | — | **Clamps** the applied payment to `max(0, debt.total - debt.paid)` — overpayment is prevented, and the *actual applied amount* (not the requested amount) is what's both added to `debt.paid` and logged in `activeMonth.pagosDeuda`. Sets `status: 'pagada'` once `paid >= total`. Returns `state` unchanged (same reference) if the debt is already fully paid or `amount <= 0` — a genuine no-op. |

### Fixed expenses

| Function | Signature | Behavior |
|---|---|---|
| `toggleFijoPagado(state, budgetItem, date)` | — | Toggles: adds a `gastosFijosPagados` record if not already marked paid this month, removes it if it was. |

### Monthly close

| Function | Signature | Behavior |
|---|---|---|
| `closeMonth(state, closedAt?, expectedMonth?)` | — | Snapshots the **`state.activeMonth` passed in** (call this from inside a `setState` updater with the freshest `s`, never from a component-scope variable captured at render time — see `BUSINESS_RULES.md`). Pushes `{...activeMonth, salary: settings.salary \|\| 0, closedAt}` onto `monthlyHistory` — **(Session 9)** the configured salary in effect at close time is stamped into the snapshot, so a later salary change can never rewrite this month's history. Resets `activeMonth` to a fresh empty month (next calendar month) and resets the `expenses` alias in lockstep. Permanent entities (`accounts`, `debts`, `wallets`, `budget`, `settings`, `nextId`) are untouched (the *live* `settings.salary` isn't reset — only a copy of its current value is captured into the archive). `expectedMonth` (optional, `'YYYY-MM'`): if given and it no longer matches `state.activeMonth.month`, this is a no-op (same state reference returned) — the guard against a double-click/double-submit closing the same month twice. Omit it to get the exact prior behavior. |

### Calculations

| Function | Signature | Behavior |
|---|---|---|
| `monthTotals(am, salary?)` | `am`: an `ActiveMonth` or `ArchivedMonth`; `salary` (optional): the configured salary to apply | **(Session 9)** Returns `{salary, additionalIncome, ingresos, variables, fijos, ahorros, deudas, sobrante}`. `ingresos = resolvedSalary + additionalIncome`, where `additionalIncome` sums only `type:'income'` transactions (never the salary itself). Salary resolution order: the explicit `salary` argument (used for the live `activeMonth`, which has no salary of its own) → `am.salary` if present (an archived snapshot) → `0` (a pre-Session-9 archive with no stored salary). Used by the live month-close summary, `HistorialMensual`'s archived-month detail view, and `dashboardTotals` — one function, one set of totals, everywhere. |
| `dashboardTotals(state)` | — | Returns the full Dashboard KPI set: `totalAvailable, totalSavings, netWorth, totalDebt, totalIncomeDash, totalVariable, monthlySavings, totalFixed, monthlyDebt, incomeSrc, savingsRate, remaining, salary, additionalIncome`. Guaranteed finite (no NaN/Infinity) on empty/zero state. Calls `monthTotals(activeMonth, settings.salary)` explicitly, so `totalIncomeDash`/`remaining` always include the configured salary — even with zero additional-income transactions logged this month. `incomeSrc` is simply `totalIncomeDash` (no separate fallback needed under the additive rule). |
| `totalAccountBalance(accounts)` | `accounts: Account[]` | `Σ balance`. Used by `dashboardTotals` (`totalAvailable`) and directly by `AccountsPage`'s own total — one implementation. |
| `totalWalletBalance(wallets)` | `wallets: Wallet[]` | `Σ balance`. Used by `dashboardTotals` (`totalSavings`) and directly by the Wallets/Ahorros page's own total. |
| `totalActiveDebt(debts)` | `debts: Debt[]` | `Σ (total - paid)` for debts where `status !== 'pagada'`. Used by `dashboardTotals` (`totalDebt`) and directly by `DebtTracker`'s own total. |

---

## Invariants (enforced by the functions above, verified by tests)

1. `expenses` (top-level) and `activeMonth.expenses` always converge to the
   same array reference after any `App.setState` transition.
2. A debt's `paid` never exceeds its `total`; a logged `pagosDeuda` amount
   never exceeds what was actually applied.
3. `closeMonth` always produces an `activeMonth` with all four arrays empty,
   regardless of what was in it before.
4. `load()` never throws, regardless of input.
5. Permanent entities (accounts, debts, wallets, budget, settings) are never
   touched by monthly-transaction functions except where a balance
   side-effect is explicit and documented above (income deposits, savings
   deposits, debt payments).
6. **(Session 9)** The configured salary is never itself an `Expense`
   record. `closeMonth` always stamps the salary in effect at close time
   into `archived.salary`; changing `settings.salary` afterward never alters
   that or any other already-archived month's totals.

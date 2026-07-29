/* perita-core.js — Perita v1.0.0 — pure state-transition & calculation core
 *
 * No React, no DOM, no localStorage access. Every function here is pure:
 * (state, ...args) -> newState (or a plain calculation result).
 * Perita.jsx (browser) and the test suite (Node) both require this exact
 * module, so financial logic is never duplicated between app and tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PeritaCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const curMonthId = () => new Date().toISOString().slice(0, 7);

  // ── Default / fresh state ───────────────────────────────────────────────────
  function makeDefault() {
    return {
      settings: { salary: 0 },
      accounts: [],
      debts: [],
      wallets: [],
      budget: [],
      varCategories: [],
      nextId: 1,
      activeMonth: {
        month: curMonthId(),
        expenses: [],
        pagosDeuda: [],
        aportesAhorro: [],
        gastosFijosPagados: [],
      },
      monthlyHistory: [],
    };
  }

  // `expenses` (top-level) is a compatibility alias for activeMonth.expenses.
  // activeMonth.expenses is canonical; the alias is kept in sync everywhere.
  const withExpensesAlias = (s) => ({ ...s, expenses: s.activeMonth.expenses });

  // Call this on every state transition before committing it (mirrors what
  // App.setState does in the browser). Idempotent / safe to call repeatedly.
  function syncExpensesAlias(next) {
    if (next && next.activeMonth && next.expenses !== next.activeMonth.expenses) {
      return { ...next, activeMonth: { ...next.activeMonth, expenses: next.expenses } };
    }
    return next;
  }

  function resetToDefault() {
    return withExpensesAlias(makeDefault());
  }

  // ── Persistence ──────────────────────────────────────────────────────────
  // load(raw): raw is the string from localStorage.getItem('perita_v1'), or
  // null/undefined for a fresh install. Never throws.
  function load(raw) {
    const base = makeDefault();
    try {
      if (!raw) return withExpensesAlias(base);
      const saved = JSON.parse(raw);
      if (!saved.activeMonth) {
        saved.activeMonth = {
          month: curMonthId(),
          expenses: saved.expenses || [],
          pagosDeuda: [],
          aportesAhorro: [],
          gastosFijosPagados: [],
        };
        delete saved.expenses;
      }
      if (!saved.monthlyHistory) saved.monthlyHistory = [];
      if (!saved.activeMonth.pagosDeuda) saved.activeMonth.pagosDeuda = [];
      if (!saved.activeMonth.aportesAhorro) saved.activeMonth.aportesAhorro = [];
      if (!saved.activeMonth.gastosFijosPagados) saved.activeMonth.gastosFijosPagados = [];
      const state = { ...base, ...saved };
      state.expenses = state.activeMonth.expenses;
      return state;
    } catch (_) {
      return withExpensesAlias(base);
    }
  }

  // serialize(state): returns the JSON string to hand to localStorage.setItem.
  function serialize(state) {
    const toSave = { ...state };
    if (toSave.activeMonth) {
      toSave.activeMonth = { ...toSave.activeMonth, expenses: toSave.expenses || [] };
    }
    return JSON.stringify(toSave);
  }

  // ── Monthly transactions (income + variable expenses) ──────────────────────
  // txData: {date, description, amount, type:'income'|'expense', account?, ...}
  function addTransaction(state, txData) {
    const tx = { ...txData, id: state.nextId };
    let next = { ...state, expenses: [tx, ...(state.expenses || [])], nextId: state.nextId + 1 };
    if (tx.type === 'income' && tx.account) {
      next.accounts = (state.accounts || []).map((a) =>
        a.id === Number(tx.account) ? { ...a, balance: a.balance + tx.amount } : a
      );
    }
    return syncExpensesAlias(next);
  }

  function deleteTransaction(state, tx) {
    let next = { ...state, expenses: (state.expenses || []).filter((x) => x.id !== tx.id) };
    if (tx.type === 'income' && tx.account) {
      next.accounts = (state.accounts || []).map((a) =>
        a.id === Number(tx.account) ? { ...a, balance: a.balance - tx.amount } : a
      );
    }
    return syncExpensesAlias(next);
  }

  // patch: partial fields to merge into the existing transaction (date,
  // description, amount, account, ...). Reconciles account balances if the
  // transaction is (or was) an income tied to an account.
  function editTransaction(state, id, patch) {
    const old = (state.expenses || []).find((x) => x.id === id);
    if (!old) return state;
    const updated = { ...old, ...patch, id };
    let next = { ...state, expenses: (state.expenses || []).map((x) => (x.id === id ? updated : x)) };

    if (old.type === 'income' || updated.type === 'income') {
      let accounts = state.accounts || [];
      if (old.type === 'income' && old.account) {
        const oldAccId = Number(old.account);
        accounts = accounts.map((a) => (a.id === oldAccId ? { ...a, balance: a.balance - old.amount } : a));
      }
      if (updated.type === 'income' && updated.account) {
        const newAccId = Number(updated.account);
        accounts = accounts.map((a) => (a.id === newAccId ? { ...a, balance: a.balance + updated.amount } : a));
      }
      next.accounts = accounts;
    }
    return syncExpensesAlias(next);
  }

  // ── Savings ──────────────────────────────────────────────────────────────
  function deposit(state, walletId, amount, fromAccountId, date) {
    const wallet = (state.wallets || []).find((w) => w.id === walletId);
    let next = {
      ...state,
      wallets: (state.wallets || []).map((w) => (w.id === walletId ? { ...w, balance: w.balance + amount } : w)),
    };
    if (fromAccountId) {
      next.accounts = (state.accounts || []).map((a) =>
        a.id === Number(fromAccountId) ? { ...a, balance: a.balance - amount } : a
      );
    }
    const am = state.activeMonth || {};
    next.activeMonth = {
      ...am,
      aportesAhorro: [
        ...(am.aportesAhorro || []),
        { walletId, walletName: wallet ? wallet.name : '', amount, date: date || curMonthId() + '-01' },
      ],
    };
    return next;
  }

  // ── Debts ────────────────────────────────────────────────────────────────
  // Clamps the applied payment to the remaining balance (overpayment prevented).
  // Returns state unchanged if the debt is already fully paid or amount <= 0.
  function registerDebtPayment(state, debtId, amount, date) {
    const debts = state.debts || [];
    const debt = debts.find((d) => d.id === debtId);
    if (!debt || amount <= 0) return state;
    const remaining = Math.max(0, debt.total - debt.paid);
    const applied = Math.min(remaining, amount);
    if (applied <= 0) return state;
    const newPaid = debt.paid + applied;
    const next = {
      ...state,
      debts: debts.map((d) =>
        d.id === debtId ? { ...d, paid: newPaid, status: newPaid >= d.total ? 'pagada' : d.status } : d
      ),
    };
    const am = state.activeMonth || {};
    next.activeMonth = {
      ...am,
      pagosDeuda: [
        ...(am.pagosDeuda || []),
        { debtId, debtName: debt.name, amount: applied, date: date || curMonthId() + '-01' },
      ],
    };
    return next;
  }

  // ── Fixed expenses ───────────────────────────────────────────────────────
  // Toggles the paid status of a budget (fixed expense) item for the current month.
  function toggleFijoPagado(state, budgetItem, date) {
    const am = state.activeMonth || {};
    const pagados = am.gastosFijosPagados || [];
    const already = pagados.some((g) => g.budgetId === budgetItem.id);
    const nextPagados = already
      ? pagados.filter((g) => g.budgetId !== budgetItem.id)
      : [...pagados, { budgetId: budgetItem.id, name: budgetItem.name, amount: budgetItem.amount, date: date || curMonthId() + '-01' }];
    return { ...state, activeMonth: { ...am, gastosFijosPagados: nextPagados } };
  }

  // ── Monthly close ────────────────────────────────────────────────────────
  // Snapshots the CURRENT activeMonth (whatever is passed in — call this with
  // the freshest state, e.g. inside a setState updater) and resets both the
  // canonical activeMonth and the compatibility alias. Permanent entities
  // (accounts, debts, wallets, budget, settings, nextId) are untouched.
  //
  // expectedMonth (optional): the 'YYYY-MM' the caller intended to close,
  // captured when the close-confirmation UI was opened. If the state's
  // activeMonth has already moved on (e.g. a second click/submit fired after
  // the first one already closed it), this is a safe no-op — same reference
  // returned, no duplicate archive entry, no second calendar advance. This is
  // the guard against double-close from a double-click or a repeated confirm.
  function closeMonth(state, closedAt, expectedMonth) {
    const am = state.activeMonth || makeDefault().activeMonth;
    if (expectedMonth != null && am.month !== expectedMonth) return state;
    // Store the exact configured salary used for this month in the snapshot
    // itself (Session 9) — archived months must never re-read the LIVE
    // settings.salary, or editing salary later would silently rewrite history.
    const salaryAtClose = (state.settings && state.settings.salary) || 0;
    const snapshot = { ...am, salary: salaryAtClose, closedAt: closedAt || new Date().toISOString() };
    const nextMonthDate = new Date(am.month + '-01');
    nextMonthDate.setMonth(nextMonthDate.getMonth() + 1);
    const nextMonth = nextMonthDate.toISOString().slice(0, 7);
    return {
      ...state,
      activeMonth: { month: nextMonth, expenses: [], pagosDeuda: [], aportesAhorro: [], gastosFijosPagados: [] },
      expenses: [],
      monthlyHistory: [...(state.monthlyHistory || []), snapshot],
    };
  }

  // ── Calculations ─────────────────────────────────────────────────────────
  // Totals for a single month object (activeMonth or an archived monthlyHistory
  // entry). `salary` (Session 9): the configured salary that applies to this
  // month — ALWAYS added into `ingresos` exactly once, per the confirmed rule
  // "Total income = configured salary + additional income" (income
  // transactions represent additional income only, never the salary itself).
  //
  // Resolution order: an explicit `salary` argument wins (the live/active
  // month has no stored salary of its own — the caller passes the CURRENT
  // settings.salary); otherwise `am.salary` is used if present (an archived
  // month's stored snapshot — see closeMonth); otherwise `0` (a pre-Session-9
  // archived month with no snapshot — see BUSINESS_RULES.md for why this is
  // the safe backward-compatible fallback, not a guess from today's salary).
  function monthTotals(am, salary) {
    am = am || {};
    const resolvedSalary = salary != null ? salary : (am.salary != null ? am.salary : 0);
    const expenses = am.expenses || [];
    const additionalIncome = expenses.filter((e) => e.type === 'income').reduce((a, e) => a + e.amount, 0);
    const ingresos = resolvedSalary + additionalIncome;
    const variables = expenses.filter((e) => e.type === 'expense').reduce((a, e) => a + e.amount, 0);
    const fijos = (am.gastosFijosPagados || []).reduce((a, g) => a + g.amount, 0);
    const ahorros = (am.aportesAhorro || []).reduce((a, x) => a + x.amount, 0);
    const deudas = (am.pagosDeuda || []).reduce((a, p) => a + p.amount, 0);
    const sobrante = ingresos - fijos - variables - ahorros - deudas;
    return { salary: resolvedSalary, additionalIncome, ingresos, variables, fijos, ahorros, deudas, sobrante };
  }

  // Page-level totals — single source of truth for AccountsPage, the
  // Wallets/Ahorros page, DebtTracker, and dashboardTotals below. Pure,
  // framework-free, so any screen (or test) can call them directly instead
  // of re-deriving the same reduce().
  function totalAccountBalance(accounts) {
    return (accounts || []).reduce((a, x) => a + x.balance, 0);
  }
  function totalWalletBalance(wallets) {
    return (wallets || []).reduce((a, w) => a + w.balance, 0);
  }
  function totalActiveDebt(debts) {
    return (debts || []).filter((d) => d.status !== 'pagada').reduce((a, d) => a + (d.total - d.paid), 0);
  }

  // Full dashboard calculation. Safe on zero/empty state (no NaN/Infinity).
  function dashboardTotals(state) {
    const settings = state.settings || { salary: 0 };
    const accs = state.accounts || [];
    const wallets = state.wallets || [];
    const debts = state.debts || [];
    const am = state.activeMonth || {};

    const totalAvailable = totalAccountBalance(accs);
    const totalSavings = totalWalletBalance(wallets);
    const netWorth = totalAvailable + totalSavings;
    const totalDebt = totalActiveDebt(debts);

    // The live/active month always uses the CURRENT configured salary
    // (confirmed rule) — passed explicitly, never read from am.salary (the
    // active month has no stored snapshot of its own; only archived months do).
    const mt = monthTotals(am, settings.salary || 0);
    const salary = mt.salary;
    const additionalIncome = mt.additionalIncome;
    const totalIncomeDash = mt.ingresos; // salary + additionalIncome, always
    const totalVariable = mt.variables;
    const monthlySavings = mt.ahorros;
    const totalFixed = mt.fijos;
    const monthlyDebt = mt.deudas;

    // incomeSrc: kept for API compatibility as the savingsRate denominator.
    // Under the additive model totalIncomeDash always includes the configured
    // salary, so there's no more "no income logged yet" case to fall back
    // from — incomeSrc is simply totalIncomeDash.
    const incomeSrc = totalIncomeDash;
    const savingsRate = incomeSrc ? Math.round((monthlySavings / incomeSrc) * 100) : 0;
    // remaining: real money left this month. Reuses monthTotals' own
    // sobrante directly (same terms) so it can never drift from the
    // section-total/month-close/archive calculation.
    const remaining = mt.sobrante;

    return {
      totalAvailable,
      totalSavings,
      netWorth,
      totalDebt,
      totalIncomeDash,
      totalVariable,
      monthlySavings,
      totalFixed,
      monthlyDebt,
      incomeSrc,
      savingsRate,
      remaining,
      salary,
      additionalIncome,
    };
  }

  return {
    makeDefault,
    withExpensesAlias,
    syncExpensesAlias,
    resetToDefault,
    load,
    serialize,
    addTransaction,
    deleteTransaction,
    editTransaction,
    deposit,
    registerDebtPayment,
    toggleFijoPagado,
    closeMonth,
    monthTotals,
    dashboardTotals,
    totalAccountBalance,
    totalWalletBalance,
    totalActiveDebt,
  };
});

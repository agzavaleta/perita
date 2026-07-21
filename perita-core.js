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
  function closeMonth(state, closedAt) {
    const am = state.activeMonth || makeDefault().activeMonth;
    const snapshot = { ...am, closedAt: closedAt || new Date().toISOString() };
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
  // Totals for a single month object (activeMonth or an archived monthlyHistory entry).
  function monthTotals(am) {
    am = am || {};
    const expenses = am.expenses || [];
    const ingresos = expenses.filter((e) => e.type === 'income').reduce((a, e) => a + e.amount, 0);
    const variables = expenses.filter((e) => e.type === 'expense').reduce((a, e) => a + e.amount, 0);
    const fijos = (am.gastosFijosPagados || []).reduce((a, g) => a + g.amount, 0);
    const ahorros = (am.aportesAhorro || []).reduce((a, x) => a + x.amount, 0);
    const deudas = (am.pagosDeuda || []).reduce((a, p) => a + p.amount, 0);
    const sobrante = ingresos - fijos - variables - ahorros;
    return { ingresos, variables, fijos, ahorros, deudas, sobrante };
  }

  // Full dashboard calculation. Safe on zero/empty state (no NaN/Infinity).
  function dashboardTotals(state) {
    const settings = state.settings || { salary: 0 };
    const accs = state.accounts || [];
    const wallets = state.wallets || [];
    const debts = state.debts || [];
    const am = state.activeMonth || {};

    const totalAvailable = accs.reduce((a, x) => a + x.balance, 0);
    const totalSavings = wallets.reduce((a, w) => a + w.balance, 0);
    const netWorth = totalAvailable + totalSavings;
    const totalDebt = debts.filter((d) => d.status !== 'pagada').reduce((a, d) => a + (d.total - d.paid), 0);

    const mt = monthTotals(am);
    const totalIncomeDash = mt.ingresos;
    const totalVariable = mt.variables;
    const monthlySavings = mt.ahorros;
    const totalFixed = mt.fijos;
    const monthlyDebt = mt.deudas;

    const incomeSrc = totalIncomeDash > 0 ? totalIncomeDash : settings.salary || 0;
    const savingsRate = incomeSrc ? Math.round((monthlySavings / incomeSrc) * 100) : 0;
    const remaining = incomeSrc - totalFixed - monthlySavings - totalVariable;

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
  };
});

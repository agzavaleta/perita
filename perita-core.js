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

  // Calendar dates shown/recorded by the app follow the user's local calendar,
  // not UTC. Using toISOString() here can move late-evening users into the next
  // day or month in negative UTC offsets.
  function localDateId(date) {
    const d = date || new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function curMonthId() {
    return localDateId().slice(0, 7);
  }

  // Month IDs are calendar identifiers, not instants in time. Advance them
  // arithmetically so no UTC/local-time conversion can change the result.
  function nextMonthId(monthId) {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(monthId || '');
    if (!match) throw new RangeError(`Invalid month id: ${monthId}`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    return month === 12
      ? `${year + 1}-01`
      : `${year}-${String(month + 1).padStart(2, '0')}`;
  }

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
    const nextMonth = nextMonthId(am.month);
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

  // ── V1.1.0 account-ledger foundation (not integrated with the app yet) ─────
  //
  // This is an intentionally separate, empty-start schema. The current
  // perita_v1 state, persistence helpers, UI writers, and dashboard calculations
  // above continue to use the existing model until a later integration step.
  const V110_SCHEMA_VERSION = '1.1.0';
  const V110_MOVEMENT_TYPES = {
    CREDIT: 'credit',
    DEBIT: 'debit',
    ADJUSTMENT: 'adjustment',
  };

  function makeV110ActiveMonth(month, salary) {
    return {
      month,
      salary,
      expenses: [],
      pagosDeuda: [],
      aportesAhorro: [],
      gastosFijosPagados: [],
    };
  }

  function makeV110Default() {
    const referenceSalary = 0;
    return {
      schemaVersion: V110_SCHEMA_VERSION,
      settings: { salary: referenceSalary },
      accounts: [],
      accountMovements: [],
      debts: [],
      wallets: [],
      budget: [],
      varCategories: [],
      nextId: 1,
      nextMovementId: 1,
      activeMonth: makeV110ActiveMonth(curMonthId(), referenceSalary),
      monthlyHistory: [],
    };
  }

  function v110PositiveIntegerOrThrow(value, field) {
    if (!Number.isInteger(value) || value < 1) {
      throw v110ValidationError('INVALID_ID', `${field} must be a positive integer: ${value}`);
    }
    return value;
  }

  function v110ValidationError(code, message) {
    const error = new Error(message);
    error.name = 'V110ValidationError';
    error.code = code;
    return error;
  }

  function isValidV110Date(date) {
    if (typeof date !== 'string') return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1 || month < 1 || month > 12 || day < 1) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= daysInMonth[month - 1];
  }

  function v110AccountOrThrow(state, accountId) {
    const account = (state.accounts || []).find((a) => a.id === accountId);
    if (!account) {
      throw v110ValidationError('ACCOUNT_NOT_FOUND', `Account not found: ${accountId}`);
    }
    return account;
  }

  function v110OperationRefOrThrow(operationRef) {
    if (typeof operationRef !== 'string' || !operationRef.trim()) {
      throw v110ValidationError('INVALID_OPERATION_REF', 'Operation reference must be a non-empty string');
    }
    return operationRef.trim();
  }

  function v110DateOrThrow(date) {
    if (!isValidV110Date(date)) {
      throw v110ValidationError('INVALID_DATE', `Invalid local calendar date: ${date}`);
    }
    return date;
  }

  function v110PositiveAmountOrThrow(amount) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw v110ValidationError('INVALID_AMOUNT', `Amount must be finite and greater than zero: ${amount}`);
    }
    return amount;
  }

  function v110MovementAmountOrThrow(amount, type) {
    if (!Number.isFinite(amount)
      || (type === V110_MOVEMENT_TYPES.ADJUSTMENT ? amount === 0 : amount <= 0)) {
      throw v110ValidationError('INVALID_AMOUNT', `Invalid amount for ${type}: ${amount}`);
    }
    return amount;
  }

  function v110AssertUniqueOperationRef(state, operationRef) {
    if ((state.accountMovements || []).some((movement) => movement.operationRef === operationRef)) {
      throw v110ValidationError('DUPLICATE_OPERATION_REF', `Duplicate operation reference: ${operationRef}`);
    }
  }

  function v110Own(source, key) {
    return Object.prototype.hasOwnProperty.call(source, key);
  }

  function v110ArrayOrDefault(source, key) {
    if (!v110Own(source, key)) return [];
    if (!Array.isArray(source[key])) {
      throw v110ValidationError('INVALID_COLLECTION', `${key} must be an array`);
    }
    return source[key];
  }

  function v110ObjectOrDefault(source, key, fallback) {
    if (!v110Own(source, key)) return fallback;
    const value = source[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw v110ValidationError('INVALID_OBJECT', `${key} must be an object`);
    }
    return value;
  }

  function v110StringOrDefault(source, key, fallback) {
    if (!v110Own(source, key)) return fallback;
    if (typeof source[key] !== 'string') {
      throw v110ValidationError('INVALID_FIELD', `${key} must be a string`);
    }
    return source[key];
  }

  function v110FiniteOrDefault(source, key, fallback, minimum) {
    const value = v110Own(source, key) ? source[key] : fallback;
    if (!Number.isFinite(value) || (minimum != null && value < minimum)) {
      throw v110ValidationError('INVALID_AMOUNT', `Invalid ${key}: ${value}`);
    }
    return value;
  }

  function v110MonthOrThrow(month) {
    if (typeof month !== 'string' || !/^(\d{4})-(0[1-9]|1[0-2])$/.test(month)) {
      throw v110ValidationError('INVALID_MONTH', `Invalid month id: ${month}`);
    }
    return month;
  }

  function normalizeV110State(saved) {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)
      || saved.schemaVersion !== V110_SCHEMA_VERSION) {
      throw v110ValidationError('INVALID_SCHEMA', `Expected schema version ${V110_SCHEMA_VERSION}`);
    }
    if (v110Own(saved, 'expenses') || v110Own(saved, 'nextAccountId')) {
      throw v110ValidationError(
        'CONFLICTING_FIELD',
        'V1.1.0 uses activeMonth.expenses and one global nextId counter'
      );
    }

    const globalIds = new Set();
    let highestGlobalId = 0;
    const registerGlobalId = (value, field) => {
      const id = v110PositiveIntegerOrThrow(value, field);
      if (globalIds.has(id)) {
        throw v110ValidationError('DUPLICATE_ID', `Duplicate global id: ${id}`);
      }
      globalIds.add(id);
      highestGlobalId = Math.max(highestGlobalId, id);
      return id;
    };
    const accountIds = new Set();
    const accounts = v110ArrayOrDefault(saved, 'accounts').map((source) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw v110ValidationError('INVALID_ACCOUNT', 'Each account must be an object');
      }
      if (v110Own(source, 'balance')) {
        throw v110ValidationError(
          'STORED_ACCOUNT_BALANCE',
          'V1.1.0 account balances must be derived from initialBalance and movements'
        );
      }
      const id = registerGlobalId(source.id, 'Account id');
      accountIds.add(id);
      const type = v110StringOrDefault(source, 'type', 'bank');
      if (type !== 'bank' && type !== 'cash') {
        throw v110ValidationError('INVALID_ACCOUNT_TYPE', `Invalid account type: ${type}`);
      }
      const active = v110Own(source, 'active') ? source.active : true;
      if (typeof active !== 'boolean') {
        throw v110ValidationError('INVALID_FIELD', 'active must be a boolean');
      }
      return {
        id,
        name: v110StringOrDefault(source, 'name', ''),
        type,
        bank: v110StringOrDefault(source, 'bank', ''),
        initialBalance: v110FiniteOrDefault(source, 'initialBalance', 0),
        active,
      };
    });

    const normalizeEntityCollection = (key, normalize) => v110ArrayOrDefault(saved, key).map((source) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw v110ValidationError('INVALID_ENTITY', `Each ${key} entry must be an object`);
      }
      const id = registerGlobalId(source.id, `${key} id`);
      return normalize(source, id);
    });
    const debts = normalizeEntityCollection('debts', (source, id) => {
      const total = v110FiniteOrDefault(source, 'total', 0, 0);
      const paid = v110FiniteOrDefault(source, 'paid', 0, 0);
      if (paid > total) {
        throw v110ValidationError('INVALID_DEBT', `Debt paid amount exceeds total: ${id}`);
      }
      const status = v110StringOrDefault(source, 'status', 'activa');
      if (!['activa', 'pausada', 'pagada'].includes(status)) {
        throw v110ValidationError('INVALID_DEBT_STATUS', `Invalid debt status: ${status}`);
      }
      const dueDate = v110StringOrDefault(source, 'dueDate', localDateId());
      v110DateOrThrow(dueDate);
      return {
        id,
        name: v110StringOrDefault(source, 'name', ''),
        total,
        paid,
        monthly: v110FiniteOrDefault(source, 'monthly', 0, 0),
        dueDate,
        status,
      };
    });
    const wallets = normalizeEntityCollection('wallets', (source, id) => ({
      id,
      emoji: v110StringOrDefault(source, 'emoji', '💰'),
      name: v110StringOrDefault(source, 'name', ''),
      bank: v110StringOrDefault(source, 'bank', ''),
      balance: v110FiniteOrDefault(source, 'balance', 0, 0),
      monthly: v110FiniteOrDefault(source, 'monthly', 0, 0),
      goal: v110FiniteOrDefault(source, 'goal', 0, 0),
    }));
    const budget = normalizeEntityCollection('budget', (source, id) => ({
      id,
      name: v110StringOrDefault(source, 'name', ''),
      amount: v110FiniteOrDefault(source, 'amount', 0, 0),
    }));
    const varCategories = normalizeEntityCollection('varCategories', (source, id) => ({
      id,
      name: v110StringOrDefault(source, 'name', ''),
    }));

    const settingsSource = v110ObjectOrDefault(saved, 'settings', {});
    const settings = {
      salary: v110FiniteOrDefault(settingsSource, 'salary', 0, 0),
    };

    const movementIds = new Set();
    const operationRefs = new Set();
    const accountMovements = v110ArrayOrDefault(saved, 'accountMovements').map((source) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw v110ValidationError('INVALID_MOVEMENT', 'Each account movement must be an object');
      }
      const id = v110PositiveIntegerOrThrow(source.id, 'Movement id');
      if (movementIds.has(id)) {
        throw v110ValidationError('DUPLICATE_MOVEMENT_ID', `Duplicate movement id: ${id}`);
      }
      movementIds.add(id);
      const accountId = v110PositiveIntegerOrThrow(source.accountId, 'Movement account id');
      if (!accountIds.has(accountId)) {
        throw v110ValidationError('ACCOUNT_NOT_FOUND', `Account not found: ${accountId}`);
      }
      const date = v110DateOrThrow(source.date);
      const type = source.type;
      if (!Object.values(V110_MOVEMENT_TYPES).includes(type)) {
        throw v110ValidationError('INVALID_MOVEMENT_TYPE', `Invalid movement type: ${type}`);
      }
      const amount = v110MovementAmountOrThrow(source.amount, type);
      const operationRef = v110OperationRefOrThrow(source.operationRef);
      if (operationRefs.has(operationRef)) {
        throw v110ValidationError('DUPLICATE_OPERATION_REF', `Duplicate operation reference: ${operationRef}`);
      }
      operationRefs.add(operationRef);
      return { id, accountId, date, amount, type, operationRef };
    });

    const normalizeMonthlyState = (source, archived) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw v110ValidationError('INVALID_MONTH', 'Monthly state must be an object');
      }
      const month = v110MonthOrThrow(v110StringOrDefault(source, 'month', curMonthId()));
      const normalizeMonthlyCollection = (key, normalize) => v110ArrayOrDefault(source, key).map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw v110ValidationError('INVALID_MONTHLY_ENTRY', `Each ${key} entry must be an object`);
        }
        const id = registerGlobalId(entry.id, `${key} id`);
        const date = v110DateOrThrow(entry.date);
        const amount = v110PositiveAmountOrThrow(entry.amount);
        return normalize(entry, { id, date, amount });
      });
      const expenses = normalizeMonthlyCollection('expenses', (entry, common) => {
        if (v110Own(entry, 'account')) {
          throw v110ValidationError(
            'CONFLICTING_FIELD',
            'V1.1.0 transactions use the numeric accountId field'
          );
        }
        const type = v110StringOrDefault(entry, 'type', '');
        if (type !== 'income' && type !== 'expense') {
          throw v110ValidationError('INVALID_TRANSACTION_TYPE', `Invalid transaction type: ${type}`);
        }
        const accountId = v110PositiveIntegerOrThrow(entry.accountId, 'Transaction account id');
        if (!accountIds.has(accountId)) {
          throw v110ValidationError('ACCOUNT_NOT_FOUND', `Account not found: ${accountId}`);
        }
        return {
          ...common,
          description: v110StringOrDefault(entry, 'description', ''),
          type,
          accountId,
          category: v110StringOrDefault(entry, 'category', type === 'income' ? 'Ingreso' : ''),
          method: v110StringOrDefault(entry, 'method', ''),
          notes: v110StringOrDefault(entry, 'notes', ''),
        };
      });
      // Pending V1.1.0 integration: formalize and validate the deterministic
      // transaction:<id> relationship against accountMovements. Persistence
      // currently validates both sides independently without inventing it.
      const normalizeAccountOutflow = (entry, common, relationKey, nameKey) => {
        const accountId = v110PositiveIntegerOrThrow(entry.accountId, `${relationKey} account id`);
        if (!accountIds.has(accountId)) {
          throw v110ValidationError('ACCOUNT_NOT_FOUND', `Account not found: ${accountId}`);
        }
        return {
          ...common,
          [relationKey]: v110PositiveIntegerOrThrow(entry[relationKey], relationKey),
          [nameKey]: v110StringOrDefault(entry, nameKey, ''),
          accountId,
        };
      };
      const pagosDeuda = normalizeMonthlyCollection(
        'pagosDeuda',
        (entry, common) => normalizeAccountOutflow(entry, common, 'debtId', 'debtName')
      );
      const aportesAhorro = normalizeMonthlyCollection(
        'aportesAhorro',
        (entry, common) => normalizeAccountOutflow(entry, common, 'walletId', 'walletName')
      );
      const gastosFijosPagados = normalizeMonthlyCollection(
        'gastosFijosPagados',
        (entry, common) => normalizeAccountOutflow(entry, common, 'budgetId', 'name')
      );
      const salary = v110FiniteOrDefault(
        source,
        'salary',
        archived ? 0 : settings.salary,
        0
      );
      const normalized = {
        month,
        salary,
        expenses,
        pagosDeuda,
        aportesAhorro,
        gastosFijosPagados,
      };
      if (archived) {
        const closedAt = v110StringOrDefault(source, 'closedAt', '');
        if (closedAt && !Number.isFinite(Date.parse(closedAt))) {
          throw v110ValidationError('INVALID_DATE', `Invalid close timestamp: ${closedAt}`);
        }
        normalized.closedAt = closedAt;
      }
      return normalized;
    };

    const activeMonthSource = v110ObjectOrDefault(
      saved,
      'activeMonth',
      { month: curMonthId() }
    );
    const activeMonth = normalizeMonthlyState(activeMonthSource, false);
    const historyMonths = new Set();
    const monthlyHistory = v110ArrayOrDefault(saved, 'monthlyHistory').map((source) => {
      const monthState = normalizeMonthlyState(source, true);
      if (monthState.month === activeMonth.month || historyMonths.has(monthState.month)) {
        throw v110ValidationError('DUPLICATE_MONTH', `Duplicate month: ${monthState.month}`);
      }
      historyMonths.add(monthState.month);
      return monthState;
    });

    const nextId = Math.max(
      Number.isInteger(saved.nextId) && saved.nextId > 0 ? saved.nextId : 1,
      highestGlobalId + 1
    );
    const nextMovementId = Math.max(
      Number.isInteger(saved.nextMovementId) && saved.nextMovementId > 0 ? saved.nextMovementId : 1,
      ...accountMovements.map((movement) => movement.id + 1)
    );
    return {
      schemaVersion: V110_SCHEMA_VERSION,
      settings,
      accounts,
      accountMovements,
      debts,
      wallets,
      budget,
      varCategories,
      nextId,
      nextMovementId,
      activeMonth,
      monthlyHistory,
    };
  }

  // Isolated V1.1.0 persistence. It intentionally does not read, migrate, or
  // alter the current perita_v1 state used by the application.
  function loadV110(raw) {
    if (!raw) return makeV110Default();
    try {
      return normalizeV110State(JSON.parse(raw));
    } catch (_) {
      return makeV110Default();
    }
  }

  function serializeV110(state) {
    return JSON.stringify(normalizeV110State(state));
  }

  function setV110ActiveMonthSalary(state, salary) {
    if (!Number.isFinite(salary) || salary < 0) {
      throw v110ValidationError('INVALID_AMOUNT', `Invalid active-month salary: ${salary}`);
    }
    return {
      ...state,
      activeMonth: {
        ...state.activeMonth,
        salary,
      },
    };
  }

  function closeV110Month(state, closedAt, expectedMonth) {
    const activeMonth = state && state.activeMonth;
    if (!activeMonth) {
      throw v110ValidationError('INVALID_MONTH', 'Active month is required');
    }
    if (expectedMonth != null && activeMonth.month !== expectedMonth) return state;
    const month = v110MonthOrThrow(activeMonth.month);
    const salary = activeMonth.salary;
    if (!Number.isFinite(salary) || salary < 0) {
      throw v110ValidationError('INVALID_AMOUNT', `Invalid active-month salary: ${salary}`);
    }
    const referenceSalary = state.settings && state.settings.salary;
    if (!Number.isFinite(referenceSalary) || referenceSalary < 0) {
      throw v110ValidationError('INVALID_AMOUNT', `Invalid reference salary: ${referenceSalary}`);
    }
    if (typeof closedAt !== 'string' || !closedAt || !Number.isFinite(Date.parse(closedAt))) {
      throw v110ValidationError('INVALID_DATE', `Invalid close timestamp: ${closedAt}`);
    }
    const copyEntries = (entries) => (entries || []).map((entry) => ({ ...entry }));
    const snapshot = {
      month,
      salary,
      expenses: copyEntries(activeMonth.expenses),
      pagosDeuda: copyEntries(activeMonth.pagosDeuda),
      aportesAhorro: copyEntries(activeMonth.aportesAhorro),
      gastosFijosPagados: copyEntries(activeMonth.gastosFijosPagados),
      closedAt,
    };
    return {
      ...state,
      activeMonth: makeV110ActiveMonth(nextMonthId(month), referenceSalary),
      monthlyHistory: [...(state.monthlyHistory || []), snapshot],
    };
  }

  function addV110Account(state, accountData) {
    const initialBalance = accountData && accountData.initialBalance != null
      ? accountData.initialBalance
      : 0;
    if (!Number.isFinite(initialBalance)) {
      throw v110ValidationError('INVALID_AMOUNT', `Initial balance must be finite: ${initialBalance}`);
    }
    const id = state.nextId;
    const account = {
      id,
      name: (accountData && accountData.name) || '',
      type: (accountData && accountData.type) || 'bank',
      bank: (accountData && accountData.bank) || '',
      initialBalance,
      active: !accountData || accountData.active !== false,
    };
    return {
      ...state,
      accounts: [...(state.accounts || []), account],
      nextId: id + 1,
    };
  }

  function v110MovementDelta(movement) {
    if (movement.type === V110_MOVEMENT_TYPES.CREDIT) return movement.amount;
    if (movement.type === V110_MOVEMENT_TYPES.DEBIT) return -movement.amount;
    if (movement.type === V110_MOVEMENT_TYPES.ADJUSTMENT) return movement.amount;
    return 0;
  }

  function v110AccountBalance(state, accountId) {
    const account = v110AccountOrThrow(state, accountId);
    return (state.accountMovements || [])
      .filter((movement) => movement.accountId === accountId)
      .reduce((balance, movement) => balance + v110MovementDelta(movement), account.initialBalance);
  }

  function v110TotalAvailable(state) {
    return (state.accounts || [])
      .filter((account) => account.active !== false)
      .reduce((total, account) => total + v110AccountBalance(state, account.id), 0);
  }

  function createV110LinkedOperation(state, operation) {
    const accountId = operation && operation.accountId;
    v110AccountOrThrow(state, accountId);
    const date = v110DateOrThrow(operation && operation.date);
    const amount = v110PositiveAmountOrThrow(operation && operation.amount);
    const type = operation && operation.type;
    if (type !== V110_MOVEMENT_TYPES.CREDIT && type !== V110_MOVEMENT_TYPES.DEBIT) {
      throw v110ValidationError('INVALID_MOVEMENT_TYPE', `Invalid linked-operation type: ${type}`);
    }
    const operationRef = v110OperationRefOrThrow(operation && operation.operationRef);
    v110AssertUniqueOperationRef(state, operationRef);

    const movement = {
      id: state.nextMovementId,
      accountId,
      date,
      amount,
      type,
      operationRef,
    };
    return {
      ...state,
      accountMovements: [...(state.accountMovements || []), movement],
      nextMovementId: state.nextMovementId + 1,
    };
  }

  function editV110LinkedOperation(state, operationRef, patch) {
    const normalizedRef = v110OperationRefOrThrow(operationRef);
    const previous = (state.accountMovements || []).find(
      (movement) => movement.operationRef === normalizedRef
    );
    if (!previous) {
      throw v110ValidationError('OPERATION_NOT_FOUND', `Operation not found: ${normalizedRef}`);
    }
    const accountId = patch && Object.prototype.hasOwnProperty.call(patch, 'accountId')
      ? patch.accountId
      : previous.accountId;
    const date = patch && Object.prototype.hasOwnProperty.call(patch, 'date')
      ? patch.date
      : previous.date;
    const amount = patch && Object.prototype.hasOwnProperty.call(patch, 'amount')
      ? patch.amount
      : previous.amount;
    const type = patch && Object.prototype.hasOwnProperty.call(patch, 'type')
      ? patch.type
      : previous.type;

    v110AccountOrThrow(state, accountId);
    v110DateOrThrow(date);
    v110PositiveAmountOrThrow(amount);
    if (type !== V110_MOVEMENT_TYPES.CREDIT && type !== V110_MOVEMENT_TYPES.DEBIT) {
      throw v110ValidationError('INVALID_MOVEMENT_TYPE', `Invalid linked-operation type: ${type}`);
    }

    const replacement = {
      ...previous,
      accountId,
      date,
      amount,
      type,
      operationRef: normalizedRef,
    };
    return {
      ...state,
      accountMovements: state.accountMovements.map(
        (movement) => movement.id === previous.id ? replacement : movement
      ),
    };
  }

  function deleteV110LinkedOperation(state, operationRef) {
    const normalizedRef = v110OperationRefOrThrow(operationRef);
    const exists = (state.accountMovements || []).some(
      (movement) => movement.operationRef === normalizedRef
    );
    if (!exists) {
      throw v110ValidationError('OPERATION_NOT_FOUND', `Operation not found: ${normalizedRef}`);
    }
    return {
      ...state,
      accountMovements: state.accountMovements.filter(
        (movement) => movement.operationRef !== normalizedRef
      ),
    };
  }

  function adjustV110AccountBalance(state, adjustment) {
    const accountId = adjustment && adjustment.accountId;
    v110AccountOrThrow(state, accountId);
    const date = v110DateOrThrow(adjustment && adjustment.date);
    const operationRef = v110OperationRefOrThrow(adjustment && adjustment.operationRef);
    v110AssertUniqueOperationRef(state, operationRef);
    const targetBalance = adjustment && adjustment.targetBalance;
    if (!Number.isFinite(targetBalance)) {
      throw v110ValidationError('INVALID_AMOUNT', `Target balance must be finite: ${targetBalance}`);
    }
    const amount = targetBalance - v110AccountBalance(state, accountId);
    if (amount === 0) {
      throw v110ValidationError('INVALID_AMOUNT', 'Adjustment must change the account balance');
    }
    const movement = {
      id: state.nextMovementId,
      accountId,
      date,
      amount,
      type: V110_MOVEMENT_TYPES.ADJUSTMENT,
      operationRef,
    };
    return {
      ...state,
      accountMovements: [...(state.accountMovements || []), movement],
      nextMovementId: state.nextMovementId + 1,
    };
  }

  return {
    localDateId,
    curMonthId,
    nextMonthId,
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
    V110_SCHEMA_VERSION,
    V110_MOVEMENT_TYPES,
    makeV110Default,
    loadV110,
    serializeV110,
    setV110ActiveMonthSalary,
    closeV110Month,
    isValidV110Date,
    addV110Account,
    v110AccountBalance,
    v110TotalAvailable,
    createV110LinkedOperation,
    editV110LinkedOperation,
    deleteV110LinkedOperation,
    adjustV110AccountBalance,
  };
});

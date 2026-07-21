'use strict';
// Regression tests for Perita's core financial state-transition & calculation
// logic. Imports perita-core.js directly — the exact module the browser app
// (Perita.jsx / index.html) uses via window.PeritaCore — so nothing here
// duplicates production logic.
//
// Run: node --test tests/
// or:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const PC = require('../perita-core.js');

// ── Helpers ──────────────────────────────────────────────────────────────────
function seedState() {
  // A state with permanent entities already in place, ready for monthly activity.
  let s = PC.resetToDefault();
  s = { ...s, settings: { salary: 1000 } };
  s = { ...s, accounts: [{ id: 1, name: 'Cuenta Principal', type: 'bank', balance: 500 }] };
  s = { ...s, debts: [{ id: 2, name: 'Tarjeta', total: 1000, paid: 200, status: 'activa' }] };
  s = { ...s, wallets: [{ id: 3, name: 'Vacaciones', balance: 100, goal: 1000, monthly: 0 }] };
  s = { ...s, budget: [{ id: 4, name: 'Arriendo', amount: 300 }] };
  s = { ...s, nextId: 100 };
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Monthly transactions
// ═══════════════════════════════════════════════════════════════════════════
test('1. Monthly transactions', async (t) => {
  await t.test('add income appends to expenses/activeMonth.expenses and adjusts account balance', () => {
    let s = seedState();
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Sueldo', amount: 500, type: 'income', account: 1 });
    assert.equal(s.expenses.length, 1);
    assert.equal(s.expenses[0].amount, 500);
    assert.equal(s.expenses, s.activeMonth.expenses, 'alias must be the same array as activeMonth.expenses');
    assert.equal(s.accounts.find(a => a.id === 1).balance, 1000, '500 + 500 deposited');
  });

  await t.test('add variable expense appends but does not touch accounts', () => {
    let s = seedState();
    s = PC.addTransaction(s, { date: '2026-07-02', description: 'Super', amount: 80, type: 'expense' });
    assert.equal(s.expenses.length, 1);
    assert.equal(s.expenses[0].type, 'expense');
    assert.equal(s.accounts.find(a => a.id === 1).balance, 500, 'unchanged');
  });

  await t.test('edit income updates amount and account, reconciling balances', () => {
    let s = seedState();
    s = { ...s, accounts: [...s.accounts, { id: 5, name: 'Otra cuenta', type: 'bank', balance: 0 }] };
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Sueldo', amount: 500, type: 'income', account: 1 });
    const txId = s.expenses[0].id;
    // move the income from account 1 to account 5, and bump amount to 600
    s = PC.editTransaction(s, txId, { amount: 600, account: 5 });
    assert.equal(s.expenses.find(x => x.id === txId).amount, 600);
    assert.equal(s.accounts.find(a => a.id === 1).balance, 500, 'reverted (500 base + 500 - 500)');
    assert.equal(s.accounts.find(a => a.id === 5).balance, 600, 'new account credited');
  });

  await t.test('edit variable expense updates amount without touching accounts', () => {
    let s = seedState();
    s = PC.addTransaction(s, { date: '2026-07-02', description: 'Super', amount: 80, type: 'expense' });
    const txId = s.expenses[0].id;
    s = PC.editTransaction(s, txId, { amount: 120, description: 'Super grande' });
    assert.equal(s.expenses[0].amount, 120);
    assert.equal(s.expenses[0].description, 'Super grande');
    assert.equal(s.accounts.find(a => a.id === 1).balance, 500);
  });

  await t.test('delete income reverses account balance', () => {
    let s = seedState();
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Sueldo', amount: 500, type: 'income', account: 1 });
    const tx = s.expenses[0];
    s = PC.deleteTransaction(s, tx);
    assert.equal(s.expenses.length, 0);
    assert.equal(s.accounts.find(a => a.id === 1).balance, 500, 'reverted');
  });

  await t.test('delete variable expense does not touch accounts', () => {
    let s = seedState();
    s = PC.addTransaction(s, { date: '2026-07-02', description: 'Super', amount: 80, type: 'expense' });
    const tx = s.expenses[0];
    s = PC.deleteTransaction(s, tx);
    assert.equal(s.expenses.length, 0);
    assert.equal(s.accounts.find(a => a.id === 1).balance, 500);
  });

  await t.test('totals update immediately (no reload) after add/edit/delete', () => {
    let s = seedState();
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Sueldo', amount: 500, type: 'income', account: 1 });
    s = PC.addTransaction(s, { date: '2026-07-02', description: 'Super', amount: 80, type: 'expense' });
    let mt = PC.monthTotals(s.activeMonth);
    assert.equal(mt.ingresos, 500);
    assert.equal(mt.variables, 80);

    const incomeId = s.expenses.find(e => e.type === 'income').id;
    s = PC.editTransaction(s, incomeId, { amount: 700 });
    mt = PC.monthTotals(s.activeMonth);
    assert.equal(mt.ingresos, 700, 'reflects edit without any reload');

    const expenseTx = s.expenses.find(e => e.type === 'expense');
    s = PC.deleteTransaction(s, expenseTx);
    mt = PC.monthTotals(s.activeMonth);
    assert.equal(mt.variables, 0, 'reflects delete without any reload');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Monthly close
// ═══════════════════════════════════════════════════════════════════════════
test('2. Monthly close', async (t) => {
  function buildActiveMonth() {
    let s = seedState();
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Sueldo', amount: 1000, type: 'income', account: 1 });
    s = PC.addTransaction(s, { date: '2026-07-02', description: 'Super', amount: 100, type: 'expense' });
    s = PC.deposit(s, 3, 200, 1, '2026-07-03');
    s = PC.registerDebtPayment(s, 2, 150, '2026-07-04');
    s = PC.toggleFijoPagado(s, s.budget[0], '2026-07-05');
    return s;
  }

  await t.test('summary reflects latest in-memory state before close', () => {
    const s = buildActiveMonth();
    const mt = PC.monthTotals(s.activeMonth);
    assert.equal(mt.ingresos, 1000);
    assert.equal(mt.variables, 100);
    assert.equal(mt.ahorros, 200);
    assert.equal(mt.deudas, 150);
    assert.equal(mt.fijos, 300);
  });

  await t.test('archive contains all current-month records; new month starts empty', () => {
    const s = buildActiveMonth();
    const closed = PC.closeMonth(s, '2026-07-31T00:00:00Z');
    const archived = closed.monthlyHistory[closed.monthlyHistory.length - 1];

    assert.equal(archived.expenses.length, 2);
    assert.equal(archived.aportesAhorro.length, 1);
    assert.equal(archived.pagosDeuda.length, 1);
    assert.equal(archived.gastosFijosPagados.length, 1);
    assert.equal(archived.closedAt, '2026-07-31T00:00:00Z');

    assert.equal(closed.activeMonth.month, '2026-08');
    assert.equal(closed.activeMonth.expenses.length, 0);
    assert.equal(closed.activeMonth.pagosDeuda.length, 0);
    assert.equal(closed.activeMonth.aportesAhorro.length, 0);
    assert.equal(closed.activeMonth.gastosFijosPagados.length, 0);
    assert.equal(closed.expenses.length, 0, 'compatibility alias also reset');
  });

  await t.test('permanent data (accounts, debts, wallets, budget, settings) unchanged by close', () => {
    const s = buildActiveMonth();
    const closed = PC.closeMonth(s);
    assert.equal(closed.accounts.length, 1);
    assert.equal(closed.accounts[0].balance, s.accounts[0].balance);
    assert.equal(closed.debts[0].paid, 350, 'debt payment from this month persists on the debt record');
    assert.equal(closed.wallets[0].balance, 300, 'deposit persists on the wallet');
    assert.equal(closed.budget.length, 1);
    assert.deepEqual(closed.settings, { salary: 1000 });
  });

  await t.test('reload (serialize + load) preserves archived month and active month', () => {
    const s = buildActiveMonth();
    const closed = PC.closeMonth(s);
    const raw = PC.serialize(closed);
    const reloaded = PC.load(raw);

    assert.equal(reloaded.activeMonth.month, '2026-08');
    assert.equal(reloaded.expenses.length, 0);
    assert.equal(reloaded.monthlyHistory.length, 1);
    assert.equal(reloaded.monthlyHistory[0].expenses.length, 2);
    assert.equal(reloaded.accounts.length, 1);
    assert.equal(reloaded.wallets[0].balance, 300);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Savings
// ═══════════════════════════════════════════════════════════════════════════
test('3. Savings', async (t) => {
  await t.test('deposit updates wallet balance', () => {
    let s = seedState();
    s = PC.deposit(s, 3, 250, null, '2026-07-01');
    assert.equal(s.wallets.find(w => w.id === 3).balance, 350);
  });

  await t.test('deposit from an account also debits that account', () => {
    let s = seedState();
    s = PC.deposit(s, 3, 250, 1, '2026-07-01');
    assert.equal(s.accounts.find(a => a.id === 1).balance, 250);
  });

  await t.test('deposit creates an activeMonth.aportesAhorro record', () => {
    let s = seedState();
    s = PC.deposit(s, 3, 250, 1, '2026-07-01');
    assert.equal(s.activeMonth.aportesAhorro.length, 1);
    assert.equal(s.activeMonth.aportesAhorro[0].amount, 250);
    assert.equal(s.activeMonth.aportesAhorro[0].walletId, 3);
    assert.equal(s.activeMonth.aportesAhorro[0].walletName, 'Vacaciones');
  });

  await t.test('monthly summary and history show the correct savings total', () => {
    let s = seedState();
    s = PC.deposit(s, 3, 100, null, '2026-07-01');
    s = PC.deposit(s, 3, 150, null, '2026-07-02');
    let mt = PC.monthTotals(s.activeMonth);
    assert.equal(mt.ahorros, 250);

    const closed = PC.closeMonth(s);
    const archived = closed.monthlyHistory[0];
    const archivedTotals = PC.monthTotals(archived);
    assert.equal(archivedTotals.ahorros, 250, 'history entry keeps correct total');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Debts
// ═══════════════════════════════════════════════════════════════════════════
test('4. Debts', async (t) => {
  await t.test('payment updates paid amount and remaining balance', () => {
    let s = seedState(); // debt: total 1000, paid 200
    s = PC.registerDebtPayment(s, 2, 300, '2026-07-01');
    const d = s.debts.find(x => x.id === 2);
    assert.equal(d.paid, 500);
    assert.equal(d.total - d.paid, 500, 'remaining balance');
  });

  await t.test('payment creates an activeMonth.pagosDeuda record', () => {
    let s = seedState();
    s = PC.registerDebtPayment(s, 2, 300, '2026-07-01');
    assert.equal(s.activeMonth.pagosDeuda.length, 1);
    assert.equal(s.activeMonth.pagosDeuda[0].amount, 300);
    assert.equal(s.activeMonth.pagosDeuda[0].debtId, 2);
  });

  await t.test('overpayment is clamped to the remaining balance', () => {
    let s = seedState(); // paid 200 of 1000 -> remaining 800
    s = PC.registerDebtPayment(s, 2, 5000, '2026-07-01');
    const d = s.debts.find(x => x.id === 2);
    assert.equal(d.paid, 1000, 'never exceeds total');
    assert.equal(s.activeMonth.pagosDeuda[0].amount, 800, 'logged amount is the actual applied amount, not the requested one');
    assert.equal(d.status, 'pagada');
  });

  await t.test('fully paid debt: further payments are a no-op', () => {
    let s = seedState();
    s = PC.registerDebtPayment(s, 2, 800, '2026-07-01'); // pays off the remaining 800
    assert.equal(s.debts.find(x => x.id === 2).status, 'pagada');
    const beforePayments = s.activeMonth.pagosDeuda.length;
    const beforeState = s;
    s = PC.registerDebtPayment(s, 2, 100, '2026-07-02');
    assert.equal(s, beforeState, 'state reference unchanged — no-op');
    assert.equal(s.activeMonth.pagosDeuda.length, beforePayments);
  });

  await t.test('zero or negative payment amount is a no-op', () => {
    let s = seedState();
    const before = s;
    s = PC.registerDebtPayment(s, 2, 0, '2026-07-01');
    assert.equal(s, before);
    s = PC.registerDebtPayment(s, 2, -50, '2026-07-01');
    assert.equal(s, before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Fixed expenses
// ═══════════════════════════════════════════════════════════════════════════
test('5. Fixed expenses', async (t) => {
  await t.test('marking as paid creates an activeMonth.gastosFijosPagados record', () => {
    let s = seedState();
    s = PC.toggleFijoPagado(s, s.budget[0], '2026-07-01');
    assert.equal(s.activeMonth.gastosFijosPagados.length, 1);
    assert.equal(s.activeMonth.gastosFijosPagados[0].budgetId, s.budget[0].id);
    assert.equal(s.activeMonth.gastosFijosPagados[0].amount, 300);
  });

  await t.test('marking as unpaid (toggle again) removes the record', () => {
    let s = seedState();
    s = PC.toggleFijoPagado(s, s.budget[0], '2026-07-01');
    assert.equal(s.activeMonth.gastosFijosPagados.length, 1);
    s = PC.toggleFijoPagado(s, s.budget[0], '2026-07-01');
    assert.equal(s.activeMonth.gastosFijosPagados.length, 0);
  });

  await t.test('monthly totals for fixed expenses are correct with multiple items', () => {
    let s = seedState();
    s = { ...s, budget: [...s.budget, { id: 6, name: 'Internet', amount: 40 }] };
    s = PC.toggleFijoPagado(s, s.budget[0], '2026-07-01');
    s = PC.toggleFijoPagado(s, s.budget[1], '2026-07-01');
    const mt = PC.monthTotals(s.activeMonth);
    assert.equal(mt.fijos, 340);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Dashboard calculations
// ═══════════════════════════════════════════════════════════════════════════
test('6. Dashboard calculations', async (t) => {
  await t.test('all totals with a full month of activity', () => {
    let s = seedState();
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Sueldo', amount: 1000, type: 'income', account: 1 });
    s = PC.addTransaction(s, { date: '2026-07-02', description: 'Super', amount: 150, type: 'expense' });
    s = PC.toggleFijoPagado(s, s.budget[0], '2026-07-03');
    s = PC.registerDebtPayment(s, 2, 100, '2026-07-04');
    s = PC.deposit(s, 3, 80, null, '2026-07-05');

    const d = PC.dashboardTotals(s);
    assert.equal(d.totalIncomeDash, 1000, 'total income');
    assert.equal(d.totalVariable, 150, 'total variable expenses');
    assert.equal(d.totalFixed, 300, 'total paid fixed expenses');
    assert.equal(d.monthlyDebt, 100, 'debt payments');
    assert.equal(d.monthlySavings, 80, 'savings contributions');
    assert.equal(d.remaining, 1000 - 300 - 80 - 150, 'remaining balance');
    assert.equal(d.incomeSrc, 1000, 'uses actual income over settings.salary when income > 0');
    assert.equal(d.savingsRate, Math.round((80 / 1000) * 100));
  });

  await t.test('percentages and denominators: falls back to settings.salary with no income', () => {
    let s = seedState(); // settings.salary = 1000
    const d = PC.dashboardTotals(s);
    assert.equal(d.totalIncomeDash, 0);
    assert.equal(d.incomeSrc, 1000, 'falls back to settings.salary');
  });

  await t.test('zero-value edge cases: fresh state produces no NaN/Infinity', () => {
    const s = PC.resetToDefault(); // settings.salary = 0, everything empty
    const d = PC.dashboardTotals(s);
    for (const [key, val] of Object.entries(d)) {
      assert.ok(Number.isFinite(val), `${key} should be a finite number, got ${val}`);
    }
    assert.equal(d.incomeSrc, 0);
    assert.equal(d.savingsRate, 0, 'no division by zero');
    assert.equal(d.remaining, 0);
    assert.equal(d.netWorth, 0);
    assert.equal(d.totalDebt, 0);
  });

  await t.test('totalDebt excludes fully paid debts', () => {
    let s = seedState();
    s = { ...s, debts: [
      { id: 10, name: 'A', total: 500, paid: 500, status: 'pagada' },
      { id: 11, name: 'B', total: 300, paid: 100, status: 'activa' },
    ] };
    const d = PC.dashboardTotals(s);
    assert.equal(d.totalDebt, 200, 'only the unpaid debt counts');
  });

  await t.test('netWorth combines account and wallet balances', () => {
    let s = seedState();
    s = { ...s, accounts: [{ id: 1, name: 'A', balance: 300 }, { id: 2, name: 'B', balance: 200 }] };
    s = { ...s, wallets: [{ id: 3, name: 'W', balance: 150, goal: 0, monthly: 0 }] };
    const d = PC.dashboardTotals(s);
    assert.equal(d.totalAvailable, 500);
    assert.equal(d.totalSavings, 150);
    assert.equal(d.netWorth, 650);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Persistence and migration
// ═══════════════════════════════════════════════════════════════════════════
test('7. Persistence and migration', async (t) => {
  await t.test('fresh localStorage (raw = null) yields a valid, non-crashing state', () => {
    const s = PC.load(null);
    assert.ok(Array.isArray(s.expenses));
    assert.equal(s.expenses.length, 0);
    assert.equal(s.expenses, s.activeMonth.expenses, 'alias points at canonical array');
    assert.deepEqual(s.accounts, []);
    assert.equal(s.settings.salary, 0);
  });

  await t.test('malformed/corrupt raw string does not throw and falls back to a fresh state', () => {
    assert.doesNotThrow(() => PC.load('{not valid json'));
    const s = PC.load('{not valid json');
    assert.ok(Array.isArray(s.expenses));
  });

  await t.test('existing v1 data (already has activeMonth) loads with alias populated', () => {
    const raw = JSON.stringify({
      settings: { salary: 500 },
      accounts: [{ id: 1, name: 'A', balance: 10 }],
      debts: [], wallets: [], budget: [], varCategories: [], nextId: 7,
      activeMonth: { month: '2026-06', expenses: [{ id: 1, type: 'income', amount: 500, date: '2026-06-01' }], pagosDeuda: [], aportesAhorro: [], gastosFijosPagados: [] },
      monthlyHistory: [],
    });
    const s = PC.load(raw);
    assert.equal(s.expenses.length, 1);
    assert.equal(s.expenses[0].amount, 500);
    assert.equal(s.settings.salary, 500);
  });

  await t.test('older data without activeMonth migrates top-level expenses into activeMonth', () => {
    const raw = JSON.stringify({
      settings: { salary: 500 },
      accounts: [], debts: [], wallets: [], budget: [], varCategories: [], nextId: 3,
      expenses: [{ id: 1, type: 'expense', amount: 42, date: '2026-05-01' }],
    });
    const s = PC.load(raw);
    assert.ok(s.activeMonth, 'activeMonth was created');
    assert.equal(s.activeMonth.expenses.length, 1);
    assert.equal(s.activeMonth.expenses[0].amount, 42);
    assert.equal(s.expenses, s.activeMonth.expenses, 'alias synced');
    assert.deepEqual(s.activeMonth.pagosDeuda, []);
    assert.deepEqual(s.activeMonth.aportesAhorro, []);
    assert.deepEqual(s.activeMonth.gastosFijosPagados, []);
    assert.deepEqual(s.monthlyHistory, []);
  });

  await t.test('older data with partial activeMonth (missing sub-arrays) is backfilled', () => {
    const raw = JSON.stringify({
      settings: { salary: 0 },
      accounts: [], debts: [], wallets: [], budget: [], varCategories: [], nextId: 1,
      activeMonth: { month: '2026-06', expenses: [] }, // missing pagosDeuda/aportesAhorro/gastosFijosPagados
    });
    const s = PC.load(raw);
    assert.deepEqual(s.activeMonth.pagosDeuda, []);
    assert.deepEqual(s.activeMonth.aportesAhorro, []);
    assert.deepEqual(s.activeMonth.gastosFijosPagados, []);
  });

  await t.test('save/load round trip preserves all data without loss', () => {
    let s = seedState();
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Sueldo', amount: 1000, type: 'income', account: 1 });
    s = PC.deposit(s, 3, 50, null, '2026-07-02');
    s = PC.registerDebtPayment(s, 2, 100, '2026-07-03');
    s = PC.toggleFijoPagado(s, s.budget[0], '2026-07-04');

    const raw = PC.serialize(s);
    const reloaded = PC.load(raw);

    assert.deepEqual(reloaded.settings, s.settings);
    assert.deepEqual(reloaded.accounts, s.accounts);
    assert.deepEqual(reloaded.wallets, s.wallets);
    assert.deepEqual(reloaded.debts, s.debts);
    assert.deepEqual(reloaded.budget, s.budget);
    assert.equal(reloaded.nextId, s.nextId);
    assert.deepEqual(reloaded.expenses, s.expenses);
    assert.deepEqual(reloaded.activeMonth.pagosDeuda, s.activeMonth.pagosDeuda);
    assert.deepEqual(reloaded.activeMonth.aportesAhorro, s.activeMonth.aportesAhorro);
    assert.deepEqual(reloaded.activeMonth.gastosFijosPagados, s.activeMonth.gastosFijosPagados);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// setState sync behavior (App.setState's alias-sync logic, extracted as
// PeritaCore.syncExpensesAlias so it's directly testable)
// ═══════════════════════════════════════════════════════════════════════════
test('syncExpensesAlias (App.setState choke point)', async (t) => {
  await t.test('re-points activeMonth.expenses at the alias when they diverge', () => {
    const base = PC.resetToDefault();
    const divergent = { ...base, expenses: [{ id: 1, type: 'income', amount: 5 }] };
    const synced = PC.syncExpensesAlias(divergent);
    assert.equal(synced.activeMonth.expenses, synced.expenses);
    assert.equal(synced.activeMonth.expenses.length, 1);
  });

  await t.test('is a no-op when already in sync', () => {
    const base = PC.resetToDefault();
    const synced = PC.syncExpensesAlias(base);
    assert.equal(synced, base, 'same reference — no unnecessary object creation');
  });
});

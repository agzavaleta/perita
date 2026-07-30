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
const { execFileSync } = require('node:child_process');
const path = require('node:path');
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
// Calendar dates and month identifiers
// ═══════════════════════════════════════════════════════════════════════════
test('Calendar dates and month identifiers', async (t) => {
  await t.test('nextMonthId advances normal months and December without Date parsing', () => {
    assert.equal(PC.nextMonthId('2026-07'), '2026-08');
    assert.equal(PC.nextMonthId('2026-11'), '2026-12');
    assert.equal(PC.nextMonthId('2026-12'), '2027-01');
  });

  await t.test('local dates and closeMonth are correct in America/Santiago and UTC', () => {
    const corePath = path.join(__dirname, '..', 'perita-core.js');
    const scenario = `
      const PC = require(${JSON.stringify(corePath)});
      const localDate = PC.localDateId(new Date('2026-08-01T01:30:00.000Z'));
      let state = PC.resetToDefault();
      state = {
        ...state,
        activeMonth: { ...state.activeMonth, month: '2026-12' },
      };
      const closed = PC.closeMonth(state, '2026-12-31T23:59:59.000Z', '2026-12');
      const duplicate = PC.closeMonth(closed, '2027-01-01T00:00:00.000Z', '2026-12');
      process.stdout.write(JSON.stringify({
        localDate,
        nextMonth: closed.activeMonth.month,
        historyLength: closed.monthlyHistory.length,
        duplicateWasNoOp: duplicate === closed,
      }));
    `;
    const run = (tz) => JSON.parse(execFileSync(
      process.execPath,
      ['-e', scenario],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8' }
    ));

    assert.deepEqual(run('America/Santiago'), {
      localDate: '2026-07-31',
      nextMonth: '2027-01',
      historyLength: 1,
      duplicateWasNoOp: true,
    });
    assert.deepEqual(run('UTC'), {
      localDate: '2026-08-01',
      nextMonth: '2027-01',
      historyLength: 1,
      duplicateWasNoOp: true,
    });
  });

  await t.test('Perita.jsx uses the shared local-date and month helpers', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'Perita.jsx'), 'utf8');
    assert.match(src, /const today = \(\) => PeritaCore\.localDateId\(\)/);
    assert.match(src, /PeritaCore\.nextMonthId\(curMonth\)/);
    assert.doesNotMatch(src, /new Date\(curMonth \+ '-01'\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Monthly close
// ═══════════════════════════════════════════════════════════════════════════
test('2. Monthly close', async (t) => {
  function buildActiveMonth() {
    let s = seedState();
    // 'Bono' here is an additional-income transaction — this section tests
    // generic monthly-close mechanics, not the salary model (see sections
    // 6-8, 10 for the additive-salary-specific coverage).
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Bono', amount: 1000, type: 'income', account: 1 });
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
// 6. Dashboard calculations — additive salary model (Session 9): total income
// is always the configured salary (settings.salary) plus additional income
// transactions. The salary is never itself an income transaction.
// ═══════════════════════════════════════════════════════════════════════════
test('6. Dashboard calculations', async (t) => {
  await t.test('all totals with a full month of activity (salary additive + additional income)', () => {
    let s = seedState(); // settings.salary = 1000
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Freelance', amount: 200, type: 'income', account: 1 });
    s = PC.addTransaction(s, { date: '2026-07-02', description: 'Super', amount: 150, type: 'expense' });
    s = PC.toggleFijoPagado(s, s.budget[0], '2026-07-03');
    s = PC.registerDebtPayment(s, 2, 100, '2026-07-04');
    s = PC.deposit(s, 3, 80, null, '2026-07-05');

    const d = PC.dashboardTotals(s);
    assert.equal(d.salary, 1000, 'configured salary');
    assert.equal(d.additionalIncome, 200, 'only the freelance transaction');
    assert.equal(d.totalIncomeDash, 1200, 'salary (1000) + additional income (200)');
    assert.equal(d.totalVariable, 150, 'total variable expenses');
    assert.equal(d.totalFixed, 300, 'total paid fixed expenses');
    assert.equal(d.monthlyDebt, 100, 'debt payments');
    assert.equal(d.monthlySavings, 80, 'savings contributions');
    assert.equal(d.remaining, 1200 - 300 - 80 - 150 - 100, 'remaining balance deducts debt payments too');
    assert.equal(d.incomeSrc, 1200, 'incomeSrc always equals totalIncomeDash under the additive model');
    assert.equal(d.savingsRate, Math.round((80 / 1200) * 100));
  });

  await t.test('remaining/sobrante deduct debt payments (regression: previously omitted)', () => {
    let s = seedState(); // settings.salary = 1000
    s = PC.registerDebtPayment(s, 2, 400, '2026-07-02'); // real cash out, funded by salary alone
    const d = PC.dashboardTotals(s);
    const mt = PC.monthTotals(s.activeMonth, s.settings.salary);
    assert.equal(d.remaining, 600, 'salary 1000 minus a 400 debt payment');
    assert.equal(mt.sobrante, 600, 'monthTotals.sobrante must match dashboardTotals.remaining');
  });

  await t.test('monthTotals.sobrante and dashboardTotals.remaining agree whenever the month has activity', () => {
    let s = seedState(); // settings.salary = 1000
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Bono', amount: 200, type: 'income', account: 1 });
    s = PC.addTransaction(s, { date: '2026-07-02', description: 'Super', amount: 150, type: 'expense' });
    s = PC.toggleFijoPagado(s, s.budget[0], '2026-07-03');
    s = PC.registerDebtPayment(s, 2, 100, '2026-07-04');
    s = PC.deposit(s, 3, 80, null, '2026-07-05');
    const d = PC.dashboardTotals(s);
    const mt = PC.monthTotals(s.activeMonth, s.settings.salary);
    assert.equal(d.remaining, mt.sobrante, 'same underlying metric, same calculation source, same result');
  });

  await t.test('required-validation-matrix scenario: salary + 2 additional incomes, 3 fixed, 3 variable, 1 debt payment, 1 saving, then edit + delete', () => {
    let s = seedState(); // settings.salary=1000, debt total 1000 paid 200, budget:[Arriendo 300]
    s = { ...s, budget: [...s.budget, { id: 20, name: 'Luz', amount: 30 }, { id: 21, name: 'Internet', amount: 20 }] };

    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Bono', amount: 300, type: 'income', account: 1 });
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Freelance', amount: 150, type: 'income', account: 1 });

    let e1 = PC.addTransaction(s, { date: '2026-07-02', description: 'Super', amount: 60, type: 'expense' });
    s = e1;
    const superTxId = s.expenses.find(e => e.description === 'Super').id;
    s = PC.addTransaction(s, { date: '2026-07-03', description: 'Bencina', amount: 40, type: 'expense' });
    const bencinaTxId = s.expenses.find(e => e.description === 'Bencina').id;
    s = PC.addTransaction(s, { date: '2026-07-04', description: 'Ocio', amount: 25, type: 'expense' });

    s = PC.toggleFijoPagado(s, s.budget[0], '2026-07-05'); // Arriendo 300
    s = PC.toggleFijoPagado(s, s.budget[1], '2026-07-05'); // Luz 30
    s = PC.toggleFijoPagado(s, s.budget[2], '2026-07-05'); // Internet 20

    s = PC.registerDebtPayment(s, 2, 50, '2026-07-06');
    s = PC.deposit(s, 3, 70, null, '2026-07-07');

    let mt = PC.monthTotals(s.activeMonth, s.settings.salary);
    assert.equal(mt.salary, 1000);
    assert.equal(mt.additionalIncome, 450, '300 + 150');
    assert.equal(mt.ingresos, 1450, '1000 configured salary + 450 additional income');
    assert.equal(mt.variables, 125, '60 + 40 + 25');
    assert.equal(mt.fijos, 350, '300 + 30 + 20');
    assert.equal(mt.ahorros, 70);
    assert.equal(mt.deudas, 50);
    assert.equal(mt.sobrante, 1450 - 350 - 125 - 70 - 50, '= 855');

    // Edit one record: Super 60 -> 90
    s = PC.editTransaction(s, superTxId, { amount: 90 });
    mt = PC.monthTotals(s.activeMonth, s.settings.salary);
    assert.equal(mt.variables, 155, '90 + 40 + 25');
    assert.equal(mt.sobrante, 1450 - 350 - 155 - 70 - 50, 'sobrante reflects the edit immediately');

    // Delete one record: Bencina 40
    const bencinaTx = s.expenses.find(e => e.id === bencinaTxId);
    s = PC.deleteTransaction(s, bencinaTx);
    mt = PC.monthTotals(s.activeMonth, s.settings.salary);
    assert.equal(mt.variables, 115, '90 + 25');
    assert.equal(mt.sobrante, 1450 - 350 - 115 - 70 - 50, 'sobrante reflects the delete immediately');

    // Close the month: archived snapshot must equal the pre-close totals exactly, and store the salary used.
    const preCloseTotals = PC.monthTotals(s.activeMonth, s.settings.salary);
    const closed = PC.closeMonth(s, '2026-07-31T00:00:00Z');
    const archived = closed.monthlyHistory[closed.monthlyHistory.length - 1];
    assert.equal(archived.salary, 1000, 'the configured salary at close time is stamped into the snapshot');
    assert.deepEqual(PC.monthTotals(archived), preCloseTotals, 'archive preserves the exact totals at close time (salary resolved from the snapshot itself)');
    assert.equal(closed.activeMonth.expenses.length, 0, 'new month starts clean');
    assert.equal(closed.debts.find(d => d.id === 2).paid, 250, '200 + 50, permanent debt record persists');
    assert.equal(closed.wallets.find(w => w.id === 3).balance, 170, '100 + 70, permanent wallet balance persists');
    assert.deepEqual(closed.settings, { salary: 1000 }, 'settings untouched by close');
  });

  await t.test('salary alone counts as income even with zero additional-income transactions', () => {
    let s = seedState(); // settings.salary = 1000, no transactions logged
    const d = PC.dashboardTotals(s);
    assert.equal(d.salary, 1000);
    assert.equal(d.additionalIncome, 0);
    assert.equal(d.totalIncomeDash, 1000, 'configured salary alone counts as income under the additive rule');
    assert.equal(d.incomeSrc, 1000);
    assert.equal(d.remaining, 1000, 'salary is real, available money — it funds "remaining" too, not just a reference');
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
// 7. Salary vs. additional income — confirmed rule (Session 9, see
// BUSINESS_RULES.md "Salary model — confirmed additive rule"): there is
// exactly one configured salary (settings.salary), managed only from
// Configuración. It is never entered as an income transaction. Every income
// transaction logged in the Income section represents additional income
// only. Total income = configured salary (or the archived snapshot's stored
// salary) + additional income transactions, always. Changing settings.salary
// never rewrites an already-archived month — each archived month carries its
// own `salary` field, stamped at close time.
// ═══════════════════════════════════════════════════════════════════════════
test('7. Salary vs. additional income', async (t) => {
  await t.test('1. salary only: no additional income logged, total income equals the configured salary', () => {
    let s = seedState(); // settings.salary = 1000, no transactions
    const d = PC.dashboardTotals(s);
    assert.equal(d.salary, 1000);
    assert.equal(d.additionalIncome, 0);
    assert.equal(d.totalIncomeDash, 1000, 'salary alone, additive rule');
    assert.equal(d.incomeSrc, 1000);
  });

  await t.test('2. salary plus one additional income: total is the sum, not a replacement', () => {
    let s = seedState(); // settings.salary = 1000
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Bono', amount: 400, type: 'income', account: 1 });
    const d = PC.dashboardTotals(s);
    assert.equal(d.salary, 1000);
    assert.equal(d.additionalIncome, 400);
    assert.equal(d.totalIncomeDash, 1400, '1000 salary + 400 additional income');
    assert.equal(d.incomeSrc, 1400);
  });

  await t.test('3. salary plus multiple additional incomes: all additional-income transactions sum together', () => {
    let s = seedState(); // settings.salary = 1000
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Freelance', amount: 250, type: 'income', account: 1 });
    s = PC.addTransaction(s, { date: '2026-07-10', description: 'Bono', amount: 100, type: 'income', account: 1 });
    s = PC.addTransaction(s, { date: '2026-07-20', description: 'Venta', amount: 75, type: 'income', account: 1 });
    const d = PC.dashboardTotals(s);
    assert.equal(d.additionalIncome, 425, '250 + 100 + 75');
    assert.equal(d.totalIncomeDash, 1425, '1000 salary + 425 additional income');
  });

  await t.test('income transactions never carry the salary: no double-count regardless of description text', () => {
    let s = seedState(); // settings.salary = 1000
    // Even a transaction confusingly labeled like a salary is treated as additional
    // income — the configured salary is never derived from the expenses list, only
    // from settings.salary (or the archived snapshot). There is no "this is the
    // salary" flag on a transaction; salary is simply never entered as one.
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Sueldo extra', amount: 200, type: 'income', account: 1 });
    const d = PC.dashboardTotals(s);
    assert.equal(d.salary, 1000, 'still the configured salary, unaffected by transaction descriptions');
    assert.equal(d.additionalIncome, 200, 'the transaction counts once, as additional income');
    assert.equal(d.totalIncomeDash, 1200, '1000 + 200 — never 1000 + 1000 + 200');
  });

  await t.test('4. salary modification before month closing: the active month always uses the current configured salary', () => {
    let s = seedState(); // settings.salary = 1000
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Bono', amount: 200, type: 'income', account: 1 });
    let d = PC.dashboardTotals(s);
    assert.equal(d.totalIncomeDash, 1200);

    // Salary changed mid-month, before closing.
    s = { ...s, settings: { salary: 1500 } };
    d = PC.dashboardTotals(s);
    assert.equal(d.salary, 1500, 'the still-open month immediately reflects the new configured salary');
    assert.equal(d.totalIncomeDash, 1700, '1500 + 200 — recalculated with the new salary, no stale value');
  });

  await t.test('5. salary modification after month closing does not alter the archived month', () => {
    let s = seedState(); // settings.salary = 1000
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Bono', amount: 200, type: 'income', account: 1 });
    s = PC.addTransaction(s, { date: '2026-07-02', description: 'Super', amount: 100, type: 'expense' });
    const closed = PC.closeMonth(s, '2026-07-31T00:00:00Z');
    const archivedBefore = closed.monthlyHistory[closed.monthlyHistory.length - 1];
    assert.equal(archivedBefore.salary, 1000, 'the salary in effect at close time was stamped into the snapshot');
    const totalsBefore = PC.monthTotals(archivedBefore);

    // Change the salary after the close.
    const afterSalaryChange = { ...closed, settings: { salary: 5000 } };
    const archivedAfter = afterSalaryChange.monthlyHistory[afterSalaryChange.monthlyHistory.length - 1];
    const totalsAfter = PC.monthTotals(archivedAfter);

    assert.deepEqual(totalsAfter, totalsBefore, 'archived month totals are identical regardless of the current salary setting');
    assert.equal(archivedAfter.salary, 1000, 'the archived snapshot keeps its own stored salary, never the live settings.salary');
  });

  await t.test('6. historical months remain unchanged even across multiple later salary changes and month closes', () => {
    let s = seedState(); // settings.salary = 1000
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Bono', amount: 200, type: 'income', account: 1 });
    let closed = PC.closeMonth(s, '2026-07-31T00:00:00Z', '2026-07');
    const firstArchived = closed.monthlyHistory[0];

    // Salary raised, second month closed with the new salary.
    closed = { ...closed, settings: { salary: 1300 } };
    let s2 = PC.addTransaction(closed, { date: '2026-08-01', description: 'Freelance', amount: 100, type: 'income', account: 1 });
    const closed2 = PC.closeMonth(s2, '2026-08-31T00:00:00Z', '2026-08');

    // Salary raised again, well after both closes.
    const finalState = { ...closed2, settings: { salary: 9999 } };

    assert.deepEqual(finalState.monthlyHistory[0], firstArchived, 'first archived month untouched');
    assert.equal(finalState.monthlyHistory[0].salary, 1000);
    assert.equal(finalState.monthlyHistory[1].salary, 1300, 'second archived month kept the salary in effect when IT was closed');
    assert.equal(PC.monthTotals(finalState.monthlyHistory[0]).ingresos, 1200, '1000 + 200, unaffected by 1300 or 9999');
    assert.equal(PC.monthTotals(finalState.monthlyHistory[1]).ingresos, 1400, '1300 + 100, unaffected by the later 9999 change');
  });

  await t.test('audit scenario regression: post-deletion sobrante is exactly 865 under the additive salary model', () => {
    let s = seedState(); // settings.salary = 1000
    s = { ...s, budget: [...s.budget, { id: 20, name: 'Luz', amount: 30 }, { id: 21, name: 'Internet', amount: 20 }] };
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Bono', amount: 300, type: 'income', account: 1 });
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Freelance', amount: 150, type: 'income', account: 1 });
    s = PC.addTransaction(s, { date: '2026-07-02', description: 'Super', amount: 90, type: 'expense' }); // already-edited amount
    s = PC.addTransaction(s, { date: '2026-07-04', description: 'Ocio', amount: 25, type: 'expense' });
    // Bencina (40) deliberately not added — this represents the post-delete state.
    s = PC.toggleFijoPagado(s, s.budget[0], '2026-07-05');
    s = PC.toggleFijoPagado(s, s.budget[1], '2026-07-05');
    s = PC.toggleFijoPagado(s, s.budget[2], '2026-07-05');
    s = PC.registerDebtPayment(s, 2, 50, '2026-07-06');
    s = PC.deposit(s, 3, 70, null, '2026-07-07');

    const mt = PC.monthTotals(s.activeMonth, s.settings.salary);
    assert.equal(mt.salary, 1000);
    assert.equal(mt.additionalIncome, 450, '300 + 150');
    assert.equal(mt.ingresos, 1450);
    assert.equal(mt.variables, 115);
    assert.equal(mt.fijos, 350);
    assert.equal(mt.ahorros, 70);
    assert.equal(mt.deudas, 50);
    assert.equal(mt.sobrante, 865, '1450 - 350 - 115 - 70 - 50 = 865');
  });

  await t.test('Perita.jsx source keeps the salary out of the Income section and uses the centralized additive helper', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'Perita.jsx'), 'utf8');
    assert.match(src, /PeritaCore\.monthTotals\(activeMonth,\s*settings\.salary\)/, 'the month-close summary must pass the current configured salary explicitly');
    assert.match(src, /Sueldo configurado/, 'the salary appears as read-only informational data');
    assert.doesNotMatch(src, /placeholder="Sueldo,\s*freelance/, 'the old income-form placeholder suggesting salary belongs in Income must be gone');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Dashboard end-to-end validation matrix — walks the exact 10-step
// sequence from the Dashboard audit, asserting PeritaCore.dashboardTotals
// (what the Dashboard renders) and PeritaCore.monthTotals (what section
// totals / month-close use) at every step. Dashboard has no calculation
// logic of its own — it destructures dashboardTotals(state) directly and
// renders it — so agreement here is agreement with what's on screen.
// ═══════════════════════════════════════════════════════════════════════════
test('8. Dashboard end-to-end validation matrix', async (t) => {
  await t.test('step 1: empty month with permanent data present — no NaN, income equals configured salary, remaining equals salary (additive rule)', () => {
    let s = seedState(); // settings.salary=1000, account balance 500, debt 1000/200, wallet 100/1000, budget Arriendo 300
    const d = PC.dashboardTotals(s);
    const mt = PC.monthTotals(s.activeMonth, s.settings.salary);
    for (const [key, val] of Object.entries(d)) assert.ok(Number.isFinite(val), `${key} should be finite, got ${val}`);
    assert.equal(d.totalIncomeDash, 1000, 'no additional income logged yet, but the configured salary always counts');
    assert.equal(d.remaining, 1000, 'salary is real, available money from the first day of the month');
    assert.equal(d.incomeSrc, 1000);
    assert.equal(mt.ingresos, 1000);
    assert.equal(mt.sobrante, 1000);
    assert.equal(d.remaining, mt.sobrante, 'dashboard and section/month-close totals agree even on an otherwise-empty month');
  });

  await t.test('steps 2–9: additional income x2 -> 3 fixed -> 3 variable -> debt payment -> savings -> edit -> delete', () => {
    let s = seedState(); // settings.salary = 1000
    s = { ...s, budget: [...s.budget, { id: 20, name: 'Luz', amount: 30 }, { id: 21, name: 'Internet', amount: 20 }] };

    // Step 2: first additional income (salary itself is never entered as a transaction).
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Bono', amount: 200, type: 'income', account: 1 });
    let d = PC.dashboardTotals(s);
    assert.equal(d.totalIncomeDash, 1200, '1000 configured salary + 200 additional income');
    assert.equal(d.incomeSrc, 1200);
    assert.equal(d.remaining, 1200);
    assert.equal(PC.monthTotals(s.activeMonth, s.settings.salary).sobrante, 1200);

    // Step 3: a second additional income.
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Freelance', amount: 300, type: 'income', account: 1 });
    d = PC.dashboardTotals(s);
    assert.equal(d.totalIncomeDash, 1500, '1000 salary + 200 bono + 300 freelance');
    assert.equal(d.remaining, 1500);

    // Step 4: three fixed expenses paid.
    s = PC.toggleFijoPagado(s, s.budget[0], '2026-07-02'); // Arriendo 300
    s = PC.toggleFijoPagado(s, s.budget[1], '2026-07-02'); // Luz 30
    s = PC.toggleFijoPagado(s, s.budget[2], '2026-07-02'); // Internet 20
    d = PC.dashboardTotals(s);
    assert.equal(d.totalFixed, 350);
    assert.equal(d.remaining, 1500 - 350);

    // Step 5: three variable expenses.
    let e = PC.addTransaction(s, { date: '2026-07-03', description: 'Super', amount: 60, type: 'expense' });
    const superId = e.expenses.find(x => x.description === 'Super').id;
    e = PC.addTransaction(e, { date: '2026-07-03', description: 'Bencina', amount: 40, type: 'expense' });
    const bencinaId = e.expenses.find(x => x.description === 'Bencina').id;
    e = PC.addTransaction(e, { date: '2026-07-03', description: 'Ocio', amount: 25, type: 'expense' });
    s = e;
    d = PC.dashboardTotals(s);
    assert.equal(d.totalVariable, 125, '60 + 40 + 25');
    assert.equal(d.remaining, 1500 - 350 - 125);

    // Step 6: one debt payment.
    s = PC.registerDebtPayment(s, 2, 100, '2026-07-04');
    d = PC.dashboardTotals(s);
    assert.equal(d.monthlyDebt, 100);
    assert.equal(d.remaining, 1500 - 350 - 125 - 100);

    // Step 7: one savings deposit.
    s = PC.deposit(s, 3, 70, null, '2026-07-05');
    d = PC.dashboardTotals(s);
    assert.equal(d.monthlySavings, 70);
    assert.equal(d.remaining, 1500 - 350 - 125 - 100 - 70, '= 855');
    assert.equal(PC.monthTotals(s.activeMonth, s.settings.salary).sobrante, d.remaining, 'dashboard and section totals agree');

    // Step 8: edit one record (Super 60 -> 90).
    s = PC.editTransaction(s, superId, { amount: 90 });
    d = PC.dashboardTotals(s);
    assert.equal(d.totalVariable, 155, '90 + 40 + 25');
    assert.equal(d.remaining, 1500 - 350 - 155 - 100 - 70, 'updates immediately, no reload needed');

    // Step 9: delete one record (Bencina 40).
    const bencinaTx = s.expenses.find(x => x.id === bencinaId);
    s = PC.deleteTransaction(s, bencinaTx);
    d = PC.dashboardTotals(s);
    const mt = PC.monthTotals(s.activeMonth, s.settings.salary);
    assert.equal(d.totalVariable, 115, '90 + 25, Bencina removed');
    assert.equal(d.totalIncomeDash, 1500);
    assert.equal(d.totalFixed, 350);
    assert.equal(d.monthlyDebt, 100);
    assert.equal(d.monthlySavings, 70);
    assert.equal(d.remaining, 1500 - 350 - 115 - 100 - 70, '= 865');
    assert.equal(mt.sobrante, d.remaining, 'section total (month-close/history) matches the dashboard exactly');

    // Step 10: close the month and start a new one.
    const preCloseDash = d;
    const closed = PC.closeMonth(s, '2026-07-31T00:00:00Z');
    const archived = closed.monthlyHistory[closed.monthlyHistory.length - 1];
    assert.equal(archived.salary, 1000, 'the configured salary at close time is stamped into the snapshot');
    assert.deepEqual(PC.monthTotals(archived), PC.monthTotals(s.activeMonth, s.settings.salary), 'archive preserves the exact pre-close totals');

    const newDash = PC.dashboardTotals(closed);
    assert.equal(newDash.additionalIncome, 0, 'new active month starts clean of additional-income transactions');
    assert.equal(newDash.totalFixed, 0);
    assert.equal(newDash.totalVariable, 0);
    assert.equal(newDash.monthlyDebt, 0);
    assert.equal(newDash.monthlySavings, 0);
    assert.equal(newDash.salary, 1000, 'the new month uses the current configured salary (rule 8)');
    assert.equal(newDash.totalIncomeDash, 1000, 'salary alone counts as income for the fresh month — not zero');
    assert.equal(newDash.remaining, 1000, 'the new month starts with the salary as available money, no leftover from the closed month');
    assert.notEqual(newDash.remaining, preCloseDash.remaining, 'the new month is a fresh state, not a stale carryover of the closed one');

    // Permanent entities (accounts/debts/wallets) still reflect the whole month's real cash movement.
    assert.equal(closed.accounts.find(a => a.id === 1).balance, 500 + 200 + 300, 'account credited by both additional-income transactions (salary was never a transaction)');
    assert.equal(closed.debts.find(d2 => d2.id === 2).paid, 300, '200 + 100');
    assert.equal(closed.wallets.find(w => w.id === 3).balance, 170, '100 + 70');
  });

  await t.test('archived months never leak into the active-month dashboard', () => {
    let s = seedState(); // settings.salary = 1000
    s = PC.addTransaction(s, { date: '2026-07-01', description: 'Bono', amount: 500, type: 'income', account: 1 });
    const closed = PC.closeMonth(s, '2026-07-31T00:00:00Z');
    // A second month of activity, deliberately different from the archived one.
    let s2 = PC.addTransaction(closed, { date: '2026-08-01', description: 'Freelance', amount: 300, type: 'income', account: 1 });
    const d = PC.dashboardTotals(s2);
    assert.equal(d.totalIncomeDash, 1300, 'only the new month\'s additional income (300) plus the current salary (1000) counts — the archived 500 does not leak in');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Centralized page-level totals — AccountsPage, the Wallets/Ahorros page,
// and DebtTracker used to each recompute their own total with a local
// reduce(); they now call these PeritaCore helpers directly (same helpers
// dashboardTotals uses internally), so there's exactly one implementation of
// each formula.
// ═══════════════════════════════════════════════════════════════════════════
test('9. Centralized page-level totals', async (t) => {
  await t.test('totalAccountBalance updates immediately after create, edit, and delete', () => {
    let accounts = [];
    assert.equal(PC.totalAccountBalance(accounts), 0, 'empty state, no NaN');

    accounts = [...accounts, { id: 1, name: 'Cuenta A', type: 'bank', balance: 500 }]; // create
    assert.equal(PC.totalAccountBalance(accounts), 500);

    accounts = [...accounts, { id: 2, name: 'Cuenta B', type: 'cash', balance: 200 }]; // create
    assert.equal(PC.totalAccountBalance(accounts), 700);

    accounts = accounts.map(a => a.id === 1 ? { ...a, balance: 650 } : a); // edit
    assert.equal(PC.totalAccountBalance(accounts), 850, '650 + 200');

    accounts = accounts.filter(a => a.id !== 2); // delete
    assert.equal(PC.totalAccountBalance(accounts), 650);
  });

  await t.test('totalWalletBalance updates immediately after deposit and delete', () => {
    let wallets = [{ id: 3, name: 'Vacaciones', balance: 100, goal: 1000, monthly: 0 }];
    assert.equal(PC.totalWalletBalance(wallets), 100);

    // "Edit" a wallet's balance the same way PC.deposit does (credit in place).
    wallets = wallets.map(w => w.id === 3 ? { ...w, balance: w.balance + 50 } : w); // deposit
    assert.equal(PC.totalWalletBalance(wallets), 150);

    wallets = [...wallets, { id: 4, name: 'Emergencia', balance: 300, goal: 500, monthly: 0 }]; // create
    assert.equal(PC.totalWalletBalance(wallets), 450);

    wallets = wallets.filter(w => w.id !== 4); // delete
    assert.equal(PC.totalWalletBalance(wallets), 150);
  });

  await t.test('totalActiveDebt updates immediately after create, payment, edit, and delete', () => {
    let debts = [];
    assert.equal(PC.totalActiveDebt(debts), 0);

    debts = [...debts, { id: 5, name: 'Tarjeta', total: 1000, paid: 200, status: 'activa' }]; // create
    assert.equal(PC.totalActiveDebt(debts), 800, '1000 - 200 remaining');

    debts = [...debts, { id: 6, name: 'Auto', total: 5000, paid: 5000, status: 'pagada' }]; // create, already paid
    assert.equal(PC.totalActiveDebt(debts), 800, 'fully paid debts are excluded');

    debts = debts.map(d => d.id === 5 ? { ...d, paid: 500 } : d); // payment
    assert.equal(PC.totalActiveDebt(debts), 500, '1000 - 500');

    debts = debts.map(d => d.id === 5 ? { ...d, total: 1200 } : d); // edit (total renegotiated)
    assert.equal(PC.totalActiveDebt(debts), 700, '1200 - 500');

    debts = debts.filter(d => d.id !== 6); // delete the already-paid one — no effect, it wasn't counted
    assert.equal(PC.totalActiveDebt(debts), 700);

    debts = debts.filter(d => d.id !== 5); // delete the active one
    assert.equal(PC.totalActiveDebt(debts), 0);
  });

  await t.test('dashboardTotals uses the exact same helpers — one source of truth', () => {
    const accounts = [{ id: 1, name: 'A', balance: 300 }];
    const wallets = [{ id: 2, name: 'W', balance: 150, goal: 0, monthly: 0 }];
    const debts = [{ id: 3, name: 'D', total: 400, paid: 100, status: 'activa' }];
    let s = PC.resetToDefault();
    s = { ...s, accounts, wallets, debts };
    const d = PC.dashboardTotals(s);
    assert.equal(d.totalAvailable, PC.totalAccountBalance(accounts));
    assert.equal(d.totalSavings, PC.totalWalletBalance(wallets));
    assert.equal(d.totalDebt, PC.totalActiveDebt(debts));
  });

  await t.test('Perita.jsx source calls the centralized helpers instead of duplicating the formulas', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'Perita.jsx'), 'utf8');
    assert.match(src, /PeritaCore\.totalAccountBalance\(/, 'AccountsPage total must call the centralized helper');
    assert.match(src, /PeritaCore\.totalWalletBalance\(/, 'Wallets/Ahorros total must call the centralized helper');
    assert.match(src, /PeritaCore\.totalActiveDebt\(/, 'DebtTracker total must call the centralized helper');
    assert.doesNotMatch(src, /accounts\.reduce\(\(s,a\)=>s\+a\.balance,0\)/, 'the old duplicated AccountsPage formula must be gone');
    assert.doesNotMatch(src, /wallets\.reduce\(\(a,w\)=>a\+w\.balance,0\)/, 'the old duplicated Wallets formula must be gone');
    assert.doesNotMatch(src, /activeDebts\.reduce\(\(a,d\)=>a\+\(d\.total-d\.paid\),0\)/, 'the old duplicated DebtTracker formula must be gone');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Month-closing flow — full validation matrix (configured salary + 2
// additional incomes, 3 fixed, 3 variable, 1 debt payment, 1 savings
// deposit), the salary snapshot stamped at close, immutability of the
// archive, and the double-close guard.
// ═══════════════════════════════════════════════════════════════════════════
test('10. Month-closing flow', async (t) => {
  function buildValidationMatrixMonth() {
    let s = seedState(); // settings.salary=1000, account bal 500, debt 1000/200, wallet 100/1000, budget Arriendo 300
    s = { ...s, budget: [...s.budget, { id: 20, name: 'Luz', amount: 30 }, { id: 21, name: 'Internet', amount: 20 }] };
    // Salary is never entered as a transaction (rule 4) — only the two
    // additional-income transactions below appear in expenses.
    s = PC.addTransaction(s, { date: '2026-07-02', description: 'Freelance', amount: 150, type: 'income', account: 1 }); // additional income 1
    s = PC.addTransaction(s, { date: '2026-07-03', description: 'Bono', amount: 50, type: 'income', account: 1 }); // additional income 2
    s = PC.addTransaction(s, { date: '2026-07-04', description: 'Super', amount: 60, type: 'expense' });
    s = PC.addTransaction(s, { date: '2026-07-05', description: 'Bencina', amount: 40, type: 'expense' });
    s = PC.addTransaction(s, { date: '2026-07-06', description: 'Ocio', amount: 25, type: 'expense' });
    s = PC.toggleFijoPagado(s, s.budget[0], '2026-07-07'); // Arriendo 300
    s = PC.toggleFijoPagado(s, s.budget[1], '2026-07-07'); // Luz 30
    s = PC.toggleFijoPagado(s, s.budget[2], '2026-07-07'); // Internet 20
    s = PC.registerDebtPayment(s, 2, 100, '2026-07-08');
    s = PC.deposit(s, 3, 70, null, '2026-07-09');
    return s;
  }

  await t.test('validation matrix: every value in the pre-close summary matches expected math, salary added exactly once', () => {
    const s = buildValidationMatrixMonth();
    const mt = PC.monthTotals(s.activeMonth, s.settings.salary);
    const d = PC.dashboardTotals(s);
    // Total income = configured salary (1000) + 2 additional incomes (150 + 50) = 1200.
    assert.equal(mt.salary, 1000);
    assert.equal(mt.additionalIncome, 200, '150 + 50');
    assert.equal(mt.ingresos, 1200, '1000 configured salary + 200 additional income');
    assert.equal(mt.variables, 125, '60 + 40 + 25');
    assert.equal(mt.fijos, 350, '300 + 30 + 20');
    assert.equal(mt.deudas, 100);
    assert.equal(mt.ahorros, 70);
    assert.equal(mt.sobrante, 1200 - 350 - 125 - 70 - 100, '= 555, the final monthly balance');
    assert.equal(d.remaining, mt.sobrante, 'dashboard "remaining" is the exact same value the pre-close summary shows');
  });

  await t.test('9. archived month contains the exact totals shown before confirmation, stores the salary snapshot, and the new month starts clean', () => {
    const s = buildValidationMatrixMonth();
    const preCloseTotals = PC.monthTotals(s.activeMonth, s.settings.salary);
    const closed = PC.closeMonth(s, '2026-07-31T00:00:00Z', '2026-07');
    const archived = closed.monthlyHistory[closed.monthlyHistory.length - 1];

    assert.equal(archived.salary, 1000, 'the configured salary in effect at close time is stamped into the snapshot (rule 6)');
    assert.deepEqual(PC.monthTotals(archived), preCloseTotals, 'archived totals match the pre-close summary exactly');
    assert.equal(archived.expenses.length, 5, '2 additional-income + 3 variable expenses (salary is never a transaction)');
    assert.equal(archived.expenses.filter(e => e.type === 'income').length, 2, 'only the 2 additional-income transactions');
    assert.equal(archived.expenses.filter(e => e.type === 'expense').length, 3, '3 variable expenses');
    assert.equal(archived.gastosFijosPagados.length, 3);
    assert.equal(archived.pagosDeuda.length, 1);
    assert.equal(archived.aportesAhorro.length, 1);
    assert.equal(archived.closedAt, '2026-07-31T00:00:00Z');

    assert.equal(closed.activeMonth.month, '2026-08', 'new month starts');
    assert.equal(closed.activeMonth.expenses.length, 0);
    assert.equal(closed.activeMonth.pagosDeuda.length, 0);
    assert.equal(closed.activeMonth.aportesAhorro.length, 0);
    assert.equal(closed.activeMonth.gastosFijosPagados.length, 0);
    const newDash = PC.dashboardTotals(closed);
    assert.equal(newDash.additionalIncome, 0, 'new active-month dashboard starts with no additional income, no carryover');
    assert.equal(newDash.totalIncomeDash, 1000, 'the new month still uses the current configured salary (rule 8) — not zero');

    // Rollover review, evidenced by the assertions above and BUSINESS_RULES.md:
    // income/variable/debt-payment/savings-deposit LOGS reset (not carried over
    // — they're this-month transactional records); fixed-expense PAID STATUS
    // resets (a new month's rent hasn't been paid yet); but the underlying
    // permanent definitions/balances are untouched by closeMonth:
    assert.equal(closed.accounts.find(a => a.id === 1).balance, 500 + 150 + 50, 'account balance carries only the real cash movement from additional-income transactions — salary was never deposited as one');
    assert.equal(closed.debts.find(d2 => d2.id === 2).paid, 300, '200 + 100 — the debt\'s accumulated paid amount persists');
    assert.equal(closed.wallets.find(w => w.id === 3).balance, 170, '100 + 70 — wallet balance persists');
    assert.equal(closed.budget.length, 3, 'fixed-expense definitions (name/amount) persist — only their paid-this-month flag resets');
    assert.deepEqual(closed.settings, { salary: 1000 }, 'settings, including salary, untouched');
  });

  await t.test('changing settings.salary after closing does not affect the archived month', () => {
    const s = buildValidationMatrixMonth();
    const closed = PC.closeMonth(s, '2026-07-31T00:00:00Z', '2026-07');
    const totalsBefore = PC.monthTotals(closed.monthlyHistory[0]);
    const afterSalaryChange = { ...closed, settings: { salary: 999999 } };
    const totalsAfter = PC.monthTotals(afterSalaryChange.monthlyHistory[0]);
    assert.deepEqual(totalsAfter, totalsBefore, 'archived month totals resolve salary from their own stored snapshot, never from live settings.salary');
  });

  await t.test('editing current accounts, debts, wallets, or settings after closing does not alter the archived snapshot', () => {
    const s = buildValidationMatrixMonth();
    const closed = PC.closeMonth(s, '2026-07-31T00:00:00Z', '2026-07');
    const archivedBefore = JSON.parse(JSON.stringify(closed.monthlyHistory[0]));

    const mutated = {
      ...closed,
      accounts: closed.accounts.map(a => ({ ...a, balance: a.balance + 99999 })),
      debts: closed.debts.map(d => ({ ...d, paid: 0, status: 'activa' })),
      wallets: closed.wallets.map(w => ({ ...w, balance: 0 })),
      settings: { salary: 1 },
    };
    assert.deepEqual(mutated.monthlyHistory[0], archivedBefore, 'the archived snapshot is a separate object graph — unaffected by later edits to live accounts/debts/wallets/settings');
  });

  await t.test('older archived months remain unchanged when a later month is closed', () => {
    let s = buildValidationMatrixMonth();
    let closed = PC.closeMonth(s, '2026-07-31T00:00:00Z', '2026-07');
    const firstArchived = closed.monthlyHistory[0];

    // A second month of different activity (settings.salary still 1000), then close it too.
    let s2 = PC.addTransaction(closed, { date: '2026-08-01', description: 'Bono', amount: 2000, type: 'income', account: 1 });
    const closed2 = PC.closeMonth(s2, '2026-08-31T00:00:00Z', '2026-08');

    assert.equal(closed2.monthlyHistory.length, 2, 'both months archived');
    assert.deepEqual(closed2.monthlyHistory[0], firstArchived, 'the first archived month is untouched by closing the second');
    assert.equal(closed2.monthlyHistory[1].salary, 1000, 'second month\'s snapshot stores the salary in effect when it was closed');
    assert.equal(PC.monthTotals(closed2.monthlyHistory[1]).ingresos, 3000, '1000 configured salary + 2000 additional income');
  });

  await t.test('double-close guard: a second closeMonth call with a stale expectedMonth is a safe no-op', () => {
    const s = buildValidationMatrixMonth();
    const firstClose = PC.closeMonth(s, '2026-07-31T00:00:00Z', '2026-07'); // curMonth captured as '2026-07' at modal-open time
    assert.equal(firstClose.monthlyHistory.length, 1);
    assert.equal(firstClose.activeMonth.month, '2026-08');

    // Simulates a second, stray invocation from a double-click — same
    // expectedMonth ('2026-07'), but the state has already moved on to August.
    const secondAttempt = PC.closeMonth(firstClose, '2026-07-31T00:00:00Z', '2026-07');
    assert.equal(secondAttempt, firstClose, 'no-op — same reference, not just equal values');
    assert.equal(secondAttempt.monthlyHistory.length, 1, 'no duplicate archive entry');
    assert.equal(secondAttempt.activeMonth.month, '2026-08', 'calendar did not advance a second time');
  });

  await t.test('double-close guard does not interfere with a normal, single close (expectedMonth matches)', () => {
    const s = buildValidationMatrixMonth();
    const closed = PC.closeMonth(s, '2026-07-31T00:00:00Z', s.activeMonth.month);
    assert.equal(closed.monthlyHistory.length, 1);
    assert.equal(closed.activeMonth.month, '2026-08');
  });

  await t.test('closeMonth without expectedMonth (backward compatible) behaves exactly as before', () => {
    const s = buildValidationMatrixMonth();
    const closed = PC.closeMonth(s, '2026-07-31T00:00:00Z');
    assert.equal(closed.monthlyHistory.length, 1);
    assert.equal(closed.activeMonth.month, '2026-08');
  });

  await t.test('empty-month close is safe: no NaN, no missing fields, no corrupted history', () => {
    let s = PC.resetToDefault(); // nothing at all — no accounts, no debts, no wallets, no budget, salary 0
    const closed = PC.closeMonth(s, '2026-07-31T00:00:00Z', s.activeMonth.month);
    const archived = closed.monthlyHistory[0];
    const mt = PC.monthTotals(archived);
    for (const [key, val] of Object.entries(mt)) assert.ok(Number.isFinite(val), `${key} should be finite, got ${val}`);
    assert.deepEqual(archived.expenses, []);
    assert.deepEqual(archived.pagosDeuda, []);
    assert.deepEqual(archived.aportesAhorro, []);
    assert.deepEqual(archived.gastosFijosPagados, []);
    assert.ok(archived.closedAt);
    assert.equal(closed.activeMonth.expenses.length, 0);
    assert.equal(PC.dashboardTotals(closed).remaining, 0);

    // Closing the (now-empty) new month again immediately must also be safe and not duplicate anything.
    const closedTwice = PC.closeMonth(closed, '2026-08-31T00:00:00Z', closed.activeMonth.month);
    assert.equal(closedTwice.monthlyHistory.length, 2, 'a second, genuinely different month closes normally');
  });

  await t.test('10. archived month visualization: a pre-existing archive with no stored salary field (created before Session 9) is still safe to render', () => {
    // Simulates an archived month from before the salary-snapshot mechanism existed.
    const legacyArchived = {
      month: '2026-05',
      expenses: [{ id: 1, type: 'income', amount: 400, date: '2026-05-01' }],
      pagosDeuda: [], aportesAhorro: [], gastosFijosPagados: [],
      closedAt: '2026-05-31T00:00:00Z',
      // no `salary` field at all
    };
    const mt = PC.monthTotals(legacyArchived);
    for (const [key, val] of Object.entries(mt)) assert.ok(Number.isFinite(val), `${key} should be finite, got ${val}`);
    assert.equal(mt.salary, 0, 'a pre-existing archive with no stored salary resolves to 0, never guessing at today\'s configured salary');
    assert.equal(mt.additionalIncome, 400, 'the transactions it does have are still counted correctly');
    assert.equal(mt.ingresos, 400);
  });

  await t.test('Perita.jsx source shows the stored-salary caveat for legacy archives lacking the field', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'Perita.jsx'), 'utf8');
    assert.match(src, /detail\.salary == null/, 'HistorialMensual must detect legacy archives with no stored salary and show a caveat');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Persistence and migration
// ═══════════════════════════════════════════════════════════════════════════
test('11. Persistence and migration', async (t) => {
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

// ═══════════════════════════════════════════════════════════════════════════
// V1.1.0 account-ledger foundation — intentionally separate from perita_v1
// ═══════════════════════════════════════════════════════════════════════════
test('V1.1.0 account-ledger foundation', async (t) => {
  const addAccount = (state, data = {}) => PC.addV110Account(state, {
    name: data.name || 'Cuenta',
    type: data.type || 'bank',
    initialBalance: data.initialBalance == null ? 0 : data.initialBalance,
    active: data.active,
  });
  const seedV110Domains = () => {
    let state = addAccount(PC.makeV110Default(), {
      name: 'Principal',
      initialBalance: 100,
    });
    state = addAccount(state, {
      name: 'Secundaria',
      initialBalance: 20,
    });
    return {
      ...state,
      debts: [{
        id: 3,
        name: 'Tarjeta',
        total: 500,
        paid: 100,
        monthly: 50,
        dueDate: '2026-08-10',
        status: 'activa',
      }],
      wallets: [{
        id: 4,
        emoji: '💰',
        name: 'Viaje',
        bank: 'Banco Estado',
        balance: 200,
        monthly: 20,
        goal: 1000,
      }],
      budget: [{ id: 5, name: 'Arriendo', amount: 30 }],
      nextId: 6,
      activeMonth: {
        ...state.activeMonth,
        month: '2026-08',
      },
    };
  };

  await t.test('new schema starts empty and accounts keep only an initial balance', () => {
    let s = PC.makeV110Default();
    assert.deepEqual(s, {
      schemaVersion: '1.1.0',
      settings: { salary: 0 },
      accounts: [],
      accountMovements: [],
      debts: [],
      wallets: [],
      budget: [],
      varCategories: [],
      nextId: 1,
      nextMovementId: 1,
      activeMonth: {
        month: PC.curMonthId(),
        salary: 0,
        expenses: [],
        pagosDeuda: [],
        aportesAhorro: [],
        gastosFijosPagados: [],
      },
      monthlyHistory: [],
    });
    assert.equal(Object.hasOwn(s, 'expenses'), false, 'monthly transactions have one canonical location');
    assert.equal(Object.hasOwn(s, 'nextAccountId'), false, 'all non-movement entities share the global counter');

    s = addAccount(s, { name: 'Principal', initialBalance: 500 });
    assert.deepEqual(s.accounts[0], {
      id: 1,
      name: 'Principal',
      type: 'bank',
      bank: '',
      initialBalance: 500,
      active: true,
    });
    assert.equal(Object.hasOwn(s.accounts[0], 'balance'), false, 'current balance is derived, never stored');
    assert.equal(PC.v110AccountBalance(s, 1), 500);
  });

  await t.test('isolated persistence loads empty storage as a fresh V1.1.0 state', () => {
    assert.deepEqual(PC.loadV110(null), PC.makeV110Default());
    assert.deepEqual(PC.loadV110(''), PC.makeV110Default());
  });

  await t.test('reference salary and active-month salary are independent values', () => {
    const startedFromReference = PC.loadV110(JSON.stringify({
      schemaVersion: '1.1.0',
      settings: { salary: 1000 },
    }));
    const state = {
      ...startedFromReference,
      settings: { salary: 1000 },
      activeMonth: {
        ...startedFromReference.activeMonth,
        salary: 850,
      },
    };

    assert.equal(startedFromReference.activeMonth.salary, 1000);
    assert.deepEqual(startedFromReference.accountMovements, []);
    assert.equal(state.settings.salary, 1000);
    assert.equal(state.activeMonth.salary, 850);
  });

  await t.test('editing the active-month salary does not change the reference or movements', () => {
    let state = addAccount(PC.makeV110Default(), { initialBalance: 100 });
    state = {
      ...state,
      settings: { salary: 1000 },
    };
    state = PC.createV110Transaction(state, {
      accountId: 1,
      date: '2026-08-01',
      amount: 50,
      type: 'income',
    });
    const movements = state.accountMovements;
    const edited = PC.setV110ActiveMonthSalary(state, 875);

    assert.equal(edited.activeMonth.salary, 875);
    assert.equal(edited.settings.salary, 1000);
    assert.equal(edited.accountMovements, movements);
    assert.equal(state.activeMonth.salary, 0, 'input state is not mutated');
  });

  await t.test('closing archives the exact active salary and starts the next month from the reference', () => {
    let state = addAccount(PC.makeV110Default(), { initialBalance: 100 });
    state = {
      ...state,
      settings: { salary: 1200 },
      activeMonth: {
        ...state.activeMonth,
        month: '2026-08',
        salary: 950,
      },
    };
    state = PC.createV110Transaction(state, {
      accountId: 1,
      date: '2026-08-05',
      amount: 200,
      description: 'Freelance',
      type: 'income',
    });
    const movements = state.accountMovements;
    const closed = PC.closeV110Month(
      state,
      '2026-08-31T23:00:00.000Z',
      '2026-08'
    );

    assert.equal(closed.monthlyHistory.length, 1);
    assert.equal(closed.monthlyHistory[0].salary, 950);
    assert.equal(closed.monthlyHistory[0].expenses.length, 1);
    assert.equal(closed.monthlyHistory[0].expenses[0].type, 'income');
    assert.equal(closed.monthlyHistory[0].expenses[0].amount, 200);
    assert.equal(closed.activeMonth.month, '2026-09');
    assert.equal(closed.activeMonth.salary, 1200);
    assert.deepEqual(closed.activeMonth.expenses, []);
    assert.deepEqual(closed.activeMonth.pagosDeuda, []);
    assert.deepEqual(closed.activeMonth.aportesAhorro, []);
    assert.deepEqual(closed.activeMonth.gastosFijosPagados, []);
    assert.equal(closed.settings.salary, 1200);
    assert.equal(closed.accountMovements, movements);
    assert.equal(closed.accountMovements.length, 1);
  });

  await t.test('salary lifecycle actions never turn salary into additional income or an account movement', () => {
    const initial = {
      ...PC.makeV110Default(),
      settings: { salary: 700 },
      activeMonth: {
        ...PC.makeV110Default().activeMonth,
        month: '2026-10',
        salary: 650,
      },
    };
    const edited = PC.setV110ActiveMonthSalary(initial, 675);
    const closed = PC.closeV110Month(
      edited,
      '2026-10-31T23:00:00.000Z',
      '2026-10'
    );

    assert.deepEqual(initial.accountMovements, []);
    assert.deepEqual(edited.accountMovements, []);
    assert.deepEqual(closed.accountMovements, []);
    assert.deepEqual(edited.activeMonth.expenses, []);
    assert.deepEqual(closed.monthlyHistory[0].expenses, []);
    assert.equal(closed.monthlyHistory[0].salary, 675);
    assert.equal(closed.activeMonth.salary, 700);
  });

  await t.test('active and archived salaries round-trip and invalid salaries fail closed', () => {
    const valid = {
      ...PC.makeV110Default(),
      settings: { salary: 1000 },
      activeMonth: {
        ...PC.makeV110Default().activeMonth,
        month: '2026-08',
        salary: 900,
      },
      monthlyHistory: [{
        month: '2026-07',
        salary: 800,
        expenses: [],
        pagosDeuda: [],
        aportesAhorro: [],
        gastosFijosPagados: [],
        closedAt: '2026-07-31T23:00:00.000Z',
      }],
    };

    assert.deepEqual(PC.loadV110(PC.serializeV110(valid)), valid);
    for (const invalidSalary of [-1, null, '1000']) {
      const invalidActive = {
        ...valid,
        activeMonth: { ...valid.activeMonth, salary: invalidSalary },
      };
      const invalidHistory = {
        ...valid,
        monthlyHistory: [{ ...valid.monthlyHistory[0], salary: invalidSalary }],
      };
      assert.deepEqual(PC.loadV110(JSON.stringify(invalidActive)), PC.makeV110Default());
      assert.deepEqual(PC.loadV110(JSON.stringify(invalidHistory)), PC.makeV110Default());
      assert.throws(
        () => PC.serializeV110(invalidActive),
        (error) => error.name === 'V110ValidationError' && error.code === 'INVALID_AMOUNT'
      );
    }
  });

  await t.test('isolated persistence round-trips every canonical application domain', () => {
    const s = {
      schemaVersion: '1.1.0',
      settings: { salary: 1000 },
      accounts: [{
        id: 1, name: 'Principal', type: 'bank', bank: 'Banco Estado',
        initialBalance: 100, active: true,
      }],
      accountMovements: [
        { id: 1, accountId: 1, date: '2026-07-02', amount: 300, type: 'credit', operationRef: 'transaction:11' },
        { id: 2, accountId: 1, date: '2026-08-01', amount: 25, type: 'credit', operationRef: 'transaction:6' },
        { id: 3, accountId: 1, date: '2026-08-02', amount: 10, type: 'debit', operationRef: 'transaction:7' },
        { id: 4, accountId: 1, date: '2026-08-03', amount: 15, type: 'debit', operationRef: 'debt-payment:8' },
        { id: 5, accountId: 1, date: '2026-08-04', amount: 20, type: 'debit', operationRef: 'saving-deposit:9' },
        { id: 6, accountId: 1, date: '2026-08-05', amount: 30, type: 'debit', operationRef: 'fixed-payment:10' },
        { id: 7, accountId: 1, date: '2026-07-03', amount: 25, type: 'debit', operationRef: 'debt-payment:12' },
        { id: 8, accountId: 1, date: '2026-07-04', amount: 20, type: 'debit', operationRef: 'saving-deposit:13' },
        { id: 9, accountId: 1, date: '2026-07-05', amount: 300, type: 'debit', operationRef: 'fixed-payment:14' },
      ],
      debts: [{
        id: 2, name: 'Tarjeta', total: 500, paid: 100, monthly: 50,
        dueDate: '2026-08-10', status: 'activa',
      }],
      wallets: [{
        id: 3, emoji: '💰', name: 'Viaje', bank: 'Banco Estado',
        balance: 200, monthly: 20, goal: 1000,
      }],
      budget: [{ id: 4, name: 'Arriendo', amount: 300 }],
      varCategories: [{ id: 5, name: 'Comida' }],
      nextId: 15,
      nextMovementId: 10,
      activeMonth: {
        month: '2026-08',
        salary: 850,
        expenses: [
          {
            id: 6, date: '2026-08-01', amount: 25, description: 'Bono',
            type: 'income', accountId: 1, category: 'Ingreso', method: '', notes: '',
          },
          {
            id: 7, date: '2026-08-02', amount: 10, description: 'Almuerzo',
            type: 'expense', accountId: 1, category: 'Comida', method: '', notes: '',
          },
        ],
        pagosDeuda: [{
          id: 8, date: '2026-08-03', amount: 15, debtId: 2,
          debtName: 'Tarjeta', accountId: 1,
        }],
        aportesAhorro: [{
          id: 9, date: '2026-08-04', amount: 20, walletId: 3,
          walletName: 'Viaje', accountId: 1,
        }],
        gastosFijosPagados: [{
          id: 10, date: '2026-08-05', amount: 30, budgetId: 4,
          name: 'Arriendo', accountId: 1,
        }],
      },
      monthlyHistory: [{
        month: '2026-07',
        expenses: [{
          id: 11, date: '2026-07-02', amount: 300, description: 'Freelance',
          type: 'income', accountId: 1, category: 'Ingreso', method: '', notes: '',
        }],
        pagosDeuda: [{
          id: 12, date: '2026-07-03', amount: 25, debtId: 2,
          debtName: 'Tarjeta', accountId: 1,
        }],
        aportesAhorro: [{
          id: 13, date: '2026-07-04', amount: 20, walletId: 3,
          walletName: 'Viaje', accountId: 1,
        }],
        gastosFijosPagados: [{
          id: 14, date: '2026-07-05', amount: 300, budgetId: 4,
          name: 'Arriendo', accountId: 1,
        }],
        salary: 900,
        closedAt: '2026-07-31T23:00:00.000Z',
      }],
    };

    const raw = PC.serializeV110(s);
    const loaded = PC.loadV110(raw);

    assert.deepEqual(loaded, s);
    assert.notEqual(loaded, s);
    assert.notEqual(loaded.accounts, s.accounts);
    assert.notEqual(loaded.accounts[0], s.accounts[0]);
    assert.notEqual(loaded.accountMovements, s.accountMovements);
    assert.notEqual(loaded.accountMovements[0], s.accountMovements[0]);
    assert.notEqual(loaded.settings, s.settings);
    assert.notEqual(loaded.activeMonth, s.activeMonth);
    assert.notEqual(loaded.activeMonth.expenses, s.activeMonth.expenses);
    assert.notEqual(loaded.monthlyHistory, s.monthlyHistory);
    assert.notEqual(loaded.monthlyHistory[0], s.monthlyHistory[0]);
  });

  await t.test('invalid JSON, missing schema, and other schema versions start empty', () => {
    for (const raw of [
      '{not-json',
      JSON.stringify({ accounts: [] }),
      JSON.stringify({ schemaVersion: '1.0.0', accounts: [] }),
      JSON.stringify({ schemaVersion: '1.2.0', accounts: [] }),
    ]) {
      assert.deepEqual(PC.loadV110(raw), PC.makeV110Default());
    }
  });

  await t.test('valid partial V1.1.0 state receives independent defaults', () => {
    const first = PC.loadV110(JSON.stringify({
      schemaVersion: '1.1.0',
      accounts: [{ id: 4, name: 'Parcial' }],
    }));
    const second = PC.loadV110(JSON.stringify({ schemaVersion: '1.1.0' }));

    assert.deepEqual(first, {
      ...PC.makeV110Default(),
      accounts: [{
        id: 4,
        name: 'Parcial',
        type: 'bank',
        bank: '',
        initialBalance: 0,
        active: true,
      }],
      nextId: 5,
    });
    first.settings.salary = 123;
    first.accounts.push({ id: 99 });
    first.accountMovements.push({ id: 99 });
    first.activeMonth.expenses.push({ id: 100 });
    first.monthlyHistory.push({ month: '2099-01' });
    assert.deepEqual(second, PC.makeV110Default(), 'default arrays are never shared across loads');
  });

  await t.test('stale counters advance beyond IDs in permanent, monthly, historical, and ledger data', () => {
    const loaded = PC.loadV110(JSON.stringify({
      schemaVersion: '1.1.0',
      accounts: [{ id: 7, name: 'Cuenta', initialBalance: 0, active: true }],
      wallets: [{ id: 20, name: 'Ahorro' }],
      accountMovements: [{
        id: 12,
        accountId: 7,
        date: '2026-08-01',
        amount: 10,
        type: 'adjustment',
        operationRef: 'adjustment:existing',
      }, {
        id: 13,
        accountId: 7,
        date: '2026-07-01',
        amount: 10,
        type: 'credit',
        operationRef: 'transaction:40',
      }],
      activeMonth: { month: '2026-08' },
      monthlyHistory: [{
        month: '2026-07',
        expenses: [{
          id: 40,
          accountId: 7,
          date: '2026-07-01',
          amount: 10,
          type: 'income',
        }],
      }],
      nextId: 2,
      nextMovementId: 3,
    }));

    assert.equal(loaded.nextId, 41);
    assert.equal(loaded.nextMovementId, 14);
    const withAccount = addAccount(loaded);
    assert.equal(withAccount.accounts.at(-1).id, 41);
    const withMovement = PC.createV110Transaction(withAccount, {
      accountId: 41,
      date: '2026-08-02',
      amount: 20,
      type: 'expense',
    });
    assert.equal(withMovement.accountMovements.at(-1).id, 14);
  });

  await t.test('invalid complete-state domains and conflicting V1.0 fields fail closed', () => {
    const validAccount = {
      id: 1, name: 'Cuenta', type: 'bank', bank: '',
      initialBalance: 100, active: true,
    };
    const invalidStates = [
      { schemaVersion: '1.1.0', settings: { salary: -1 } },
      { schemaVersion: '1.1.0', wallets: {} },
      {
        schemaVersion: '1.1.0',
        accounts: [validAccount],
        debts: [{ id: 2, total: 100, paid: 101 }],
      },
      {
        schemaVersion: '1.1.0',
        accounts: [validAccount],
        wallets: [{ id: 1 }],
      },
      {
        schemaVersion: '1.1.0',
        accounts: [validAccount],
        activeMonth: {
          month: '2026-08',
          expenses: [{
            id: 2, accountId: 999, date: '2026-08-01',
            amount: 10, type: 'expense',
          }],
        },
      },
      {
        schemaVersion: '1.1.0',
        accounts: [validAccount],
        activeMonth: {
          month: '2026-08',
          expenses: [{
            id: 2, accountId: 1, date: '2026-08-32',
            amount: 10, type: 'expense',
          }],
        },
      },
      {
        schemaVersion: '1.1.0',
        activeMonth: { month: '2026-08' },
        monthlyHistory: [{ month: '2026-08' }],
      },
      { schemaVersion: '1.1.0', expenses: [] },
      { schemaVersion: '1.1.0', nextAccountId: 1 },
      { schemaVersion: '1.1.0', accounts: [{ ...validAccount, balance: 100 }] },
      {
        schemaVersion: '1.1.0',
        accounts: [validAccount],
        activeMonth: {
          month: '2026-08',
          expenses: [{
            id: 2, accountId: 1, account: '1', date: '2026-08-01',
            amount: 10, type: 'expense',
          }],
        },
      },
    ];

    for (const invalid of invalidStates) {
      assert.deepEqual(PC.loadV110(JSON.stringify(invalid)), PC.makeV110Default());
    }
    assert.throws(
      () => PC.serializeV110(invalidStates.at(-1)),
      (error) => error.name === 'V110ValidationError' && error.code === 'CONFLICTING_FIELD'
    );
  });

  await t.test('creating every monthly operation atomically creates one deterministic movement', () => {
    let state = seedV110Domains();
    state = PC.createV110Transaction(state, {
      accountId: 1,
      date: '2026-08-01',
      amount: 250,
      type: 'income',
      description: 'Freelance',
    });
    state = PC.createV110Transaction(state, {
      accountId: 1,
      date: '2026-08-02',
      amount: 40,
      type: 'expense',
      description: 'Comida',
    });
    state = PC.createV110FixedPayment(state, {
      budgetId: 5,
      accountId: 1,
      date: '2026-08-03',
    });
    state = PC.createV110DebtPayment(state, {
      debtId: 3,
      accountId: 1,
      date: '2026-08-04',
      amount: 15,
    });
    state = PC.createV110SavingDeposit(state, {
      walletId: 4,
      accountId: 1,
      date: '2026-08-05',
      amount: 20,
    });

    assert.deepEqual(
      state.accountMovements.map(({ operationRef, type, accountId, date, amount }) => ({
        operationRef, type, accountId, date, amount,
      })),
      [
        { operationRef: 'transaction:6', type: 'credit', accountId: 1, date: '2026-08-01', amount: 250 },
        { operationRef: 'transaction:7', type: 'debit', accountId: 1, date: '2026-08-02', amount: 40 },
        { operationRef: 'fixed-payment:8', type: 'debit', accountId: 1, date: '2026-08-03', amount: 30 },
        { operationRef: 'debt-payment:9', type: 'debit', accountId: 1, date: '2026-08-04', amount: 15 },
        { operationRef: 'saving-deposit:10', type: 'debit', accountId: 1, date: '2026-08-05', amount: 20 },
      ]
    );
    assert.equal(state.activeMonth.expenses.length, 2);
    assert.equal(state.activeMonth.gastosFijosPagados.length, 1);
    assert.equal(state.activeMonth.pagosDeuda.length, 1);
    assert.equal(state.activeMonth.aportesAhorro.length, 1);
    assert.equal(state.debts[0].paid, 115);
    assert.equal(state.wallets[0].balance, 220);
    assert.equal(PC.v110AccountBalance(state, 1), 245);
  });

  await t.test('editing a transaction preserves its identity while changing account and direction', () => {
    let state = seedV110Domains();
    state = PC.createV110Transaction(state, {
      accountId: 1,
      date: '2026-08-01',
      amount: 50,
      type: 'income',
    });
    const id = state.activeMonth.expenses[0].id;
    const movementId = state.accountMovements[0].id;
    const edited = PC.editV110Transaction(state, id, {
      accountId: 2,
      date: '2026-08-03',
      amount: 30,
      type: 'expense',
    });

    assert.equal(edited.activeMonth.expenses[0].id, id);
    assert.equal(edited.accountMovements[0].id, movementId);
    assert.equal(edited.accountMovements[0].operationRef, `transaction:${id}`);
    assert.equal(edited.accountMovements[0].type, 'debit');
    assert.equal(edited.accountMovements[0].accountId, 2);
    assert.equal(PC.v110AccountBalance(edited, 1), 100);
    assert.equal(PC.v110AccountBalance(edited, 2), -10);
    assert.equal(PC.v110AccountBalance(state, 1), 150, 'input state remains unchanged');
  });

  await t.test('deleting transactions and fixed payments removes both operation and movement', () => {
    let state = seedV110Domains();
    state = PC.createV110Transaction(state, {
      accountId: 1,
      date: '2026-08-01',
      amount: 25,
      type: 'expense',
    });
    const transactionId = state.activeMonth.expenses[0].id;
    state = PC.deleteV110Transaction(state, transactionId);
    assert.deepEqual(state.activeMonth.expenses, []);
    assert.deepEqual(state.accountMovements, []);

    state = PC.createV110FixedPayment(state, {
      budgetId: 5,
      accountId: 1,
      date: '2026-08-02',
    });
    const paymentId = state.activeMonth.gastosFijosPagados[0].id;
    state = PC.editV110FixedPayment(state, paymentId, {
      accountId: 2,
      date: '2026-08-03',
      amount: 35,
    });
    assert.deepEqual(
      state.accountMovements[0],
      {
        id: 2,
        accountId: 2,
        date: '2026-08-03',
        amount: 35,
        type: 'debit',
        operationRef: `fixed-payment:${paymentId}`,
      }
    );
    state = PC.deleteV110FixedPayment(state, paymentId);
    assert.deepEqual(state.activeMonth.gastosFijosPagados, []);
    assert.deepEqual(state.accountMovements, []);
  });

  await t.test('debt payment create, edit, and delete reconcile debt.paid atomically', () => {
    let state = seedV110Domains();
    state = PC.createV110DebtPayment(state, {
      debtId: 3,
      accountId: 1,
      date: '2026-08-01',
      amount: 40,
    });
    const id = state.activeMonth.pagosDeuda[0].id;
    assert.equal(state.debts[0].paid, 140);

    state = PC.editV110DebtPayment(state, id, {
      accountId: 2,
      date: '2026-08-02',
      amount: 60,
    });
    assert.equal(state.debts[0].paid, 160);
    assert.equal(state.accountMovements[0].accountId, 2);
    assert.equal(state.accountMovements[0].amount, 60);
    assert.equal(state.accountMovements[0].operationRef, `debt-payment:${id}`);

    state = PC.deleteV110DebtPayment(state, id);
    assert.equal(state.debts[0].paid, 100);
    assert.deepEqual(state.activeMonth.pagosDeuda, []);
    assert.deepEqual(state.accountMovements, []);
  });

  await t.test('saving deposit create, edit, and delete reconcile wallet.balance atomically', () => {
    let state = seedV110Domains();
    state = PC.createV110SavingDeposit(state, {
      walletId: 4,
      accountId: 1,
      date: '2026-08-01',
      amount: 40,
    });
    const id = state.activeMonth.aportesAhorro[0].id;
    assert.equal(state.wallets[0].balance, 240);

    state = PC.editV110SavingDeposit(state, id, {
      accountId: 2,
      date: '2026-08-02',
      amount: 60,
    });
    assert.equal(state.wallets[0].balance, 260);
    assert.equal(state.accountMovements[0].accountId, 2);
    assert.equal(state.accountMovements[0].amount, 60);
    assert.equal(state.accountMovements[0].operationRef, `saving-deposit:${id}`);

    state = PC.deleteV110SavingDeposit(state, id);
    assert.equal(state.wallets[0].balance, 200);
    assert.deepEqual(state.activeMonth.aportesAhorro, []);
    assert.deepEqual(state.accountMovements, []);
  });

  await t.test('failed creates and edits leave the original state untouched', () => {
    const state = seedV110Domains();
    const before = JSON.stringify(state);
    assert.throws(
      () => PC.createV110DebtPayment(state, {
        debtId: 3,
        accountId: 1,
        date: '2026-08-01',
        amount: 1000,
      }),
      (error) => error.code === 'INVALID_AMOUNT'
    );
    assert.equal(JSON.stringify(state), before);

    const withDeposit = PC.createV110SavingDeposit(state, {
      walletId: 4,
      accountId: 1,
      date: '2026-08-01',
      amount: 40,
    });
    const withDepositBefore = JSON.stringify(withDeposit);
    assert.throws(
      () => PC.editV110SavingDeposit(
        withDeposit,
        withDeposit.activeMonth.aportesAhorro[0].id,
        { accountId: 999 }
      ),
      (error) => error.code === 'ACCOUNT_NOT_FOUND'
    );
    assert.equal(JSON.stringify(withDeposit), withDepositBefore);
  });

  await t.test('balance adjustments are explicit signed movements, never silent overwrites', () => {
    let s = addAccount(PC.makeV110Default(), { initialBalance: 100 });
    s = PC.adjustV110AccountBalance(s, {
      accountId: 1,
      date: '2026-08-05',
      targetBalance: 130,
      operationRef: 'adjustment:1',
    });
    s = PC.adjustV110AccountBalance(s, {
      accountId: 1,
      date: '2026-08-06',
      targetBalance: 90,
      operationRef: 'adjustment:2',
    });

    assert.equal(s.accounts[0].initialBalance, 100);
    assert.equal(PC.v110AccountBalance(s, 1), 90);
    assert.deepEqual(s.accountMovements.map((movement) => ({
      amount: movement.amount,
      type: movement.type,
      operationRef: movement.operationRef,
    })), [
      { amount: 30, type: 'adjustment', operationRef: 'adjustment:1' },
      { amount: -40, type: 'adjustment', operationRef: 'adjustment:2' },
    ]);
  });

  await t.test('generic unlinked movement writers are not public', () => {
    assert.equal(PC.createV110LinkedOperation, undefined);
    assert.equal(PC.editV110LinkedOperation, undefined);
    assert.equal(PC.deleteV110LinkedOperation, undefined);
  });

  await t.test('closing preserves deterministic references and remains serializable', () => {
    let state = seedV110Domains();
    state = PC.createV110Transaction(state, {
      accountId: 1,
      date: '2026-08-01',
      amount: 10,
      type: 'income',
    });
    state = PC.createV110DebtPayment(state, {
      debtId: 3,
      accountId: 1,
      date: '2026-08-02',
      amount: 20,
    });
    const refs = state.accountMovements.map((movement) => movement.operationRef);
    const closed = PC.closeV110Month(
      state,
      '2026-08-31T23:00:00.000Z',
      '2026-08'
    );

    assert.deepEqual(closed.accountMovements.map((movement) => movement.operationRef), refs);
    assert.deepEqual(closed.activeMonth.expenses, []);
    assert.equal(closed.monthlyHistory[0].expenses.length, 1);
    assert.equal(closed.monthlyHistory[0].pagosDeuda.length, 1);
    assert.deepEqual(PC.loadV110(PC.serializeV110(closed)), closed);
  });

  await t.test('persistence rejects orphaned, duplicate, and discordant operation links', () => {
    let valid = seedV110Domains();
    valid = PC.createV110Transaction(valid, {
      accountId: 1,
      date: '2026-08-01',
      amount: 10,
      type: 'income',
    });
    const clone = () => JSON.parse(JSON.stringify(valid));
    const orphanOperation = clone();
    orphanOperation.accountMovements = [];
    const orphanMovement = clone();
    orphanMovement.activeMonth.expenses = [];
    const mismatchedAmount = clone();
    mismatchedAmount.accountMovements[0].amount = 11;
    const mismatchedAccount = clone();
    mismatchedAccount.accountMovements[0].accountId = 2;
    const mismatchedDate = clone();
    mismatchedDate.accountMovements[0].date = '2026-08-02';
    const mismatchedDirection = clone();
    mismatchedDirection.accountMovements[0].type = 'debit';
    const duplicate = clone();
    duplicate.accountMovements.push({
      ...duplicate.accountMovements[0],
      id: 2,
    });
    const duplicateOperation = clone();
    duplicateOperation.activeMonth.expenses.push({
      ...duplicateOperation.activeMonth.expenses[0],
    });
    const closed = PC.closeV110Month(
      valid,
      '2026-08-31T23:00:00.000Z',
      '2026-08'
    );
    const historicalOrphanOperation = JSON.parse(JSON.stringify(closed));
    historicalOrphanOperation.accountMovements = [];
    const historicalOrphanMovement = JSON.parse(JSON.stringify(closed));
    historicalOrphanMovement.monthlyHistory[0].expenses = [];
    const historicalMismatch = JSON.parse(JSON.stringify(closed));
    historicalMismatch.monthlyHistory[0].expenses[0].amount = 11;

    for (const invalid of [
      orphanOperation,
      orphanMovement,
      mismatchedAmount,
      mismatchedAccount,
      mismatchedDate,
      mismatchedDirection,
      duplicate,
      duplicateOperation,
      historicalOrphanOperation,
      historicalOrphanMovement,
      historicalMismatch,
    ]) {
      assert.deepEqual(PC.loadV110(JSON.stringify(invalid)), PC.makeV110Default());
      assert.throws(
        () => PC.serializeV110(invalid),
        (error) => error.name === 'V110ValidationError'
      );
    }

    let adjustmentOnly = addAccount(PC.makeV110Default(), { initialBalance: 100 });
    adjustmentOnly = PC.adjustV110AccountBalance(adjustmentOnly, {
      accountId: 1,
      date: '2026-08-01',
      targetBalance: 120,
      operationRef: 'adjustment:standalone',
    });
    assert.deepEqual(
      PC.loadV110(PC.serializeV110(adjustmentOnly)),
      adjustmentOnly
    );
  });

  await t.test('validates nonexistent accounts, calendar dates, and amounts atomically', () => {
    const state = seedV110Domains();
    const valid = {
      accountId: 1,
      date: '2024-02-29',
      amount: 10,
      type: 'income',
    };

    assert.throws(
      () => PC.createV110Transaction(state, { ...valid, accountId: 999 }),
      (error) => error.code === 'ACCOUNT_NOT_FOUND'
    );
    for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '01-08-2026']) {
      assert.throws(
        () => PC.createV110Transaction(state, { ...valid, date }),
        (error) => error.code === 'INVALID_DATE'
      );
    }
    for (const amount of [0, -1, NaN, Infinity]) {
      assert.throws(
        () => PC.createV110Transaction(state, { ...valid, amount }),
        (error) => error.code === 'INVALID_AMOUNT'
      );
    }
    assert.equal(PC.isValidV110Date('2024-02-29'), true);
    assert.equal(state.accountMovements.length, 0, 'failed validations do not mutate state');
    assert.equal(state.activeMonth.expenses.length, 0);
  });

  await t.test('available is the sum of current balances from active accounts only', () => {
    let s = addAccount(PC.makeV110Default(), { name: 'Activa', initialBalance: 100 });
    s = addAccount(s, { name: 'Inactiva', initialBalance: 1000, active: false });
    s = PC.createV110Transaction(s, {
      accountId: 1,
      date: '2026-08-01',
      amount: 50,
      type: 'income',
    });
    s = PC.createV110Transaction(s, {
      accountId: 2,
      date: '2026-08-01',
      amount: 500,
      type: 'income',
    });

    assert.equal(PC.v110AccountBalance(s, 1), 150);
    assert.equal(PC.v110AccountBalance(s, 2), 1500);
    assert.equal(PC.v110TotalAvailable(s), 150);
  });
});

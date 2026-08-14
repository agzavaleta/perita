'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const IndexedDb = require('../perita-indexeddb.js');
const Runtime = require('../perita-runtime.js');
const DomainCommands = require('../perita-domain-commands.js');
const PeritaApp = require('../perita-app.js');

const NOW = '2026-08-05T12:00:00.000Z';
const DATE = '2026-08-05';

function id(number) {
  return `f1000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function sequence(prefix) {
  let number = 1;
  return () => `${prefix}-0000-4000-8000-${String(number++).padStart(12, '0')}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('presentation translates operation types and domain errors without exposing technical names', () => {
  const expectedLabels = {
    balance_adjustment: 'Ajuste de saldo',
    salary_receipt: 'Sueldo recibido',
    additional_income: 'Ingreso adicional',
    variable_expense: 'Gasto variable',
    fixed_expense_payment: 'Pago de gasto fijo',
    debt_payment: 'Pago de deuda',
    debt_total_adjustment: 'Ajuste de deuda',
    savings_deposit: 'Aporte a ahorro',
    savings_withdrawal: 'Retiro de ahorro',
    transfer: 'Transferencia',
  };
  for (const [type, label] of Object.entries(expectedLabels)) {
    assert.equal(PeritaApp.operationTypeLabel(type), label);
  }
  assert.equal(PeritaApp.operationTypeLabel('future_operation'), 'Movimiento');

  const invalidField = PeritaApp.userErrorMessage({
    code: 'INVALID_DOMAIN_FIELD', message: 'technical validation details', context: { field: 'paymentDay' },
  });
  assert.equal(invalidField, 'Revisa el día habitual de pago: el valor ingresado no es válido. Corrígelo e intenta nuevamente.');
  assert.doesNotMatch(invalidField, /INVALID_DOMAIN_FIELD|technical validation details/);

  const inactive = PeritaApp.userErrorMessage({
    code: 'DOMAIN_STATE_INVALID', message: 'only an active Account can receive this operation',
  });
  assert.match(inactive, /seleccionada está inactiva/i);
  assert.doesNotMatch(inactive, /DOMAIN_STATE_INVALID|only an active Account/);

  const writer = PeritaApp.userErrorMessage({
    code: 'WRITER_ALREADY_OWNED', message: 'another tab currently owns the writer lease',
  });
  assert.match(writer, /Otra ventana de Perita/);
  assert.doesNotMatch(writer, /writer|lease/i);

  assert.equal(
    PeritaApp.userErrorMessage({ code: 'UNEXPECTED_ENGINE_FAILURE', message: 'private diagnostics' }),
    'No pudimos completar la acción. Intenta nuevamente.'
  );
});

function legacyStorage(raw) {
  const writes = [];
  return {
    writes,
    getItem: (key) => key === 'perita_v1' ? raw : null,
    setItem: (...args) => writes.push(args),
    removeItem: (...args) => writes.push(args),
  };
}

function sessionStore() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    clone: () => {
      const copy = sessionStore();
      values.forEach((value, key) => copy.setItem(key, value));
      return copy;
    },
  };
}

function mutableClock(initial) {
  let milliseconds = Date.parse(initial || NOW);
  return {
    now: () => new Date(milliseconds).toISOString(),
    advance: (amount) => { milliseconds += amount; },
  };
}

function intervalHarness() {
  let nextId = 1;
  const active = new Map();
  return {
    setInterval: (callback, delay) => {
      const idValue = nextId++;
      active.set(idValue, { callback, delay });
      return idValue;
    },
    clearInterval: (idValue) => active.delete(idValue),
    runActive: () => Promise.all([...active.values()].map(({ callback }) => callback())),
    get activeCount() { return active.size; },
    get createdCount() { return nextId - 1; },
  };
}

function channelHarness() {
  const instances = [];
  return {
    instances,
    create: () => {
      const instance = {
        closed: false,
        messages: [],
        onmessage: null,
        postMessage(message) { this.messages.push(message); },
        close() { this.closed = true; },
      };
      instances.push(instance);
      return instance;
    },
  };
}

function eventTargetHarness(initialVisibility) {
  const listeners = new Map();
  return {
    visibilityState: initialVisibility || 'visible',
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      if (listeners.has(type)) listeners.get(type).delete(listener);
    },
    dispatch(type, event) {
      for (const listener of listeners.get(type) || []) listener(event || { type });
    },
    listenerCount(type) { return (listeners.get(type) || new Set()).size; },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function application(factory, options) {
  const settings = options || {};
  return PeritaApp.createPeritaApplication({
    indexedDB: factory,
    IDBKeyRange,
    storage: settings.storage,
    crypto: { randomUUID: () => id(900) },
    legacyStorage: settings.legacyStorage || legacyStorage(null),
    now: settings.now || (() => NOW),
    createUuid: sequence(settings.prefix || 'f2000000'),
    sha256,
    tabId: settings.tabId || 'integration-tab-a',
    channel: null,
    channelFactory: settings.channelFactory,
    setInterval: settings.setInterval,
    clearInterval: settings.clearInterval,
    setTimeout: settings.setTimeout || ((callback) => { queueMicrotask(callback); return 1; }),
  });
}

function setupPayload() {
  return {
    currentCivilDate: DATE,
    financialSettings: {
      key: 'current', salaryReferenceAmount: 900000, currency: 'CLP',
      timezone: 'America/Santiago', revision: 1, createdAt: NOW, updatedAt: NOW,
    },
    period: {
      id: id(1), periodKey: '2026-08', status: 'open', plannedSalaryAmount: 900000,
      openedAt: NOW, closedAt: null, snapshotId: null, revision: 1,
    },
    accounts: [{
      id: id(2), name: 'Cuenta principal', openingBalance: 100000,
      currentBalance: 100000, status: 'active', revision: 1,
      createdAt: NOW, updatedAt: NOW,
    }],
  };
}

function legacyState() {
  return {
    settings:{salary:900000},
    accounts:[{id:1,name:'Cuenta legado',type:'bank',bank:'Banco',balance:150000}],
    debts:[],wallets:[],budget:[],varCategories:[],nextId:2,
    activeMonth:{month:'2026-08',expenses:[],pagosDeuda:[],aportesAhorro:[],gastosFijosPagados:[]},
    monthlyHistory:[{month:'2026-07',salary:850000,closedAt:'2026-07-31T23:00:00.000Z',expenses:[],pagosDeuda:[],aportesAhorro:[],gastosFijosPagados:[]}],
    expenses:[],
  };
}

test('application integration initializes a new install without touching legacy storage', async (t) => {
  const factory = new IDBFactory();
  const source = legacyStorage(null);
  const app = application(factory, { legacyStorage: source });
  t.after(() => app.close());
  const initialized = await app.initialize();
  assert.equal(initialized.phase, 'setup_required');
  assert.equal(initialized.writer, true);
  assert.equal(source.writes.length, 0);

  const completed = await app.completeSetup(setupPayload());
  assert.equal(completed.state.runtime.setupStatus, 'completed');
  assert.equal(completed.state.accounts[0].balance, 100000);
  assert.equal(completed.state.summary.totalIncomeAmount, 0);
  assert.equal(source.writes.length, 0);
});

test('zero salary reference keeps real income and fixed-expense availability canonical', async (t) => {
  const app = application(new IDBFactory(), { prefix: 'f2100000' });
  t.after(() => app.close());
  await app.initialize();
  const setup = setupPayload();
  setup.financialSettings.salaryReferenceAmount = 0;
  setup.period.periodKey = '2026-07';
  setup.period.plannedSalaryAmount = 0;
  await app.completeSetup(setup);

  const templateId = id(81);
  await app.execute('fixed-expense-template.create', { template: {
    id: templateId, name: 'Internet', referenceAmount: 20000, status: 'active',
    revision: 1, createdAt: NOW, updatedAt: NOW,
  } });
  const opened = await app.execute('period.close-and-open-next', {});
  assert.equal(opened.state.period.periodKey, '2026-08');
  assert.equal(opened.state.settings.salary, 0);
  assert.equal(opened.state.summary.fixedExpensePlannedAmount, 20000);
  assert.equal(opened.state.summary.fixedExpensePaidAmount, 0);
  assert.equal(opened.state.summary.fixedExpenseUnpaidAmount, 20000);
  assert.equal(opened.state.summary.availableAmount, 0);

  const salary = await app.execute('salary-receipt.create', {
    accountId: id(2), operationDate: DATE, amount: 100000,
  });
  assert.equal(salary.state.summary.receivedSalaryAmount, 100000);
  assert.equal(salary.state.summary.additionalIncomeAmount, 0);
  assert.equal(salary.state.summary.totalIncomeAmount, 100000);
  assert.equal(salary.state.summary.availableAmount, 100000);

  const additional = await app.execute('additional-income.create', {
    accountId: id(2), operationDate: DATE, amount: 50000,
    concept: 'Trabajo adicional', observation: null,
  });
  assert.equal(additional.state.summary.receivedSalaryAmount, 100000);
  assert.equal(additional.state.summary.additionalIncomeAmount, 50000);
  assert.equal(additional.state.summary.totalIncomeAmount, 150000);
  assert.equal(additional.state.summary.availableAmount, 150000);

  const instance = additional.state._snapshot.fixedExpenseInstances.find(
    (item) => item.templateId === templateId && item.periodId === additional.state.period.id
  );
  const paid = await app.execute('fixed-expense-payment.create', {
    accountId: id(2), fixedExpenseInstanceId: instance.id,
    operationDate: DATE, amount: 20000,
  });
  assert.equal(paid.state.summary.fixedExpensePaidAmount, 20000);
  assert.equal(paid.state.summary.fixedExpenseUnpaidAmount, 0);
  assert.equal(paid.state.summary.availableAmount, 130000);
});

test('post-setup account creation records the requested real balance as a canonical adjustment', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory, { prefix: 'a1000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  const deliveredStates = [];
  const unsubscribe = app.subscribe((state) => deliveredStates.push(state));
  t.after(unsubscribe);

  const completed = await app.createAccountWithBalance({
    name: 'Cuenta nueva',
    bank: 'Banco Estado',
    currentBalance: 500000,
    operationDate: DATE,
  });
  const account = completed.state._snapshot.accounts.find((item) => item.id === completed.accountId);
  const opening = completed.state._snapshot.periodOpenings.find((item) => item.targetId === completed.accountId);
  const operation = completed.state.operations.find((item) => item.details.accountId === completed.accountId);
  const movement = completed.state.movements.find((item) => item.operationId === operation.id);

  assert.equal(account.openingBalance, 0);
  assert.equal(account.bank, 'Banco Estado');
  assert.equal(account.currentBalance, 500000);
  assert.equal(opening.openingAmount, 0);
  assert.equal(operation.type, 'balance_adjustment');
  assert.equal(operation.status, 'posted');
  assert.equal(movement.targetType, 'account');
  assert.equal(movement.targetId, completed.accountId);
  assert.equal(movement.delta, 500000);
  assert.equal(completed.state.accounts.find((item) => item.id === completed.accountId).balance, 500000);
  const projectedAdjustment = completed.state.expenses.find((item) => item.id === operation.id);
  assert.equal(projectedAdjustment.type, 'movement');
  assert.equal(projectedAdjustment.description, 'Ajuste de saldo');
  assert.equal(completed.state.expenses.some((item) => item.id === operation.id && item.type === 'expense'), false);
  assert.equal(completed.state.summary.totalIncomeAmount, 0);
  assert.equal(completed.state.summary.variableExpenseAmount, 0);
  assert.deepEqual(deliveredStates.map((state) => state.accounts.find((item) => item.id === completed.accountId)?.balance), [500000]);

  const withoutBank = await app.createAccountWithBalance({
    name: 'Efectivo', currentBalance: 0, operationDate: DATE,
  });
  assert.equal(
    withoutBank.state._snapshot.accounts.find((item) => item.id === withoutBank.accountId).bank,
    null
  );

  await assert.rejects(
    app.createAccountWithBalance({ name: 'Línea utilizada', currentBalance: -25000, operationDate: DATE }),
    (error) => error.code === 'DOMAIN_STATE_INVALID' && /cannot leave the Account negative/.test(error.message)
  );
  assert.equal(app.state._snapshot.accounts.some((item) => item.name === 'Línea utilizada'), false);
});

test('savings-goal onboarding preserves zero or preexisting balance without monthly savings', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory, { prefix: 'a1250000' });
  await app.initialize();
  await app.completeSetup(setupPayload());

  const zero = await app.createSavingsGoalWithBalance({
    name: 'Meta desde cero',
    targetAmount: 300000,
    plannedMonthlyAmount: 0,
    currentBalance: 0,
    operationDate: DATE,
  });
  const zeroGoal = zero.state._snapshot.savingsGoals.find((item) => item.id === zero.goalId);
  assert.equal(zeroGoal.openingBalance, 0);
  assert.equal(zeroGoal.currentBalance, 0);
  assert.equal(zero.adjustment, null);
  assert.equal(
    zero.state.operations.some((operation) => operation.details.goalId === zero.goalId),
    false
  );

  const preexisting = await app.createSavingsGoalWithBalance({
    name: 'Ahorro anterior a Perita',
    targetAmount: 500000,
    plannedMonthlyAmount: 25000,
    currentBalance: 175000,
    operationDate: DATE,
  });
  const goal = preexisting.state._snapshot.savingsGoals.find((item) => item.id === preexisting.goalId);
  const opening = preexisting.state._snapshot.periodOpenings.find(
    (item) => item.targetType === 'savings_goal' && item.targetId === preexisting.goalId
  );
  const operation = preexisting.state.operations.find(
    (item) => item.type === 'balance_adjustment' && item.details.goalId === preexisting.goalId
  );
  const movement = preexisting.state.movements.find((item) => item.operationId === operation.id);

  assert.equal(goal.openingBalance, 0);
  assert.equal(goal.currentBalance, 175000);
  assert.equal(opening.openingAmount, 0);
  assert.equal(operation.amount, 175000);
  assert.deepEqual(operation.details, {
    goalId: preexisting.goalId,
    reason: 'Saldo preexistente al crear la meta de ahorro',
  });
  assert.equal(movement.targetType, 'savings_goal');
  assert.equal(movement.targetId, preexisting.goalId);
  assert.equal(movement.delta, 175000);
  const projectedAdjustment = preexisting.state.expenses.find((item) => item.id === operation.id);
  assert.equal(projectedAdjustment.type, 'movement');
  assert.equal(projectedAdjustment.description, 'Ajuste de saldo');
  assert.equal(
    preexisting.state.expenses.some((item) => item.id === operation.id && item.type === 'expense'),
    false
  );
  assert.equal(preexisting.state.summary.totalIncomeAmount, 0);
  assert.equal(preexisting.state.summary.variableExpenseAmount, 0);
  assert.equal(preexisting.state.summary.netSavingsAmount, 0);
  assert.equal(
    preexisting.state.operations.some((item) => ['savings_deposit', 'transfer'].includes(item.type)),
    false
  );

  await app.close();
  const reloaded = application(factory, {
    prefix: 'a1350000',
    tabId: 'savings-onboarding-reload',
  });
  t.after(() => reloaded.close());
  const initialized = await reloaded.initialize();
  const persisted = initialized.state._snapshot.savingsGoals.find(
    (item) => item.id === preexisting.goalId
  );
  assert.equal(initialized.phase, 'ok');
  assert.equal(persisted.currentBalance, 175000);
  assert.equal(initialized.state.summary.netSavingsAmount, 0);
});

test('account edit processes name, balance, or both through canonical commands', async (t) => {
  const app = application(new IDBFactory(), { prefix: 'a1400000' });
  t.after(() => app.close());
  await app.initialize();
  const setup = await app.completeSetup(setupPayload());
  const accountId = setup.state.accounts[0].id;

  const named = await app.updateAccountWithBalance({
    accountId, name: 'Cuenta renombrada', bank: 'Banco Uno', currentBalance: 100000, operationDate: DATE,
  });
  assert.equal(named.state.accounts.find((item) => item.id === accountId).name, 'Cuenta renombrada');
  assert.equal(named.state.accounts.find((item) => item.id === accountId).bank, 'Banco Uno');
  assert.equal(named.state.operations.length, 0);

  const balanced = await app.updateAccountWithBalance({
    accountId, name: 'Cuenta renombrada', bank: 'Banco Uno', currentBalance: 125000, operationDate: DATE,
  });
  assert.equal(balanced.state.accounts.find((item) => item.id === accountId).balance, 125000);
  assert.equal(balanced.state.movements.at(-1).delta, 25000);

  const both = await app.updateAccountWithBalance({
    accountId, name: 'Cuenta final', bank: 'Banco Dos', currentBalance: 90000, operationDate: DATE,
  });
  const account = both.state._snapshot.accounts.find((item) => item.id === accountId);
  assert.equal(account.name, 'Cuenta final');
  assert.equal(account.bank, 'Banco Dos');
  assert.equal(account.currentBalance, 90000);
  assert.equal(both.state.movements.at(-1).delta, -35000);
});

test('savings edit adjusts balance with or without descriptive changes and excludes monthly savings', async (t) => {
  const app = application(new IDBFactory(), { prefix: 'a1450000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  const created = await app.createSavingsGoalWithBalance({
    name: 'Meta editable', targetAmount: 300000, plannedMonthlyAmount: 10000,
    currentBalance: 0, operationDate: DATE,
  });

  const balanced = await app.updateSavingsGoalWithBalance({
    goalId: created.goalId, name: 'Meta editable', targetAmount: 300000,
    plannedMonthlyAmount: 10000, currentBalance: 50000, operationDate: DATE,
  });
  assert.equal(balanced.state.wallets.find((item) => item.id === created.goalId).balance, 50000);
  assert.equal(balanced.state.summary.netSavingsAmount, 0);
  assert.equal(balanced.state.operations.at(-1).type, 'balance_adjustment');

  const both = await app.updateSavingsGoalWithBalance({
    goalId: created.goalId, name: 'Meta actualizada', targetAmount: 400000,
    plannedMonthlyAmount: 15000, currentBalance: 80000, operationDate: DATE,
  });
  const goal = both.state._snapshot.savingsGoals.find((item) => item.id === created.goalId);
  assert.equal(goal.name, 'Meta actualizada');
  assert.equal(goal.targetAmount, 400000);
  assert.equal(goal.plannedMonthlyAmount, 15000);
  assert.equal(goal.currentBalance, 80000);
  assert.equal(both.state.movements.at(-1).delta, 30000);
  assert.equal(both.state.summary.netSavingsAmount, 0);
});

test('savings location supports bank, cash, custom text, and editing without financial effects', async (t) => {
  const app = application(new IDBFactory(), { prefix: 'a1460000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());

  const bankGoal = await app.createSavingsGoalWithBalance({
    name: 'Ahorro bancario', bank: 'BancoEstado', targetAmount: 300000,
    plannedMonthlyAmount: 10000, currentBalance: 0, operationDate: DATE,
  });
  const cashGoal = await app.createSavingsGoalWithBalance({
    name: 'Ahorro efectivo', bank: 'Efectivo', targetAmount: 200000,
    plannedMonthlyAmount: 5000, currentBalance: 0, operationDate: DATE,
  });
  const customGoal = await app.createSavingsGoalWithBalance({
    name: 'Ahorro cooperativa', bank: 'Cooperativa local', targetAmount: 400000,
    plannedMonthlyAmount: 15000, currentBalance: 0, operationDate: DATE,
  });
  assert.equal(bankGoal.state.wallets.find((item) => item.id === bankGoal.goalId).bank, 'BancoEstado');
  assert.equal(cashGoal.state.wallets.find((item) => item.id === cashGoal.goalId).bank, 'Efectivo');
  assert.equal(customGoal.state.wallets.find((item) => item.id === customGoal.goalId).bank, 'Cooperativa local');

  const before = customGoal.state._snapshot.savingsGoals.find((item) => item.id === customGoal.goalId);
  const operationCount = customGoal.state.operations.length;
  const movementCount = customGoal.state.movements.length;
  const edited = await app.updateSavingsGoalWithBalance({
    goalId: customGoal.goalId, name: before.name, bank: 'Banco de Chile',
    targetAmount: before.targetAmount, plannedMonthlyAmount: before.plannedMonthlyAmount,
    currentBalance: before.currentBalance, operationDate: DATE,
  });
  const after = edited.state._snapshot.savingsGoals.find((item) => item.id === customGoal.goalId);
  assert.equal(after.bank, 'Banco de Chile');
  for (const field of ['openingBalance', 'currentBalance', 'targetAmount', 'plannedMonthlyAmount']) {
    assert.equal(after[field], before[field], field);
  }
  assert.equal(edited.state.operations.length, operationCount);
  assert.equal(edited.state.movements.length, movementCount);
});

test('debt edit processes descriptive data, total, or both from one integration action', async (t) => {
  const app = application(new IDBFactory(), { prefix: 'a1470000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  const created = await app.createDebt({
    debtId: id(30), name: 'Deuda inicial', totalAmount: 200000,
    monthlyPaymentAmount: 80000, paymentDay: 31, timestamp: NOW,
  });
  const debtId = created.debtId;
  assert.equal(created.state.debts.find((item) => item.id === debtId).estimatedEndDate, '2026-10-31');

  const details = await app.updateDebtDetailsAndTotal({
    debtId, name: 'Deuda renombrada', monthlyPaymentAmount: 100000, paymentDay: 15,
    totalAmount: 200000, operationDate: DATE,
  });
  assert.equal(details.state.debts.find((item) => item.id === debtId).name, 'Deuda renombrada');
  assert.equal(details.state.debts.find((item) => item.id === debtId).estimatedEndDate, '2026-09-15');
  assert.equal(details.state.operations.length, 0);

  const total = await app.updateDebtDetailsAndTotal({
    debtId, name: 'Deuda renombrada', monthlyPaymentAmount: 100000, paymentDay: 15,
    totalAmount: 240000, operationDate: DATE,
  });
  assert.equal(total.state.debts.find((item) => item.id === debtId).total, 240000);
  assert.equal(total.state.debts.find((item) => item.id === debtId).estimatedEndDate, '2026-10-15');
  assert.equal(total.state.operations.at(-1).type, 'debt_total_adjustment');

  const both = await app.updateDebtDetailsAndTotal({
    debtId, name: 'Deuda final', monthlyPaymentAmount: 120000, paymentDay: 31,
    totalAmount: 260000, operationDate: DATE,
  });
  const debt = both.state._snapshot.debts.find((item) => item.id === debtId);
  assert.equal(debt.name, 'Deuda final');
  assert.equal(debt.monthlyPaymentAmount, 120000);
  assert.equal(debt.paymentDay, 31);
  assert.equal(debt.dueDate, null);
  assert.equal(debt.totalAmount, 260000);
  assert.equal(debt.outstandingAmount, 260000);
  assert.equal(debt.openingOutstanding, 200000);
  assert.equal(both.state.movements.at(-1).delta, 20000);
  assert.equal(both.state.debts.find((item) => item.id === debtId).estimatedEndDate, '2026-10-31');

  const paid = await app.execute('debt-payment.create', {
    accountId: id(2), debtId, operationDate: DATE, amount: 50000,
    concept: null, observation: null,
  });
  const afterPayment = paid.state._snapshot.debts.find((item) => item.id === debtId);
  assert.equal(afterPayment.outstandingAmount, 210000);
  assert.equal(paid.state.debts.find((item) => item.id === debtId).estimatedEndDate, '2026-09-30');
});

test('a failed initial balance adjustment leaves the newly created account explicitly at zero', async (t) => {
  const factory = new IDBFactory();
  const createUuid = sequence('a1500000');
  const storage = IndexedDb.createPeritaIndexedDb({
    indexedDB: factory,
    IDBKeyRange,
    crypto: { randomUUID: () => id(901) },
    now: () => NOW,
  });
  const runtime = Runtime.createPeritaRuntime({
    storage,
    now: () => NOW,
    tabId: 'integration-tab-failed-adjustment',
    createUuid,
  });
  const realCommands = DomainCommands.createPeritaDomainCommands({
    runtime,
    now: () => NOW,
    createUuid,
    sha256,
  });
  const commands = {
    ...realCommands,
    balanceAdjustment: {
      ...realCommands.balanceAdjustment,
      create: async () => {
        const error = new Error('induced balance adjustment failure');
        error.code = 'INDUCED_ADJUSTMENT_FAILURE';
        throw error;
      },
    },
  };
  const app = PeritaApp.createPeritaApplication({
    indexedDB: factory,
    IDBKeyRange,
    storage,
    runtime,
    commands,
    legacyStorage: legacyStorage(null),
    now: () => NOW,
    createUuid,
    sha256,
    tabId: 'integration-tab-failed-adjustment',
    channel: null,
  });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  const deliveredStates = [];
  const unsubscribe = app.subscribe((state) => deliveredStates.push(state));
  t.after(unsubscribe);

  await assert.rejects(
    app.createAccountWithBalance({
      name: 'Cuenta con ajuste fallido',
      currentBalance: 60000,
      operationDate: DATE,
    }),
    (error) => error.code === 'ACCOUNT_BALANCE_ADJUSTMENT_FAILED' &&
      error.context.causeCode === 'INDUCED_ADJUSTMENT_FAILURE' &&
      /se creó en \$0/.test(error.message)
  );

  const state = app.state;
  const account = state._snapshot.accounts.find((item) => item.name === 'Cuenta con ajuste fallido');
  const opening = state._snapshot.periodOpenings.find((item) => item.targetId === account.id);
  assert.equal(account.openingBalance, 0);
  assert.equal(account.currentBalance, 0);
  assert.equal(opening.openingAmount, 0);
  assert.equal(state.operations.some((item) => item.details.accountId === account.id), false);
  assert.equal(state.movements.some((item) => item.targetId === account.id), false);
  assert.deepEqual(
    deliveredStates.map((item) => item.accounts.find((entry) => entry.id === account.id)?.balance),
    [0]
  );
});

test('active accounts can be adjusted while deactivation and inactive projections stay safe', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory, { prefix: 'a2000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  const created = await app.createAccountWithBalance({
    name: 'Cuenta operativa',
    currentBalance: 0,
    operationDate: DATE,
  });

  const adjusted = await app.execute('balance-adjustment.create', {
    accountId: created.accountId,
    operationDate: DATE,
    delta: 25000,
    reason: 'Ajuste de prueba',
  });
  assert.equal(adjusted.state.accounts.find((item) => item.id === created.accountId).balance, 25000);
  await assert.rejects(
    app.execute('account.deactivate', { accountId: created.accountId }),
    (error) => error.code === 'DOMAIN_STATE_INVALID' && /balance must be zero/.test(error.message)
  );

  await app.execute('balance-adjustment.create', {
    accountId: created.accountId,
    operationDate: DATE,
    delta: -25000,
    reason: 'Dejar saldo en cero',
  });
  const deactivated = await app.execute('account.deactivate', { accountId: created.accountId });
  assert.equal(deactivated.state.accounts.some((item) => item.id === created.accountId), false);
  assert.equal(deactivated.state._snapshot.accounts.find((item) => item.id === created.accountId).status, 'inactive');
  await assert.rejects(
    app.execute('balance-adjustment.create', {
      accountId: created.accountId,
      operationDate: DATE,
      delta: 1,
      reason: 'No permitido',
    }),
    (error) => error.code === 'DOMAIN_STATE_INVALID' && /must exist and be active/.test(error.message)
  );
});

test('application adapter delegates a UI intent to a domain command and reloads IndexedDB', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory);
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());

  const updated = await app.execute('financial-settings.update-reference-salary', {
    salaryReferenceAmount: 950000,
  });
  assert.equal(updated.state.settings.salary, 950000);
  assert.equal(updated.state.financialSettings.revision, 2);
  assert.equal(updated.state.runtime.dataRevision, 3);
  assert.equal(updated.state.operations.length, 0);
  assert.equal(updated.state.movements.length, 0);
});

test('an incomplete setup renews its writer after page teardown and reload', async (t) => {
  const factory = new IDBFactory();
  const tabSession = sessionStore();
  const create = (prefix, navigationType) => PeritaApp.createPeritaApplication({
    indexedDB: factory,
    IDBKeyRange,
    crypto: { randomUUID: () => id(900) },
    legacyStorage: legacyStorage(null),
    sessionStorage: tabSession,
    navigationType,
    now: () => NOW,
    createUuid: sequence(prefix),
    channel: null,
    setTimeout: (callback) => { queueMicrotask(callback); return 1; },
  });
  const first = create('f3100000', 'navigate');
  const initial = await first.initialize();
  assert.equal(initial.phase, 'setup_required');
  assert.equal(initial.writer, true);
  const originalEpoch = initial.writerEpoch;
  first.suspend();

  const reopened = create('f3200000', 'reload');
  t.after(() => reopened.close());
  const next = await reopened.initialize();
  assert.equal(next.phase, 'setup_required');
  assert.equal(next.writer, true);
  assert.equal(next.writerEpoch, originalEpoch);
  assert.equal(next.error, undefined);
});

test('suspend and resume rebuild resources, renew the valid writer, and keep one heartbeat', async (t) => {
  const factory = new IDBFactory();
  const clock = mutableClock();
  const baseStorage = IndexedDb.createPeritaIndexedDb({
    indexedDB: factory,
    IDBKeyRange,
    crypto: { randomUUID: () => id(902) },
    now: clock.now,
  });
  let openCount = 0;
  let closeCount = 0;
  const storage = {
    ...baseStorage,
    open: async () => { openCount += 1; return baseStorage.open(); },
    close: () => { closeCount += 1; baseStorage.close(); },
  };
  const channels = channelHarness();
  const intervals = intervalHarness();
  const app = application(factory, {
    prefix: 'f3150000',
    storage,
    now: clock.now,
    channelFactory: channels.create,
    setInterval: intervals.setInterval,
    clearInterval: intervals.clearInterval,
  });
  t.after(() => app.close());
  const unsubscribe = app.subscribe(() => undefined);
  t.after(unsubscribe);
  await app.initialize();
  await app.completeSetup(setupPayload());
  const stateBeforeSuspend = app.state;
  const canonicalFinancialState = {
    dataRevision: stateBeforeSuspend.runtime.dataRevision,
    lastCommitId: stateBeforeSuspend.runtime.lastCommitId,
    activePeriodId: stateBeforeSuspend.runtime.activePeriodId,
    periodRevision: stateBeforeSuspend.period.revision,
    accounts: stateBeforeSuspend._snapshot.accounts.map((account) => ({
      id: account.id,
      openingBalance: account.openingBalance,
      currentBalance: account.currentBalance,
      revision: account.revision,
    })),
    operations: stateBeforeSuspend.operations,
    movements: stateBeforeSuspend.movements,
    commits: stateBeforeSuspend._snapshot.commits,
  };
  const originalEpoch = app.writerEpoch;
  const leaseLosses = [];
  app.startHeartbeat((error) => leaseLosses.push(error));
  app.startHeartbeat((error) => leaseLosses.push(error));
  assert.equal(intervals.activeCount, 1);
  assert.equal(intervals.createdCount, 1);
  assert.equal(channels.instances.length, 1);

  const heartbeatInFlight = intervals.runActive();
  app.suspend();
  await heartbeatInFlight;
  assert.equal(app.suspended, true);
  assert.equal(app.writerEpoch, null);
  assert.equal(app.heartbeatActive, false);
  assert.equal(intervals.activeCount, 0);
  assert.equal(channels.instances[0].closed, true);
  assert.equal(leaseLosses.length, 0);
  const opensBeforeResume = openCount;

  const resumed = await app.resume();
  assert.equal(resumed.phase, 'ok');
  assert.equal(resumed.writer, true);
  assert.equal(resumed.writerEpoch, originalEpoch);
  assert.equal(app.suspended, false);
  assert.ok(openCount > opensBeforeResume);
  assert.ok(closeCount >= 1);
  assert.equal(channels.instances.length, 2);
  assert.equal(channels.instances[1].closed, false);
  assert.equal(typeof channels.instances[1].onmessage, 'function');
  assert.deepEqual({
    dataRevision: resumed.state.runtime.dataRevision,
    lastCommitId: resumed.state.runtime.lastCommitId,
    activePeriodId: resumed.state.runtime.activePeriodId,
    periodRevision: resumed.state.period.revision,
    accounts: resumed.state._snapshot.accounts.map((account) => ({
      id: account.id,
      openingBalance: account.openingBalance,
      currentBalance: account.currentBalance,
      revision: account.revision,
    })),
    operations: resumed.state.operations,
    movements: resumed.state.movements,
    commits: resumed.state._snapshot.commits,
  }, canonicalFinancialState);
  app.startHeartbeat();
  app.startHeartbeat();
  assert.equal(intervals.activeCount, 1);
  assert.equal(intervals.createdCount, 2);

  const updated = await app.execute('financial-settings.update-reference-salary', {
    salaryReferenceAmount: 910000,
  });
  assert.equal(updated.state.settings.salary, 910000);
});

test('resume reacquires an expired writer canonically and respects another winner', async (t) => {
  const factory = new IDBFactory();
  const clock = mutableClock();
  const first = application(factory, {
    tabId: 'resume-expired-a', prefix: 'f3250000', now: clock.now,
  });
  await first.initialize();
  await first.completeSetup(setupPayload());
  const originalEpoch = first.writerEpoch;
  first.suspend();
  clock.advance(PeritaApp.LEASE_DURATION_MS + 1);
  const reacquired = await first.resume();
  assert.equal(reacquired.phase, 'ok');
  assert.equal(reacquired.writer, true);
  assert.equal(reacquired.writerEpoch, originalEpoch + 1);

  first.suspend();
  clock.advance(PeritaApp.LEASE_DURATION_MS + 1);
  const second = application(factory, {
    tabId: 'resume-expired-b', prefix: 'f3350000', now: clock.now,
  });
  t.after(async () => { await second.close(); await first.close(); });
  const winner = await second.initialize();
  assert.equal(winner.writer, true);
  const readOnly = await first.resume();
  assert.equal(readOnly.phase, 'ready_read_only');
  assert.equal(readOnly.writer, false);
  assert.equal(readOnly.error.code, 'WRITER_ALREADY_OWNED');
  assert.equal(first.writerEpoch, null);
});

test('a residual iOS writer lease is awaited once and then reacquired without duplicate heartbeat', async (t) => {
  const factory = new IDBFactory();
  const clock = mutableClock();
  const abandoned = application(factory, {
    tabId: 'ios-residual-a', prefix: 'f3370000', now: clock.now,
  });
  await abandoned.initialize();
  await abandoned.completeSetup(setupPayload());
  const previousEpoch = abandoned.writerEpoch;
  abandoned.suspend();

  const intervals = intervalHarness();
  const delays = [];
  const reopened = application(factory, {
    tabId: 'ios-residual-b', prefix: 'f3380000', now: clock.now,
    setInterval: intervals.setInterval,
    clearInterval: intervals.clearInterval,
    setTimeout: (callback, delay) => {
      delays.push(delay);
      clock.advance(delay);
      queueMicrotask(callback);
      return 1;
    },
  });
  t.after(async () => { await reopened.close(); await abandoned.close(); });
  const initialized = await reopened.initialize();
  assert.equal(delays.length, 1);
  assert.ok(delays[0] > 0 && delays[0] <= PeritaApp.LEASE_DURATION_MS + 1);
  assert.equal(initialized.phase, 'ok');
  assert.equal(initialized.writer, true);
  assert.equal(initialized.writerEpoch, previousEpoch + 1);
  reopened.startHeartbeat();
  reopened.startHeartbeat();
  assert.equal(intervals.activeCount, 1);
  assert.equal(intervals.createdCount, 1);
});

test('service worker waiting and newly installed updates remain detectable without reload loops', async () => {
  const container = eventTargetHarness();
  container.controller = { id: 'current-controller' };
  const registration = eventTargetHarness();
  let updateCalls = 0;
  const waiting = { id: 'waiting-worker' };
  registration.waiting = waiting;
  registration.installing = null;
  registration.update = async () => { updateCalls += 1; };
  container.ready = Promise.resolve(registration);
  const detected = [];
  let reloads = 0;
  const updates = PeritaApp.createServiceWorkerUpdateController({
    serviceWorker: container,
    onWaiting: (worker) => detected.push(worker),
    reload: () => { reloads += 1; },
  });

  await updates.start();
  assert.equal(updateCalls, 1);
  assert.equal(detected.includes(waiting), true);

  const installing = eventTargetHarness();
  installing.state = 'installing';
  registration.waiting = null;
  registration.installing = installing;
  registration.dispatch('updatefound');
  installing.state = 'installed';
  installing.dispatch('statechange');
  assert.equal(detected.includes(installing), true);

  await updates.check();
  assert.equal(updateCalls, 2);
  container.dispatch('controllerchange');
  container.dispatch('controllerchange');
  assert.equal(reloads, 1);
  updates.stop();
  assert.equal(container.listenerCount('controllerchange'), 0);
});

test('a failed resume remains retryable and never reuses a closed storage connection', async (t) => {
  const factory = new IDBFactory();
  const baseStorage = IndexedDb.createPeritaIndexedDb({
    indexedDB: factory,
    IDBKeyRange,
    crypto: { randomUUID: () => id(903) },
    now: () => NOW,
  });
  let failNextOpen = false;
  const storage = {
    ...baseStorage,
    open: async () => {
      if (failNextOpen) {
        failNextOpen = false;
        throw new Error('induced resume open failure');
      }
      return baseStorage.open();
    },
  };
  const app = application(factory, { prefix: 'f3450000', storage });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  app.suspend();
  failNextOpen = true;
  const failed = await app.resume();
  assert.equal(failed.phase, 'error');
  assert.match(failed.error.message, /induced resume open failure/);
  const retried = await app.resume();
  assert.equal(retried.phase, 'ok');
  assert.equal(retried.writer, true);
  assert.equal(retried.state.runtime.setupStatus, 'completed');
});

test('lifecycle controller serializes pageshow and visibility resumes without duplicate listeners', async () => {
  const eventTarget = eventTargetHarness();
  const visibility = eventTargetHarness('visible');
  const resumptions = [];
  const suspendedReasons = [];
  const recoveringReasons = [];
  const results = [];
  const applicationStub = {
    resume: () => {
      const pending = deferred();
      resumptions.push(pending);
      return pending.promise;
    },
    suspend: () => suspendedReasons.push('suspended'),
  };
  const controller = PeritaApp.createLifecycleController({
    application: applicationStub,
    eventTarget,
    visibilitySource: visibility,
    onRecovering: ({ reason }) => recoveringReasons.push(reason),
    onResult: (result, reason) => results.push({ result, reason }),
  });
  const initial = controller.start();
  await Promise.resolve();
  assert.equal(resumptions.length, 1);
  eventTarget.dispatch('pageshow', { persisted: false });
  visibility.dispatch('visibilitychange');
  assert.equal(resumptions.length, 1);
  resumptions[0].resolve({ phase: 'ok' });
  await initial;
  assert.equal(results.length, 1);

  eventTarget.dispatch('pageshow', { persisted: false });
  await Promise.resolve();
  assert.equal(resumptions.length, 2);
  resumptions[1].resolve({ phase: 'ok' });
  await controller.resume('observe-normal-pageshow');

  visibility.visibilityState = 'hidden';
  visibility.dispatch('visibilitychange');
  eventTarget.dispatch('pagehide');
  assert.equal(suspendedReasons.length, 1);
  visibility.visibilityState = 'visible';
  eventTarget.dispatch('pageshow', { persisted: true });
  visibility.dispatch('visibilitychange');
  await Promise.resolve();
  assert.equal(resumptions.length, 3);
  resumptions[2].resolve({ phase: 'ok' });
  await controller.resume('observe-bfcache');
  assert.equal(resumptions.length, 3);
  assert.ok(recoveringReasons.includes('pageshow-bfcache'));
  assert.ok(results.some((item) => item.reason === 'pageshow-bfcache'));

  const rapidOld = controller.resume('rapid-foreground');
  await Promise.resolve();
  assert.equal(resumptions.length, 4);
  visibility.visibilityState = 'hidden';
  visibility.dispatch('visibilitychange');
  visibility.visibilityState = 'visible';
  visibility.dispatch('visibilitychange');
  resumptions[3].resolve({ phase: 'stale-result' });
  await rapidOld;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resumptions.length, 5);
  resumptions[4].resolve({ phase: 'ok' });
  await controller.resume('observe-rapid-foreground');
  assert.equal(results.some((item) => item.result.phase === 'stale-result'), false);
  assert.equal(eventTarget.listenerCount('pagehide'), 1);
  assert.equal(eventTarget.listenerCount('pageshow'), 1);
  assert.equal(visibility.listenerCount('visibilitychange'), 1);

  controller.stop();
  assert.equal(eventTarget.listenerCount('pagehide'), 0);
  assert.equal(eventTarget.listenerCount('pageshow'), 0);
  assert.equal(visibility.listenerCount('visibilitychange'), 0);
  assert.equal(suspendedReasons.length, 3);
});

test('lifecycle recovery failure is visible to callbacks and a manual retry can recover', async () => {
  const eventTarget = eventTargetHarness();
  const visibility = eventTargetHarness('visible');
  let attempts = 0;
  const errors = [];
  const results = [];
  const controller = PeritaApp.createLifecycleController({
    application: {
      resume: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('induced lifecycle resume failure');
        return { phase: 'ok' };
      },
      suspend: () => undefined,
    },
    eventTarget,
    visibilitySource: visibility,
    onError: (error) => errors.push(error.message),
    onResult: (result) => results.push(result),
  });
  await controller.start();
  assert.deepEqual(errors, ['induced lifecycle resume failure']);
  await controller.resume('manual-retry');
  assert.equal(attempts, 2);
  assert.equal(results[0].phase, 'ok');
  controller.stop();
});

test('definitive close after suspension releases the writer and forbids instance reuse', async (t) => {
  const factory = new IDBFactory();
  const first = application(factory, { tabId: 'close-after-suspend-a', prefix: 'f3550000' });
  await first.initialize();
  await first.completeSetup(setupPayload());
  first.suspend();
  await first.close();
  assert.equal(first.closed, true);
  await assert.rejects(first.resume(), /ya fue cerrada/);

  const second = application(factory, { tabId: 'close-after-suspend-b', prefix: 'f3650000' });
  t.after(() => second.close());
  const initialized = await second.initialize();
  assert.equal(initialized.writer, true);
  assert.notEqual(initialized.phase, 'ready_read_only');
});

test('a duplicated or separate tab never reuses the active writer identity', async (t) => {
  const factory = new IDBFactory();
  const firstSession = sessionStore();
  const create = (prefix, tabSession) => PeritaApp.createPeritaApplication({
    indexedDB: factory,
    IDBKeyRange,
    crypto: { randomUUID: () => id(900) },
    legacyStorage: legacyStorage(null),
    sessionStorage: tabSession,
    navigationType: 'navigate',
    now: () => NOW,
    createUuid: sequence(prefix),
    channel: null,
    setTimeout: (callback) => { queueMicrotask(callback); return 1; },
  });
  const first = create('f3500000', firstSession);
  t.after(() => first.close());
  assert.equal((await first.initialize()).phase, 'setup_required');

  const duplicate = create('f3600000', firstSession.clone());
  t.after(() => duplicate.close());
  const duplicateState = await duplicate.initialize();
  assert.equal(duplicateState.phase, 'read_only');
  assert.equal(duplicateState.writer, false);
  assert.equal(duplicateState.error.code, 'WRITER_ALREADY_OWNED');

  const separate = create('f3700000', sessionStore());
  t.after(() => separate.close());
  const separateState = await separate.initialize();
  assert.equal(separateState.phase, 'read_only');
  assert.equal(separateState.writer, false);
  assert.equal(separateState.error.code, 'WRITER_ALREADY_OWNED');
});

test('retired monthly-planning values in an existing V1.1.0 Period are ignored compatibly', async (t) => {
  const factory = new IDBFactory();
  const first = application(factory, { tabId: 'compatibility-tab-a', prefix: 'f3300000' });
  await first.initialize();
  await first.completeSetup(setupPayload());
  await first.close();

  const storage = IndexedDb.createPeritaIndexedDb({ indexedDB: factory, IDBKeyRange });
  await storage.open();
  const period = await storage.get('periods', id(1));
  await storage.put('periods', {
    ...period,
    variableExpenseBudgetAmount: 123456,
    plannedSavingsAmount: 654321,
  });
  storage.close();

  const reopened = application(factory, { tabId: 'compatibility-tab-b', prefix: 'f3400000' });
  t.after(() => reopened.close());
  const initialized = await reopened.initialize();
  assert.notEqual(initialized.phase, 'error');
  assert.equal(Object.hasOwn(initialized.state.period, 'variableExpenseBudgetAmount'), false);
  assert.equal(Object.hasOwn(initialized.state.period, 'plannedSavingsAmount'), false);
  const backup = await reopened.exportBackup();
  assert.equal(Object.hasOwn(backup.data.periods[0], 'variableExpenseBudgetAmount'), false);
  assert.equal(Object.hasOwn(backup.data.periods[0], 'plannedSavingsAmount'), false);
});

test('financial UI adapter enriches create, edit, and void revisions from canonical state', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory, { prefix: 'f7000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  const categoryId = id(30);
  await app.execute('category.create', { category: {
    id: categoryId, name: 'Comida', status: 'active', revision: 1, createdAt: NOW, updatedAt: NOW,
  } });
  const created = await app.execute('variable-expense.create', {
    accountId: id(2), categoryId, operationDate: DATE, amount: 10000,
    concept: 'Almuerzo', observation: null,
  });
  const operationId = created.result.result.operation.id;
  const edited = await app.execute('variable-expense.edit', {
    operationId, accountId: id(2), categoryId, amount: 12000,
  });
  assert.equal(edited.result.result.operation.revision, 2);
  const voided = await app.execute('variable-expense.void', {
    operationId, reason: 'Duplicado',
  });
  assert.equal(voided.result.result.operation.status, 'voided');
  assert.equal(voided.state.accounts[0].balance, 100000);
  assert.equal(voided.state.operationRevisions.length, 2);
});

test('a second tab is visibly read-only while the first writer lease is active', async (t) => {
  const factory = new IDBFactory();
  const first = application(factory, { tabId: 'integration-tab-a', prefix: 'f3000000' });
  const second = application(factory, { tabId: 'integration-tab-b', prefix: 'f4000000' });
  t.after(async () => { await second.close(); await first.close(); });
  await first.initialize();
  await first.completeSetup(setupPayload());

  const initialized = await second.initialize();
  assert.equal(initialized.phase, 'ready_read_only');
  assert.equal(initialized.writer, false);
  await assert.rejects(
    second.execute('financial-settings.update-reference-salary', { salaryReferenceAmount: 1 }),
    /solo lectura/
  );
});

test('a read-only tab can take over after the previous writer releases its lease', async (t) => {
  const factory = new IDBFactory();
  const first = application(factory, { tabId: 'takeover-tab-a', prefix: 'fb000000' });
  const second = application(factory, { tabId: 'takeover-tab-b', prefix: 'fc000000' });
  t.after(() => second.close());
  await first.initialize();
  await first.completeSetup(setupPayload());
  assert.equal((await second.initialize()).phase, 'ready_read_only');
  await first.close();

  const takeover = await second.takeOverWriter();
  assert.equal(takeover.writer.ownerTabId, 'takeover-tab-b');
  assert.equal(takeover.state.runtime.writeEnabled, true);
  assert.notEqual(takeover.report.status, 'diagnostic_only');
});

test('a lost writer epoch is surfaced as a typed error and persists no command effect', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory, { tabId: 'stale-tab-a', prefix: 'fd000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  const storage = IndexedDb.createPeritaIndexedDb({ indexedDB: factory, IDBKeyRange });
  t.after(() => storage.close());
  await storage.open();
  const previous = await storage.get('coordination', 'writer');
  await storage.put('coordination', {
    ...previous,
    ownerTabId: 'stale-tab-b',
    epoch: previous.epoch + 1,
    heartbeatAt: NOW,
    expiresAt: '2026-08-05T12:01:00.000Z',
    status: 'active',
  });

  await assert.rejects(
    app.execute('financial-settings.update-reference-salary', { salaryReferenceAmount: 950000 }),
    (error) => error.code === 'WRITER_EPOCH_LOST'
  );
  assert.equal((await app.refresh()).settings.salary, 900000);
});

test('an integrity mismatch initializes visibly restricted instead of silently repairing data', async (t) => {
  const factory = new IDBFactory();
  const first = application(factory, { tabId: 'integrity-tab-a', prefix: 'fe000000' });
  await first.initialize();
  await first.completeSetup(setupPayload());
  await first.close();
  const storage = IndexedDb.createPeritaIndexedDb({ indexedDB: factory, IDBKeyRange });
  await storage.open();
  const account = await storage.get('accounts', id(2));
  await storage.put('accounts', { ...account, currentBalance: account.currentBalance + 1 });
  storage.close();

  const second = application(factory, { tabId: 'integrity-tab-b', prefix: 'ff000000' });
  t.after(() => second.close());
  const initialized = await second.initialize();
  assert.ok(['warning', 'restricted', 'diagnostic'].includes(initialized.phase), initialized.phase);
  assert.notEqual(initialized.report.status, 'ok');
  assert.equal(initialized.state.accounts[0].balance, 100001);
});

test('legacy initialization performs dry-run, confirms cutover, and preserves perita_v1', async (t) => {
  const factory = new IDBFactory();
  const raw = JSON.stringify(legacyState());
  const source = legacyStorage(raw);
  const app = application(factory, { legacyStorage: source, prefix: 'f8000000' });
  t.after(() => app.close());
  const initialized = await app.initialize();
  assert.equal(initialized.phase, 'migration_pending');
  assert.notEqual(initialized.dryRun.classification, 'blocked');
  const migrated = await app.confirmMigration(initialized.dryRun);
  assert.equal(migrated.state.runtime.setupStatus, 'completed');
  assert.equal(migrated.state.operations.length, 0);
  assert.equal(migrated.state.movements.length, 0);
  assert.equal(migrated.state.migrations.length, 1);
  assert.equal(source.getItem('perita_v1'), raw);
  assert.equal(source.writes.length, 0);
});

test('a blocked legacy dry-run never enables V1.1.0 writes', async (t) => {
  const factory = new IDBFactory();
  const blocked = legacyState();
  blocked.expenses = [{ id: 99, type: 'income', date: DATE, amount: 1, account: 1 }];
  const app = application(factory, {
    legacyStorage: legacyStorage(JSON.stringify(blocked)), prefix: 'be000000',
  });
  t.after(() => app.close());
  const initialized = await app.initialize();
  assert.equal(initialized.phase, 'migration_blocked');
  assert.equal(initialized.state.runtime.writeEnabled, false);
  assert.equal(initialized.state.runtime.dataRevision, 0);
});

test('a storage read failure is an explicit error and never a fresh install', async () => {
  const storage = {
    open: async () => { throw new Error('induced read failure'); },
    runTransaction: async () => { throw new Error('must not run'); },
  };
  const noop = () => Promise.resolve();
  const app = PeritaApp.createPeritaApplication({
    storage,
    runtime: { getWriterState: noop, acquireWriter: noop, setWriteEnabled: noop },
    commands: {},
    integrity: { runFullCheck: noop },
    migration: {},
    backup: {},
    legacyStorage: legacyStorage(null),
    createUuid: sequence('f5000000'),
    tabId: 'failure-tab',
    channel: null,
  });
  const initialized = await app.initialize();
  assert.equal(initialized.phase, 'error');
  assert.equal(initialized.state, null);
  assert.match(initialized.error.message, /induced read failure/);
});

test('all approved V1.1.0 UI command paths are exposed by the adapter', () => {
  const names = Object.keys(PeritaApp.COMMANDS);
  for (const required of [
    'balance-adjustment.create', 'salary-receipt.create', 'additional-income.edit',
    'variable-expense.void', 'fixed-expense-payment.create', 'debt-payment.edit',
    'debt-total-adjustment.create', 'savings-deposit.create', 'savings-withdrawal.void',
    'transfer.edit', 'period.close-and-open-next', 'fixed-expense-instance.update-planned-amount',
  ]) assert.ok(names.includes(required), required);
});

test('browser synchronous SHA-256 matches standard vectors required by monthly close', () => {
  assert.equal(PeritaApp.browserSha256(''), sha256(''));
  assert.equal(PeritaApp.browserSha256('Perita 💰'), sha256('Perita 💰'));
});

test('backup restore integration replaces state, rechecks integrity, and re-enables normal writing', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory, { prefix: 'f6000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  const target = await app.exportBackup();
  await app.execute('financial-settings.update-reference-salary', { salaryReferenceAmount: 1 });
  const restored = await app.restoreBackup(target);
  assert.equal(restored.state.settings.salary, 900000);
  assert.equal(restored.state.runtime.writeEnabled, true);
  assert.notEqual(restored.report.status, 'diagnostic_only');
});

test('an invalid backup is rejected before restore and leaves canonical data intact', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory, { prefix: 'ab000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  const backup = await app.exportBackup();
  const invalid = { ...backup, dataRevision: backup.dataRevision + 1 };
  const validation = await app.validateBackup(invalid);
  assert.equal(validation.status, 'invalid');
  assert.ok(validation.errors.some((error) => error.code === 'BACKUP_HASH_MISMATCH'));
  assert.equal((await app.refresh()).settings.salary, 900000);
});

test('monthly-close adapter derives exact revisions and reloads the new period plus snapshot history', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory, { prefix: 'f9000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  await app.execute('salary-receipt.create', { accountId:id(2), operationDate:DATE, amount:900000 });
  const closed = await app.execute('period.close-and-open-next', {});
  assert.equal(closed.state.period.periodKey, '2026-09');
  assert.equal(closed.state.monthlyHistory.length, 1);
  assert.equal(closed.state.monthlyHistory[0].totals.totalIncomeAmount, 900000);
  assert.equal(closed.state.accounts[0].balance, 1000000);
});

test('fixed-expense monthly amount is updated independently from its future reference', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory, { prefix: 'bd000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  await app.execute('fixed-expense-template.create', { template: {
    id: id(20), name: 'Arriendo', referenceAmount: 50000, status: 'active', revision: 1,
    createdAt: NOW, updatedAt: NOW,
  } });
  await app.execute('salary-receipt.create', { accountId: id(2), operationDate: DATE, amount: 900000 });
  const closed = await app.execute('period.close-and-open-next', {});
  const instance = closed.state.budget[0].instance;
  const updated = await app.execute('fixed-expense-instance.update-planned-amount', {
    instanceId: instance.id, plannedAmount: 62000,
  });
  assert.equal(updated.state.budget[0].instance.plannedAmount, 62000);
  assert.equal(updated.state.budget[0].amount, 50000);
});

test('definitive deletion integration requires external backup and exact ELIMINAR', async (t) => {
  const factory = new IDBFactory();
  const source = legacyStorage(null);
  const app = application(factory, { legacyStorage:source, prefix:'fa000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  const externalBackup = await app.exportBackup();
  await assert.rejects(app.deleteAllData(externalBackup, 'Eliminar'));
  assert.notEqual(app.writerEpoch, null);
  const result = await app.deleteAllData(externalBackup, 'ELIMINAR');
  assert.equal(result.deleted, true);
  assert.equal(source.writes.length, 0);
});

test('responsive record views select tables or cards without duplicating filters and actions', () => {
  const html = readFileSync(`${__dirname}/../index.html`, 'utf8');
  const jsx = readFileSync(`${__dirname}/../Perita.jsx`, 'utf8');

  assert.match(jsx, /const ResponsiveDataView = \(\{desktop,mobile\}\) => useMobileRecords\(\) \? mobile : desktop/);
  assert.equal((jsx.match(/<ResponsiveDataView/g)||[]).length, 4);
  assert.equal((jsx.match(/table-wrap table-compact/g)||[]).length, 5);
  assert.match(jsx, /incomeList\.map\(e=><MobileRecordCard[\s\S]*actions=\{incomeActions\(e\)\}/);
  assert.match(jsx, /filtered\.map\(e=><MobileRecordCard[\s\S]*actions=\{expenseActions\(e\)\}/);
  assert.match(jsx, /debts\.map\(d=><MobileRecordCard[\s\S]*actions=\{debtActions\(d\)\}/);
  assert.match(jsx, /activeOperations\.map\(operation=><MobileRecordCard[\s\S]*actions=\{operationActions\(operation\)\}/);
  assert.match(jsx, /if\(e\.type!=='expense'\) return false;[\s\S]*filtered\.map\(e=>/);

  assert.match(html, /@media\(max-width:700px\)[\s\S]*\.table-compact table\{min-width:0;table-layout:fixed\}/);
  assert.match(html, /\.mobile-record-list\{display:grid;gap:10px;min-width:0\}/);
  assert.match(html, /\.mobile-record-actions\{display:flex;justify-content:flex-end/);
});

test('static integration loads V1.1.0 modules in order and caches the complete offline shell', () => {
  const html = readFileSync(`${__dirname}/../index.html`, 'utf8');
  const jsx = readFileSync(`${__dirname}/../Perita.jsx`, 'utf8');
  const worker = readFileSync(`${__dirname}/../service-worker.js`, 'utf8');
  const ordered = [
    'perita-contracts.js','perita-indexeddb.js','perita-domain.js','perita-runtime.js',
    'perita-integrity.js','perita-legacy.js','perita-domain-commands.js','perita-backup.js',
    'perita-migration.js','perita-app.js',
  ];
  let cursor = -1;
  for (const file of ordered) {
    const index = html.indexOf(`src="${file}"`);
    assert.ok(index > cursor, file);
    cursor = index;
    assert.match(worker, new RegExp(`/${file.replace('.', '\\.')}`));
  }
  assert.doesNotMatch(jsx, /PeritaCore|localStorage\.(setItem|removeItem)/);
  assert.match(jsx, /fixed-expense-instance\.update-planned-amount/);
  assert.match(jsx, /La cuenta debe crearse en cero/);
  assert.match(jsx, /La meta debe crearse en cero/);
  assert.match(jsx, /const MoneyInput/);
  assert.match(jsx, /const OtherPage/);
  assert.match(jsx, /history',label:'Historial',icon:'document'/);
  assert.doesNotMatch(jsx, /Presupuesto variable|Ahorro planificado|Guardar planificación/);
  assert.match(worker, /perita-v110-shell-v1/);
  assert.match(html, /IndexedDB perita_v110/);
});

test('UI integration keeps setup, navigation, icons, hierarchy, and unsaved guards coherent', () => {
  const html = readFileSync(`${__dirname}/../index.html`, 'utf8');
  const jsx = readFileSync(`${__dirname}/../Perita.jsx`, 'utf8');

  assert.doesNotMatch(jsx, /Agregar otra cuenta|Quitar cuenta/);
  assert.match(jsx, /accounts:\[\{id:recordId\(\),name:account\.name\.trim\(\)/);
  assert.match(jsx, /window\.scrollTo\(\{top:0,left:0,behavior:'auto'\}\)/);
  assert.match(jsx, /EmptyState icon="document" title="Aún no hay meses cerrados\."/);
  assert.match(jsx, /Agregar gasto fijo<\/button>/);
  assert.match(jsx, /Referencia configurada: \{fmt\(state\.settings\.salary\)\}/);
  assert.match(jsx, /Cuenta destino: \{salaryDestination\?\.name/);
  assert.match(jsx, /Distribución de ingresos/);
  assert.doesNotMatch(jsx, /Distribución del Sueldo/);
  assert.match(jsx, /Registra un ingreso para ver la distribución del mes\./);
  assert.match(jsx, /Total fijos del mes/);
  assert.match(jsx, /Los gastos fijos se descuentan del disponible cuando los marcas como pagados\./);
  const dashboardSource = jsx.slice(jsx.indexOf('const Dashboard ='), jsx.indexOf('// ── Accounts'));
  const fixedSource = jsx.slice(jsx.indexOf('const Budget ='), jsx.indexOf('const IngresosPanel ='));
  const incomeSource = jsx.slice(jsx.indexOf('const IngresosPanel ='), jsx.indexOf('const ExpenseTracker ='));
  assert.doesNotMatch(dashboardSource, /settings\.salary/);
  assert.doesNotMatch(fixedSource, /settings\.salary|Total ahorro|Uso del sueldo/);
  assert.doesNotMatch(incomeSource, /state\.settings\.salary\s*>\s*0\s*&&\s*\(/);
  assert.match(jsx, /Sin ahorros registrados\./);
  for (const location of [
    'BancoEstado', 'Banco de Chile', 'Banco Santander', 'BCI', 'Scotiabank', 'Itaú',
    'Banco Falabella', 'Banco Ripley', 'Banco BICE', 'Banco Security', 'Banco Consorcio',
    'Banco Internacional', 'Tenpo Bank', 'Tanner Banco Digital', 'Efectivo',
  ]) assert.match(jsx, new RegExp(location));
  assert.match(jsx, /form\.bankChoice==='Otro'/);
  assert.match(jsx, /Nombre de la institución/);
  assert.match(jsx, /app\.createAccountWithBalance/);
  assert.match(jsx, /title:'Desactivar cuenta'/);
  assert.match(jsx, /const presentError = \(error\) => PeritaApp\.userErrorMessage\(error\)/);
  assert.match(jsx, /PeritaApp\.operationTypeLabel\(operation\.type\)/);
  assert.doesNotMatch(jsx, /operationType==='additional_income'\?'additional-income':'variable-expense'/);
  assert.match(jsx, /operation\.type!=='balance_adjustment'/);
  assert.doesNotMatch(jsx, /\{operation\.type\}<\/td>|Revisiones<\/th>|\$\{error\?\.code|\$\{error\.code/);
  assert.match(jsx, /const RecoveryOverlay = \(\) =>/);
  assert.match(jsx, /PeritaApp\.createLifecycleController/);
  assert.match(jsx, /Revalidando tus datos y el control seguro de escritura\./);
  assert.match(jsx, /Reintentar conexión/);
  assert.match(jsx, /const \[pendingClose, setPendingClose\] = useState\(null\)/);
  assert.match(jsx, /setPendingClose\(\(\) => closeFn\)/);
  assert.equal((jsx.match(/if\(valid\) resetAndCloseForm\(\)/g)||[]).length, 2);

  assert.match(html, /\.form-input\{width:100%;min-width:0;max-width:100%/);
  assert.match(html, /\.form-input\[type="date"\],\.form-input\[type="month"\]\{display:block;inline-size:100%;min-inline-size:0/);
  assert.match(html, /::-webkit-date-and-time-value\{inline-size:100%;min-inline-size:0/);
  assert.match(html, /\.notif-close\{width:32px;height:32px;min-width:32px/);
  assert.match(html, /\.items-start\{align-items:flex-start\}/);
  assert.match(html, /\.mb-1\{margin-bottom:4px\}.*\.mb-3\{margin-bottom:12px\}.*\.mb-5\{margin-bottom:20px\}/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const Contracts = require('../perita-contracts.js');
const IndexedDb = require('../perita-indexeddb.js');
const Runtime = require('../perita-runtime.js');
const Integrity = require('../perita-integrity.js');
const DomainCommands = require('../perita-domain-commands.js');

const NOW = '2026-08-05T12:00:00.000Z';
const PERIOD_ID = uuid(1);
const ACCOUNT_A = uuid(2);
const ACCOUNT_B = uuid(3);
const CATEGORY_A = uuid(4);
const CATEGORY_B = uuid(5);
const TEMPLATE_ID = uuid(6);
const INSTANCE_ID = uuid(7);
const LEASE_MS = 60000;

function uuid(number) {
  return `d1000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function sequence(prefix) {
  let number = 1;
  return () => `${prefix}-0000-4000-8000-${String(number++).padStart(12, '0')}`;
}

function clock() {
  let time = Date.parse(NOW);
  return {
    now: () => new Date(time).toISOString(),
    advance: (milliseconds) => { time += milliseconds; },
  };
}

function storage(factory) {
  return IndexedDb.createPeritaIndexedDb({
    indexedDB: factory,
    IDBKeyRange,
    now: () => NOW,
    crypto: { randomUUID: () => 'd0000000-0000-4000-8000-000000000000' },
  });
}

function runtime(store, time) {
  return Runtime.createPeritaRuntime({
    storage: store,
    now: time.now,
    tabId: 'income-expenses-tab',
    createUuid: sequence('d2000000'),
  });
}

function commands(run, time, capture, createUuid) {
  const port = capture
    ? Object.freeze({
      executeCommand: (command) => {
        capture.command = command;
        return run.executeCommand(command);
      },
    })
    : run;
  return DomainCommands.createPeritaDomainCommands({
    runtime: port,
    now: time.now,
    createUuid: createUuid || sequence('d3000000'),
  });
}

function account(id, balance) {
  return {
    id,
    name: id === ACCOUNT_A ? 'Cuenta A' : 'Cuenta B',
    openingBalance: balance,
    currentBalance: balance,
    status: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function category(id, name, overrides) {
  return {
    id,
    name,
    status: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...(overrides || {}),
  };
}

function fixedInstance(overrides) {
  return {
    id: INSTANCE_ID,
    periodId: PERIOD_ID,
    templateId: TEMPLATE_ID,
    nameSnapshot: 'Internet',
    plannedAmount: 25000,
    status: 'pending',
    activePaymentOperationId: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...(overrides || {}),
  };
}

async function fixture(t, options) {
  const config = options || {};
  const factory = config.factory || new IDBFactory();
  const time = clock();
  const store = storage(factory);
  await store.open();
  t.after(() => store.close());
  const run = runtime(store, time);
  const capture = {};
  const domain = commands(run, time, capture, config.commandUuid);
  await run.acquireWriter({ expectedEpoch: 0, leaseDurationMs: LEASE_MS });
  await run.setWriteEnabled({ enabled: true, reason: 'income expenses setup' });
  let state = await store.get('system', 'runtime');
  await domain.setup.complete({
    expectedDataRevision: state.dataRevision,
    expectedWriterEpoch: 1,
    currentCivilDate: '2026-08-05',
    financialSettings: {
      key: 'current', salaryReferenceAmount: 900000, currency: 'CLP',
      timezone: 'America/Santiago', revision: 1, createdAt: NOW, updatedAt: NOW,
    },
    period: {
      id: PERIOD_ID, periodKey: '2026-08', status: 'open',
      plannedSalaryAmount: 900000, variableExpenseBudgetAmount: 200000,
      plannedSavingsAmount: 100000, openedAt: NOW, closedAt: null,
      snapshotId: null, revision: 1,
    },
    accounts: [account(ACCOUNT_A, 100000), account(ACCOUNT_B, 50000)],
  });
  await store.add('categories', category(CATEGORY_A, 'Comida'));
  await store.add('categories', category(CATEGORY_B, 'Transporte'));
  await store.add('fixedExpenseTemplates', {
    id: TEMPLATE_ID, name: 'Internet', referenceAmount: 25000,
    status: 'active', revision: 1, createdAt: NOW, updatedAt: NOW,
  });
  await store.add('fixedExpenseInstances', fixedInstance());
  time.advance(1000);
  return { factory, time, store, run, capture, domain };
}

async function base(f, accountId) {
  const state = await f.store.get('system', 'runtime');
  const target = await f.store.get('accounts', accountId || ACCOUNT_A);
  return {
    expectedDataRevision: state.dataRevision,
    expectedWriterEpoch: 1,
    periodId: PERIOD_ID,
    accountId: target.id,
    expectedAccountRevision: target.revision,
  };
}

async function editBase(f, operation, nextAccountId) {
  const previousAccountId = operation.details.accountId;
  const previous = await f.store.get('accounts', previousAccountId);
  const next = await f.store.get('accounts', nextAccountId || previousAccountId);
  return {
    expectedDataRevision: (await f.store.get('system', 'runtime')).dataRevision,
    expectedWriterEpoch: 1,
    periodId: PERIOD_ID,
    operationId: operation.id,
    expectedOperationRevision: operation.revision,
    previousAccountId,
    expectedPreviousAccountRevision: previous.revision,
    accountId: next.id,
    expectedAccountRevision: next.revision,
  };
}

async function voidBase(f, operation) {
  const target = await f.store.get('accounts', operation.details.accountId);
  return {
    expectedDataRevision: (await f.store.get('system', 'runtime')).dataRevision,
    expectedWriterEpoch: 1,
    periodId: PERIOD_ID,
    operationId: operation.id,
    expectedOperationRevision: operation.revision,
    accountId: target.id,
    expectedAccountRevision: target.revision,
  };
}

function rejection(promise) {
  return promise.then(() => assert.fail('expected rejection'), (error) => error);
}

function errorChain(error) {
  const chain = [];
  let current = error;
  while (current) {
    chain.push({ name: current.name, code: current.code, message: current.message, context: current.context });
    current = current.cause;
  }
  return chain;
}

async function salary(f, overrides) {
  return f.domain.salaryReceipt.create({
    ...await base(f), operationDate: '2026-08-05', amount: 900000, ...(overrides || {}),
  });
}

async function income(f, overrides) {
  return f.domain.additionalIncome.create({
    ...await base(f), operationDate: '2026-08-05', amount: 30000,
    concept: 'Venta', observation: 'Transferencia', ...(overrides || {}),
  });
}

async function expense(f, overrides) {
  const categoryRecord = await f.store.get('categories', (overrides && overrides.categoryId) || CATEGORY_A);
  return f.domain.variableExpense.create({
    ...await base(f), categoryId: CATEGORY_A,
    expectedCategoryRevision: overrides && overrides.expectedCategoryRevision !== undefined
      ? overrides.expectedCategoryRevision
      : categoryRecord.revision,
    operationDate: '2026-08-05', amount: 20000, concept: 'Almuerzo', observation: null,
    ...(overrides || {}),
  });
}

async function fixedPayment(f, overrides) {
  const instance = await f.store.get('fixedExpenseInstances', INSTANCE_ID);
  return f.domain.fixedExpensePayment.create({
    ...await base(f), fixedExpenseInstanceId: INSTANCE_ID,
    expectedInstanceRevision: instance.revision,
    operationDate: '2026-08-05', amount: 25000, ...(overrides || {}),
  });
}

async function snapshot(f) {
  return {
    accounts: await f.store.getAll('accounts'),
    instances: await f.store.getAll('fixedExpenseInstances'),
    operations: await f.store.getAll('operations'),
    movements: await f.store.getAll('movements'),
    revisions: await f.store.getAll('operationRevisions'),
    runtime: await f.store.get('system', 'runtime'),
  };
}

function failingStorage(store, targetStore, method) {
  return Object.freeze({
    open: () => store.open(), close: () => store.close(),
    get: (...args) => store.get(...args), getAll: (...args) => store.getAll(...args),
    add: (...args) => store.add(...args), put: (...args) => store.put(...args),
    remove: (...args) => store.remove(...args), queryIndex: (...args) => store.queryIndex(...args),
    runTransaction: (stores, mode, worker) => store.runTransaction(stores, mode, (tx) => worker(Object.freeze({
      ...tx,
      get: (name, key) => {
        if (name === targetStore && method === 'get') throw new Error(`induced ${name}.get`);
        return tx.get(name, key);
      },
      getAll: (name) => {
        if (name === targetStore && method === 'getAll') throw new Error(`induced ${name}.getAll`);
        return tx.getAll(name);
      },
      add: (name, value) => {
        if (name === targetStore && method === 'add') throw new Error(`induced ${name}.add`);
        return tx.add(name, value);
      },
      put: (name, value) => {
        if (name === targetStore && method === 'put') throw new Error(`induced ${name}.put`);
        return tx.put(name, value);
      },
    }))),
  });
}

test('V1.1.0 salary receipt commands', async (t) => {
  await t.test('create posts one income movement and preserves planning and settings', async (t2) => {
    const f = await fixture(t2);
    const planned = await f.store.get('periods', PERIOD_ID);
    const settings = await f.store.get('financialSettings', 'current');
    const audits = await f.store.getAll('auditEvents');
    const completed = await salary(f);
    assert.equal(completed.result.operation.type, 'salary_receipt');
    assert.equal(completed.result.operation.amount, 900000);
    assert.deepEqual(completed.result.operation.details, { accountId: ACCOUNT_A });
    assert.equal(completed.result.movement.delta, 900000);
    assert.equal(completed.result.account.currentBalance, 1000000);
    assert.deepEqual(await f.store.get('periods', PERIOD_ID), planned);
    assert.deepEqual(await f.store.get('financialSettings', 'current'), settings);
    assert.deepEqual(await f.store.getAll('auditEvents'), audits);
  });

  await t.test('a second posted salary in the Period is rejected', async (t2) => {
    const f = await fixture(t2);
    await salary(f);
    const error = await rejection(salary(f));
    assert.equal(error.code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID, JSON.stringify(errorChain(error)));
    assert.equal((await f.store.getAll('operations')).length, 1);
  });

  await t.test('edit changes amount, date, or account with full scopes and revision', async (t2) => {
    const f = await fixture(t2);
    const created = (await salary(f)).result;
    f.time.advance(1000);
    const completed = await f.domain.salaryReceipt.edit({
      ...await editBase(f, created.operation, ACCOUNT_B),
      operationDate: '2026-08-04',
      amount: 800000,
    });
    assert.equal(completed.result.operation.id, created.operation.id);
    assert.equal(completed.result.operation.revision, 2);
    assert.deepEqual(completed.result.operation.details, { accountId: ACCOUNT_B });
    assert.equal(completed.result.movement.id, created.movement.id);
    assert.equal(completed.result.movement.delta, 800000);
    assert.equal(completed.result.previousAccount.currentBalance, 100000);
    assert.equal(completed.result.account.currentBalance, 850000);
    assert.deepEqual(completed.result.operationRevision.previousOperation, created.operation);
    assert.deepEqual(completed.result.operationRevision.previousMovements, [created.movement]);
    assert.deepEqual(f.capture.command.affectedScopes, [
      `period:${PERIOD_ID}`, `account:${ACCOUNT_A}`, `account:${ACCOUNT_B}`,
    ]);
  });

  await t.test('void restores pending financial effect and can be blocked by missing balance', async (t2) => {
    const valid = await fixture(t2);
    const created = (await salary(valid)).result;
    const voided = await valid.domain.salaryReceipt.void(await voidBase(valid, created.operation));
    assert.equal(voided.result.operation.status, 'voided');
    assert.equal(voided.result.movement.status, 'voided');
    assert.equal(voided.result.account.currentBalance, 100000);
    assert.equal(voided.result.operationRevision.changeType, 'void');

    const invalid = await fixture(t2);
    const incoming = (await salary(invalid)).result;
    await invalid.domain.balanceAdjustment.create({
      ...await base(invalid), operationDate: '2026-08-05', delta: -1000000, reason: 'Consumir ingreso',
    });
    assert.equal(
      (await rejection(invalid.domain.salaryReceipt.void(await voidBase(invalid, incoming.operation)))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
  });
});

test('V1.1.0 additional income commands', async (t) => {
  await t.test('multiple incomes are allowed and optional text is represented explicitly', async (t2) => {
    const f = await fixture(t2);
    const first = await income(f, { concept: null, observation: null });
    const second = await income(f, { amount: 10000, concept: 'Reembolso' });
    assert.equal(first.result.movement.delta, 30000);
    assert.deepEqual(first.result.operation.details, {
      accountId: ACCOUNT_A, concept: null, observation: null,
    });
    assert.equal(second.result.account.currentBalance, 140000);
    assert.equal((await f.store.getAll('operations')).length, 2);
  });

  await t.test('edit account, date, amount, concept, and observation then void with history', async (t2) => {
    const f = await fixture(t2);
    const created = (await income(f)).result;
    f.time.advance(1000);
    const edited = await f.domain.additionalIncome.edit({
      ...await editBase(f, created.operation, ACCOUNT_B),
      operationDate: '2026-08-04', amount: 40000,
      concept: 'Venta editada', observation: null,
    });
    assert.deepEqual(edited.result.operation.details, {
      accountId: ACCOUNT_B, concept: 'Venta editada', observation: null,
    });
    assert.equal(edited.result.account.currentBalance, 90000);
    assert.equal((await f.store.getAll('operationRevisions')).length, 1);
    const voided = await f.domain.additionalIncome.void(await voidBase(f, edited.result.operation));
    assert.equal(voided.result.account.currentBalance, 50000);
    assert.equal((await f.store.getAll('operationRevisions')).length, 2);
  });

  await t.test('edit and void reject an income whose reversal cannot be funded', async (t2) => {
    for (const action of ['edit', 'void']) {
      const f = await fixture(t2);
      const created = (await income(f, { amount: 100 })).result;
      await f.domain.balanceAdjustment.create({
        ...await base(f), operationDate: '2026-08-05', delta: -100100, reason: 'Consumir saldo',
      });
      const promise = action === 'edit'
        ? f.domain.additionalIncome.edit({
          ...await editBase(f, created.operation), amount: 200,
        })
        : f.domain.additionalIncome.void(await voidBase(f, created.operation));
      assert.equal((await rejection(promise)).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
    }
  });
});

test('V1.1.0 variable expense commands', async (t) => {
  await t.test('create debits exactly, snapshots category name, and validates balance', async (t2) => {
    const f = await fixture(t2);
    const completed = await expense(f, { amount: 100000 });
    assert.equal(completed.result.operation.type, 'variable_expense');
    assert.equal(completed.result.operation.amount, 100000);
    assert.equal(completed.result.movement.delta, -100000);
    assert.equal(completed.result.account.currentBalance, 0);
    assert.deepEqual(completed.result.operation.details, {
      accountId: ACCOUNT_A, categoryId: CATEGORY_A, categoryName: 'Comida',
      concept: 'Almuerzo', observation: null,
    });
    assert.equal(
      (await rejection(expense(f, { amount: 1 }))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
  });

  await t.test('missing or inactive Category and empty concept are rejected', async (t2) => {
    const missing = await fixture(t2);
    assert.equal(
      (await rejection(expense(missing, { categoryId: uuid(99), expectedCategoryRevision: 1 }))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
    const inactive = await fixture(t2);
    await inactive.store.put('categories', category(CATEGORY_A, 'Comida', { status: 'inactive' }));
    assert.equal((await rejection(expense(inactive))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
    const empty = await fixture(t2);
    assert.equal((await rejection(expense(empty, { concept: '' }))).code, Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD);
  });

  await t.test('edit can change account, category, date, amount, concept, and observation', async (t2) => {
    const f = await fixture(t2);
    const created = (await expense(f)).result;
    const categoryB = await f.store.get('categories', CATEGORY_B);
    f.time.advance(1000);
    const edited = await f.domain.variableExpense.edit({
      ...await editBase(f, created.operation, ACCOUNT_B),
      previousCategoryId: CATEGORY_A,
      categoryId: CATEGORY_B,
      expectedCategoryRevision: categoryB.revision,
      operationDate: '2026-08-04', amount: 10000,
      concept: 'Bus', observation: 'Ida',
    });
    assert.equal(edited.result.previousAccount.currentBalance, 100000);
    assert.equal(edited.result.account.currentBalance, 40000);
    assert.deepEqual(edited.result.operation.details, {
      accountId: ACCOUNT_B, categoryId: CATEGORY_B, categoryName: 'Transporte',
      concept: 'Bus', observation: 'Ida',
    });
    assert.deepEqual(f.capture.command.affectedScopes, [
      `period:${PERIOD_ID}`, `account:${ACCOUNT_A}`, `account:${ACCOUNT_B}`,
      `category:${CATEGORY_A}`, `category:${CATEGORY_B}`,
    ]);
  });

  await t.test('void succeeds after category deactivation and preserves its historical snapshot', async (t2) => {
    const f = await fixture(t2);
    const created = (await expense(f)).result;
    await f.store.put('categories', category(CATEGORY_A, 'Nombre nuevo', { status: 'inactive', revision: 2 }));
    const voided = await f.domain.variableExpense.void({
      ...await voidBase(f, created.operation), categoryId: CATEGORY_A,
    });
    assert.equal(voided.result.account.currentBalance, 100000);
    assert.equal(voided.result.operation.details.categoryName, 'Comida');
    assert.equal(voided.result.movement.delta, -20000);
  });
});

test('V1.1.0 fixed expense payment commands', async (t) => {
  await t.test('create pays one pending instance without changing planned amount or template', async (t2) => {
    const f = await fixture(t2);
    const templateBefore = await f.store.get('fixedExpenseTemplates', TEMPLATE_ID);
    const completed = await fixedPayment(f);
    assert.equal(completed.result.operation.type, 'fixed_expense_payment');
    assert.equal(completed.result.movement.delta, -25000);
    assert.equal(completed.result.account.currentBalance, 75000);
    assert.equal(completed.result.fixedExpenseInstance.status, 'paid');
    assert.equal(completed.result.fixedExpenseInstance.activePaymentOperationId, completed.result.operation.id);
    assert.equal(completed.result.fixedExpenseInstance.plannedAmount, 25000);
    assert.deepEqual(await f.store.get('fixedExpenseTemplates', TEMPLATE_ID), templateBefore);
  });

  await t.test('duplicate, insufficient, foreign, and already-paid instances are rejected', async (t2) => {
    const duplicate = await fixture(t2);
    await fixedPayment(duplicate);
    assert.equal((await rejection(fixedPayment(duplicate))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);

    const insufficient = await fixture(t2);
    assert.equal(
      (await rejection(fixedPayment(insufficient, { amount: 100001 }))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const foreign = await fixture(t2);
    await foreign.store.put('fixedExpenseInstances', fixedInstance({ periodId: uuid(90) }));
    assert.equal((await rejection(fixedPayment(foreign))).code, Contracts.ERROR_CODES.DOMAIN_RELATION_MISMATCH);

    const paid = await fixture(t2);
    await paid.store.put('fixedExpenseInstances', fixedInstance({
      status: 'paid', activePaymentOperationId: uuid(91),
    }));
    assert.equal((await rejection(fixedPayment(paid))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
  });

  await t.test('edit preserves instance link/planning and can change account, amount, and date', async (t2) => {
    const f = await fixture(t2);
    const created = (await fixedPayment(f)).result;
    const instance = await f.store.get('fixedExpenseInstances', INSTANCE_ID);
    f.time.advance(1000);
    const edited = await f.domain.fixedExpensePayment.edit({
      ...await editBase(f, created.operation, ACCOUNT_B),
      fixedExpenseInstanceId: INSTANCE_ID,
      expectedInstanceRevision: instance.revision,
      operationDate: '2026-08-04', amount: 30000,
    });
    assert.equal(edited.result.account.currentBalance, 20000);
    assert.equal(edited.result.previousAccount.currentBalance, 100000);
    assert.equal(edited.result.fixedExpenseInstance.plannedAmount, 25000);
    assert.equal(edited.result.fixedExpenseInstance.revision, instance.revision);
    assert.equal(edited.result.operation.details.fixedExpenseInstanceId, INSTANCE_ID);
  });

  await t.test('void restores account and pending instance without touching planning', async (t2) => {
    const f = await fixture(t2);
    const created = (await fixedPayment(f)).result;
    const instance = await f.store.get('fixedExpenseInstances', INSTANCE_ID);
    const voided = await f.domain.fixedExpensePayment.void({
      ...await voidBase(f, created.operation),
      fixedExpenseInstanceId: INSTANCE_ID,
      expectedInstanceRevision: instance.revision,
    });
    assert.equal(voided.result.account.currentBalance, 100000);
    assert.equal(voided.result.fixedExpenseInstance.status, 'pending');
    assert.equal(voided.result.fixedExpenseInstance.activePaymentOperationId, null);
    assert.equal(voided.result.fixedExpenseInstance.plannedAmount, 25000);
    assert.equal(voided.result.operation.status, 'voided');
  });
});

test('V1.1.0 income/expense common engine gates and atomicity', async (t) => {
  await t.test('invalid amount/date, no-op, stale operation, wrong type, and already voided are rejected', async (t2) => {
    const invalidAmount = await fixture(t2);
    await rejection(income(invalidAmount, { amount: 0 }));
    const invalidDate = await fixture(t2);
    await rejection(income(invalidDate, { operationDate: '2026-08-06' }));

    const noOp = await fixture(t2);
    const created = (await income(noOp)).result;
    assert.equal((await rejection(noOp.domain.additionalIncome.edit({
      ...await editBase(noOp, created.operation),
    }))).code, Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD);
    assert.equal((await rejection(noOp.domain.additionalIncome.edit({
      ...await editBase(noOp, created.operation), amount: 30000, unsupported: true,
    }))).code, Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD);
    assert.equal((await rejection(noOp.domain.additionalIncome.edit({
      ...await editBase(noOp, created.operation), expectedOperationRevision: 99, amount: 1,
    }))).code, Contracts.ERROR_CODES.REVISION_CONFLICT);

    const wrong = await fixture(t2);
    const salaryCreated = (await salary(wrong)).result;
    assert.equal((await rejection(wrong.domain.additionalIncome.void({
      ...await voidBase(wrong, salaryCreated.operation),
    }))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
    const voided = await wrong.domain.salaryReceipt.void(await voidBase(wrong, salaryCreated.operation));
    assert.equal((await rejection(wrong.domain.salaryReceipt.void(
      await voidBase(wrong, voided.result.operation)
    ))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
  });

  await t.test('runtime revision, epoch, lease, write gate, health, and scopes remain authoritative', async (t2) => {
    const cases = [
      async (f) => income(f, { expectedDataRevision: 0 }),
      async (f) => income(f, { expectedWriterEpoch: 2 }),
      async (f) => { f.time.advance(LEASE_MS + 1); return income(f); },
      async (f) => { await f.run.setWriteEnabled({ enabled: false, reason: 'test' }); return income(f); },
      async (f) => {
        const state = await f.store.get('system', 'runtime');
        await f.store.put('system', { ...state, healthStatus: 'diagnostic_only', restrictedScopes: [] });
        return income(f);
      },
      async (f) => {
        const state = await f.store.get('system', 'runtime');
        await f.store.put('system', {
          ...state, healthStatus: 'restricted', restrictedScopes: [`account:${ACCOUNT_A}`],
        });
        return income(f);
      },
    ];
    for (const invoke of cases) {
      const f = await fixture(t2);
      await rejection(invoke(f));
      assert.deepEqual(await f.store.getAll('operations'), []);
    }
  });

  await t.test('induced failures in every relevant store roll back all effects', async (t2) => {
    for (const [storeName, method, kind] of [
      ['periods', 'get', 'income'],
      ['accounts', 'put', 'income'], ['operations', 'add', 'income'],
      ['operations', 'getAll', 'salary'], ['movements', 'add', 'income'],
      ['commits', 'add', 'income'],
      ['system', 'put', 'income'], ['operationRevisions', 'add', 'edit'],
      ['fixedExpenseInstances', 'put', 'fixed'], ['fixedExpenseInstances', 'get', 'fixed'],
      ['categories', 'get', 'variable'],
    ]) {
      const f = await fixture(t2);
      let created;
      if (kind === 'edit') created = (await income(f)).result;
      const before = await snapshot(f);
      const brokenStore = failingStorage(f.store, storeName, method);
      const brokenRuntime = runtime(brokenStore, f.time);
      const broken = commands(brokenRuntime, f.time, null, sequence('d5000000'));
      const promise = kind === 'fixed'
        ? broken.fixedExpensePayment.create({
          ...await base(f), fixedExpenseInstanceId: INSTANCE_ID, expectedInstanceRevision: 1,
          operationDate: '2026-08-05', amount: 25000,
        })
        : kind === 'variable'
          ? broken.variableExpense.create({
            ...await base(f), categoryId: CATEGORY_A, expectedCategoryRevision: 1,
            operationDate: '2026-08-05', amount: 10000, concept: 'Prueba',
          })
          : kind === 'salary'
            ? broken.salaryReceipt.create({
              ...await base(f), operationDate: '2026-08-05', amount: 10000,
            })
            : kind === 'edit'
          ? broken.additionalIncome.edit({
            ...await editBase(f, created.operation), amount: 10000,
          })
          : broken.additionalIncome.create({
            ...await base(f), operationDate: '2026-08-05', amount: 10000,
          });
      await rejection(promise);
      assert.deepEqual(await snapshot(f), before, `${storeName}.${method}`);
    }
  });

  await t.test('commands advance once and reload coherently', async (t2) => {
    const factory = new IDBFactory();
    const f = await fixture(t2, { factory });
    const before = await f.store.get('system', 'runtime');
    const one = await income(f);
    const two = await expense(f);
    const three = await fixedPayment(f);
    assert.equal(one.commit.dataRevision, before.dataRevision + 1);
    assert.equal(two.commit.dataRevision, before.dataRevision + 2);
    assert.equal(three.commit.dataRevision, before.dataRevision + 3);
    f.store.close();
    const reloaded = storage(factory);
    await reloaded.open();
    t2.after(() => reloaded.close());
    assert.equal((await reloaded.getAll('operations')).length, 3);
    assert.equal((await reloaded.getAll('movements')).length, 3);
    assert.equal((await reloaded.get('fixedExpenseInstances', INSTANCE_ID)).status, 'paid');
  });
});

test('V1.1.0 income/expense integrity', async (t) => {
  function checker(f) {
    if (!f.integrity) {
      f.integrity = Integrity.createPeritaIntegrity({
        storage: f.store, now: f.time.now, createUuid: sequence('d6000000'),
      });
    }
    return f.integrity;
  }

  await t.test('valid create/edit/void states remain integral', async (t2) => {
    const f = await fixture(t2);
    const salaryCreated = (await salary(f)).result;
    const incomeCreated = (await income(f)).result;
    await expense(f);
    const fixedCreated = (await fixedPayment(f)).result;
    await f.domain.additionalIncome.void(await voidBase(f, incomeCreated.operation));
    const instance = await f.store.get('fixedExpenseInstances', INSTANCE_ID);
    await f.domain.fixedExpensePayment.void({
      ...await voidBase(f, fixedCreated.operation), fixedExpenseInstanceId: INSTANCE_ID,
      expectedInstanceRevision: instance.revision,
    });
    assert.equal(salaryCreated.operation.status, 'posted');
    assert.equal((await checker(f).runFullCheck()).status, 'ok');
  });

  await t.test('cardinality, sign, salary duplicate, payment duplicate, and instance mismatch are detected', async (t2) => {
    const cardinality = await fixture(t2);
    const createdIncome = (await income(cardinality)).result;
    await cardinality.store.add('movements', { ...createdIncome.movement, id: uuid(80) });
    let report = await checker(cardinality).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'ACCOUNT_OPERATION_MOVEMENT_CARDINALITY'));

    const sign = await fixture(t2);
    const createdExpense = (await expense(sign)).result;
    await sign.store.put('movements', { ...createdExpense.movement, delta: 20000 });
    report = await checker(sign).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'ACCOUNT_OPERATION_MOVEMENT_INVALID'));

    const duplicateSalary = await fixture(t2);
    const firstSalary = (await salary(duplicateSalary)).result;
    await duplicateSalary.store.add('operations', { ...firstSalary.operation, id: uuid(81) });
    report = await checker(duplicateSalary).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'SALARY_RECEIPT_POSTED_DUPLICATE'));

    const fixed = await fixture(t2);
    const payment = (await fixedPayment(fixed)).result;
    await fixed.store.add('operations', { ...payment.operation, id: uuid(82) });
    await fixed.store.put('fixedExpenseInstances', {
      ...payment.fixedExpenseInstance, activePaymentOperationId: uuid(83),
    });
    report = await checker(fixed).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'FIXED_PAYMENT_POSTED_DUPLICATE'));
    assert.ok(report.issues.some((issue) => issue.code === 'FIXED_INSTANCE_PAYMENT_STATE_INCONSISTENT'));

    const pendingLink = await fixture(t2);
    await pendingLink.store.put('fixedExpenseInstances', fixedInstance({
      activePaymentOperationId: uuid(84),
    }));
    report = await checker(pendingLink).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'FIXED_INSTANCE_PAYMENT_STATE_INCONSISTENT'));
  });
});

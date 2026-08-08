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
const DATE = '2026-08-05';
const PERIOD = uuid(1);
const ACCOUNT_A = uuid(2);
const ACCOUNT_B = uuid(3);
const GOAL_A = uuid(4);
const GOAL_B = uuid(5);
const DEBT = uuid(6);
const LEASE_MS = 60000;

function uuid(number) {
  return `e1000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
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
    crypto: { randomUUID: () => uuid(900) },
  });
}

function runtime(store, time) {
  return Runtime.createPeritaRuntime({
    storage: store,
    now: time.now,
    tabId: 'debt-savings-transfer-tab',
    createUuid: sequence('e2000000'),
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
    createUuid: createUuid || sequence('e3000000'),
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

function goal(id, overrides) {
  return {
    id,
    name: id === GOAL_A ? 'Meta A' : 'Meta B',
    targetAmount: 100000,
    openingBalance: 0,
    currentBalance: 0,
    plannedMonthlyAmount: 0,
    lifecycleStatus: 'active',
    progressStatus: 'in_progress',
    closedAt: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...(overrides || {}),
  };
}

function debt(overrides) {
  return {
    id: DEBT,
    name: 'Deuda',
    totalAmount: 100000,
    openingOutstanding: 100000,
    outstandingAmount: 100000,
    dueDate: '2026-08-01',
    lifecycleStatus: 'active',
    paymentStatus: 'overdue',
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
  const domain = commands(run, time, capture, config.createUuid);
  await run.acquireWriter({ expectedEpoch: 0, leaseDurationMs: LEASE_MS });
  await run.setWriteEnabled({ enabled: true, reason: 'block four fixture' });
  const state = await store.get('system', 'runtime');
  await domain.setup.complete({
    expectedDataRevision: state.dataRevision,
    expectedWriterEpoch: 1,
    currentCivilDate: DATE,
    financialSettings: {
      key: 'current', salaryReferenceAmount: 0, currency: 'CLP',
      timezone: 'America/Santiago', revision: 1, createdAt: NOW, updatedAt: NOW,
    },
    period: {
      id: PERIOD, periodKey: '2026-08', status: 'open',
      plannedSalaryAmount: 0, variableExpenseBudgetAmount: 0,
      plannedSavingsAmount: 0, openedAt: NOW, closedAt: null,
      snapshotId: null, revision: 1,
    },
    accounts: [account(ACCOUNT_A, 200000), account(ACCOUNT_B, 100000)],
  });
  await store.add('savingsGoals', goal(GOAL_A));
  await store.add('savingsGoals', goal(GOAL_B));
  await store.add('debts', debt());
  await store.add('periodOpenings', {
    id: uuid(10), periodId: PERIOD, targetType: 'savings_goal', targetId: GOAL_A, openingAmount: 0,
  });
  await store.add('periodOpenings', {
    id: uuid(11), periodId: PERIOD, targetType: 'savings_goal', targetId: GOAL_B, openingAmount: 0,
  });
  await store.add('periodOpenings', {
    id: uuid(12), periodId: PERIOD, targetType: 'debt', targetId: DEBT, openingAmount: 100000,
  });
  time.advance(1000);
  return { factory, time, store, run, capture, domain };
}

async function header(f) {
  return {
    expectedDataRevision: (await f.store.get('system', 'runtime')).dataRevision,
    expectedWriterEpoch: 1,
    periodId: PERIOD,
  };
}

async function targetRevision(f, targetType, targetId) {
  const storeName = targetType === 'account' ? 'accounts' : 'savingsGoals';
  return (await f.store.get(storeName, targetId)).revision;
}

async function payment(f, overrides) {
  return f.domain.debtPayment.create({
    ...await header(f),
    accountId: ACCOUNT_A,
    expectedAccountRevision: (await f.store.get('accounts', ACCOUNT_A)).revision,
    debtId: DEBT,
    expectedDebtRevision: (await f.store.get('debts', DEBT)).revision,
    operationDate: DATE,
    amount: 20000,
    concept: null,
    observation: null,
    ...(overrides || {}),
  });
}

async function deposit(f, goalId, amount, overrides) {
  const id = goalId || GOAL_A;
  return f.domain.savingsDeposit.create({
    ...await header(f),
    goalId: id,
    expectedGoalRevision: (await f.store.get('savingsGoals', id)).revision,
    operationDate: DATE,
    amount: amount || 50000,
    concept: null,
    observation: null,
    ...(overrides || {}),
  });
}

async function transfer(f, sourceType, sourceId, destinationType, destinationId, amount) {
  return f.domain.transfer.create({
    ...await header(f),
    sourceType,
    sourceId,
    expectedSourceRevision: await targetRevision(f, sourceType, sourceId),
    destinationType,
    destinationId,
    expectedDestinationRevision: await targetRevision(f, destinationType, destinationId),
    operationDate: DATE,
    amount: amount || 20000,
    concept: null,
    observation: null,
  });
}

function rejection(promise) {
  return promise.then(() => assert.fail('expected rejection'), (error) => error);
}

async function allFinancial(f) {
  return {
    accounts: await f.store.getAll('accounts'),
    goals: await f.store.getAll('savingsGoals'),
    debts: await f.store.getAll('debts'),
    operations: await f.store.getAll('operations'),
    movements: await f.store.getAll('movements'),
    revisions: await f.store.getAll('operationRevisions'),
    runtime: await f.store.get('system', 'runtime'),
  };
}

function failingStorage(store, targetStore, method) {
  return Object.freeze({
    open: () => store.open(),
    close: () => store.close(),
    get: (...args) => store.get(...args),
    getAll: (...args) => store.getAll(...args),
    add: (...args) => store.add(...args),
    put: (...args) => store.put(...args),
    remove: (...args) => store.remove(...args),
    queryIndex: (...args) => store.queryIndex(...args),
    runTransaction: (stores, mode, action) => store.runTransaction(
      stores,
      mode,
      (transaction) => action(Object.freeze({
        abort: () => transaction.abort(),
        get: (name, key) => {
          if (name === targetStore && method === 'get') throw new Error(`induced ${name}.get`);
          return transaction.get(name, key);
        },
        getAll: (name) => {
          if (name === targetStore && method === 'getAll') throw new Error(`induced ${name}.getAll`);
          return transaction.getAll(name);
        },
        add: (name, value) => {
          if (name === targetStore && method === 'add') throw new Error(`induced ${name}.add`);
          return transaction.add(name, value);
        },
        put: (name, value) => {
          if (name === targetStore && method === 'put') throw new Error(`induced ${name}.put`);
          return transaction.put(name, value);
        },
      }))
    ),
  });
}

function checker(f) {
  return Integrity.createPeritaIntegrity({
    storage: f.store, now: f.time.now, createUuid: sequence('e6000000'),
  });
}

test('V1.1.0 debt payment and total adjustment commands', async (t) => {
  await t.test('partial and total payments update two targets and derived status', async (t2) => {
    const partial = await fixture(t2);
    const one = (await payment(partial)).result;
    assert.equal(one.operation.amount, 20000);
    assert.deepEqual(one.movements.map((movement) => movement.delta), [-20000, -20000]);
    assert.equal((await partial.store.get('accounts', ACCOUNT_A)).currentBalance, 180000);
    assert.equal((await partial.store.get('debts', DEBT)).outstandingAmount, 80000);
    assert.equal((await partial.store.get('debts', DEBT)).paymentStatus, 'overdue');

    const total = await fixture(t2);
    await payment(total, { amount: 100000 });
    assert.equal((await total.store.get('debts', DEBT)).outstandingAmount, 0);
    assert.equal((await total.store.get('debts', DEBT)).paymentStatus, 'paid');
  });

  await t.test('overpayment and insufficient Account balance are rejected atomically', async (t2) => {
    const over = await fixture(t2);
    assert.equal((await rejection(payment(over, { amount: 100001 }))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
    const poor = await fixture(t2);
    await poor.store.put('accounts', account(ACCOUNT_A, 10000));
    assert.equal((await rejection(payment(poor, { amount: 20000 }))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
    assert.equal((await poor.store.getAll('operations')).length, 0);
  });

  await t.test('edit changes Account, date, and amount while preserving the Debt and full history', async (t2) => {
    const f = await fixture(t2);
    const created = (await payment(f)).result;
    f.time.advance(1000);
    const edited = await f.domain.debtPayment.edit({
      ...await header(f),
      operationId: created.operation.id,
      expectedOperationRevision: 1,
      previousAccountId: ACCOUNT_A,
      expectedPreviousAccountRevision: (await f.store.get('accounts', ACCOUNT_A)).revision,
      accountId: ACCOUNT_B,
      expectedAccountRevision: (await f.store.get('accounts', ACCOUNT_B)).revision,
      debtId: DEBT,
      expectedDebtRevision: (await f.store.get('debts', DEBT)).revision,
      operationDate: '2026-08-04',
      amount: 30000,
    });
    assert.equal((await f.store.get('accounts', ACCOUNT_A)).currentBalance, 200000);
    assert.equal((await f.store.get('accounts', ACCOUNT_B)).currentBalance, 70000);
    assert.equal((await f.store.get('debts', DEBT)).outstandingAmount, 70000);
    assert.deepEqual(edited.result.operationRevision.previousOperation, created.operation);
    assert.deepEqual(edited.result.operationRevision.previousMovements, created.movements);
    assert.deepEqual(f.capture.command.affectedScopes, [
      `period:${PERIOD}`, `account:${ACCOUNT_A}`, `account:${ACCOUNT_B}`, `debt:${DEBT}`,
    ]);
  });

  await t.test('void restores Account and Debt, including paid to overdue transition', async (t2) => {
    const f = await fixture(t2);
    const created = (await payment(f, { amount: 100000 })).result;
    const voided = await f.domain.debtPayment.void({
      ...await header(f),
      operationId: created.operation.id,
      expectedOperationRevision: 1,
      accountId: ACCOUNT_A,
      expectedAccountRevision: (await f.store.get('accounts', ACCOUNT_A)).revision,
      debtId: DEBT,
      expectedDebtRevision: (await f.store.get('debts', DEBT)).revision,
    });
    assert.equal((await f.store.get('accounts', ACCOUNT_A)).currentBalance, 200000);
    assert.equal((await f.store.get('debts', DEBT)).outstandingAmount, 100000);
    assert.equal((await f.store.get('debts', DEBT)).paymentStatus, 'overdue');
    assert.ok(voided.result.movements.every((movement) => movement.status === 'voided'));
  });

  await t.test('total adjustment moves outstanding up/down without touching payments or opening', async (t2) => {
    for (const newTotalAmount of [120000, 80000]) {
      const f = await fixture(t2);
      await payment(f);
      const beforeOperations = await f.store.getAll('operations');
      const completed = await f.domain.debtTotalAdjustment.create({
        ...await header(f),
        debtId: DEBT,
        expectedDebtRevision: (await f.store.get('debts', DEBT)).revision,
        operationDate: DATE,
        newTotalAmount,
      });
      const expectedOutstanding = newTotalAmount - 20000;
      assert.equal(completed.result.debt.totalAmount, newTotalAmount);
      assert.equal(completed.result.debt.outstandingAmount, expectedOutstanding);
      assert.equal(completed.result.debt.openingOutstanding, 100000);
      assert.equal(completed.result.movement.delta, expectedOutstanding - 80000);
      assert.deepEqual((await f.store.getAll('operations'))[0], beforeOperations[0]);
      assert.equal(completed.result.validPostedPaymentsTotal, 20000);
    }
  });

  await t.test('total below posted payments and zero-effect adjustment are rejected', async (t2) => {
    const f = await fixture(t2);
    await payment(f, { amount: 60000 });
    assert.equal((await rejection(f.domain.debtTotalAdjustment.create({
      ...await header(f), debtId: DEBT,
      expectedDebtRevision: (await f.store.get('debts', DEBT)).revision,
      operationDate: DATE, newTotalAmount: 50000,
    }))).code, Contracts.ERROR_CODES.DEBT_ADJUSTMENT_INVALID);
    assert.equal((await rejection(f.domain.debtTotalAdjustment.create({
      ...await header(f), debtId: DEBT,
      expectedDebtRevision: (await f.store.get('debts', DEBT)).revision,
      operationDate: DATE, newTotalAmount: 100000,
    }))).code, Contracts.ERROR_CODES.DEBT_ADJUSTMENT_INVALID);
  });
});

test('V1.1.0 savings deposit and withdrawal commands', async (t) => {
  await t.test('deposit completes a Goal and edit/void recalculate balance and progress', async (t2) => {
    const f = await fixture(t2);
    const created = (await deposit(f, GOAL_A, 100000)).result;
    assert.equal((await f.store.get('savingsGoals', GOAL_A)).progressStatus, 'completed');
    const edited = await f.domain.savingsDeposit.edit({
      ...await header(f), operationId: created.operation.id, expectedOperationRevision: 1,
      goalId: GOAL_A,
      expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
      operationDate: '2026-08-04', amount: 40000, concept: 'Editado', observation: null,
    });
    assert.equal((await f.store.get('savingsGoals', GOAL_A)).currentBalance, 40000);
    assert.equal((await f.store.get('savingsGoals', GOAL_A)).progressStatus, 'in_progress');
    const voided = await f.domain.savingsDeposit.void({
      ...await header(f), operationId: edited.result.operation.id, expectedOperationRevision: 2,
      goalId: GOAL_A,
      expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
    });
    assert.equal((await f.store.get('savingsGoals', GOAL_A)).currentBalance, 0);
    assert.equal(voided.result.operationRevision.changeType, 'void');
  });

  await t.test('deposit void is blocked when later use leaves insufficient Goal balance', async (t2) => {
    const f = await fixture(t2);
    const created = (await deposit(f, GOAL_A, 50000)).result;
    await f.domain.savingsWithdrawal.create({
      ...await header(f), goalId: GOAL_A,
      expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
      operationDate: DATE, amount: 30000,
    });
    assert.equal((await rejection(f.domain.savingsDeposit.void({
      ...await header(f), operationId: created.operation.id, expectedOperationRevision: 1,
      goalId: GOAL_A,
      expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
    }))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
  });

  await t.test('withdrawal enforces balance and edit/void restore it atomically', async (t2) => {
    const f = await fixture(t2);
    await deposit(f, GOAL_A, 60000);
    assert.equal((await rejection(f.domain.savingsWithdrawal.create({
      ...await header(f), goalId: GOAL_A,
      expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
      operationDate: DATE, amount: 60001,
    }))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
    const created = await f.domain.savingsWithdrawal.create({
      ...await header(f), goalId: GOAL_A,
      expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
      operationDate: DATE, amount: 20000, concept: null, observation: null,
    });
    const edited = await f.domain.savingsWithdrawal.edit({
      ...await header(f), operationId: created.result.operation.id, expectedOperationRevision: 1,
      goalId: GOAL_A,
      expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
      amount: 30000,
    });
    assert.equal((await f.store.get('savingsGoals', GOAL_A)).currentBalance, 30000);
    await f.domain.savingsWithdrawal.void({
      ...await header(f), operationId: edited.result.operation.id, expectedOperationRevision: 2,
      goalId: GOAL_A,
      expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
    });
    assert.equal((await f.store.get('savingsGoals', GOAL_A)).currentBalance, 60000);
  });
});

test('V1.1.0 transfer commands', async (t) => {
  for (const [label, sourceType, sourceId, destinationType, destinationId] of [
    ['account to account', 'account', ACCOUNT_A, 'account', ACCOUNT_B],
    ['account to goal', 'account', ACCOUNT_A, 'savings_goal', GOAL_A],
    ['goal to account', 'savings_goal', GOAL_A, 'account', ACCOUNT_A],
    ['goal to goal', 'savings_goal', GOAL_A, 'savings_goal', GOAL_B],
  ]) {
    await t.test(label, async (t2) => {
      const f = await fixture(t2);
      if (sourceType === 'savings_goal') await deposit(f, sourceId, 50000);
      const completed = await transfer(f, sourceType, sourceId, destinationType, destinationId, 20000);
      assert.equal(completed.result.operation.type, 'transfer');
      assert.deepEqual(completed.result.movements.map((movement) => movement.delta), [-20000, 20000]);
      assert.equal(completed.result.movements.length, 2);
    });
  }

  await t.test('same endpoint and insufficient source are rejected', async (t2) => {
    const same = await fixture(t2);
    assert.equal((await rejection(transfer(
      same, 'account', ACCOUNT_A, 'account', ACCOUNT_A, 10000
    ))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
    const poor = await fixture(t2);
    assert.equal((await rejection(transfer(
      poor, 'savings_goal', GOAL_A, 'account', ACCOUNT_A, 1
    ))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
  });

  await t.test('edit changes endpoints, amount, date and text with all scopes and history', async (t2) => {
    const f = await fixture(t2);
    await deposit(f, GOAL_A, 50000);
    const created = (await transfer(f, 'account', ACCOUNT_A, 'savings_goal', GOAL_B, 20000)).result;
    const edited = await f.domain.transfer.edit({
      ...await header(f), operationId: created.operation.id, expectedOperationRevision: 1,
      previousSourceType: 'account', previousSourceId: ACCOUNT_A,
      expectedPreviousSourceRevision: await targetRevision(f, 'account', ACCOUNT_A),
      previousDestinationType: 'savings_goal', previousDestinationId: GOAL_B,
      expectedPreviousDestinationRevision: await targetRevision(f, 'savings_goal', GOAL_B),
      sourceType: 'savings_goal', sourceId: GOAL_A,
      expectedSourceRevision: await targetRevision(f, 'savings_goal', GOAL_A),
      destinationType: 'account', destinationId: ACCOUNT_B,
      expectedDestinationRevision: await targetRevision(f, 'account', ACCOUNT_B),
      operationDate: '2026-08-04', amount: 30000,
      concept: 'Cambio', observation: 'Completo',
    });
    assert.equal((await f.store.get('accounts', ACCOUNT_A)).currentBalance, 200000);
    assert.equal((await f.store.get('savingsGoals', GOAL_B)).currentBalance, 0);
    assert.equal((await f.store.get('savingsGoals', GOAL_A)).currentBalance, 20000);
    assert.equal((await f.store.get('accounts', ACCOUNT_B)).currentBalance, 130000);
    assert.deepEqual(edited.result.operationRevision.previousMovements, created.movements);
    assert.deepEqual(f.capture.command.affectedScopes, [
      `period:${PERIOD}`, `account:${ACCOUNT_A}`, `savings_goal:${GOAL_B}`,
      `savings_goal:${GOAL_A}`, `account:${ACCOUNT_B}`,
    ]);
  });

  await t.test('void reverses both movements and can be blocked by destination balance', async (t2) => {
    const valid = await fixture(t2);
    const created = (await transfer(
      valid, 'account', ACCOUNT_A, 'account', ACCOUNT_B, 20000
    )).result;
    await valid.domain.transfer.void({
      ...await header(valid), operationId: created.operation.id, expectedOperationRevision: 1,
      sourceType: 'account', sourceId: ACCOUNT_A,
      expectedSourceRevision: await targetRevision(valid, 'account', ACCOUNT_A),
      destinationType: 'account', destinationId: ACCOUNT_B,
      expectedDestinationRevision: await targetRevision(valid, 'account', ACCOUNT_B),
    });
    assert.equal((await valid.store.get('accounts', ACCOUNT_A)).currentBalance, 200000);
    assert.equal((await valid.store.get('accounts', ACCOUNT_B)).currentBalance, 100000);

    const blocked = await fixture(t2);
    const incoming = (await transfer(
      blocked, 'account', ACCOUNT_A, 'account', ACCOUNT_B, 20000
    )).result;
    await blocked.domain.balanceAdjustment.create({
      ...await header(blocked), accountId: ACCOUNT_B,
      expectedAccountRevision: await targetRevision(blocked, 'account', ACCOUNT_B),
      operationDate: DATE, delta: -120000, reason: 'Consumir destino',
    });
    assert.equal((await rejection(blocked.domain.transfer.void({
      ...await header(blocked), operationId: incoming.operation.id, expectedOperationRevision: 1,
      sourceType: 'account', sourceId: ACCOUNT_A,
      expectedSourceRevision: await targetRevision(blocked, 'account', ACCOUNT_A),
      destinationType: 'account', destinationId: ACCOUNT_B,
      expectedDestinationRevision: await targetRevision(blocked, 'account', ACCOUNT_B),
    }))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
  });
});

test('V1.1.0 block four runtime, atomicity, and integrity', async (t) => {
  await t.test('stale revisions, no-op edit, wrong type, and voided operation reject', async (t2) => {
    const f = await fixture(t2);
    const created = (await deposit(f, GOAL_A, 10000)).result;
    assert.equal((await rejection(f.domain.savingsDeposit.edit({
      ...await header(f), operationId: created.operation.id, expectedOperationRevision: 1,
      goalId: GOAL_A, expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
    }))).code, Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD);
    assert.equal((await rejection(f.domain.savingsDeposit.edit({
      ...await header(f), operationId: created.operation.id, expectedOperationRevision: 99,
      goalId: GOAL_A, expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
      amount: 1,
    }))).code, Contracts.ERROR_CODES.REVISION_CONFLICT);
    assert.equal((await rejection(f.domain.savingsDeposit.edit({
      ...await header(f), operationId: uuid(99), expectedOperationRevision: 1,
      goalId: GOAL_A, expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
      amount: 1,
    }))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
    assert.equal((await rejection(f.domain.savingsWithdrawal.void({
      ...await header(f), operationId: created.operation.id, expectedOperationRevision: 1,
      goalId: GOAL_A, expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
    }))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
    const voided = await f.domain.savingsDeposit.void({
      ...await header(f), operationId: created.operation.id, expectedOperationRevision: 1,
      goalId: GOAL_A, expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
    });
    assert.equal((await rejection(f.domain.savingsDeposit.void({
      ...await header(f), operationId: voided.result.operation.id, expectedOperationRevision: 2,
      goalId: GOAL_A, expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
    }))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
  });

  await t.test('exact stores, scopes, active targets, dates, and no AuditEvent are enforced', async (t2) => {
    const f = await fixture(t2);
    const audits = await f.store.getAll('auditEvents');
    const saved = await deposit(f, GOAL_A, 10000);
    assert.deepEqual(saved.commit.affectedStores, [
      'periods', 'operations', 'movements', 'savingsGoals',
    ]);
    assert.deepEqual(f.capture.command.affectedScopes, [
      `period:${PERIOD}`, `savings_goal:${GOAL_A}`,
    ]);
    const paid = await payment(f, { amount: 10000 });
    assert.deepEqual(paid.commit.affectedStores, [
      'periods', 'operations', 'movements', 'accounts', 'debts',
    ]);
    const moved = await transfer(f, 'account', ACCOUNT_A, 'savings_goal', GOAL_B, 10000);
    assert.deepEqual(moved.commit.affectedStores, [
      'periods', 'operations', 'movements', 'accounts', 'savingsGoals',
    ]);
    assert.deepEqual(await f.store.getAll('auditEvents'), audits);

    const future = await fixture(t2);
    assert.equal((await rejection(deposit(
      future, GOAL_A, 1000, { operationDate: '2026-08-06' }
    ))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
    await future.store.put('savingsGoals', goal(GOAL_A, {
      lifecycleStatus: 'closed', closedAt: NOW,
    }));
    assert.equal((await rejection(deposit(future, GOAL_A, 1000))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
  });

  await t.test('runtime gates leave no effects', async (t2) => {
    const cases = [
      (f) => deposit(f, GOAL_A, 1000, { expectedDataRevision: 0 }),
      (f) => deposit(f, GOAL_A, 1000, { expectedWriterEpoch: 2 }),
      async (f) => { f.time.advance(LEASE_MS + 1); return deposit(f, GOAL_A, 1000); },
      async (f) => { await f.run.setWriteEnabled({ enabled: false, reason: 'test' }); return deposit(f); },
      async (f) => {
        const state = await f.store.get('system', 'runtime');
        await f.store.put('system', { ...state, healthStatus: 'diagnostic_only', restrictedScopes: [] });
        return deposit(f);
      },
      async (f) => {
        const state = await f.store.get('system', 'runtime');
        await f.store.put('system', {
          ...state, healthStatus: 'restricted', restrictedScopes: [`savings_goal:${GOAL_A}`],
        });
        return deposit(f);
      },
    ];
    for (const invoke of cases) {
      const f = await fixture(t2);
      await rejection(invoke(f));
      assert.equal((await f.store.getAll('operations')).length, 0);
    }
  });

  await t.test('commands advance once and reload coherently', async (t2) => {
    const factory = new IDBFactory();
    const f = await fixture(t2, { factory });
    const before = (await f.store.get('system', 'runtime')).dataRevision;
    const one = await deposit(f, GOAL_A, 50000);
    const two = await payment(f);
    const three = await transfer(f, 'account', ACCOUNT_A, 'savings_goal', GOAL_B, 10000);
    assert.equal(one.commit.dataRevision, before + 1);
    assert.equal(two.commit.dataRevision, before + 2);
    assert.equal(three.commit.dataRevision, before + 3);
    f.store.close();
    const reloaded = storage(factory);
    await reloaded.open();
    t2.after(() => reloaded.close());
    assert.equal((await reloaded.getAll('operations')).length, 3);
    assert.equal((await reloaded.getAll('movements')).length, 5);
  });

  await t.test('induced failures in every relevant store roll back all effects', async (t2) => {
    for (const [storeName, method, kind] of [
      ['periods', 'get', 'deposit'],
      ['savingsGoals', 'put', 'deposit'],
      ['accounts', 'put', 'payment'],
      ['debts', 'put', 'payment'],
      ['operations', 'add', 'deposit'],
      ['movements', 'add', 'deposit'],
      ['operations', 'getAll', 'adjustment'],
      ['movements', 'getAll', 'adjustment'],
      ['operations', 'put', 'edit'],
      ['movements', 'put', 'edit'],
      ['operationRevisions', 'add', 'edit'],
      ['commits', 'add', 'deposit'],
      ['system', 'put', 'deposit'],
    ]) {
      const f = await fixture(t2);
      let created;
      if (kind === 'edit') created = (await deposit(f, GOAL_A, 10000)).result;
      const before = await allFinancial(f);
      const brokenStore = failingStorage(f.store, storeName, method);
      const brokenRuntime = runtime(brokenStore, f.time);
      const broken = commands(brokenRuntime, f.time, null, sequence('e5000000'));
      let promise;
      if (kind === 'payment') {
        promise = broken.debtPayment.create({
          ...await header(f), accountId: ACCOUNT_A,
          expectedAccountRevision: (await f.store.get('accounts', ACCOUNT_A)).revision,
          debtId: DEBT, expectedDebtRevision: (await f.store.get('debts', DEBT)).revision,
          operationDate: DATE, amount: 10000,
        });
      } else if (kind === 'adjustment') {
        promise = broken.debtTotalAdjustment.create({
          ...await header(f), debtId: DEBT,
          expectedDebtRevision: (await f.store.get('debts', DEBT)).revision,
          operationDate: DATE, newTotalAmount: 120000,
        });
      } else if (kind === 'edit') {
        promise = broken.savingsDeposit.edit({
          ...await header(f), operationId: created.operation.id, expectedOperationRevision: 1,
          goalId: GOAL_A,
          expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
          amount: 20000,
        });
      } else {
        promise = broken.savingsDeposit.create({
          ...await header(f), goalId: GOAL_A,
          expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
          operationDate: DATE, amount: 10000,
        });
      }
      await rejection(promise);
      assert.deepEqual(await allFinancial(f), before, `${storeName}.${method}`);
    }
  });

  await t.test('integrity detects block-four cardinality, signs, balance, and derived states', async (t2) => {
    const debtCardinality = await fixture(t2);
    const paid = (await payment(debtCardinality)).result;
    await debtCardinality.store.remove('movements', paid.movements[0].id);
    let report = await checker(debtCardinality).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'DEBT_PAYMENT_MOVEMENT_CARDINALITY'));

    const adjustment = await fixture(t2);
    const adjusted = await adjustment.domain.debtTotalAdjustment.create({
      ...await header(adjustment), debtId: DEBT, expectedDebtRevision: 1,
      operationDate: DATE, newTotalAmount: 120000,
    });
    await adjustment.store.put('movements', { ...adjusted.result.movement, delta: -20000 });
    report = await checker(adjustment).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'DEBT_TOTAL_ADJUSTMENT_MOVEMENT_INVALID'));

    const savings = await fixture(t2);
    const deposited = (await deposit(savings, GOAL_A, 10000)).result;
    await savings.store.put('movements', { ...deposited.movements[0], delta: -10000 });
    report = await checker(savings).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'SAVINGS_OPERATION_MOVEMENT_INVALID'));

    const unbalanced = await fixture(t2);
    const transferred = (await transfer(
      unbalanced, 'account', ACCOUNT_A, 'account', ACCOUNT_B, 10000
    )).result;
    await unbalanced.store.put('movements', { ...transferred.movements[1], delta: 9999 });
    report = await checker(unbalanced).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'TRANSFER_MOVEMENTS_INVALID'));

    const derived = await fixture(t2);
    const derivedChecker = checker(derived);
    await derived.store.put('savingsGoals', goal(GOAL_A, { progressStatus: 'completed' }));
    await derived.store.put('debts', debt({ paymentStatus: 'paid' }));
    report = await derivedChecker.checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'SAVINGS_GOAL_STATE_INCONSISTENT'));
    assert.ok(report.issues.some((issue) => issue.code === 'DEBT_PAYMENT_STATE_INCONSISTENT'));

    await derived.store.put('debts', debt({ paymentStatus: 'active' }));
    report = await derivedChecker.checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'DEBT_PAYMENT_STATE_INCONSISTENT'));
  });

  await t.test('valid records pass integrity and voided movements do not affect balances', async (t2) => {
    const f = await fixture(t2);
    const created = (await deposit(f, GOAL_A, 30000)).result;
    await f.domain.savingsDeposit.void({
      ...await header(f), operationId: created.operation.id, expectedOperationRevision: 1,
      goalId: GOAL_A, expectedGoalRevision: (await f.store.get('savingsGoals', GOAL_A)).revision,
    });
    assert.equal((await checker(f).runFullCheck()).status, 'ok');
    assert.equal((await f.store.get('savingsGoals', GOAL_A)).currentBalance, 0);
  });
});

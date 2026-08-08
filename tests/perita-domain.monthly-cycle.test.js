'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const IndexedDb = require('../perita-indexeddb.js');
const Runtime = require('../perita-runtime.js');
const Integrity = require('../perita-integrity.js');
const Commands = require('../perita-domain-commands.js');

const NOW = '2026-08-31T12:00:00.000Z';
const PERIOD = uuid(1);
const ACCOUNT = uuid(2);
const GOAL = uuid(3);
const DEBT = uuid(4);
const TEMPLATE_OLD = uuid(5);
const TEMPLATE_NEW = uuid(6);
const TEMPLATE_INACTIVE = uuid(7);
const CURRENT_INSTANCE = uuid(8);

function uuid(number) {
  return `f1000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function sequence() {
  let number = 100;
  return () => uuid(number++);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function clock() {
  let milliseconds = Date.parse(NOW);
  return {
    now: () => new Date(milliseconds).toISOString(),
    advance: (amount) => { milliseconds += amount; },
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

function runtime(store, time, tabId) {
  return Runtime.createPeritaRuntime({
    storage: store,
    now: time.now,
    tabId: tabId || 'monthly-cycle-tab',
    createUuid: sequence(),
  });
}

function commands(run, time, ids) {
  return Commands.createPeritaDomainCommands({
    runtime: run,
    now: time.now,
    createUuid: ids || sequence(),
    sha256,
  });
}

function financialSettings() {
  return {
    key: 'current',
    salaryReferenceAmount: 500000,
    currency: 'CLP',
    timezone: 'America/Santiago',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function period(periodKey, plannedSalaryAmount) {
  return {
    id: PERIOD,
    periodKey: periodKey || '2026-08',
    status: 'open',
    plannedSalaryAmount: plannedSalaryAmount || 0,
    variableExpenseBudgetAmount: 100000,
    plannedSavingsAmount: 50000,
    openedAt: NOW,
    closedAt: null,
    snapshotId: null,
    revision: 1,
  };
}

function account() {
  return {
    id: ACCOUNT,
    name: 'Cuenta principal',
    openingBalance: 200000,
    currentBalance: 200000,
    status: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function goal() {
  return {
    id: GOAL,
    name: 'Meta',
    targetAmount: 100000,
    openingBalance: 0,
    currentBalance: 0,
    plannedMonthlyAmount: 10000,
    lifecycleStatus: 'active',
    progressStatus: 'in_progress',
    closedAt: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function debt() {
  return {
    id: DEBT,
    name: 'Deuda',
    totalAmount: 100000,
    openingOutstanding: 100000,
    outstandingAmount: 100000,
    dueDate: null,
    lifecycleStatus: 'active',
    paymentStatus: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function template(id, status, referenceAmount, updatedAt) {
  return {
    id,
    name: `Plantilla ${id.slice(-2)}`,
    referenceAmount,
    status,
    revision: status === 'active' ? 1 : 2,
    createdAt: '2026-07-01T12:00:00.000Z',
    updatedAt: updatedAt || '2026-07-01T12:00:00.000Z',
  };
}

function currentInstance() {
  return {
    id: CURRENT_INSTANCE,
    periodId: PERIOD,
    templateId: TEMPLATE_OLD,
    nameSnapshot: 'Arriendo',
    plannedAmount: 80000,
    status: 'pending',
    activePaymentOperationId: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function fixture(t, options) {
  const config = options || {};
  const factory = new IDBFactory();
  const store = storage(factory);
  const time = clock();
  await store.open();
  t.after(() => store.close());
  const run = runtime(store, time);
  const domain = commands(run, time);
  await run.acquireWriter({ expectedEpoch: 0, leaseDurationMs: 60000 });
  await run.setWriteEnabled({ enabled: true, reason: 'monthly cycle fixture' });
  let state = await store.get('system', 'runtime');
  await domain.setup.complete({
    expectedDataRevision: state.dataRevision,
    expectedWriterEpoch: 1,
    currentCivilDate: '2026-08-31',
    financialSettings: financialSettings(),
    period: period(config.periodKey, 500000),
    accounts: [account()],
  });
  const desiredPlannedSalary = config.plannedSalaryAmount === undefined
    ? 0
    : config.plannedSalaryAmount;
  if (desiredPlannedSalary !== 500000) {
    state = await store.get('system', 'runtime');
    const currentPeriod = await store.get('periods', PERIOD);
    await domain.period.updatePlanning({
      expectedDataRevision: state.dataRevision,
      expectedWriterEpoch: 1,
      periodId: PERIOD,
      expectedPeriodRevision: currentPeriod.revision,
      plannedSalaryAmount: desiredPlannedSalary,
    });
  }
  await store.add('savingsGoals', goal());
  await store.add('debts', debt());
  await store.add('periodOpenings', {
    id: uuid(20), periodId: PERIOD, targetType: 'savings_goal', targetId: GOAL, openingAmount: 0,
  });
  await store.add('periodOpenings', {
    id: uuid(21), periodId: PERIOD, targetType: 'debt', targetId: DEBT, openingAmount: 100000,
  });
  await store.add('fixedExpenseTemplates', template(TEMPLATE_OLD, 'active', 80000));
  await store.add('fixedExpenseTemplates', template(TEMPLATE_NEW, 'active', 30000));
  await store.add('fixedExpenseTemplates', template(
    TEMPLATE_INACTIVE, 'inactive', 20000, '2026-08-15T12:00:00.000Z'
  ));
  await store.add('fixedExpenseInstances', currentInstance());
  state = await store.get('system', 'runtime');
  return { factory, store, time, run, domain, writerEpoch: 1, state };
}

async function closeInput(f, overrides) {
  const state = await f.store.get('system', 'runtime');
  const currentPeriod = await f.store.get('periods', state.activePeriodId);
  const settings = await f.store.get('financialSettings', 'current');
  const entities = [
    ...(await f.store.getAll('accounts')).map((entity) => ({ targetType: 'account', entity })),
    ...(await f.store.getAll('savingsGoals')).map((entity) => ({ targetType: 'savings_goal', entity })),
    ...(await f.store.getAll('debts')).map((entity) => ({ targetType: 'debt', entity })),
  ];
  const templates = (await f.store.getAll('fixedExpenseTemplates'))
    .filter((record) => record.status === 'active');
  const instances = (await f.store.getAll('fixedExpenseInstances'))
    .filter((record) => record.periodId === currentPeriod.id);
  return {
    expectedDataRevision: state.dataRevision,
    expectedWriterEpoch: f.writerEpoch,
    periodId: currentPeriod.id,
    expectedPeriodRevision: currentPeriod.revision,
    expectedSettingsRevision: settings.revision,
    entityRevisions: entities.map(({ targetType, entity }) => ({
      targetType, targetId: entity.id, expectedRevision: entity.revision,
    })),
    activeTemplateRevisions: templates.map((record) => ({
      templateId: record.id, expectedRevision: record.revision,
    })),
    currentInstanceRevisions: instances.map((record) => ({
      instanceId: record.id, expectedRevision: record.revision,
    })),
    ...(overrides || {}),
  };
}

function movement(operation, targetType, targetId, delta, number) {
  return {
    id: uuid(300 + number),
    operationId: operation.id,
    periodId: PERIOD,
    targetType,
    targetId,
    effectType: targetType === 'debt' ? 'debt_outstanding' : 'asset_balance',
    delta,
    status: operation.status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function operation(number, type, amount, details, status) {
  return {
    id: uuid(200 + number),
    periodId: PERIOD,
    type,
    operationDate: '2026-08-20',
    amount,
    status: status || 'posted',
    revision: status === 'voided' ? 2 : 1,
    createdAt: NOW,
    updatedAt: NOW,
    voidedAt: status === 'voided' ? NOW : null,
    voidReason: status === 'voided' ? 'Corrección' : null,
    details,
  };
}

function summaryRecords() {
  const records = [];
  const add = (op, specs) => {
    records.push({ operation: op, movements: specs.map((spec, index) => (
      movement(op, spec[0], spec[1], spec[2], records.length * 3 + index)
    )) });
  };
  add(operation(1, 'salary_receipt', 500, { accountId: ACCOUNT }), [
    ['account', ACCOUNT, 500],
  ]);
  add(operation(2, 'additional_income', 100, {
    accountId: ACCOUNT, concept: null, observation: null,
  }), [['account', ACCOUNT, 100]]);
  add(operation(3, 'fixed_expense_payment', 50, {
    accountId: ACCOUNT, fixedExpenseInstanceId: uuid(51),
  }), [['account', ACCOUNT, -50]]);
  add(operation(4, 'variable_expense', 40, {
    accountId: ACCOUNT, categoryId: uuid(52), categoryName: 'Casa', concept: 'Compra', observation: null,
  }), [['account', ACCOUNT, -40]]);
  add(operation(5, 'debt_payment', 30, {
    accountId: ACCOUNT, debtId: DEBT, concept: null, observation: null,
  }), [['account', ACCOUNT, -30], ['debt', DEBT, -30]]);
  add(operation(6, 'savings_deposit', 20, {
    goalId: GOAL, concept: null, observation: null,
  }), [['savings_goal', GOAL, 20]]);
  add(operation(7, 'savings_withdrawal', 5, {
    goalId: GOAL, concept: null, observation: null,
  }), [['savings_goal', GOAL, -5]]);
  add(operation(8, 'transfer', 10, {
    sourceType: 'account', sourceId: ACCOUNT,
    destinationType: 'savings_goal', destinationId: GOAL,
    concept: null, observation: null,
  }), [['account', ACCOUNT, -10], ['savings_goal', GOAL, 10]]);
  add(operation(9, 'transfer', 3, {
    sourceType: 'savings_goal', sourceId: GOAL,
    destinationType: 'account', destinationId: ACCOUNT,
    concept: null, observation: null,
  }), [['savings_goal', GOAL, -3], ['account', ACCOUNT, 3]]);
  add(operation(10, 'transfer', 7, {
    sourceType: 'account', sourceId: ACCOUNT,
    destinationType: 'account', destinationId: uuid(53),
    concept: null, observation: null,
  }), [['account', ACCOUNT, -7], ['account', uuid(53), 7]]);
  add(operation(11, 'additional_income', 999, {
    accountId: ACCOUNT, concept: null, observation: null,
  }, 'voided'), [['account', ACCOUNT, 999]]);
  return {
    operations: records.map((record) => record.operation),
    movements: records.flatMap((record) => record.movements),
  };
}

function integrityFor(f) {
  return Integrity.createPeritaIntegrity({
    storage: f.store,
    now: f.time.now,
    createUuid: sequence(),
    sha256,
  });
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected rejection');
}

async function financialState(store) {
  const names = [
    'system', 'periods', 'periodOpenings', 'accounts', 'savingsGoals', 'debts',
    'categories', 'fixedExpenseTemplates', 'fixedExpenseInstances', 'operations', 'movements',
    'auditEvents', 'periodSnapshots', 'commits',
  ];
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await store.getAll(name)])));
}

function failingStorage(base, storeName, method) {
  return {
    open: () => base.open(),
    get: (...args) => base.get(...args),
    getAll: (...args) => base.getAll(...args),
    runTransaction: (stores, mode, callback) => base.runTransaction(stores, mode, (transaction) => {
      const wrapper = Object.create(transaction);
      wrapper[method] = (...args) => {
        if (args[0] === storeName) throw new Error(`induced ${storeName}.${method}`);
        return transaction[method](...args);
      };
      return callback(wrapper);
    }),
  };
}

test('V1.1.0 derived monthly summary', async (t) => {
  await t.test('derives the confirmed real and planned totals and excludes voided records', () => {
    const records = summaryRecords();
    const paid = {
      ...currentInstance(), id: uuid(51), plannedAmount: 60, status: 'paid',
      activePaymentOperationId: uuid(203),
    };
    const pending = { ...currentInstance(), id: uuid(54), templateId: TEMPLATE_NEW, plannedAmount: 70 };
    const summary = Commands.deriveMonthlySummary({
      period: period(),
      operations: records.operations,
      movements: records.movements,
      fixedExpenseInstances: [paid, pending],
    });
    assert.deepEqual(summary, {
      periodId: PERIOD,
      periodKey: '2026-08',
      plannedSalaryAmount: 0,
      receivedSalaryAmount: 500,
      additionalIncomeAmount: 100,
      totalIncomeAmount: 600,
      variableExpenseBudgetAmount: 100000,
      fixedExpensePlannedAmount: 130,
      fixedExpensePaidAmount: 50,
      fixedExpenseUnpaidAmount: 70,
      variableExpenseAmount: 40,
      debtPaymentAmount: 30,
      plannedSavingsAmount: 50000,
      netSavingsAmount: 22,
      availableAmount: 458,
    });
    assert.ok(Object.isFrozen(summary));
  });

  await t.test('rejects duplicate salary, duplicate fixed payment, and invalid cardinality', () => {
    const records = summaryRecords();
    const salary = records.operations[0];
    const duplicateSalary = { ...salary, id: uuid(99) };
    const duplicateMovement = { ...records.movements[0], id: uuid(98), operationId: duplicateSalary.id };
    assert.throws(() => Commands.deriveMonthlySummary({
      period: period(),
      operations: [...records.operations, duplicateSalary],
      movements: [...records.movements, duplicateMovement],
      fixedExpenseInstances: [],
    }));
    assert.throws(() => Commands.deriveMonthlySummary({
      period: period(),
      operations: records.operations,
      movements: records.movements.slice(1),
      fixedExpenseInstances: [],
    }));
    const fixed = records.operations.find((record) => record.type === 'fixed_expense_payment');
    const duplicateFixed = { ...fixed, id: uuid(97) };
    const duplicateFixedMovement = {
      ...records.movements.find((record) => record.operationId === fixed.id),
      id: uuid(96),
      operationId: duplicateFixed.id,
    };
    assert.throws(() => Commands.deriveMonthlySummary({
      period: period(),
      operations: [...records.operations, duplicateFixed],
      movements: [...records.movements, duplicateFixedMovement],
      fixedExpenseInstances: [{
        ...currentInstance(),
        id: uuid(51),
        plannedAmount: 60,
        status: 'paid',
        activePaymentOperationId: fixed.id,
      }],
    }));
  });
});

test('V1.1.0 period.close-and-open-next', async (t) => {
  await t.test('closes atomically, creates canonical history, and opens the exact next month', async (t2) => {
    const f = await fixture(t2);
    const beforeOperations = await f.store.getAll('operations');
    const beforeMovements = await f.store.getAll('movements');
    const input = await closeInput(f);
    const result = await f.domain.period.closeAndOpenNext(input);
    assert.equal(result.result.closedPeriod.status, 'closed');
    assert.equal(result.result.closedPeriod.revision, input.expectedPeriodRevision + 1);
    assert.equal(result.result.nextPeriod.periodKey, '2026-09');
    assert.equal(result.result.nextPeriod.status, 'open');
    assert.equal(result.result.nextPeriod.plannedSalaryAmount, 500000);
    assert.equal(result.result.nextPeriod.variableExpenseBudgetAmount, 0);
    assert.equal(result.result.nextPeriod.plannedSavingsAmount, 0);
    assert.equal((await f.store.get('system', 'runtime')).activePeriodId, result.result.nextPeriod.id);
    assert.equal((await f.store.getAll('periodSnapshots')).length, 1);
    assert.equal(result.result.periodSnapshot.snapshotKind, 'canonical');
    assert.equal(result.result.periodSnapshot.integrity.algorithm, 'SHA-256');
    assert.match(result.result.periodSnapshot.integrity.payloadHash, /^[0-9a-f]{64}$/);
    assert.ok(Object.isFrozen(result.result.periodSnapshot));
    assert.deepEqual(await f.store.getAll('operations'), beforeOperations);
    assert.deepEqual(await f.store.getAll('movements'), beforeMovements);
    assert.equal((await f.store.get('fixedExpenseInstances', CURRENT_INSTANCE)).status, 'unpaid');
    assert.equal(result.commit.commandType, 'period.close-and-open-next');
    assert.deepEqual(result.commit.affectedStores, Commands.MONTHLY_CLOSE_STORES);
    assert.equal(result.commit.dataRevision, result.commit.previousDataRevision + 1);
    assert.equal((await f.store.getAll('pendingIntents')).at(-1).status, 'completed');
  });

  await t.test('creates exact openings and preserves entity initial openings', async (t2) => {
    const f = await fixture(t2);
    const result = (await f.domain.period.closeAndOpenNext(await closeInput(f))).result;
    const openings = result.periodOpenings;
    assert.deepEqual(openings.map((opening) => [opening.targetType, opening.openingAmount]), [
      ['account', 200000], ['savings_goal', 0], ['debt', 100000],
    ]);
    assert.equal((await f.store.get('accounts', ACCOUNT)).openingBalance, 200000);
    assert.equal((await f.store.get('savingsGoals', GOAL)).openingBalance, 0);
    assert.equal((await f.store.get('debts', DEBT)).openingOutstanding, 100000);
    assert.equal(new Set(openings.map((opening) => `${opening.periodId}:${opening.targetType}:${opening.targetId}`)).size, 3);
  });

  await t.test('copies only active fixed templates with current reference and pending state', async (t2) => {
    const f = await fixture(t2);
    const result = (await f.domain.period.closeAndOpenNext(await closeInput(f))).result;
    assert.deepEqual(result.fixedExpenseInstances.map((instance) => instance.templateId).sort(), [
      TEMPLATE_NEW, TEMPLATE_OLD,
    ].sort());
    assert.ok(result.fixedExpenseInstances.every((instance) => (
      instance.status === 'pending' && instance.activePaymentOperationId === null && instance.revision === 1
    )));
    assert.equal(
      result.fixedExpenseInstances.find((instance) => instance.templateId === TEMPLATE_NEW).plannedAmount,
      30000
    );
    assert.ok(!result.fixedExpenseInstances.some((instance) => instance.templateId === TEMPLATE_INACTIVE));
  });

  await t.test('advances December to January', async (t2) => {
    const f = await fixture(t2, { periodKey: '2025-12' });
    const result = (await f.domain.period.closeAndOpenNext(await closeInput(f))).result;
    assert.equal(result.nextPeriod.periodKey, '2026-01');
  });

  await t.test('requires salary receipt only when planned salary is positive', async (t2) => {
    const blocked = await fixture(t2, { plannedSalaryAmount: 500000 });
    const error = await rejection(blocked.domain.period.closeAndOpenNext(await closeInput(blocked)));
    assert.equal(error.code, 'DOMAIN_STATE_INVALID');
    assert.equal((await blocked.store.get('periods', PERIOD)).status, 'open');

    const allowed = await fixture(t2, { plannedSalaryAmount: 0 });
    assert.equal((await allowed.domain.period.closeAndOpenNext(await closeInput(allowed))).result.closedPeriod.status, 'closed');

    const received = await fixture(t2, { plannedSalaryAmount: 500000 });
    let state = await received.store.get('system', 'runtime');
    const storedAccount = await received.store.get('accounts', ACCOUNT);
    await received.domain.salaryReceipt.create({
      expectedDataRevision: state.dataRevision,
      expectedWriterEpoch: 1,
      periodId: PERIOD,
      accountId: ACCOUNT,
      expectedAccountRevision: storedAccount.revision,
      operationDate: '2026-08-31',
      amount: 500000,
    });
    state = await received.store.get('system', 'runtime');
    assert.ok(state.dataRevision > 0);
    assert.equal(
      (await received.domain.period.closeAndOpenNext(await closeInput(received))).result.summary.receivedSalaryAmount,
      500000
    );
  });

  await t.test('prevents double close, duplicate next Period, and stale revisions', async (t2) => {
    const f = await fixture(t2);
    const firstInput = await closeInput(f);
    const first = await f.domain.period.closeAndOpenNext(firstInput);
    const error = await rejection(f.domain.period.closeAndOpenNext(firstInput));
    assert.equal(error.code, 'STALE_REVISION');
    assert.equal((await f.store.getAll('periodSnapshots')).length, 1);
    assert.equal((await f.store.getAll('periods')).length, 2);
    assert.equal((await f.store.get('system', 'runtime')).activePeriodId, first.result.nextPeriod.id);
  });

  await t.test('rejects stale entity expectations and unreconciled balances', async (t2) => {
    const stale = await fixture(t2);
    const input = await closeInput(stale);
    input.entityRevisions[0].expectedRevision += 1;
    assert.equal(
      (await rejection(stale.domain.period.closeAndOpenNext(input))).code,
      'REVISION_CONFLICT'
    );
    const broken = await fixture(t2);
    await broken.store.put('accounts', { ...(await broken.store.get('accounts', ACCOUNT)), currentBalance: 199999 });
    assert.equal(
      (await rejection(broken.domain.period.closeAndOpenNext(await closeInput(broken)))).code,
      'DOMAIN_STATE_INVALID'
    );
  });

  await t.test('runtime gates reject stale revision, epoch, expired lease, disabled writes, and health restrictions', async (t2) => {
    const stale = await fixture(t2);
    assert.equal((await rejection(stale.domain.period.closeAndOpenNext({
      ...await closeInput(stale), expectedDataRevision: 0,
    }))).code, 'STALE_REVISION');
    assert.equal((await rejection(stale.domain.period.closeAndOpenNext({
      ...await closeInput(stale), expectedWriterEpoch: 2,
    }))).code, 'WRITER_EPOCH_LOST');

    const expired = await fixture(t2);
    expired.time.advance(60001);
    assert.equal((await rejection(expired.domain.period.closeAndOpenNext(await closeInput(expired)))).code, 'WRITER_LEASE_EXPIRED');

    const disabled = await fixture(t2);
    await disabled.run.setWriteEnabled({ enabled: false, reason: 'test' });
    assert.equal((await rejection(disabled.domain.period.closeAndOpenNext(await closeInput(disabled)))).code, 'WRITE_DISABLED');

    const diagnostic = await fixture(t2);
    await diagnostic.store.put('system', {
      ...(await diagnostic.store.get('system', 'runtime')),
      healthStatus: 'diagnostic_only', writeEnabled: false,
    });
    assert.equal((await rejection(diagnostic.domain.period.closeAndOpenNext(await closeInput(diagnostic)))).code, 'DIAGNOSTIC_ONLY');

    const restricted = await fixture(t2);
    await restricted.store.put('system', {
      ...(await restricted.store.get('system', 'runtime')),
      healthStatus: 'restricted', restrictedScopes: [`period:${PERIOD}`],
    });
    assert.equal((await rejection(restricted.domain.period.closeAndOpenNext(await closeInput(restricted)))).code, 'RESTRICTED_SCOPE');
  });

  await t.test('every declared store failure leaves no partial monthly close', async (t2) => {
    const failures = [
      ...Commands.MONTHLY_CLOSE_STORES.map((storeName) => ({
        storeName,
        method: storeName === 'financialSettings' ? 'get' : 'getAll',
      })),
      { storeName: 'periods', method: 'put' },
      { storeName: 'periods', method: 'add' },
      { storeName: 'periodSnapshots', method: 'add' },
      { storeName: 'periodOpenings', method: 'add' },
      { storeName: 'fixedExpenseInstances', method: 'put' },
      { storeName: 'fixedExpenseInstances', method: 'add' },
      { storeName: 'auditEvents', method: 'add' },
      { storeName: 'commits', method: 'add' },
      { storeName: 'system', method: 'put' },
    ];
    for (const { storeName, method } of failures) {
      const f = await fixture(t2);
      const before = await financialState(f.store);
      const brokenStore = failingStorage(f.store, storeName, method);
      const brokenRuntime = runtime(brokenStore, f.time);
      const brokenCommands = commands(brokenRuntime, f.time);
      await rejection(brokenCommands.period.closeAndOpenNext(await closeInput(f)));
      assert.deepEqual(await financialState(f.store), before, `${storeName}.${method}`);
    }
  });
});

test('V1.1.0 monthly-cycle integrity', async (t) => {
  await t.test('a native close remains fully verifiable, including hash and cached balances', async (t2) => {
    const f = await fixture(t2);
    await f.domain.period.closeAndOpenNext(await closeInput(f));
    const report = await integrityFor(f).runFullCheck();
    assert.equal(report.status, 'ok');
    assert.deepEqual(report.issues, []);
  });

  await t.test('detects missing snapshot, wrong next opening, and bad snapshot hash', async (t2) => {
    const missing = await fixture(t2);
    const closed = (await missing.domain.period.closeAndOpenNext(await closeInput(missing))).result;
    await missing.store.remove('periodSnapshots', closed.periodSnapshot.id);
    let report = await integrityFor(missing).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'CLOSED_PERIOD_SNAPSHOT_MISSING'));

    const opening = await fixture(t2);
    const openingClose = (await opening.domain.period.closeAndOpenNext(await closeInput(opening))).result;
    const nextOpening = openingClose.periodOpenings[0];
    await opening.store.put('periodOpenings', { ...nextOpening, openingAmount: nextOpening.openingAmount - 1 });
    report = await integrityFor(opening).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'PERIOD_OPENING_CONTINUITY_INVALID'));

    const hash = await fixture(t2);
    const hashClose = (await hash.domain.period.closeAndOpenNext(await closeInput(hash))).result;
    await hash.store.put('periodSnapshots', {
      ...hashClose.periodSnapshot,
      integrity: { ...hashClose.periodSnapshot.integrity, payloadHash: '0'.repeat(64) },
    });
    report = await integrityFor(hash).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'CANONICAL_SNAPSHOT_HASH_INVALID'));
  });

  await t.test('detects two open Periods, invalid sequence, and activePeriod mismatch', async (t2) => {
    const f = await fixture(t2);
    await f.store.add('periods', {
      ...period('2026-10'), id: uuid(70), periodKey: '2026-10', openedAt: NOW,
    });
    let report = await integrityFor(f).runFullCheck();
    assert.ok(report.issues.some((issue) => issue.code === 'MULTIPLE_OPEN_PERIODS'));
    assert.ok(report.issues.some((issue) => issue.code === 'PERIOD_SEQUENCE_INVALID'));
    assert.ok(report.issues.some((issue) => issue.code === 'ACTIVE_PERIOD_MISMATCH'));
  });

  await t.test('detects an inactive template copied after deactivation', async (t2) => {
    const f = await fixture(t2);
    const closed = (await f.domain.period.closeAndOpenNext(await closeInput(f))).result;
    await f.store.add('fixedExpenseInstances', {
      ...currentInstance(),
      id: uuid(71),
      periodId: closed.nextPeriod.id,
      templateId: TEMPLATE_INACTIVE,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const report = await integrityFor(f).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'INACTIVE_FIXED_TEMPLATE_COPIED'));
  });
});

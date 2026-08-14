'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const Contracts = require('../perita-contracts.js');
const IndexedDb = require('../perita-indexeddb.js');
const Runtime = require('../perita-runtime.js');
const DomainCommands = require('../perita-domain-commands.js');

const START = '2026-08-05T12:00:00.000Z';
const CURRENT_DATE = '2026-08-05';
const LEASE_MS = 60_000;
const DATABASE_CRYPTO = Object.freeze({
  randomUUID: () => 'b0000000-0000-4000-8000-000000000000',
});

function id(number) {
  return `b1000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function uuidSequence(prefix, start) {
  let value = start || 1;
  return () => `${prefix}-0000-4000-8000-${String(value++).padStart(12, '0')}`;
}

function makeClock() {
  let milliseconds = Date.parse(START);
  return {
    now: () => new Date(milliseconds).toISOString(),
    advance: (amount) => { milliseconds += amount; },
  };
}

function makeStorage(factory) {
  return IndexedDb.createPeritaIndexedDb({
    indexedDB: factory,
    IDBKeyRange,
    now: () => START,
    crypto: DATABASE_CRYPTO,
  });
}

function makeRuntime(storage, clock, createUuid) {
  return Runtime.createPeritaRuntime({
    storage,
    now: clock.now,
    tabId: 'tab-a',
    createUuid: createUuid || uuidSequence('b2000000'),
  });
}

function makeCommands(runtime, clock, createUuid, capture) {
  const runtimePort = capture
    ? Object.freeze({
      executeCommand: (command) => {
        capture.command = command;
        return runtime.executeCommand(command);
      },
    })
    : runtime;
  return DomainCommands.createPeritaDomainCommands({
    runtime: runtimePort,
    now: clock.now,
    createUuid: createUuid || uuidSequence('b3000000'),
  });
}

function financialSettings() {
  return {
    key: 'current',
    salaryReferenceAmount: 900000,
    currency: 'CLP',
    timezone: 'America/Santiago',
    revision: 1,
    createdAt: START,
    updatedAt: START,
  };
}

function period(overrides) {
  return {
    id: id(1),
    periodKey: '2026-08',
    status: 'open',
    plannedSalaryAmount: 900000,
    openedAt: START,
    closedAt: null,
    snapshotId: null,
    revision: 1,
    ...(overrides || {}),
  };
}

function account(overrides) {
  return {
    id: id(2),
    name: 'Cuenta principal',
    openingBalance: 0,
    currentBalance: 0,
    status: 'active',
    revision: 1,
    createdAt: START,
    updatedAt: START,
    ...(overrides || {}),
  };
}

function category(number, overrides) {
  return {
    id: id(number || 10),
    name: `Categoría ${number || 10}`,
    status: 'active',
    revision: 1,
    createdAt: START,
    updatedAt: START,
    ...(overrides || {}),
  };
}

function template(number, overrides) {
  return {
    id: id(number || 20),
    name: `Plantilla ${number || 20}`,
    referenceAmount: 50000,
    status: 'active',
    revision: 1,
    createdAt: START,
    updatedAt: START,
    ...(overrides || {}),
  };
}

function instance(number, overrides) {
  return {
    id: id(number || 21),
    periodId: id(1),
    templateId: id(20),
    nameSnapshot: 'Plantilla 20',
    plannedAmount: 50000,
    status: 'pending',
    activePaymentOperationId: null,
    revision: 1,
    createdAt: START,
    updatedAt: START,
    ...(overrides || {}),
  };
}

function goal(number, overrides) {
  return {
    id: id(number || 30),
    name: `Meta ${number || 30}`,
    bank: null,
    targetAmount: 500000,
    openingBalance: 0,
    currentBalance: 0,
    plannedMonthlyAmount: 50000,
    lifecycleStatus: 'active',
    progressStatus: 'in_progress',
    closedAt: null,
    revision: 1,
    createdAt: START,
    updatedAt: START,
    ...(overrides || {}),
  };
}

function debt(number, overrides) {
  return {
    id: id(number || 40),
    name: `Deuda ${number || 40}`,
    totalAmount: 300000,
    openingOutstanding: 300000,
    outstandingAmount: 300000,
    dueDate: null,
    monthlyPaymentAmount: 50000,
    paymentDay: 31,
    lifecycleStatus: 'active',
    paymentStatus: 'active',
    revision: 1,
    createdAt: START,
    updatedAt: START,
    ...(overrides || {}),
  };
}

async function fixture(t, options) {
  const config = options || {};
  const factory = config.factory || new IDBFactory();
  const clock = config.clock || makeClock();
  const storage = config.storage || makeStorage(factory);
  await storage.open();
  t.after(() => storage.close());
  const runtime = makeRuntime(storage, clock, config.runtimeUuid);
  const capture = {};
  const commands = makeCommands(runtime, clock, config.commandUuid, capture);
  return { factory, clock, storage, runtime, commands, capture };
}

async function acquireAndEnable(f) {
  await f.runtime.acquireWriter({ expectedEpoch: 0, leaseDurationMs: LEASE_MS });
  await f.runtime.setWriteEnabled({ enabled: true, reason: 'entities catalogs bootstrap' });
}

async function bootstrap(f) {
  await acquireAndEnable(f);
  const state = await f.storage.get('system', 'runtime');
  await f.commands.setup.complete({
    expectedDataRevision: state.dataRevision,
    expectedWriterEpoch: 1,
    currentCivilDate: CURRENT_DATE,
    financialSettings: financialSettings(),
    period: period(),
    accounts: [account()],
  });
  f.clock.advance(1000);
}

async function seedCatalogs(f) {
  await f.storage.add('categories', category());
  await f.storage.add('fixedExpenseTemplates', template());
  await f.storage.add('fixedExpenseInstances', instance());
  await f.storage.add('savingsGoals', goal());
  await f.storage.add('debts', debt());
}

async function commonInput(storage) {
  const state = await storage.get('system', 'runtime');
  return {
    expectedDataRevision: state.dataRevision,
    expectedWriterEpoch: 1,
    periodId: id(1),
  };
}

function captureRejection(promise) {
  return promise.then(
    () => assert.fail('expected promise to reject'),
    (error) => error
  );
}

async function assertNoFinancialRecords(storage) {
  assert.deepEqual(await storage.getAll('operations'), []);
  assert.deepEqual(await storage.getAll('movements'), []);
  assert.deepEqual(await storage.getAll('operationRevisions'), []);
}

function assertAudit(event, expected) {
  assert.equal(event.periodId, id(1));
  assert.equal(event.subjectType, expected.subjectType);
  assert.equal(event.subjectId, expected.subjectId);
  assert.equal(event.action, expected.action);
  assert.equal(event.commandType, expected.commandType);
  assert.equal(Object.isFrozen(event), true);
  if (expected.action === 'created') {
    assert.equal(event.previousRevision, null);
    assert.equal(event.previousValue, null);
    assert.equal(event.nextRevision, 1);
  } else {
    assert.equal(event.previousRevision + 1, event.nextRevision);
    assert.ok(event.previousValue);
    assert.ok(event.nextValue);
    assert.equal(Object.isFrozen(event.previousValue), true);
  }
}

function wrapFailingStorage(storage, targetStore, targetMethod) {
  return Object.freeze({
    open: () => storage.open(),
    close: () => storage.close(),
    get: (...args) => storage.get(...args),
    getAll: (...args) => storage.getAll(...args),
    add: (...args) => storage.add(...args),
    put: (...args) => storage.put(...args),
    remove: (...args) => storage.remove(...args),
    queryIndex: (...args) => storage.queryIndex(...args),
    runTransaction: (stores, mode, worker) => storage.runTransaction(
      stores,
      mode,
      (transaction) => worker(Object.freeze({
        ...transaction,
        add: (storeName, value) => {
          if (storeName === targetStore && targetMethod === 'add') {
            throw new Error(`induced ${storeName} add failure`);
          }
          return transaction.add(storeName, value);
        },
        put: (storeName, value) => {
          if (storeName === targetStore && targetMethod === 'put') {
            throw new Error(`induced ${storeName} put failure`);
          }
          return transaction.put(storeName, value);
        },
      }))
    ),
  });
}

test('V1.1.0 category catalog commands', async (t) => {
  await t.test('create is active, permits duplicate names, and audits exact scopes/stores', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    await f.storage.add('categories', category(10, { name: 'Duplicada' }));
    const createdCategory = category(11, { name: 'Duplicada' });
    const completed = await f.commands.category.create({
      ...await commonInput(f.storage),
      category: createdCategory,
    });

    assert.deepEqual(await f.storage.get('categories', id(11)), createdCategory);
    assertAudit(completed.result.auditEvent, {
      subjectType: 'category', subjectId: id(11), action: 'created', commandType: 'category.create',
    });
    assert.deepEqual(completed.commit.affectedStores, DomainCommands.CATEGORY_STORES);
    assert.deepEqual(f.capture.command.affectedScopes, [`period:${id(1)}`, `category:${id(11)}`]);
  });

  await t.test('duplicate ID is rejected', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    await f.storage.add('categories', category());
    assert.equal(
      (await captureRejection(f.commands.category.create({
        ...await commonInput(f.storage), category: category(),
      }))).code,
      Contracts.ERROR_CODES.DOMAIN_RELATION_MISMATCH
    );
  });

  await t.test('update changes only name and rejects no-op, extra field, and stale revision', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    await f.storage.add('categories', category());
    const previous = await f.storage.get('categories', id(10));
    const updated = await f.commands.category.update({
      ...await commonInput(f.storage),
      categoryId: id(10),
      expectedCategoryRevision: 1,
      name: 'Categoría editada',
    });
    assert.equal(updated.result.category.name, 'Categoría editada');
    assert.equal(updated.result.category.status, previous.status);
    assert.equal(updated.result.category.revision, 2);
    assertAudit(updated.result.auditEvent, {
      subjectType: 'category', subjectId: id(10), action: 'updated', commandType: 'category.update',
    });

    const noOp = await fixture(t2);
    await bootstrap(noOp);
    await noOp.storage.add('categories', category());
    assert.equal((await captureRejection(noOp.commands.category.update({
      ...await commonInput(noOp.storage), categoryId: id(10), expectedCategoryRevision: 1, name: 'Categoría 10',
    }))).code, Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD);

    const extra = await fixture(t2);
    await bootstrap(extra);
    await extra.storage.add('categories', category());
    assert.equal((await captureRejection(extra.commands.category.update({
      ...await commonInput(extra.storage), categoryId: id(10), expectedCategoryRevision: 1,
      name: 'Otra', status: 'inactive',
    }))).code, Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD);

    const stale = await fixture(t2);
    await bootstrap(stale);
    await stale.storage.add('categories', category());
    assert.equal((await captureRejection(stale.commands.category.update({
      ...await commonInput(stale.storage), categoryId: id(10), expectedCategoryRevision: 2, name: 'Otra',
    }))).code, Contracts.ERROR_CODES.REVISION_CONFLICT);
  });

  await t.test('deactivate changes only state and preserves history', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    await f.storage.add('categories', category());
    const previous = await f.storage.get('categories', id(10));
    const completed = await f.commands.category.deactivate({
      ...await commonInput(f.storage), categoryId: id(10), expectedCategoryRevision: 1,
    });
    assert.equal(completed.result.category.status, 'inactive');
    assert.equal(completed.result.category.name, previous.name);
    assert.equal(completed.result.category.revision, 2);
    assertAudit(completed.result.auditEvent, {
      subjectType: 'category', subjectId: id(10), action: 'deactivated', commandType: 'category.deactivate',
    });
  });
});

test('V1.1.0 fixed-expense template commands', async (t) => {
  await t.test('create stores only the active reference and leaves current planning/instances unchanged', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const beforePeriod = await f.storage.get('periods', id(1));
    const beforeInstances = await f.storage.getAll('fixedExpenseInstances');
    const newTemplate = template(20);
    const completed = await f.commands.fixedExpenseTemplate.create({
      ...await commonInput(f.storage), template: newTemplate,
    });

    assert.deepEqual(await f.storage.get('fixedExpenseTemplates', id(20)), newTemplate);
    assert.deepEqual(await f.storage.get('periods', id(1)), beforePeriod);
    assert.deepEqual(await f.storage.getAll('fixedExpenseInstances'), beforeInstances);
    assertAudit(completed.result.auditEvent, {
      subjectType: 'fixed_expense_template', subjectId: id(20),
      action: 'created', commandType: 'fixed-expense-template.create',
    });
    assert.deepEqual(completed.commit.affectedStores, DomainCommands.FIXED_TEMPLATE_CREATE_STORES);
  });

  await t.test('create rejects invalid amount and duplicate ID', async (t2) => {
    for (const referenceAmount of [0, -1, 1.5]) {
      const f = await fixture(t2);
      await bootstrap(f);
      assert.ok((await captureRejection(f.commands.fixedExpenseTemplate.create({
        ...await commonInput(f.storage), template: template(20, { referenceAmount }),
      }))).code);
    }
    const duplicate = await fixture(t2);
    await bootstrap(duplicate);
    await duplicate.storage.add('fixedExpenseTemplates', template());
    assert.equal((await captureRejection(duplicate.commands.fixedExpenseTemplate.create({
      ...await commonInput(duplicate.storage), template: template(),
    }))).code, Contracts.ERROR_CODES.DOMAIN_RELATION_MISMATCH);
  });

  await t.test('update changes approved fields without altering current instances or planning', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    await f.storage.add('fixedExpenseTemplates', template());
    await f.storage.add('fixedExpenseInstances', instance());
    const periodBefore = await f.storage.get('periods', id(1));
    const instanceBefore = await f.storage.get('fixedExpenseInstances', id(21));
    const completed = await f.commands.fixedExpenseTemplate.update({
      ...await commonInput(f.storage),
      templateId: id(20),
      expectedTemplateRevision: 1,
      name: 'Referencia editada',
      referenceAmount: 65000,
    });
    assert.equal(completed.result.template.name, 'Referencia editada');
    assert.equal(completed.result.template.referenceAmount, 65000);
    assert.equal(completed.result.template.revision, 2);
    assert.deepEqual(await f.storage.get('fixedExpenseInstances', id(21)), instanceBefore);
    assert.deepEqual(await f.storage.get('periods', id(1)), periodBefore);
    assertAudit(completed.result.auditEvent, {
      subjectType: 'fixed_expense_template', subjectId: id(20),
      action: 'updated', commandType: 'fixed-expense-template.update',
    });
  });

  await t.test('update rejects no-op and invalid amount', async (t2) => {
    const noOp = await fixture(t2);
    await bootstrap(noOp);
    await noOp.storage.add('fixedExpenseTemplates', template());
    assert.equal((await captureRejection(noOp.commands.fixedExpenseTemplate.update({
      ...await commonInput(noOp.storage), templateId: id(20), expectedTemplateRevision: 1,
      referenceAmount: 50000,
    }))).code, Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD);

    for (const referenceAmount of [0, -1, 1.5]) {
      const f = await fixture(t2);
      await bootstrap(f);
      await f.storage.add('fixedExpenseTemplates', template());
      assert.ok((await captureRejection(f.commands.fixedExpenseTemplate.update({
        ...await commonInput(f.storage), templateId: id(20), expectedTemplateRevision: 1,
        referenceAmount,
      }))).code);
    }
  });

  await t.test('deactivate preserves existing instances and blocks repeated deactivation', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    await f.storage.add('fixedExpenseTemplates', template());
    await f.storage.add('fixedExpenseInstances', instance());
    const instanceBefore = await f.storage.get('fixedExpenseInstances', id(21));
    const completed = await f.commands.fixedExpenseTemplate.deactivate({
      ...await commonInput(f.storage), templateId: id(20), expectedTemplateRevision: 1,
    });
    assert.equal(completed.result.template.status, 'inactive');
    assert.deepEqual(await f.storage.get('fixedExpenseInstances', id(21)), instanceBefore);
    assertAudit(completed.result.auditEvent, {
      subjectType: 'fixed_expense_template', subjectId: id(20),
      action: 'deactivated', commandType: 'fixed-expense-template.deactivate',
    });
    assert.equal((await captureRejection(f.commands.fixedExpenseTemplate.deactivate({
      ...await commonInput(f.storage), templateId: id(20), expectedTemplateRevision: 2,
    }))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
  });
});

test('V1.1.0 fixed-expense instance planning command', async (t) => {
  await t.test('updates only plannedAmount for an existing active-period instance', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    await f.storage.add('fixedExpenseTemplates', template());
    await f.storage.add('fixedExpenseInstances', instance());
    const templateBefore = await f.storage.get('fixedExpenseTemplates', id(20));
    const previous = await f.storage.get('fixedExpenseInstances', id(21));
    const completed = await f.commands.fixedExpenseInstance.updatePlannedAmount({
      ...await commonInput(f.storage),
      instanceId: id(21),
      expectedInstanceRevision: 1,
      plannedAmount: 62000,
    });
    const updated = completed.result.instance;

    assert.equal(updated.plannedAmount, 62000);
    assert.equal(updated.revision, 2);
    for (const field of [
      'id', 'periodId', 'templateId', 'nameSnapshot', 'status',
      'activePaymentOperationId', 'createdAt',
    ]) assert.equal(updated[field], previous[field], field);
    assert.deepEqual(await f.storage.get('fixedExpenseTemplates', id(20)), templateBefore);
    assertAudit(completed.result.auditEvent, {
      subjectType: 'fixed_expense_instance', subjectId: id(21),
      action: 'updated', commandType: 'fixed-expense-instance.update-planned-amount',
    });
    assert.deepEqual(completed.commit.affectedStores, DomainCommands.FIXED_INSTANCE_CHANGE_STORES);
    assert.deepEqual(f.capture.command.affectedScopes, [
      `period:${id(1)}`, `fixed_expense_instance:${id(21)}`,
    ]);
  });

  await t.test('rejects invalid or unchanged amounts', async (t2) => {
    for (const plannedAmount of [0, -1, 1.5, 50000]) {
      const f = await fixture(t2);
      await bootstrap(f);
      await f.storage.add('fixedExpenseTemplates', template());
      await f.storage.add('fixedExpenseInstances', instance());
      const error = await captureRejection(f.commands.fixedExpenseInstance.updatePlannedAmount({
        ...await commonInput(f.storage), instanceId: id(21), expectedInstanceRevision: 1, plannedAmount,
      }));
      assert.ok(error.code);
      assert.equal((await f.storage.get('fixedExpenseInstances', id(21))).revision, 1);
    }
  });

  await t.test('rejects a closed or non-active Period and a foreign instance', async (t2) => {
    const closed = await fixture(t2);
    await bootstrap(closed);
    await closed.storage.add('fixedExpenseInstances', instance());
    await closed.storage.put('periods', period({
      status: 'closed', closedAt: closed.clock.now(), snapshotId: id(90),
    }));
    assert.equal((await captureRejection(closed.commands.fixedExpenseInstance.updatePlannedAmount({
      ...await commonInput(closed.storage), instanceId: id(21), expectedInstanceRevision: 1, plannedAmount: 60000,
    }))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);

    const foreign = await fixture(t2);
    await bootstrap(foreign);
    await foreign.storage.add('fixedExpenseInstances', instance(21, { periodId: id(99) }));
    assert.equal((await captureRejection(foreign.commands.fixedExpenseInstance.updatePlannedAmount({
      ...await commonInput(foreign.storage), instanceId: id(21), expectedInstanceRevision: 1, plannedAmount: 60000,
    }))).code, Contracts.ERROR_CODES.DOMAIN_RELATION_MISMATCH);

    const nonActive = await fixture(t2);
    await bootstrap(nonActive);
    await nonActive.storage.add('fixedExpenseInstances', instance());
    assert.equal((await captureRejection(nonActive.commands.fixedExpenseInstance.updatePlannedAmount({
      ...await commonInput(nonActive.storage), periodId: id(99),
      instanceId: id(21), expectedInstanceRevision: 1, plannedAmount: 60000,
    }))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
  });
});

test('V1.1.0 savings-goal management commands', async (t) => {
  await t.test('create starts active at zero and creates one exact PeriodOpening', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const newGoal = goal(30, { bank: 'BancoEstado' });
    const completed = await f.commands.savingsGoal.create({
      ...await commonInput(f.storage), goal: newGoal,
    });
    const openings = (await f.storage.getAll('periodOpenings')).filter(
      (opening) => opening.targetType === 'savings_goal' && opening.targetId === id(30)
    );
    assert.deepEqual(await f.storage.get('savingsGoals', id(30)), newGoal);
    assert.equal(openings.length, 1);
    assert.deepEqual(openings[0], completed.result.periodOpening);
    assert.equal(openings[0].openingAmount, 0);
    assertAudit(completed.result.auditEvent, {
      subjectType: 'savings_goal', subjectId: id(30), action: 'created', commandType: 'savings-goal.create',
    });
    assert.deepEqual(completed.commit.affectedStores, DomainCommands.SAVINGS_GOAL_CREATE_STORES);
  });

  await t.test('create rejects nonzero opening/current balance and duplicate ID', async (t2) => {
    for (const override of [
      { openingBalance: 1, currentBalance: 1 },
      { openingBalance: 0, currentBalance: 1 },
    ]) {
      const f = await fixture(t2);
      await bootstrap(f);
      assert.ok((await captureRejection(f.commands.savingsGoal.create({
        ...await commonInput(f.storage), goal: goal(30, override),
      }))).code);
    }
    const duplicate = await fixture(t2);
    await bootstrap(duplicate);
    await duplicate.storage.add('savingsGoals', goal());
    assert.equal((await captureRejection(duplicate.commands.savingsGoal.create({
      ...await commonInput(duplicate.storage), goal: goal(),
    }))).code, Contracts.ERROR_CODES.DOMAIN_RELATION_MISMATCH);
  });

  await t.test('update changes approved goal fields, derives progress, and preserves balances/lifecycle', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    await f.storage.add('savingsGoals', goal(30, { currentBalance: 100000 }));
    const previous = await f.storage.get('savingsGoals', id(30));
    const completed = await f.commands.savingsGoal.update({
      ...await commonInput(f.storage),
      goalId: id(30),
      expectedGoalRevision: 1,
      name: 'Meta editada',
      bank: 'Efectivo',
      targetAmount: 50000,
      plannedMonthlyAmount: 25000,
    });
    const updated = completed.result.goal;
    assert.equal(updated.name, 'Meta editada');
    assert.equal(updated.bank, 'Efectivo');
    assert.equal(updated.targetAmount, 50000);
    assert.equal(updated.plannedMonthlyAmount, 25000);
    assert.equal(updated.progressStatus, 'completed');
    for (const field of ['openingBalance', 'currentBalance', 'lifecycleStatus', 'closedAt']) {
      assert.equal(updated[field], previous[field], field);
    }
    assert.equal(updated.revision, 2);
    assertAudit(completed.result.auditEvent, {
      subjectType: 'savings_goal', subjectId: id(30), action: 'updated', commandType: 'savings-goal.update',
    });
  });

  await t.test('update rejects extra state fields, no-op, and stale revision', async (t2) => {
    const cases = [
      { patch: { name: 'Meta 30' }, code: Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD },
      { patch: { name: 'Otra', currentBalance: 10 }, code: Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD },
      { patch: { name: 'Otra', expectedGoalRevision: 2 }, code: Contracts.ERROR_CODES.REVISION_CONFLICT },
    ];
    for (const item of cases) {
      const f = await fixture(t2);
      await bootstrap(f);
      await f.storage.add('savingsGoals', goal());
      const error = await captureRejection(f.commands.savingsGoal.update({
        ...await commonInput(f.storage), goalId: id(30), expectedGoalRevision: 1, ...item.patch,
      }));
      assert.equal(error.code, item.code);
    }
  });

  await t.test('close requires zero balance, preserves history, and cannot reopen', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    await f.storage.add('savingsGoals', goal());
    const completed = await f.commands.savingsGoal.close({
      ...await commonInput(f.storage), goalId: id(30), expectedGoalRevision: 1,
    });
    assert.equal(completed.result.goal.lifecycleStatus, 'closed');
    assert.equal(completed.result.goal.currentBalance, 0);
    assert.equal(completed.result.goal.closedAt, f.clock.now());
    assertAudit(completed.result.auditEvent, {
      subjectType: 'savings_goal', subjectId: id(30), action: 'closed', commandType: 'savings-goal.close',
    });
    assert.equal((await captureRejection(f.commands.savingsGoal.close({
      ...await commonInput(f.storage), goalId: id(30), expectedGoalRevision: 2,
    }))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);

    const nonzero = await fixture(t2);
    await bootstrap(nonzero);
    await nonzero.storage.add('savingsGoals', goal(30, { currentBalance: 1 }));
    assert.equal((await captureRejection(nonzero.commands.savingsGoal.close({
      ...await commonInput(nonzero.storage), goalId: id(30), expectedGoalRevision: 1,
    }))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
  });
});

test('V1.1.0 debt management commands', async (t) => {
  await t.test('create records only the obligation and exact opening without touching accounts', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const accountBefore = await f.storage.get('accounts', id(2));
    const newDebt = debt();
    const completed = await f.commands.debt.create({
      ...await commonInput(f.storage), currentCivilDate: CURRENT_DATE, debt: newDebt,
    });
    const openings = (await f.storage.getAll('periodOpenings')).filter(
      (opening) => opening.targetType === 'debt' && opening.targetId === id(40)
    );

    assert.deepEqual(await f.storage.get('debts', id(40)), newDebt);
    assert.equal(completed.result.debt.openingOutstanding, 300000);
    assert.equal(completed.result.debt.outstandingAmount, 300000);
    assert.equal(openings.length, 1);
    assert.equal(openings[0].openingAmount, 300000);
    assert.deepEqual(await f.storage.get('accounts', id(2)), accountBefore);
    assertAudit(completed.result.auditEvent, {
      subjectType: 'debt', subjectId: id(40), action: 'created', commandType: 'debt.create',
    });
    assert.deepEqual(completed.commit.affectedStores, DomainCommands.DEBT_CREATE_STORES);
  });

  await t.test('create requires a payment schedule and rejects inconsistent opening or duplicate ID', async (t2) => {
    for (const override of [
      { openingOutstanding: 200000 },
      { outstandingAmount: 200000 },
      { paymentStatus: 'overdue' },
      { monthlyPaymentAmount: null, paymentDay: null },
      { monthlyPaymentAmount: 0 },
      { paymentDay: 32 },
    ]) {
      const f = await fixture(t2);
      await bootstrap(f);
      assert.ok((await captureRejection(f.commands.debt.create({
        ...await commonInput(f.storage), currentCivilDate: CURRENT_DATE, debt: debt(40, override),
      }))).code);
    }

    const duplicate = await fixture(t2);
    await bootstrap(duplicate);
    await duplicate.storage.add('debts', debt());
    assert.equal((await captureRejection(duplicate.commands.debt.create({
      ...await commonInput(duplicate.storage), currentCivilDate: CURRENT_DATE, debt: debt(),
    }))).code, Contracts.ERROR_CODES.DOMAIN_RELATION_MISMATCH);
  });

  await t.test('update changes name, monthly payment, payment day, or all and preserves financial amounts', async (t2) => {
    const patches = [
      { name: 'Deuda editada' },
      { monthlyPaymentAmount: 60000 },
      { paymentDay: 15 },
      { name: 'Deuda completa', monthlyPaymentAmount: 75000, paymentDay: 28 },
    ];
    for (const patchValue of patches) {
      const f = await fixture(t2);
      await bootstrap(f);
      await f.storage.add('debts', debt());
      const previous = await f.storage.get('debts', id(40));
      const completed = await f.commands.debt.updateNameAndDueDate({
        ...await commonInput(f.storage),
        currentCivilDate: CURRENT_DATE,
        debtId: id(40),
        expectedDebtRevision: 1,
        ...patchValue,
      });
      const updated = completed.result.debt;
      for (const field of ['totalAmount', 'openingOutstanding', 'outstandingAmount', 'lifecycleStatus']) {
        assert.equal(updated[field], previous[field], field);
      }
      assert.equal(updated.revision, 2);
      assert.equal(updated.dueDate, previous.dueDate);
      assert.equal(updated.paymentStatus, previous.paymentStatus);
      assertAudit(completed.result.auditEvent, {
        subjectType: 'debt', subjectId: id(40),
        action: 'updated', commandType: 'debt.update-name-and-due-date',
      });
    }
  });

  await t.test('update rejects total edits, no-op, stale revision, and paid Debt', async (t2) => {
    const cases = [
      {
        patch: { name: 'Otra', totalAmount: 400000 },
        code: Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD,
      },
      { patch: { name: 'Deuda 40' }, code: Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD },
      {
        patch: { name: 'Otra', expectedDebtRevision: 2 },
        code: Contracts.ERROR_CODES.REVISION_CONFLICT,
      },
    ];
    for (const item of cases) {
      const f = await fixture(t2);
      await bootstrap(f);
      await f.storage.add('debts', debt());
      const error = await captureRejection(f.commands.debt.updateNameAndDueDate({
        ...await commonInput(f.storage), currentCivilDate: CURRENT_DATE,
        debtId: id(40), expectedDebtRevision: 1, ...item.patch,
      }));
      assert.equal(error.code, item.code);
    }

    const paid = await fixture(t2);
    await bootstrap(paid);
    await paid.storage.add('debts', debt(40, {
      totalAmount: 1,
      openingOutstanding: 1,
      outstandingAmount: 0,
      paymentStatus: 'paid',
    }));
    assert.equal((await captureRejection(paid.commands.debt.updateNameAndDueDate({
      ...await commonInput(paid.storage), currentCivilDate: CURRENT_DATE,
      debtId: id(40), expectedDebtRevision: 1, name: 'No editable',
    }))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
  });
});

test('V1.1.0 entity/catalog command rollback', async (t) => {
  const cases = [
    {
      name: 'category.create', store: 'categories', method: 'add', seed: false,
      invoke: (commands, input) => commands.category.create({ ...input, category: category(11) }),
      read: (storage) => storage.get('categories', id(11)),
    },
    {
      name: 'category.update', store: 'categories', method: 'put', seed: true,
      invoke: (commands, input) => commands.category.update({
        ...input, categoryId: id(10), expectedCategoryRevision: 1, name: 'Otra',
      }),
      read: (storage) => storage.get('categories', id(10)),
    },
    {
      name: 'category.deactivate', store: 'categories', method: 'put', seed: true,
      invoke: (commands, input) => commands.category.deactivate({
        ...input, categoryId: id(10), expectedCategoryRevision: 1,
      }),
      read: (storage) => storage.get('categories', id(10)),
    },
    {
      name: 'fixed-expense-template.create', store: 'fixedExpenseTemplates', method: 'add', seed: false,
      invoke: (commands, input) => commands.fixedExpenseTemplate.create({ ...input, template: template(22) }),
      read: (storage) => storage.get('fixedExpenseTemplates', id(22)),
    },
    {
      name: 'fixed-expense-template.update', store: 'fixedExpenseTemplates', method: 'put', seed: true,
      invoke: (commands, input) => commands.fixedExpenseTemplate.update({
        ...input, templateId: id(20), expectedTemplateRevision: 1, referenceAmount: 60000,
      }),
      read: (storage) => storage.get('fixedExpenseTemplates', id(20)),
    },
    {
      name: 'fixed-expense-template.deactivate', store: 'fixedExpenseTemplates', method: 'put', seed: true,
      invoke: (commands, input) => commands.fixedExpenseTemplate.deactivate({
        ...input, templateId: id(20), expectedTemplateRevision: 1,
      }),
      read: (storage) => storage.get('fixedExpenseTemplates', id(20)),
    },
    {
      name: 'fixed-expense-instance.update-planned-amount', store: 'fixedExpenseInstances', method: 'put', seed: true,
      invoke: (commands, input) => commands.fixedExpenseInstance.updatePlannedAmount({
        ...input, instanceId: id(21), expectedInstanceRevision: 1, plannedAmount: 60000,
      }),
      read: (storage) => storage.get('fixedExpenseInstances', id(21)),
    },
    {
      name: 'savings-goal.create', store: 'savingsGoals', method: 'add', seed: false,
      invoke: (commands, input) => commands.savingsGoal.create({ ...input, goal: goal(31) }),
      read: (storage) => storage.get('savingsGoals', id(31)),
    },
    {
      name: 'savings-goal.update', store: 'savingsGoals', method: 'put', seed: true,
      invoke: (commands, input) => commands.savingsGoal.update({
        ...input, goalId: id(30), expectedGoalRevision: 1, plannedMonthlyAmount: 60000,
      }),
      read: (storage) => storage.get('savingsGoals', id(30)),
    },
    {
      name: 'savings-goal.close', store: 'savingsGoals', method: 'put', seed: true,
      invoke: (commands, input) => commands.savingsGoal.close({
        ...input, goalId: id(30), expectedGoalRevision: 1,
      }),
      read: (storage) => storage.get('savingsGoals', id(30)),
    },
    {
      name: 'debt.create', store: 'debts', method: 'add', seed: false,
      invoke: (commands, input) => commands.debt.create({
        ...input, currentCivilDate: CURRENT_DATE, debt: debt(41),
      }),
      read: (storage) => storage.get('debts', id(41)),
    },
    {
      name: 'debt.update-name-and-due-date', store: 'debts', method: 'put', seed: true,
      invoke: (commands, input) => commands.debt.updateNameAndDueDate({
        ...input, currentCivilDate: CURRENT_DATE,
        debtId: id(40), expectedDebtRevision: 1, name: 'Otra',
      }),
      read: (storage) => storage.get('debts', id(40)),
    },
  ];

  for (const item of cases) {
    await t.test(`${item.name} rolls back its entity write`, async (t2) => {
      const f = await fixture(t2);
      await bootstrap(f);
      if (item.seed) await seedCatalogs(f);
      const before = await item.read(f.storage);
      const auditsBefore = await f.storage.getAll('auditEvents');
      const runtimeBefore = await f.storage.get('system', 'runtime');
      const openingsBefore = await f.storage.getAll('periodOpenings');
      const failingStorage = wrapFailingStorage(f.storage, item.store, item.method);
      const runtime = makeRuntime(failingStorage, f.clock, uuidSequence('b4000000'));
      const commands = makeCommands(runtime, f.clock, uuidSequence('b5000000'));

      await captureRejection(item.invoke(commands, await commonInput(f.storage)));
      assert.deepEqual(await item.read(f.storage), before);
      assert.deepEqual(await f.storage.getAll('auditEvents'), auditsBefore);
      assert.deepEqual(await f.storage.getAll('periodOpenings'), openingsBefore);
      assert.deepEqual(await f.storage.get('system', 'runtime'), runtimeBefore);
    });
  }

  for (const [storeName, method] of [['auditEvents', 'add'], ['commits', 'add'], ['system', 'put']]) {
    await t.test(`all effects roll back when ${storeName}.${method} fails`, async (t2) => {
      const f = await fixture(t2);
      await bootstrap(f);
      const beforeRuntime = await f.storage.get('system', 'runtime');
      const failingStorage = wrapFailingStorage(f.storage, storeName, method);
      const runtime = makeRuntime(failingStorage, f.clock, uuidSequence('b6000000'));
      const commands = makeCommands(runtime, f.clock, uuidSequence('b7000000'));
      await captureRejection(commands.savingsGoal.create({
        ...await commonInput(f.storage), goal: goal(31),
      }));
      assert.equal(await f.storage.get('savingsGoals', id(31)), undefined);
      assert.equal((await f.storage.getAll('periodOpenings')).length, 1);
      assert.deepEqual(await f.storage.get('system', 'runtime'), beforeRuntime);
    });
  }
});

test('V1.1.0 entity/catalog runtime gates', async (t) => {
  async function createCategoryCommand(f, overrides) {
    return f.commands.category.create({
      ...await commonInput(f.storage), category: category(11), ...(overrides || {}),
    });
  }

  await t.test('setup and active open Period are mandatory', async (t2) => {
    const incomplete = await fixture(t2);
    await acquireAndEnable(incomplete);
    assert.equal(
      (await captureRejection(createCategoryCommand(incomplete))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const missing = await fixture(t2);
    await bootstrap(missing);
    await missing.storage.remove('periods', id(1));
    assert.equal(
      (await captureRejection(createCategoryCommand(missing))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const closed = await fixture(t2);
    await bootstrap(closed);
    await closed.storage.put('periods', period({
      status: 'closed', closedAt: closed.clock.now(), snapshotId: id(90),
    }));
    assert.equal(
      (await captureRejection(createCategoryCommand(closed))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const nonActive = await fixture(t2);
    await bootstrap(nonActive);
    assert.equal(
      (await captureRejection(createCategoryCommand(nonActive, { periodId: id(99) }))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
  });

  await t.test('stale data revision and writer epoch are rejected', async (t2) => {
    const staleData = await fixture(t2);
    await bootstrap(staleData);
    assert.equal(
      (await captureRejection(createCategoryCommand(staleData, { expectedDataRevision: 1 }))).code,
      Contracts.ERROR_CODES.STALE_REVISION
    );

    const staleEpoch = await fixture(t2);
    await bootstrap(staleEpoch);
    assert.equal(
      (await captureRejection(createCategoryCommand(staleEpoch, { expectedWriterEpoch: 2 }))).code,
      Contracts.ERROR_CODES.WRITER_EPOCH_LOST
    );
  });

  await t.test('lease, writeEnabled, restricted scope, and diagnostic_only remain runtime gates', async (t2) => {
    const expired = await fixture(t2);
    await bootstrap(expired);
    expired.clock.advance(LEASE_MS + 1);
    assert.equal(
      (await captureRejection(createCategoryCommand(expired))).code,
      Contracts.ERROR_CODES.WRITER_LEASE_EXPIRED
    );

    const disabled = await fixture(t2);
    await bootstrap(disabled);
    await disabled.runtime.setWriteEnabled({ enabled: false, reason: 'test' });
    assert.equal(
      (await captureRejection(createCategoryCommand(disabled))).code,
      Contracts.ERROR_CODES.WRITE_DISABLED
    );

    const policies = [
      {
        healthStatus: 'restricted',
        restrictedScopes: [`category:${id(11)}`],
        code: Contracts.ERROR_CODES.RESTRICTED_SCOPE,
      },
      {
        healthStatus: 'diagnostic_only',
        restrictedScopes: [],
        code: Contracts.ERROR_CODES.DIAGNOSTIC_ONLY,
      },
    ];
    for (const policy of policies) {
      const f = await fixture(t2);
      await bootstrap(f);
      const state = await f.storage.get('system', 'runtime');
      await f.storage.put('system', {
        ...state,
        healthStatus: policy.healthStatus,
        restrictedScopes: policy.restrictedScopes,
      });
      assert.equal((await captureRejection(createCategoryCommand(f))).code, policy.code);
    }
  });

  await t.test('creation commands reject entity fields outside the approved contracts', async (t2) => {
    const cases = [
      {
        invoke: (f, input) => f.commands.category.create({
          ...input, category: category(11, { color: '#fff' }),
        }),
      },
      {
        invoke: (f, input) => f.commands.fixedExpenseTemplate.create({
          ...input, template: template(22, { accountId: id(2) }),
        }),
      },
      {
        invoke: (f, input) => f.commands.savingsGoal.create({
          ...input, goal: goal(31, { targetDate: '2026-12-31' }),
        }),
      },
      {
        invoke: (f, input) => f.commands.debt.create({
          ...input, currentCivilDate: CURRENT_DATE, debt: debt(41, { paidAmount: 0 }),
        }),
      },
    ];
    for (const item of cases) {
      const f = await fixture(t2);
      await bootstrap(f);
      assert.equal(
        (await captureRejection(item.invoke(f, await commonInput(f.storage)))).code,
        Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD
      );
    }
  });
});

test('V1.1.0 entity/catalog general invariants', async (t) => {
  await t.test('every command advances once, reloads coherently, and creates no financial records', async (t2) => {
    const factory = new IDBFactory();
    const f = await fixture(t2, { factory });
    await bootstrap(f);
    await seedCatalogs(f);
    const initialRuntime = await f.storage.get('system', 'runtime');
    const commits = [];

    commits.push(await f.commands.category.create({
      ...await commonInput(f.storage), category: category(11),
    }));
    commits.push(await f.commands.category.update({
      ...await commonInput(f.storage), categoryId: id(10), expectedCategoryRevision: 1, name: 'Categoría nueva',
    }));
    commits.push(await f.commands.category.deactivate({
      ...await commonInput(f.storage), categoryId: id(10), expectedCategoryRevision: 2,
    }));
    commits.push(await f.commands.fixedExpenseTemplate.create({
      ...await commonInput(f.storage), template: template(22),
    }));
    commits.push(await f.commands.fixedExpenseTemplate.update({
      ...await commonInput(f.storage), templateId: id(20), expectedTemplateRevision: 1,
      referenceAmount: 60000,
    }));
    commits.push(await f.commands.fixedExpenseTemplate.deactivate({
      ...await commonInput(f.storage), templateId: id(20), expectedTemplateRevision: 2,
    }));
    commits.push(await f.commands.fixedExpenseInstance.updatePlannedAmount({
      ...await commonInput(f.storage), instanceId: id(21), expectedInstanceRevision: 1,
      plannedAmount: 55000,
    }));
    commits.push(await f.commands.savingsGoal.create({
      ...await commonInput(f.storage), goal: goal(31),
    }));
    commits.push(await f.commands.savingsGoal.update({
      ...await commonInput(f.storage), goalId: id(30), expectedGoalRevision: 1,
      plannedMonthlyAmount: 60000,
    }));
    commits.push(await f.commands.savingsGoal.close({
      ...await commonInput(f.storage), goalId: id(30), expectedGoalRevision: 2,
    }));
    commits.push(await f.commands.debt.create({
      ...await commonInput(f.storage), currentCivilDate: CURRENT_DATE, debt: debt(41),
    }));
    commits.push(await f.commands.debt.updateNameAndDueDate({
      ...await commonInput(f.storage), currentCivilDate: CURRENT_DATE,
      debtId: id(40), expectedDebtRevision: 1, name: 'Deuda nueva',
    }));

    for (let index = 0; index < commits.length; index += 1) {
      assert.equal(commits[index].commit.dataRevision, initialRuntime.dataRevision + index + 1);
    }
    await assertNoFinancialRecords(f.storage);
    f.storage.close();

    const reloaded = makeStorage(factory);
    await reloaded.open();
    t2.after(() => reloaded.close());
    assert.equal((await reloaded.get('categories', id(10))).status, 'inactive');
    assert.equal((await reloaded.get('fixedExpenseTemplates', id(20))).status, 'inactive');
    assert.equal((await reloaded.get('fixedExpenseInstances', id(21))).plannedAmount, 55000);
    assert.equal((await reloaded.get('savingsGoals', id(30))).lifecycleStatus, 'closed');
    assert.equal((await reloaded.get('savingsGoals', id(31))).currentBalance, 0);
    assert.equal((await reloaded.get('debts', id(40))).name, 'Deuda nueva');
    assert.equal((await reloaded.get('debts', id(41))).outstandingAmount, 300000);
    assert.equal((await reloaded.getAll('periodOpenings')).length, 3);
    await assertNoFinancialRecords(reloaded);
  });
});

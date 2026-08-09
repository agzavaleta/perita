'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const Contracts = require('../perita-contracts.js');
const Domain = require('../perita-domain.js');
const IndexedDb = require('../perita-indexeddb.js');
const Runtime = require('../perita-runtime.js');
const DomainCommands = require('../perita-domain-commands.js');

const START = '2026-08-05T12:00:00.000Z';
const LEASE_MS = 60_000;
const DATABASE_CRYPTO = Object.freeze({
  randomUUID: () => '90000000-0000-4000-8000-000000000000',
});

function id(number) {
  return `91000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
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

function makeRuntime(storage, clock, tabId, createUuid) {
  return Runtime.createPeritaRuntime({
    storage,
    now: clock.now,
    tabId: tabId || 'tab-a',
    createUuid: createUuid || uuidSequence('92000000'),
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
    createUuid: createUuid || uuidSequence('93000000'),
  });
}

function settings(overrides) {
  return {
    key: 'current',
    salaryReferenceAmount: 900000,
    currency: 'CLP',
    timezone: 'America/Santiago',
    revision: 1,
    createdAt: START,
    updatedAt: START,
    ...(overrides || {}),
  };
}

function activePeriod(overrides) {
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

function account() {
  return {
    id: id(2),
    name: 'Cuenta principal',
    openingBalance: 100000,
    currentBalance: 100000,
    status: 'active',
    revision: 1,
    createdAt: START,
    updatedAt: START,
  };
}

async function fixture(t, options) {
  const config = options || {};
  const factory = config.factory || new IDBFactory();
  const clock = config.clock || makeClock();
  const storage = config.storage || makeStorage(factory);
  await storage.open();
  t.after(() => storage.close());
  const runtime = makeRuntime(storage, clock, config.tabId, config.runtimeUuid);
  const capture = {};
  const commands = makeCommands(runtime, clock, config.commandUuid, capture);
  return { factory, clock, storage, runtime, commands, capture };
}

async function bootstrap(fixtureValue) {
  const { runtime, storage, commands } = fixtureValue;
  await runtime.acquireWriter({ expectedEpoch: 0, leaseDurationMs: LEASE_MS });
  await runtime.setWriteEnabled({ enabled: true, reason: 'settings planning bootstrap' });
  const beforeSetup = await storage.get('system', 'runtime');
  await commands.setup.complete({
    expectedDataRevision: beforeSetup.dataRevision,
    expectedWriterEpoch: 1,
    currentCivilDate: '2026-08-05',
    financialSettings: settings(),
    period: activePeriod(),
    accounts: [account()],
  });
  fixtureValue.clock.advance(1000);
}

async function settingsInput(storage, overrides) {
  const state = await storage.get('system', 'runtime');
  return {
    expectedDataRevision: state.dataRevision,
    expectedWriterEpoch: 1,
    expectedSettingsRevision: 1,
    salaryReferenceAmount: 950000,
    ...(overrides || {}),
  };
}

async function planningInput(storage, overrides) {
  const state = await storage.get('system', 'runtime');
  return {
    expectedDataRevision: state.dataRevision,
    expectedWriterEpoch: 1,
    periodId: id(1),
    expectedPeriodRevision: 1,
    plannedSalaryAmount: 950000,
    ...(overrides || {}),
  };
}

function captureRejection(promise) {
  return promise.then(
    () => assert.fail('expected promise to reject'),
    (error) => error
  );
}

function wrapFailingStorage(storage, targetStore) {
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
          if (storeName === targetStore) throw new Error(`induced ${storeName} add failure`);
          return transaction.add(storeName, value);
        },
        put: (storeName, value) => {
          if (storeName === targetStore) throw new Error(`induced ${storeName} put failure`);
          return transaction.put(storeName, value);
        },
      }))
    ),
  });
}

async function assertNoFinancialRecords(storage) {
  assert.deepEqual(await storage.getAll('operations'), []);
  assert.deepEqual(await storage.getAll('movements'), []);
  assert.deepEqual(await storage.getAll('operationRevisions'), []);
}

test('V1.1.0 reference salary updates', async (t) => {
  await t.test('valid update changes only salary, revision, and updatedAt', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const before = await f.storage.get('financialSettings', 'current');
    const result = await f.commands.financialSettings.updateReferenceSalary(
      await settingsInput(f.storage)
    );
    const after = await f.storage.get('financialSettings', 'current');

    assert.equal(after.salaryReferenceAmount, 950000);
    assert.equal(after.revision, 2);
    assert.equal(after.updatedAt, f.clock.now());
    for (const field of ['key', 'currency', 'timezone', 'createdAt']) {
      assert.equal(after[field], before[field], field);
    }
    assert.deepEqual(result.result.financialSettings, after);
    assert.equal(Object.isFrozen(result.result.financialSettings), true);
  });

  await t.test('zero is accepted', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    await f.commands.financialSettings.updateReferenceSalary(
      await settingsInput(f.storage, { salaryReferenceAmount: 0 })
    );
    assert.equal((await f.storage.get('financialSettings', 'current')).salaryReferenceAmount, 0);
  });

  await t.test('negative, decimal, and unsafe values are rejected', async (t2) => {
    for (const salaryReferenceAmount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const f = await fixture(t2);
      await bootstrap(f);
      const error = await captureRejection(
        f.commands.financialSettings.updateReferenceSalary(
          await settingsInput(f.storage, { salaryReferenceAmount })
        )
      );
      assert.ok([
        Contracts.ERROR_CODES.MONEY_NEGATIVE_NOT_ALLOWED,
        Contracts.ERROR_CODES.INVALID_MONEY,
      ].includes(error.code));
      assert.equal((await f.storage.get('financialSettings', 'current')).revision, 1);
    }
  });

  await t.test('stale entity and data revisions are rejected', async (t2) => {
    const entity = await fixture(t2);
    await bootstrap(entity);
    assert.equal(
      (await captureRejection(entity.commands.financialSettings.updateReferenceSalary(
        await settingsInput(entity.storage, { expectedSettingsRevision: 2 })
      ))).code,
      Contracts.ERROR_CODES.REVISION_CONFLICT
    );

    const data = await fixture(t2);
    await bootstrap(data);
    assert.equal(
      (await captureRejection(data.commands.financialSettings.updateReferenceSalary(
        await settingsInput(data.storage, { expectedDataRevision: 1 })
      ))).code,
      Contracts.ERROR_CODES.STALE_REVISION
    );
  });

  await t.test('stale epoch, disabled writes, expired lease, and restricted scope are rejected', async (t2) => {
    const epoch = await fixture(t2);
    await bootstrap(epoch);
    assert.equal(
      (await captureRejection(epoch.commands.financialSettings.updateReferenceSalary(
        await settingsInput(epoch.storage, { expectedWriterEpoch: 2 })
      ))).code,
      Contracts.ERROR_CODES.WRITER_EPOCH_LOST
    );

    const disabled = await fixture(t2);
    await bootstrap(disabled);
    await disabled.runtime.setWriteEnabled({ enabled: false, reason: 'test' });
    assert.equal(
      (await captureRejection(disabled.commands.financialSettings.updateReferenceSalary(
        await settingsInput(disabled.storage)
      ))).code,
      Contracts.ERROR_CODES.WRITE_DISABLED
    );

    const expired = await fixture(t2);
    await bootstrap(expired);
    expired.clock.advance(LEASE_MS + 1);
    assert.equal(
      (await captureRejection(expired.commands.financialSettings.updateReferenceSalary(
        await settingsInput(expired.storage)
      ))).code,
      Contracts.ERROR_CODES.WRITER_LEASE_EXPIRED
    );

    const restricted = await fixture(t2);
    await bootstrap(restricted);
    const state = await restricted.storage.get('system', 'runtime');
    await restricted.storage.put('system', {
      ...state,
      healthStatus: 'restricted',
      restrictedScopes: ['financial_settings:current'],
    });
    assert.equal(
      (await captureRejection(restricted.commands.financialSettings.updateReferenceSalary(
        await settingsInput(restricted.storage)
      ))).code,
      Contracts.ERROR_CODES.RESTRICTED_SCOPE
    );
  });

  await t.test('audit snapshots and command declaration are exact', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const previous = await f.storage.get('financialSettings', 'current');
    const completed = await f.commands.financialSettings.updateReferenceSalary(
      await settingsInput(f.storage)
    );
    const event = completed.result.auditEvent;

    assert.equal(event.periodId, null);
    assert.equal(event.subjectType, 'financial_settings');
    assert.equal(event.subjectId, 'current');
    assert.equal(event.action, 'updated');
    assert.equal(event.commandType, 'financial-settings.update-reference-salary');
    assert.equal(event.previousRevision, 1);
    assert.equal(event.nextRevision, 2);
    assert.deepEqual(event.previousValue, previous);
    assert.deepEqual(event.nextValue, completed.result.financialSettings);
    assert.equal(Object.isFrozen(event.previousValue), true);
    assert.deepEqual(completed.commit.affectedStores, ['financialSettings', 'auditEvents']);
    assert.deepEqual(f.capture.command.affectedScopes, ['financial_settings:current']);
  });
});

test('V1.1.0 active-period planned salary updates', async (t) => {
  await t.test('planned salary remains the only approved Period planning field', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const completed = await f.commands.period.updatePlanning(
      await planningInput(f.storage, { plannedSalaryAmount: 880000 })
    );
    assert.equal(completed.result.period.plannedSalaryAmount, 880000);
  });

  await t.test('zero is allowed and unedited fields are preserved', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const before = await f.storage.get('periods', id(1));
    const completed = await f.commands.period.updatePlanning(
      await planningInput(f.storage, { plannedSalaryAmount: 0 })
    );
    assert.equal(completed.result.period.plannedSalaryAmount, 0);
    for (const field of ['id', 'periodKey', 'status', 'openedAt', 'closedAt', 'snapshotId']) {
      assert.equal(completed.result.period[field], before[field], field);
    }
    assert.equal(completed.result.period.revision, 2);
  });

  await t.test('negative and invalid planning values are rejected', async (t2) => {
    for (const plannedSalaryAmount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const f = await fixture(t2);
      await bootstrap(f);
      const error = await captureRejection(f.commands.period.updatePlanning(
        await planningInput(f.storage, { plannedSalaryAmount })
      ));
      assert.ok([
        Contracts.ERROR_CODES.MONEY_NEGATIVE_NOT_ALLOWED,
        Contracts.ERROR_CODES.INVALID_MONEY,
      ].includes(error.code));
      assert.equal((await f.storage.get('periods', id(1))).revision, 1);
    }

    const unsupported = await fixture(t2);
    await bootstrap(unsupported);
    assert.equal(
      (await captureRejection(unsupported.commands.period.updatePlanning(
        await planningInput(unsupported.storage, { status: 'closed' })
      ))).code,
      Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD
    );

    for (const retiredField of ['variableExpenseBudgetAmount', 'plannedSavingsAmount']) {
      const retired = await fixture(t2);
      await bootstrap(retired);
      assert.equal(
        (await captureRejection(retired.commands.period.updatePlanning(
          await planningInput(retired.storage, { [retiredField]: 1 })
        ))).code,
        Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD
      );
    }

    const empty = await fixture(t2);
    await bootstrap(empty);
    const state = await empty.storage.get('system', 'runtime');
    assert.equal(
      (await captureRejection(empty.commands.period.updatePlanning({
        expectedDataRevision: state.dataRevision,
        expectedWriterEpoch: 1,
        periodId: id(1),
        expectedPeriodRevision: 1,
      }))).code,
      Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD
    );
  });

  await t.test('missing, closed, and non-active periods are rejected', async (t2) => {
    const missing = await fixture(t2);
    await bootstrap(missing);
    assert.equal(
      (await captureRejection(missing.commands.period.updatePlanning(
        await planningInput(missing.storage, { periodId: id(99) })
      ))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const closed = await fixture(t2);
    await bootstrap(closed);
    const current = await closed.storage.get('periods', id(1));
    await closed.storage.put('periods', {
      ...current,
      status: 'closed',
      closedAt: closed.clock.now(),
      snapshotId: id(50),
    });
    assert.equal(
      (await captureRejection(closed.commands.period.updatePlanning(
        await planningInput(closed.storage)
      ))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const inactive = await fixture(t2);
    await bootstrap(inactive);
    const other = activePeriod({ id: id(3), periodKey: '2026-07' });
    await inactive.storage.add('periods', other);
    assert.equal(
      (await captureRejection(inactive.commands.period.updatePlanning(
        await planningInput(inactive.storage, { periodId: id(3) })
      ))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
  });

  await t.test('stale period revision is rejected', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const error = await captureRejection(f.commands.period.updatePlanning(
      await planningInput(f.storage, { expectedPeriodRevision: 2 })
    ));
    assert.equal(error.code, Contracts.ERROR_CODES.REVISION_CONFLICT);

    const staleData = await fixture(t2);
    await bootstrap(staleData);
    assert.equal(
      (await captureRejection(staleData.commands.period.updatePlanning(
        await planningInput(staleData.storage, { expectedDataRevision: 1 })
      ))).code,
      Contracts.ERROR_CODES.STALE_REVISION
    );

    const staleEpoch = await fixture(t2);
    await bootstrap(staleEpoch);
    assert.equal(
      (await captureRejection(staleEpoch.commands.period.updatePlanning(
        await planningInput(staleEpoch.storage, { expectedWriterEpoch: 2 })
      ))).code,
      Contracts.ERROR_CODES.WRITER_EPOCH_LOST
    );

    const restricted = await fixture(t2);
    await bootstrap(restricted);
    const runtimeState = await restricted.storage.get('system', 'runtime');
    await restricted.storage.put('system', {
      ...runtimeState,
      healthStatus: 'restricted',
      restrictedScopes: [`period:${id(1)}`],
    });
    assert.equal(
      (await captureRejection(restricted.commands.period.updatePlanning(
        await planningInput(restricted.storage)
      ))).code,
      Contracts.ERROR_CODES.RESTRICTED_SCOPE
    );
  });

  await t.test('audit and command declaration are exact', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const previous = await f.storage.get('periods', id(1));
    const completed = await f.commands.period.updatePlanning(
      await planningInput(f.storage, {
        plannedSalaryAmount: 875000,
      })
    );
    const event = completed.result.auditEvent;
    assert.equal(event.periodId, id(1));
    assert.equal(event.subjectType, 'period');
    assert.equal(event.subjectId, id(1));
    assert.equal(event.action, 'updated');
    assert.equal(event.commandType, 'period.update-planning');
    assert.deepEqual(event.previousValue, previous);
    assert.deepEqual(event.nextValue, completed.result.period);
    assert.equal(event.previousRevision, 1);
    assert.equal(event.nextRevision, 2);
    Domain.validateAuditEvent(event);
    assert.deepEqual(completed.commit.affectedStores, ['periods', 'auditEvents']);
    assert.deepEqual(f.capture.command.affectedScopes, [`period:${id(1)}`]);
  });
});

test('V1.1.0 settings and planned-salary rollback', async (t) => {
  for (const targetStore of ['financialSettings', 'auditEvents', 'commits', 'system']) {
    await t.test(`salary update rolls back when ${targetStore} fails`, async (t2) => {
      const f = await fixture(t2);
      await bootstrap(f);
      const beforeSettings = await f.storage.get('financialSettings', 'current');
      const beforeAudits = await f.storage.getAll('auditEvents');
      const beforeRuntime = await f.storage.get('system', 'runtime');
      const failingStorage = wrapFailingStorage(f.storage, targetStore);
      const failingRuntime = makeRuntime(failingStorage, f.clock, 'tab-a', uuidSequence('94000000'));
      const commands = makeCommands(failingRuntime, f.clock, uuidSequence('95000000'));

      await captureRejection(commands.financialSettings.updateReferenceSalary(
        await settingsInput(f.storage)
      ));
      assert.deepEqual(await f.storage.get('financialSettings', 'current'), beforeSettings);
      assert.deepEqual(await f.storage.getAll('auditEvents'), beforeAudits);
      assert.deepEqual(await f.storage.get('system', 'runtime'), beforeRuntime);
      assert.equal((await f.storage.getAll('commits')).length, 2);
    });
  }

  for (const targetStore of ['periods', 'auditEvents', 'commits', 'system']) {
    await t.test(`planned salary update rolls back when ${targetStore} fails`, async (t2) => {
      const f = await fixture(t2);
      await bootstrap(f);
      const beforePeriod = await f.storage.get('periods', id(1));
      const beforeAudits = await f.storage.getAll('auditEvents');
      const beforeRuntime = await f.storage.get('system', 'runtime');
      const failingStorage = wrapFailingStorage(f.storage, targetStore);
      const failingRuntime = makeRuntime(failingStorage, f.clock, 'tab-a', uuidSequence('96000000'));
      const commands = makeCommands(failingRuntime, f.clock, uuidSequence('97000000'));

      await captureRejection(commands.period.updatePlanning(await planningInput(f.storage)));
      assert.deepEqual(await f.storage.get('periods', id(1)), beforePeriod);
      assert.deepEqual(await f.storage.getAll('auditEvents'), beforeAudits);
      assert.deepEqual(await f.storage.get('system', 'runtime'), beforeRuntime);
      assert.equal((await f.storage.getAll('commits')).length, 2);
    });
  }
});

test('V1.1.0 settings and planned-salary general invariants', async (t) => {
  await t.test('each command advances dataRevision exactly once and creates no financial records', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const before = await f.storage.get('system', 'runtime');
    const salary = await f.commands.financialSettings.updateReferenceSalary(
      await settingsInput(f.storage)
    );
    assert.equal(salary.commit.previousDataRevision, before.dataRevision);
    assert.equal(salary.commit.dataRevision, before.dataRevision + 1);
    const plannedSalary = await f.commands.period.updatePlanning(await planningInput(f.storage));
    assert.equal(plannedSalary.commit.previousDataRevision, before.dataRevision + 1);
    assert.equal(plannedSalary.commit.dataRevision, before.dataRevision + 2);
    await assertNoFinancialRecords(f.storage);
  });

  await t.test('updated settings and planned salary reload coherently from IndexedDB', async (t2) => {
    const factory = new IDBFactory();
    const f = await fixture(t2, { factory });
    await bootstrap(f);
    await f.commands.financialSettings.updateReferenceSalary(
      await settingsInput(f.storage, { salaryReferenceAmount: 990000 })
    );
    await f.commands.period.updatePlanning(await planningInput(f.storage, {
      plannedSalaryAmount: 990000,
    }));
    f.storage.close();

    const reloaded = makeStorage(factory);
    await reloaded.open();
    t2.after(() => reloaded.close());
    assert.equal((await reloaded.get('financialSettings', 'current')).salaryReferenceAmount, 990000);
    const savedPeriod = await reloaded.get('periods', id(1));
    assert.equal(savedPeriod.plannedSalaryAmount, 990000);
    assert.equal((await reloaded.getAll('auditEvents')).length, 5);
    await assertNoFinancialRecords(reloaded);
  });
});

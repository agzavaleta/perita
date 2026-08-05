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
  randomUUID: () => 'a0000000-0000-4000-8000-000000000000',
});

function id(number) {
  return `a1000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
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
    createUuid: createUuid || uuidSequence('a2000000'),
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
    createUuid: createUuid || uuidSequence('a3000000'),
  });
}

function settings() {
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
    variableExpenseBudgetAmount: 200000,
    plannedSavingsAmount: 100000,
    openedAt: START,
    closedAt: null,
    snapshotId: null,
    revision: 1,
    ...(overrides || {}),
  };
}

function account(number, overrides) {
  return {
    id: id(number),
    name: `Cuenta ${number}`,
    openingBalance: 0,
    currentBalance: 0,
    status: 'active',
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
  await f.runtime.setWriteEnabled({ enabled: true, reason: 'accounts bootstrap' });
}

async function bootstrap(f) {
  await acquireAndEnable(f);
  const runtimeState = await f.storage.get('system', 'runtime');
  await f.commands.setup.complete({
    expectedDataRevision: runtimeState.dataRevision,
    expectedWriterEpoch: 1,
    currentCivilDate: '2026-08-05',
    financialSettings: settings(),
    period: period(),
    accounts: [account(2)],
  });
  f.clock.advance(1000);
}

async function createInput(storage, overrides) {
  const runtimeState = await storage.get('system', 'runtime');
  return {
    expectedDataRevision: runtimeState.dataRevision,
    expectedWriterEpoch: 1,
    periodId: id(1),
    account: account(3),
    ...(overrides || {}),
  };
}

async function updateInput(storage, overrides) {
  const runtimeState = await storage.get('system', 'runtime');
  return {
    expectedDataRevision: runtimeState.dataRevision,
    expectedWriterEpoch: 1,
    periodId: id(1),
    accountId: id(2),
    expectedAccountRevision: 1,
    name: 'Cuenta renombrada',
    ...(overrides || {}),
  };
}

async function deactivateInput(storage, overrides) {
  const runtimeState = await storage.get('system', 'runtime');
  return {
    expectedDataRevision: runtimeState.dataRevision,
    expectedWriterEpoch: 1,
    periodId: id(1),
    accountId: id(2),
    expectedAccountRevision: 1,
    ...(overrides || {}),
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
        get: (storeName, key) => {
          if (storeName === targetStore && targetMethod === 'get') {
            throw new Error(`induced ${storeName} get failure`);
          }
          return transaction.get(storeName, key);
        },
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

test('V1.1.0 account.create', async (t) => {
  await t.test('creates an active zero-balance Account and exact PeriodOpening', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const completed = await f.commands.account.create(await createInput(f.storage));
    const saved = await f.storage.get('accounts', id(3));
    const openings = await f.storage.getAll('periodOpenings');
    const opening = openings.find((item) => item.targetId === id(3));

    assert.equal(openings.length, 2);
    assert.equal(openings.filter((item) => item.targetId === id(3)).length, 1);
    assert.deepEqual(saved, account(3));
    assert.deepEqual(opening, completed.result.periodOpening);
    assert.deepEqual(opening, {
      id: completed.result.periodOpening.id,
      periodId: id(1),
      targetType: 'account',
      targetId: id(3),
      openingAmount: 0,
    });
    assert.equal(completed.result.account.status, 'active');
    assert.deepEqual(completed.commit.affectedStores, DomainCommands.ACCOUNT_CREATE_STORES);
    assert.deepEqual(f.capture.command.affectedScopes, [`period:${id(1)}`, `account:${id(3)}`]);
  });

  await t.test('creates the exact immutable AuditEvent without financial records', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const completed = await f.commands.account.create(await createInput(f.storage));
    const event = completed.result.auditEvent;

    assert.equal(event.periodId, id(1));
    assert.equal(event.subjectType, 'account');
    assert.equal(event.subjectId, id(3));
    assert.equal(event.action, 'created');
    assert.equal(event.commandType, 'account.create');
    assert.equal(event.previousRevision, null);
    assert.equal(event.nextRevision, 1);
    assert.equal(event.previousValue, null);
    assert.deepEqual(event.nextValue, completed.result.account);
    assert.equal(Object.isFrozen(event.nextValue), true);
    await assertNoFinancialRecords(f.storage);
  });

  await t.test('allows duplicate names but rejects duplicate IDs', async (t2) => {
    const sameName = await fixture(t2);
    await bootstrap(sameName);
    const created = account(3, { name: 'Cuenta 2' });
    await sameName.commands.account.create(await createInput(sameName.storage, { account: created }));
    assert.equal((await sameName.storage.get('accounts', id(3))).name, 'Cuenta 2');

    const duplicate = await fixture(t2);
    await bootstrap(duplicate);
    assert.equal(
      (await captureRejection(duplicate.commands.account.create(
        await createInput(duplicate.storage, { account: account(2) })
      ))).code,
      Contracts.ERROR_CODES.DOMAIN_RELATION_MISMATCH
    );
  });

  await t.test('rejects nonzero balances, inactive status, and noninitial revision', async (t2) => {
    const cases = [
      { openingBalance: 1, currentBalance: 1 },
      { openingBalance: -1, currentBalance: -1 },
      { status: 'inactive' },
      { revision: 2 },
    ];
    for (const override of cases) {
      const f = await fixture(t2);
      await bootstrap(f);
      const error = await captureRejection(f.commands.account.create(
        await createInput(f.storage, { account: account(3, override) })
      ));
      assert.ok([
        Contracts.ERROR_CODES.DOMAIN_STATE_INVALID,
        Contracts.ERROR_CODES.MONEY_NEGATIVE_NOT_ALLOWED,
      ].includes(error.code));
      assert.equal(await f.storage.get('accounts', id(3)), undefined);
    }
  });

  await t.test('rejects missing, closed, non-active Periods and incomplete setup', async (t2) => {
    const missing = await fixture(t2);
    await bootstrap(missing);
    await missing.storage.remove('periods', id(1));
    assert.equal(
      (await captureRejection(missing.commands.account.create(
        await createInput(missing.storage)
      ))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const closed = await fixture(t2);
    await bootstrap(closed);
    await closed.storage.put('periods', period({
      status: 'closed',
      closedAt: closed.clock.now(),
      snapshotId: id(90),
    }));
    assert.equal(
      (await captureRejection(closed.commands.account.create(
        await createInput(closed.storage)
      ))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const inactive = await fixture(t2);
    await bootstrap(inactive);
    assert.equal(
      (await captureRejection(inactive.commands.account.create(
        await createInput(inactive.storage, { periodId: id(99) })
      ))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const incomplete = await fixture(t2);
    await acquireAndEnable(incomplete);
    assert.equal(
      (await captureRejection(incomplete.commands.account.create(
        await createInput(incomplete.storage)
      ))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
  });
});

test('V1.1.0 account.update', async (t) => {
  await t.test('updates only the existing descriptive name and advances once', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const before = await f.storage.get('accounts', id(2));
    const runtimeBefore = await f.storage.get('system', 'runtime');
    const completed = await f.commands.account.update(await updateInput(f.storage));
    const after = completed.result.account;

    assert.equal(after.name, 'Cuenta renombrada');
    assert.equal(after.revision, 2);
    assert.equal(after.updatedAt, f.clock.now());
    for (const field of [
      'id', 'openingBalance', 'currentBalance', 'status', 'createdAt',
    ]) assert.equal(after[field], before[field], field);
    assert.equal(completed.commit.previousDataRevision, runtimeBefore.dataRevision);
    assert.equal(completed.commit.dataRevision, runtimeBefore.dataRevision + 1);
    assert.deepEqual(completed.commit.affectedStores, DomainCommands.ACCOUNT_CHANGE_STORES);
    assert.deepEqual(f.capture.command.affectedScopes, [`period:${id(1)}`, `account:${id(2)}`]);
  });

  await t.test('requires one editable field and rejects every protected or unknown field', async (t2) => {
    const none = await fixture(t2);
    await bootstrap(none);
    const empty = await updateInput(none.storage);
    delete empty.name;
    assert.equal(
      (await captureRejection(none.commands.account.update(empty))).code,
      Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD
    );

    const unchanged = await fixture(t2);
    await bootstrap(unchanged);
    const runtimeBefore = await unchanged.storage.get('system', 'runtime');
    const auditsBefore = await unchanged.storage.getAll('auditEvents');
    assert.equal(
      (await captureRejection(unchanged.commands.account.update(
        await updateInput(unchanged.storage, { name: 'Cuenta 2' })
      ))).code,
      Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD
    );
    assert.equal((await unchanged.storage.get('accounts', id(2))).revision, 1);
    assert.deepEqual(await unchanged.storage.getAll('auditEvents'), auditsBefore);
    assert.deepEqual(await unchanged.storage.get('system', 'runtime'), runtimeBefore);

    for (const field of [
      'openingBalance', 'currentBalance', 'status', 'id', 'revision', 'createdAt', 'updatedAt', 'type',
    ]) {
      const f = await fixture(t2);
      await bootstrap(f);
      const error = await captureRejection(f.commands.account.update(
        await updateInput(f.storage, { [field]: field === 'status' ? 'inactive' : 0 })
      ));
      assert.equal(error.code, Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD, field);
    }
  });

  await t.test('rejects missing Account and stale entity revision', async (t2) => {
    const missing = await fixture(t2);
    await bootstrap(missing);
    assert.equal(
      (await captureRejection(missing.commands.account.update(
        await updateInput(missing.storage, { accountId: id(99) })
      ))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const stale = await fixture(t2);
    await bootstrap(stale);
    assert.equal(
      (await captureRejection(stale.commands.account.update(
        await updateInput(stale.storage, { expectedAccountRevision: 2 })
      ))).code,
      Contracts.ERROR_CODES.REVISION_CONFLICT
    );
  });

  await t.test('AuditEvent contains complete previous and next snapshots', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const previous = await f.storage.get('accounts', id(2));
    const completed = await f.commands.account.update(await updateInput(f.storage));
    const event = completed.result.auditEvent;

    assert.equal(event.periodId, id(1));
    assert.equal(event.action, 'updated');
    assert.equal(event.commandType, 'account.update');
    assert.equal(event.previousRevision, 1);
    assert.equal(event.nextRevision, 2);
    assert.deepEqual(event.previousValue, previous);
    assert.deepEqual(event.nextValue, completed.result.account);
    assert.equal(Object.isFrozen(event.previousValue), true);
  });
});

test('V1.1.0 account.deactivate', async (t) => {
  await t.test('deactivates a zero-balance Account and preserves opening and history', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const previous = await f.storage.get('accounts', id(2));
    const openingsBefore = await f.storage.getAll('periodOpenings');
    const auditsBefore = await f.storage.getAll('auditEvents');
    const completed = await f.commands.account.deactivate(await deactivateInput(f.storage));
    const saved = completed.result.account;

    assert.equal(saved.status, 'inactive');
    assert.equal(saved.openingBalance, 0);
    assert.equal(saved.currentBalance, 0);
    assert.equal(saved.revision, 2);
    for (const field of ['id', 'name', 'openingBalance', 'currentBalance', 'createdAt']) {
      assert.equal(saved[field], previous[field], field);
    }
    assert.equal(saved.updatedAt, f.clock.now());
    assert.deepEqual(await f.storage.getAll('periodOpenings'), openingsBefore);
    assert.equal((await f.storage.getAll('auditEvents')).length, auditsBefore.length + 1);
    assert.deepEqual(completed.commit.affectedStores, DomainCommands.ACCOUNT_CHANGE_STORES);
    assert.deepEqual(f.capture.command.affectedScopes, [`period:${id(1)}`, `account:${id(2)}`]);
  });

  await t.test('creates a deactivated AuditEvent with complete snapshots', async (t2) => {
    const f = await fixture(t2);
    await bootstrap(f);
    const previous = await f.storage.get('accounts', id(2));
    const completed = await f.commands.account.deactivate(await deactivateInput(f.storage));
    const event = completed.result.auditEvent;

    assert.equal(event.periodId, id(1));
    assert.equal(event.subjectType, 'account');
    assert.equal(event.action, 'deactivated');
    assert.equal(event.commandType, 'account.deactivate');
    assert.equal(event.previousRevision, 1);
    assert.equal(event.nextRevision, 2);
    assert.deepEqual(event.previousValue, previous);
    assert.deepEqual(event.nextValue, completed.result.account);
  });

  await t.test('rejects missing, inactive, stale, and nonzero-balance Accounts', async (t2) => {
    const missing = await fixture(t2);
    await bootstrap(missing);
    assert.equal(
      (await captureRejection(missing.commands.account.deactivate(
        await deactivateInput(missing.storage, { accountId: id(99) })
      ))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const inactive = await fixture(t2);
    await bootstrap(inactive);
    await inactive.commands.account.deactivate(await deactivateInput(inactive.storage));
    assert.equal(
      (await captureRejection(inactive.commands.account.deactivate(
        await deactivateInput(inactive.storage, { expectedAccountRevision: 2 })
      ))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const stale = await fixture(t2);
    await bootstrap(stale);
    assert.equal(
      (await captureRejection(stale.commands.account.deactivate(
        await deactivateInput(stale.storage, { expectedAccountRevision: 2 })
      ))).code,
      Contracts.ERROR_CODES.REVISION_CONFLICT
    );

    for (const currentBalance of [1, -1]) {
      const nonzero = await fixture(t2);
      await bootstrap(nonzero);
      await nonzero.storage.put('accounts', account(2, { currentBalance }));
      const error = await captureRejection(nonzero.commands.account.deactivate(
        await deactivateInput(nonzero.storage)
      ));
      assert.equal(error.code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
      assert.equal((await nonzero.storage.get('accounts', id(2))).status, 'active');
    }
  });
});

test('V1.1.0 Account command atomicity', async (t) => {
  const createFailures = [
    ['periods', 'get'],
    ['accounts', 'add'],
    ['periodOpenings', 'add'],
    ['auditEvents', 'add'],
    ['commits', 'add'],
    ['system', 'put'],
  ];
  for (const [storeName, method] of createFailures) {
    await t.test(`account.create rolls back when ${storeName}.${method} fails`, async (t2) => {
      const f = await fixture(t2);
      await bootstrap(f);
      const beforeRuntime = await f.storage.get('system', 'runtime');
      const beforeAudits = await f.storage.getAll('auditEvents');
      const beforeOpenings = await f.storage.getAll('periodOpenings');
      const failingStorage = wrapFailingStorage(f.storage, storeName, method);
      const runtime = makeRuntime(failingStorage, f.clock, uuidSequence('a4000000'));
      const commands = makeCommands(runtime, f.clock, uuidSequence('a5000000'));

      await captureRejection(commands.account.create(await createInput(f.storage)));
      assert.equal(await f.storage.get('accounts', id(3)), undefined);
      assert.deepEqual(await f.storage.getAll('periodOpenings'), beforeOpenings);
      assert.deepEqual(await f.storage.getAll('auditEvents'), beforeAudits);
      assert.deepEqual(await f.storage.get('system', 'runtime'), beforeRuntime);
    });
  }

  for (const commandName of ['update', 'deactivate']) {
    for (const [storeName, method] of [
      ['periods', 'get'],
      ['accounts', 'put'],
      ['auditEvents', 'add'],
      ['commits', 'add'],
      ['system', 'put'],
    ]) {
      await t.test(`account.${commandName} rolls back when ${storeName}.${method} fails`, async (t2) => {
        const f = await fixture(t2);
        await bootstrap(f);
        const beforeAccount = await f.storage.get('accounts', id(2));
        const beforeRuntime = await f.storage.get('system', 'runtime');
        const beforeAudits = await f.storage.getAll('auditEvents');
        const failingStorage = wrapFailingStorage(f.storage, storeName, method);
        const runtime = makeRuntime(failingStorage, f.clock, uuidSequence('a6000000'));
        const commands = makeCommands(runtime, f.clock, uuidSequence('a7000000'));
        const input = commandName === 'update'
          ? await updateInput(f.storage)
          : await deactivateInput(f.storage);

        await captureRejection(commands.account[commandName](input));
        assert.deepEqual(await f.storage.get('accounts', id(2)), beforeAccount);
        assert.deepEqual(await f.storage.getAll('auditEvents'), beforeAudits);
        assert.deepEqual(await f.storage.get('system', 'runtime'), beforeRuntime);
      });
    }
  }
});

test('V1.1.0 Account runtime gates and invariants', async (t) => {
  await t.test('stale data revision and writer epoch are rejected', async (t2) => {
    const staleData = await fixture(t2);
    await bootstrap(staleData);
    assert.equal(
      (await captureRejection(staleData.commands.account.create(
        await createInput(staleData.storage, { expectedDataRevision: 1 })
      ))).code,
      Contracts.ERROR_CODES.STALE_REVISION
    );

    const staleEpoch = await fixture(t2);
    await bootstrap(staleEpoch);
    assert.equal(
      (await captureRejection(staleEpoch.commands.account.create(
        await createInput(staleEpoch.storage, { expectedWriterEpoch: 2 })
      ))).code,
      Contracts.ERROR_CODES.WRITER_EPOCH_LOST
    );
  });

  await t.test('expired lease, disabled writes, and restricted scope are rejected', async (t2) => {
    const expired = await fixture(t2);
    await bootstrap(expired);
    expired.clock.advance(LEASE_MS + 1);
    assert.equal(
      (await captureRejection(expired.commands.account.create(
        await createInput(expired.storage)
      ))).code,
      Contracts.ERROR_CODES.WRITER_LEASE_EXPIRED
    );

    const disabled = await fixture(t2);
    await bootstrap(disabled);
    await disabled.runtime.setWriteEnabled({ enabled: false, reason: 'test' });
    assert.equal(
      (await captureRejection(disabled.commands.account.create(
        await createInput(disabled.storage)
      ))).code,
      Contracts.ERROR_CODES.WRITE_DISABLED
    );

    const restricted = await fixture(t2);
    await bootstrap(restricted);
    const runtimeState = await restricted.storage.get('system', 'runtime');
    await restricted.storage.put('system', {
      ...runtimeState,
      healthStatus: 'restricted',
      restrictedScopes: [`account:${id(3)}`],
    });
    assert.equal(
      (await captureRejection(restricted.commands.account.create(
        await createInput(restricted.storage)
      ))).code,
      Contracts.ERROR_CODES.RESTRICTED_SCOPE
    );
  });

  await t.test('commands advance once, create no financial records, and reload coherently', async (t2) => {
    const factory = new IDBFactory();
    const f = await fixture(t2, { factory });
    await bootstrap(f);
    const before = await f.storage.get('system', 'runtime');
    const created = await f.commands.account.create(await createInput(f.storage));
    assert.equal(created.commit.dataRevision, before.dataRevision + 1);
    const updated = await f.commands.account.update(await updateInput(f.storage));
    assert.equal(updated.commit.dataRevision, before.dataRevision + 2);
    const deactivated = await f.commands.account.deactivate(await deactivateInput(f.storage, {
      expectedAccountRevision: 2,
    }));
    assert.equal(deactivated.commit.dataRevision, before.dataRevision + 3);
    await assertNoFinancialRecords(f.storage);
    f.storage.close();

    const reloaded = makeStorage(factory);
    await reloaded.open();
    t2.after(() => reloaded.close());
    assert.equal((await reloaded.get('accounts', id(3))).status, 'active');
    assert.equal((await reloaded.get('accounts', id(2))).name, 'Cuenta renombrada');
    assert.equal((await reloaded.get('accounts', id(2))).status, 'inactive');
    assert.equal((await reloaded.getAll('periodOpenings')).length, 2);
    await assertNoFinancialRecords(reloaded);
  });
});

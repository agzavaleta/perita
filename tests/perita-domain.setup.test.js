'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const Contracts = require('../perita-contracts.js');
const Domain = require('../perita-domain.js');
const IndexedDb = require('../perita-indexeddb.js');
const Runtime = require('../perita-runtime.js');
const DomainCommands = require('../perita-domain-commands.js');

const START = '2026-08-05T12:00:00.000Z';
const CURRENT_DATE = '2026-08-05';
const LEASE_MS = 60_000;
const DATABASE_CRYPTO = Object.freeze({
  randomUUID: () => '50000000-0000-4000-8000-000000000000',
});

function id(number) {
  return `60000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
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
    createUuid: createUuid || uuidSequence('70000000'),
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
    createUuid: createUuid || uuidSequence('80000000'),
  });
}

async function fixture(t, options) {
  const settings = options || {};
  const factory = settings.factory || new IDBFactory();
  const clock = settings.clock || makeClock();
  const storage = settings.storage || makeStorage(factory);
  await storage.open();
  t.after(() => storage.close());
  const runtime = makeRuntime(storage, clock, settings.tabId, settings.runtimeUuid);
  const capture = {};
  const commands = makeCommands(runtime, clock, settings.commandUuid, capture);
  return { factory, clock, storage, runtime, commands, capture };
}

async function acquireAndEnable(runtime) {
  const writer = await runtime.acquireWriter({ expectedEpoch: 0, leaseDurationMs: LEASE_MS });
  const enabled = await runtime.setWriteEnabled({ enabled: true, reason: 'setup test bootstrap' });
  return { writer, enabled };
}

function financialSettings(overrides) {
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

function account(number, overrides) {
  return {
    id: id(number || 2),
    name: `Cuenta ${number || 2}`,
    openingBalance: 0,
    currentBalance: 0,
    status: 'active',
    revision: 1,
    createdAt: START,
    updatedAt: START,
    ...(overrides || {}),
  };
}

async function setupInput(storage, overrides) {
  const state = await storage.get('system', 'runtime');
  return {
    expectedDataRevision: state.dataRevision,
    expectedWriterEpoch: 1,
    currentCivilDate: CURRENT_DATE,
    financialSettings: financialSettings(),
    period: period(),
    accounts: [account(2)],
    ...(overrides || {}),
  };
}

function captureRejection(promise) {
  return promise.then(
    () => assert.fail('expected promise to reject'),
    (error) => error
  );
}

async function emptyDomainStores(storage) {
  const result = {};
  for (const storeName of DomainCommands.SETUP_COMPLETE_STORES) {
    result[storeName] = await storage.getAll(storeName);
  }
  return result;
}

function assertAllEmpty(stores) {
  for (const [storeName, records] of Object.entries(stores)) {
    assert.deepEqual(records, [], storeName);
  }
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

test('V1.1.0 setup.complete valid installations', async (t) => {
  await t.test('one account is committed atomically with exact stores and scopes', async (t2) => {
    const { storage, runtime, commands, capture } = await fixture(t2);
    await acquireAndEnable(runtime);
    const input = await setupInput(storage);
    const completed = await commands.setup.complete(input);

    assert.equal(completed.commit.commandType, 'setup.complete');
    assert.deepEqual(completed.commit.affectedStores, DomainCommands.SETUP_COMPLETE_STORES);
    assert.deepEqual(capture.command.affectedScopes, [
      'financial_settings:current',
      `period:${id(1)}`,
      `account:${id(2)}`,
    ]);
    assert.deepEqual(await storage.get('financialSettings', 'current'), input.financialSettings);
    assert.deepEqual(await storage.get('periods', id(1)), input.period);
    assert.deepEqual(await storage.get('accounts', id(2)), input.accounts[0]);
    assert.equal(completed.result.accounts.length, 1);
  });

  await t.test('multiple positive, zero, and negative accounts receive exact openings', async (t2) => {
    const { storage, runtime, commands } = await fixture(t2);
    await acquireAndEnable(runtime);
    const accounts = [
      account(2, { openingBalance: 250000, currentBalance: 250000 }),
      account(3),
      account(4, { openingBalance: -15000, currentBalance: -15000 }),
    ];
    const completed = await commands.setup.complete(await setupInput(storage, { accounts }));
    const openings = await storage.getAll('periodOpenings');

    assert.equal(openings.length, 3);
    for (const source of accounts) {
      assert.deepEqual(
        openings.find((opening) => opening.targetId === source.id),
        {
          id: completed.result.periodOpenings.find((opening) => opening.targetId === source.id).id,
          periodId: id(1),
          targetType: 'account',
          targetId: source.id,
          openingAmount: source.openingBalance,
        }
      );
    }
    assert.deepEqual(completed.result.warnings, [{
      code: DomainCommands.NEGATIVE_OPENING_BALANCE_WARNING,
      accountId: id(4),
      openingBalance: -15000,
    }]);
    assert.deepEqual(completed.commit.metadata.warnings, completed.result.warnings);
  });

  await t.test('current and prior periods are accepted', async (t2) => {
    const current = await fixture(t2);
    await acquireAndEnable(current.runtime);
    assert.equal(
      (await current.commands.setup.complete(await setupInput(current.storage))).result.period.periodKey,
      '2026-08'
    );

    const prior = await fixture(t2);
    await acquireAndEnable(prior.runtime);
    assert.equal(
      (await prior.commands.setup.complete(await setupInput(prior.storage, {
        period: period({ periodKey: '2026-07' }),
      }))).result.period.periodKey,
      '2026-07'
    );
  });

  await t.test('salary, variable budget, and planned savings may all be zero', async (t2) => {
    const { storage, runtime, commands } = await fixture(t2);
    await acquireAndEnable(runtime);
    const completed = await commands.setup.complete(await setupInput(storage, {
      financialSettings: financialSettings({ salaryReferenceAmount: 0 }),
      period: period({
        plannedSalaryAmount: 0,
      }),
    }));
    assert.equal(completed.result.financialSettings.salaryReferenceAmount, 0);
  });
});

test('V1.1.0 setup.complete validation and one-time guard', async (t) => {
  await t.test('a future period is rejected without effects', async (t2) => {
    const { storage, runtime, commands } = await fixture(t2);
    await acquireAndEnable(runtime);
    const error = await captureRejection(commands.setup.complete(await setupInput(storage, {
      period: period({ periodKey: '2026-09' }),
    })));
    assert.equal(error.code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
    assertAllEmpty(await emptyDomainStores(storage));
  });

  await t.test('at least one active account with matching opening/current balance is required', async (t2) => {
    const cases = [
      [],
      [account(2, { status: 'inactive' })],
      [account(2, { openingBalance: 10, currentBalance: 0 })],
    ];
    for (const accounts of cases) {
      const { storage, runtime, commands } = await fixture(t2);
      await acquireAndEnable(runtime);
      const error = await captureRejection(commands.setup.complete(
        await setupInput(storage, { accounts })
      ));
      assert.ok([
        Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD,
        Contracts.ERROR_CODES.DOMAIN_STATE_INVALID,
      ].includes(error.code));
      assertAllEmpty(await emptyDomainStores(storage));
    }
  });

  await t.test('duplicate account IDs are rejected before persistence', async (t2) => {
    const { storage, runtime, commands } = await fixture(t2);
    await acquireAndEnable(runtime);
    const error = await captureRejection(commands.setup.complete(await setupInput(storage, {
      accounts: [account(2), account(3, { id: id(2) })],
    })));
    assert.equal(error.code, Contracts.ERROR_CODES.DOMAIN_RELATION_MISMATCH);
    assertAllEmpty(await emptyDomainStores(storage));
  });

  await t.test('setup can complete only once', async (t2) => {
    const { storage, runtime, commands } = await fixture(t2);
    await acquireAndEnable(runtime);
    await commands.setup.complete(await setupInput(storage));
    const error = await captureRejection(commands.setup.complete(await setupInput(storage)));
    assert.equal(error.code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
    assert.equal((await storage.getAll('accounts')).length, 1);
    assert.equal((await storage.getAll('periods')).length, 1);
  });

  await t.test('an incomplete in_progress setup can be completed', async (t2) => {
    const { storage, runtime, commands } = await fixture(t2);
    await acquireAndEnable(runtime);
    const state = await storage.get('system', 'runtime');
    await storage.put('system', { ...state, setupStatus: 'in_progress' });
    const completed = await commands.setup.complete(await setupInput(storage));
    assert.equal(completed.commit.commandType, 'setup.complete');
    assert.equal((await storage.get('system', 'runtime')).setupStatus, 'completed');
  });
});

test('V1.1.0 setup.complete runtime gates', async (t) => {
  await t.test('stale data revision is rejected', async (t2) => {
    const { storage, runtime, commands } = await fixture(t2);
    await acquireAndEnable(runtime);
    const error = await captureRejection(commands.setup.complete(await setupInput(storage, {
      expectedDataRevision: 0,
    })));
    assert.equal(error.code, Contracts.ERROR_CODES.STALE_REVISION);
    assertAllEmpty(await emptyDomainStores(storage));
  });

  await t.test('stale writer epoch is rejected', async (t2) => {
    const { storage, runtime, commands } = await fixture(t2);
    await acquireAndEnable(runtime);
    const error = await captureRejection(commands.setup.complete(await setupInput(storage, {
      expectedWriterEpoch: 2,
    })));
    assert.equal(error.code, Contracts.ERROR_CODES.WRITER_EPOCH_LOST);
  });

  await t.test('a non-owner and an expired lease are rejected', async (t2) => {
    const owner = await fixture(t2);
    await acquireAndEnable(owner.runtime);
    const otherRuntime = makeRuntime(owner.storage, owner.clock, 'tab-b', uuidSequence('71000000'));
    const otherCommands = makeCommands(otherRuntime, owner.clock, uuidSequence('81000000'));
    assert.equal(
      (await captureRejection(otherCommands.setup.complete(await setupInput(owner.storage)))).code,
      Contracts.ERROR_CODES.WRITER_EPOCH_LOST
    );

    owner.clock.advance(LEASE_MS + 1);
    assert.equal(
      (await captureRejection(owner.commands.setup.complete(await setupInput(owner.storage)))).code,
      Contracts.ERROR_CODES.WRITER_LEASE_EXPIRED
    );
  });

  await t.test('writeEnabled false blocks setup', async (t2) => {
    const { storage, runtime, commands } = await fixture(t2);
    await runtime.acquireWriter({ expectedEpoch: 0, leaseDurationMs: LEASE_MS });
    const error = await captureRejection(commands.setup.complete(await setupInput(storage)));
    assert.equal(error.code, Contracts.ERROR_CODES.WRITE_DISABLED);
    assertAllEmpty(await emptyDomainStores(storage));
  });

  await t.test('restricted scope and diagnostic_only block setup', async (t2) => {
    for (const policy of [
      { healthStatus: 'restricted', restrictedScopes: ['financial_settings:current'], code: 'RESTRICTED_SCOPE' },
      { healthStatus: 'diagnostic_only', restrictedScopes: [], code: 'DIAGNOSTIC_ONLY' },
    ]) {
      const { storage, runtime, commands } = await fixture(t2);
      await acquireAndEnable(runtime);
      const state = await storage.get('system', 'runtime');
      await storage.put('system', {
        ...state,
        healthStatus: policy.healthStatus,
        restrictedScopes: policy.restrictedScopes,
      });
      const error = await captureRejection(commands.setup.complete(await setupInput(storage)));
      assert.equal(error.code, Contracts.ERROR_CODES[policy.code]);
      assertAllEmpty(await emptyDomainStores(storage));
    }
  });

  await t.test('runtime patches remain generic and reject protected runtime fields', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    const state = await storage.get('system', 'runtime');
    const protectedField = await captureRejection(runtime.executeCommand({
      commandType: 'test.invalid-runtime-patch',
      expectedDataRevision: state.dataRevision,
      expectedWriterEpoch: 1,
      affectedStores: ['drafts'],
      runtimePatch: { writeEnabled: true },
      execute: async () => undefined,
    }));
    assert.equal(protectedField.code, Contracts.ERROR_CODES.COMMAND_FAILED);

    const invalidDomainState = await captureRejection(runtime.executeCommand({
      commandType: 'test.invalid-domain-runtime-state',
      expectedDataRevision: state.dataRevision,
      expectedWriterEpoch: 1,
      affectedStores: ['drafts'],
      runtimePatch: { setupStatus: 'unknown' },
      execute: async () => undefined,
    }));
    assert.equal(invalidDomainState.code, Contracts.ERROR_CODES.COMMAND_FAILED);
    assert.equal((await storage.get('system', 'runtime')).setupStatus, 'not_started');
  });
});

test('V1.1.0 setup.complete atomic persistence', async (t) => {
  for (const targetStore of [
    ...DomainCommands.SETUP_COMPLETE_STORES,
    'commits',
    'system',
  ]) {
    await t.test(`failure in ${targetStore} rolls back every setup effect`, async (t2) => {
      const base = await fixture(t2);
      await acquireAndEnable(base.runtime);
      const failingStorage = wrapFailingStorage(base.storage, targetStore);
      const failingRuntime = makeRuntime(
        failingStorage,
        base.clock,
        'tab-a',
        uuidSequence('72000000')
      );
      const commands = makeCommands(failingRuntime, base.clock, uuidSequence('82000000'));
      const error = await captureRejection(commands.setup.complete(await setupInput(base.storage)));
      assert.ok(error instanceof Contracts.PeritaError);
      assertAllEmpty(await emptyDomainStores(base.storage));
      const runtimeState = await base.storage.get('system', 'runtime');
      assert.equal(runtimeState.setupStatus, 'not_started');
      assert.equal(runtimeState.activePeriodId, null);
      assert.equal(runtimeState.dataRevision, 1);
      assert.equal((await base.storage.getAll('commits')).length, 1);
    });
  }

  await t.test('success advances dataRevision once and creates no financial records', async (t2) => {
    const { storage, runtime, commands } = await fixture(t2);
    await acquireAndEnable(runtime);
    const before = await storage.get('system', 'runtime');
    const completed = await commands.setup.complete(await setupInput(storage));
    const after = await storage.get('system', 'runtime');

    assert.equal(completed.commit.previousDataRevision, before.dataRevision);
    assert.equal(completed.commit.dataRevision, before.dataRevision + 1);
    assert.equal(after.dataRevision, before.dataRevision + 1);
    assert.equal(after.setupStatus, 'completed');
    assert.equal(after.activePeriodId, id(1));
    assert.deepEqual(await storage.getAll('operations'), []);
    assert.deepEqual(await storage.getAll('movements'), []);
    assert.deepEqual(await storage.getAll('operationRevisions'), []);
  });
});

test('V1.1.0 setup.complete audit and reload', async (t) => {
  await t.test('audit events cover only settings, period, and accounts', async (t2) => {
    const { storage, runtime, commands } = await fixture(t2);
    await acquireAndEnable(runtime);
    const accounts = [account(2), account(3)];
    await commands.setup.complete(await setupInput(storage, { accounts }));
    const events = await storage.getAll('auditEvents');

    assert.equal(events.length, 4);
    const settingsEvent = events.find((event) => event.subjectType === 'financial_settings');
    assert.equal(settingsEvent.periodId, null);
    for (const event of events) {
      assert.equal(event.action, 'created');
      assert.equal(event.commandType, 'setup.complete');
      assert.equal(event.previousRevision, null);
      assert.equal(event.nextRevision, 1);
      assert.equal(event.previousValue, null);
      assert.equal(event.reason, null);
      Domain.validateAuditEvent(event);
      if (event.subjectType !== 'financial_settings') assert.equal(event.periodId, id(1));
    }
  });

  await t.test('reopening IndexedDB returns a coherent completed installation', async (t2) => {
    const factory = new IDBFactory();
    const first = await fixture(t2, { factory });
    await acquireAndEnable(first.runtime);
    await first.commands.setup.complete(await setupInput(first.storage, {
      accounts: [account(2), account(3)],
    }));
    first.storage.close();

    const reloaded = makeStorage(factory);
    await reloaded.open();
    t2.after(() => reloaded.close());
    const state = await reloaded.get('system', 'runtime');
    assert.equal(state.setupStatus, 'completed');
    assert.equal(state.activePeriodId, id(1));
    assert.equal((await reloaded.getAll('accounts')).length, 2);
    assert.equal((await reloaded.getAll('periodOpenings')).length, 2);
    assert.equal((await reloaded.getAll('auditEvents')).length, 4);
    assert.deepEqual(await reloaded.getAll('operations'), []);
    assert.deepEqual(await reloaded.getAll('movements'), []);
  });
});

test('V1.1.0 setup command module remains isolated and browser-compatible', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'perita-domain-commands.js'),
    'utf8'
  );
  const context = { self: { PeritaContracts: Contracts, PeritaDomain: Domain } };
  vm.runInNewContext(source, context, { filename: 'perita-domain-commands.js' });
  assert.equal(typeof context.self.PeritaDomainCommands.createPeritaDomainCommands, 'function');
  assert.doesNotMatch(source, /indexedDB|localStorage|document\.|Perita\.jsx|perita-core/);
  assert.doesNotMatch(source, /new Date\s*\(\s*\)/);
});

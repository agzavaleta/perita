'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');

const Contracts = require('../perita-contracts.js');
const IndexedDb = require('../perita-indexeddb.js');
const Runtime = require('../perita-runtime.js');
const Commands = require('../perita-domain-commands.js');
const Integrity = require('../perita-integrity.js');
const Backup = require('../perita-backup.js');

const NOW = '2026-08-31T12:00:00.000Z';
const DATE = '2026-08-20';
const PERIOD = id(1);
const ACCOUNT = id(2);
const CATEGORY = id(3);
const GOAL = id(4);
const DEBT = id(5);
const TEMPLATE = id(6);

function id(number) {
  return `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function sequence(prefix) {
  let number = 0;
  const head = prefix || '90000000';
  return () => `${head}-0000-4000-8000-${String(++number).padStart(12, '0')}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeStorage(factory) {
  return IndexedDb.createPeritaIndexedDb({
    indexedDB: factory,
    IDBKeyRange,
    crypto: crypto.webcrypto,
    now: () => NOW,
  });
}

function financialSettings() {
  return {
    key: 'current',
    salaryReferenceAmount: 0,
    currency: 'CLP',
    timezone: 'America/Santiago',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function period() {
  return {
    id: PERIOD,
    periodKey: '2026-08',
    status: 'open',
    plannedSalaryAmount: 0,
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
    bank: 'Banco Estado',
    openingBalance: 1000000,
    currentBalance: 1000000,
    status: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function category() {
  return {
    id: CATEGORY,
    name: 'Hogar',
    status: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function goal() {
  return {
    id: GOAL,
    name: 'Emergencia',
    targetAmount: 500000,
    openingBalance: 0,
    currentBalance: 0,
    plannedMonthlyAmount: 50000,
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
    name: 'Crédito',
    totalAmount: 300000,
    openingOutstanding: 300000,
    outstandingAmount: 300000,
    dueDate: '2026-12-31',
    lifecycleStatus: 'active',
    paymentStatus: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function template() {
  return {
    id: TEMPLATE,
    name: 'Internet',
    referenceAmount: 30000,
    status: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function fixture(t) {
  const factory = new IDBFactory();
  const storage = makeStorage(factory);
  const now = () => NOW;
  await storage.open();
  t.after(() => storage.close());
  const runtime = Runtime.createPeritaRuntime({
    storage,
    now,
    tabId: id(900),
    createUuid: sequence('91000000'),
  });
  const commands = Commands.createPeritaDomainCommands({
    runtime,
    now,
    createUuid: sequence('92000000'),
    sha256,
  });
  await runtime.acquireWriter({ expectedEpoch: 0, leaseDurationMs: 60000 });
  await runtime.setWriteEnabled({ enabled: true, reason: 'backup test bootstrap' });
  const state = await storage.get('system', 'runtime');
  await commands.setup.complete({
    expectedDataRevision: state.dataRevision,
    expectedWriterEpoch: 1,
    currentCivilDate: '2026-08-31',
    financialSettings: financialSettings(),
    period: period(),
    accounts: [account()],
  });
  const backup = Backup.createPeritaBackup({ storage, indexedDB: factory, now, sha256 });
  return { factory, storage, runtime, commands, backup };
}

async function header(f) {
  return {
    expectedDataRevision: (await f.storage.get('system', 'runtime')).dataRevision,
    expectedWriterEpoch: 1,
    periodId: (await f.storage.get('system', 'runtime')).activePeriodId,
  };
}

async function addComplexState(f) {
  await f.commands.category.create({ ...await header(f), category: category() });
  await f.commands.savingsGoal.create({ ...await header(f), goal: goal() });
  await f.commands.debt.create({
    ...await header(f), currentCivilDate: '2026-08-31', debt: debt(),
  });
  await f.commands.fixedExpenseTemplate.create({ ...await header(f), template: template() });
  let accountRecord = await f.storage.get('accounts', ACCOUNT);
  await f.commands.additionalIncome.create({
    ...await header(f),
    accountId: ACCOUNT,
    expectedAccountRevision: accountRecord.revision,
    operationDate: DATE,
    amount: 50000,
    concept: 'Venta',
    observation: null,
  });
  accountRecord = await f.storage.get('accounts', ACCOUNT);
  await f.commands.variableExpense.create({
    ...await header(f),
    accountId: ACCOUNT,
    expectedAccountRevision: accountRecord.revision,
    categoryId: CATEGORY,
    expectedCategoryRevision: (await f.storage.get('categories', CATEGORY)).revision,
    operationDate: DATE,
    amount: 10000,
    concept: 'Compra',
    observation: null,
  });
  await f.commands.savingsDeposit.create({
    ...await header(f),
    goalId: GOAL,
    expectedGoalRevision: (await f.storage.get('savingsGoals', GOAL)).revision,
    operationDate: DATE,
    amount: 20000,
    concept: null,
    observation: null,
  });
  accountRecord = await f.storage.get('accounts', ACCOUNT);
  await f.commands.transfer.create({
    ...await header(f),
    sourceType: 'account',
    sourceId: ACCOUNT,
    expectedSourceRevision: accountRecord.revision,
    destinationType: 'savings_goal',
    destinationId: GOAL,
    expectedDestinationRevision: (await f.storage.get('savingsGoals', GOAL)).revision,
    operationDate: DATE,
    amount: 10000,
    concept: null,
    observation: null,
  });
  accountRecord = await f.storage.get('accounts', ACCOUNT);
  await f.commands.debtPayment.create({
    ...await header(f),
    accountId: ACCOUNT,
    expectedAccountRevision: accountRecord.revision,
    debtId: DEBT,
    expectedDebtRevision: (await f.storage.get('debts', DEBT)).revision,
    operationDate: DATE,
    amount: 30000,
    concept: null,
    observation: null,
  });
}

async function closePeriod(f) {
  const runtime = await f.storage.get('system', 'runtime');
  const currentPeriod = await f.storage.get('periods', runtime.activePeriodId);
  const settings = await f.storage.get('financialSettings', 'current');
  const entities = [
    ...(await f.storage.getAll('accounts')).map((entity) => ({ targetType: 'account', entity })),
    ...(await f.storage.getAll('savingsGoals')).map((entity) => ({ targetType: 'savings_goal', entity })),
    ...(await f.storage.getAll('debts')).map((entity) => ({ targetType: 'debt', entity })),
  ];
  const templates = (await f.storage.getAll('fixedExpenseTemplates'))
    .filter((record) => record.status === 'active');
  const instances = (await f.storage.getAll('fixedExpenseInstances'))
    .filter((record) => record.periodId === currentPeriod.id);
  return f.commands.period.closeAndOpenNext({
    expectedDataRevision: runtime.dataRevision,
    expectedWriterEpoch: 1,
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
  });
}

async function rehash(backup, mutate) {
  const copy = JSON.parse(JSON.stringify(backup));
  mutate(copy);
  const payload = { ...copy };
  delete payload.integrity;
  copy.integrity.payloadHash = sha256(Backup.canonicalJson(payload));
  return copy;
}

async function completeState(storage) {
  return Object.fromEntries(await Promise.all(
    IndexedDb.STORE_NAMES.map(async (storeName) => [storeName, await storage.getAll(storeName)])
  ));
}

function rejection(promise) {
  return promise.then(() => assert.fail('expected rejection'), (error) => error);
}

function failingStorage(base, targetStore) {
  return Object.freeze({
    open: () => base.open(),
    close: () => base.close(),
    get: (...args) => base.get(...args),
    getAll: (...args) => base.getAll(...args),
    runTransaction: (stores, mode, worker) => base.runTransaction(stores, mode, (transaction) => {
      return worker(Object.freeze({
        ...transaction,
        add: (storeName, value) => {
          if (storeName === targetStore) throw new Error(`induced ${storeName}.add`);
          return transaction.add(storeName, value);
        },
      }));
    }),
  });
}

function changingBeforeRestoreStorage(base) {
  let changed = false;
  return Object.freeze({
    open: () => base.open(),
    close: () => base.close(),
    runTransaction: async (stores, mode, worker) => {
      if (mode === 'readwrite' && !changed) {
        changed = true;
        await base.put('preferences', { key: 'theme', value: 'changed concurrently' });
      }
      return base.runTransaction(stores, mode, worker);
    },
  });
}

test('V1.1.0 backup export', async (t) => {
  await t.test('exports a complete deterministic read-only document with exact hash', async (t2) => {
    const f = await fixture(t2);
    const beforeRuntime = await f.storage.get('system', 'runtime');
    const beforeCommits = await f.storage.getAll('commits');
    const first = await f.backup.exportBackup();
    const second = await f.backup.exportBackup();
    assert.deepEqual(second, first);
    assert.equal(first.documentType, 'perita-backup');
    assert.equal(first.backupFormatVersion, '1.0.0');
    assert.equal(first.schemaVersion, '1.1.0');
    assert.equal(first.appVersion, '1.1.0');
    assert.equal(first.timezone, 'America/Santiago');
    assert.deepEqual(Object.keys(first.data).sort(), Backup.BACKUP_STORE_NAMES.slice().sort());
    const payload = { ...first };
    delete payload.integrity;
    assert.equal(first.integrity.algorithm, 'SHA-256');
    assert.equal(first.integrity.canonicalization, 'perita-stable-json-v1');
    assert.equal(first.integrity.payloadHash, sha256(Backup.canonicalJson(payload)));
    assert.ok(Object.isFrozen(first));
    assert.deepEqual(await f.storage.get('system', 'runtime'), beforeRuntime);
    assert.deepEqual(await f.storage.getAll('commits'), beforeCommits);
  });
});

test('V1.1.0 backup validation', async (t) => {
  await t.test('accepts valid object and JSON representations', async (t2) => {
    const f = await fixture(t2);
    const backup = await f.backup.exportBackup();
    assert.equal((await f.backup.validateBackup(backup)).status, 'valid');
    assert.equal((await f.backup.validateBackup(JSON.stringify(backup))).status, 'valid');
  });

  await t.test('accepts a previously published V1.1.0 backup with retired Period fields', async (t2) => {
    const f = await fixture(t2);
    const backup = await f.backup.exportBackup();
    const legacyBackup = await rehash(backup, (copy) => {
      copy.data.periods[0].variableExpenseBudgetAmount = 123456;
      copy.data.periods[0].plannedSavingsAmount = 654321;
    });
    assert.equal((await f.backup.validateBackup(legacyBackup)).status, 'valid');
  });

  await t.test('classifies malformed, incomplete, altered, and incompatible documents', async (t2) => {
    const f = await fixture(t2);
    const backup = await f.backup.exportBackup();
    assert.equal((await f.backup.validateBackup('{')).status, 'invalid');
    const missingStore = JSON.parse(JSON.stringify(backup));
    delete missingStore.data.accounts;
    assert.equal((await f.backup.validateBackup(missingStore)).status, 'invalid');
    const altered = JSON.parse(JSON.stringify(backup));
    altered.data.accounts[0].name = 'Alterada';
    const hashResult = await f.backup.validateBackup(altered);
    assert.equal(hashResult.status, 'invalid');
    assert.equal(hashResult.errors[0].code, Contracts.ERROR_CODES.BACKUP_HASH_MISMATCH);
    const future = JSON.parse(JSON.stringify(backup));
    future.schemaVersion = '2.0.0';
    assert.equal((await f.backup.validateBackup(future)).status, 'incompatible');
    const physical = JSON.parse(JSON.stringify(backup));
    physical.data.system.find((record) => record.key === 'schema').indexedDbVersion = 2;
    assert.equal((await f.backup.validateBackup(physical)).status, 'incompatible');
  });

  await t.test('rejects invalid contracts, relationships, commits, balances, and snapshots', async (t2) => {
    const f = await fixture(t2);
    await addComplexState(f);
    await closePeriod(f);
    const backup = await f.backup.exportBackup();
    const cases = [
      await rehash(backup, (copy) => { copy.data.accounts[0].id = 'invalid'; }),
      await rehash(backup, (copy) => { copy.data.accounts.length = 0; }),
      await rehash(backup, (copy) => { copy.data.commits[0].sequence = 99; }),
      await rehash(backup, (copy) => { copy.data.accounts[0].currentBalance += 1; }),
      await rehash(backup, (copy) => {
        copy.data.periodSnapshots[0].integrity.payloadHash = '0'.repeat(64);
      }),
    ];
    for (const candidate of cases) {
      assert.equal((await f.backup.validateBackup(candidate)).status, 'invalid');
    }
  });
});

test('V1.1.0 backup restoration', async (t) => {
  await t.test('restores a valid backup over a truly empty installation', async (t2) => {
    const source = await fixture(t2);
    const targetBackup = await source.backup.exportBackup();
    const factory = new IDBFactory();
    const storage = makeStorage(factory);
    await storage.open();
    t2.after(() => storage.close());
    const service = Backup.createPeritaBackup({
      storage, indexedDB: factory, now: () => NOW, sha256,
    });
    const preventiveBackup = await service.exportBackup();
    assert.equal(preventiveBackup.dataRevision, 0);
    await service.restoreBackup({ backup: targetBackup, preventiveBackup });
    assert.deepEqual(await storage.get('accounts', ACCOUNT), account());
    assert.equal((await storage.get('system', 'runtime')).writeEnabled, false);
  });

  await t.test('restores an older V1.1.0 backup without reviving retired planning', async (t2) => {
    const source = await fixture(t2);
    await addComplexState(source);
    await closePeriod(source);
    const exported = await source.backup.exportBackup();
    const legacyBackup = await rehash(exported, (copy) => {
      copy.data.accounts.forEach((record) => { delete record.bank; });
      copy.data.periods.forEach((record) => {
        record.variableExpenseBudgetAmount = 123456;
        record.plannedSavingsAmount = 654321;
      });
      const snapshot = copy.data.periodSnapshots[0];
      snapshot.data.periodPlan.variableExpenseBudgetAmount = 123456;
      snapshot.data.periodPlan.plannedSavingsAmount = 654321;
      snapshot.data.totals.variableExpenseBudgetAmount = 123456;
      snapshot.data.totals.plannedSavingsAmount = 654321;
      const snapshotPayload = { ...snapshot };
      delete snapshotPayload.integrity;
      snapshot.integrity.payloadHash = sha256(Backup.canonicalJson(snapshotPayload));
    });
    assert.equal((await source.backup.validateBackup(legacyBackup)).status, 'valid');
    const factory = new IDBFactory();
    const storage = makeStorage(factory);
    await storage.open();
    t2.after(() => storage.close());
    const service = Backup.createPeritaBackup({
      storage, indexedDB: factory, now: () => NOW, sha256,
    });
    const preventiveBackup = await service.exportBackup();
    await service.restoreBackup({ backup: legacyBackup, preventiveBackup });
    assert.equal((await storage.get('accounts', ACCOUNT)).bank, null);
    for (const restoredPeriod of await storage.getAll('periods')) {
      assert.equal(Object.hasOwn(restoredPeriod, 'variableExpenseBudgetAmount'), false);
      assert.equal(Object.hasOwn(restoredPeriod, 'plannedSavingsAmount'), false);
    }
    const restoredSnapshot = (await storage.getAll('periodSnapshots'))[0];
    assert.deepEqual(restoredSnapshot, legacyBackup.data.periodSnapshots[0]);
    assert.equal(
      restoredSnapshot.integrity.payloadHash,
      legacyBackup.data.periodSnapshots[0].integrity.payloadHash
    );
    assert.equal((await service.validateBackup(await service.exportBackup())).status, 'valid');
  });

  await t.test('preserves restored health restrictions while disabling writes and leases', async (t2) => {
    const source = await fixture(t2);
    const exported = await source.backup.exportBackup();
    const restrictedBackup = await rehash(exported, (copy) => {
      const runtime = copy.data.system.find((record) => record.key === 'runtime');
      runtime.healthStatus = 'diagnostic_only';
      runtime.restrictedScopes = [`account:${ACCOUNT}`];
      runtime.writeEnabled = true;
    });
    assert.equal((await source.backup.validateBackup(restrictedBackup)).status, 'valid');

    const factory = new IDBFactory();
    const storage = makeStorage(factory);
    await storage.open();
    t2.after(() => storage.close());
    const service = Backup.createPeritaBackup({
      storage, indexedDB: factory, now: () => NOW, sha256,
    });
    const preventiveBackup = await service.exportBackup();
    await service.restoreBackup({ backup: restrictedBackup, preventiveBackup });
    const runtime = await storage.get('system', 'runtime');
    assert.equal(runtime.healthStatus, 'diagnostic_only');
    assert.deepEqual(runtime.restrictedScopes, [`account:${ACCOUNT}`]);
    assert.equal(runtime.writeEnabled, false);
    assert.deepEqual(await storage.getAll('coordination'), []);
  });

  await t.test('replaces the database atomically and preserves complete canonical history', async (t2) => {
    const source = await fixture(t2);
    await addComplexState(source);
    await closePeriod(source);
    const targetBackup = await source.backup.exportBackup();
    const targetValidation = await source.backup.validateBackup(targetBackup);
    assert.equal(targetValidation.status, 'valid', JSON.stringify(targetValidation.errors));

    const destination = await fixture(t2);
    const preventiveBackup = await destination.backup.exportBackup();
    const restored = await destination.backup.restoreBackup({
      backup: targetBackup,
      preventiveBackup,
    });
    assert.equal(restored.restored, true);
    assert.equal(restored.dataRevision, targetBackup.dataRevision);
    assert.equal(restored.runtime.writeEnabled, false);
    assert.equal(restored.runtime.healthStatus, 'ok');
    assert.deepEqual(restored.runtime.restrictedScopes, []);
    assert.deepEqual(await destination.storage.getAll('coordination'), []);
    assert.deepEqual(await destination.storage.getAll('drafts'), []);
    assert.deepEqual(await destination.storage.getAll('pendingIntents'), []);
    for (const storeName of Backup.BACKUP_STORE_NAMES) {
      const actual = await destination.storage.getAll(storeName);
      if (storeName === 'system') {
        const expectedRuntime = targetBackup.data.system.find((record) => record.key === 'runtime');
        const actualRuntime = actual.find((record) => record.key === 'runtime');
        assert.deepEqual(actualRuntime, {
          ...expectedRuntime, healthStatus: 'ok', restrictedScopes: [], writeEnabled: false,
        });
      } else {
        assert.deepEqual(
          actual.slice().sort((a, b) => Backup.canonicalJson(a).localeCompare(Backup.canonicalJson(b))),
          targetBackup.data[storeName].slice().sort(
            (a, b) => Backup.canonicalJson(a).localeCompare(Backup.canonicalJson(b))
          )
        );
      }
    }
    const reloaded = makeStorage(destination.factory);
    await reloaded.open();
    t2.after(() => reloaded.close());
    assert.equal((await reloaded.getAll('operations')).length, 5);
    assert.equal((await reloaded.getAll('movements')).length, 7);
    assert.equal((await reloaded.getAll('periodSnapshots')).length, 1);
    const check = Integrity.createPeritaIntegrity({
      storage: reloaded, now: () => NOW, createUuid: sequence('93000000'), sha256,
    });
    assert.equal((await check.runFullCheck()).status, 'ok');
  });

  await t.test('requires a valid matching preventive backup before writing', async (t2) => {
    const source = await fixture(t2);
    const target = await source.backup.exportBackup();
    const destination = await fixture(t2);
    const before = await completeState(destination.storage);
    assert.equal((await rejection(destination.backup.restoreBackup({ backup: target }))).code, 'BACKUP_INVALID');
    const unrelated = await source.backup.exportBackup();
    assert.equal((await rejection(destination.backup.restoreBackup({
      backup: target, preventiveBackup: unrelated,
    }))).code, 'BACKUP_INVALID');
    assert.deepEqual(await completeState(destination.storage), before);
  });

  await t.test('revalidates the preventive backup inside the replacement transaction', async (t2) => {
    const source = await fixture(t2);
    await addComplexState(source);
    const target = await source.backup.exportBackup();
    const destination = await fixture(t2);
    const preventive = await destination.backup.exportBackup();
    const guarded = Backup.createPeritaBackup({
      storage: changingBeforeRestoreStorage(destination.storage),
      indexedDB: destination.factory,
      now: () => NOW,
      sha256,
    });
    const error = await rejection(guarded.restoreBackup({
      backup: target,
      preventiveBackup: preventive,
    }));
    assert.equal(error.code, Contracts.ERROR_CODES.BACKUP_INVALID);
    assert.deepEqual(await destination.storage.get('preferences', 'theme'), {
      key: 'theme', value: 'changed concurrently',
    });
    assert.deepEqual(await destination.storage.get('accounts', ACCOUNT), account());
    assert.deepEqual(await destination.storage.getAll('operations'), []);
  });

  await t.test('rolls back every replacement write after an induced failure', async (t2) => {
    const source = await fixture(t2);
    await addComplexState(source);
    const target = await source.backup.exportBackup();
    const targetValidation = await source.backup.validateBackup(target);
    assert.equal(targetValidation.status, 'valid', JSON.stringify(targetValidation.errors));
    const destination = await fixture(t2);
    const preventive = await destination.backup.exportBackup();
    const before = await completeState(destination.storage);
    const broken = Backup.createPeritaBackup({
      storage: failingStorage(destination.storage, 'accounts'),
      indexedDB: destination.factory,
      now: () => NOW,
      sha256,
    });
    const error = await rejection(broken.restoreBackup({ backup: target, preventiveBackup: preventive }));
    assert.equal(
      error.code,
      Contracts.ERROR_CODES.RESTORE_FAILED,
      JSON.stringify({ code: error.code, message: error.message, context: error.context })
    );
    assert.deepEqual(await completeState(destination.storage), before);
  });
});

test('V1.1.0 definitive deletion', async (t) => {
  await t.test('requires backup and the exact ELIMINAR confirmation without partial deletion', async (t2) => {
    const f = await fixture(t2);
    const valid = await f.backup.exportBackup();
    const before = await completeState(f.storage);
    assert.equal((await rejection(f.backup.deleteAllData({ confirmation: 'ELIMINAR' }))).code, 'DELETE_BACKUP_REQUIRED');
    for (const confirmation of ['eliminar', ' ELIMINAR', 'ELIMINAR ', 'Eliminar', '']) {
      assert.equal((await rejection(f.backup.deleteAllData({
        backup: valid, confirmation,
      }))).code, 'DELETE_CONFIRMATION_INVALID');
    }
    const invalid = JSON.parse(JSON.stringify(valid));
    invalid.integrity.payloadHash = '0'.repeat(64);
    assert.equal((await rejection(f.backup.deleteAllData({
      backup: invalid, confirmation: 'ELIMINAR',
    }))).code, 'DELETE_BACKUP_INVALID');
    assert.deepEqual(await completeState(f.storage), before);
  });

  await t.test('deletes the complete database and a second attempt is idempotent', async (t2) => {
    const f = await fixture(t2);
    await addComplexState(f);
    await closePeriod(f);
    const externalBackup = await f.backup.exportBackup();
    const externalValidation = await f.backup.validateBackup(externalBackup);
    assert.equal(externalValidation.status, 'valid', JSON.stringify(externalValidation.errors));
    assert.deepEqual(await f.backup.deleteAllData({
      backup: externalBackup, confirmation: 'ELIMINAR',
    }), { deleted: true, databaseName: 'perita_v110' });
    assert.deepEqual(await f.backup.deleteAllData({
      backup: externalBackup, confirmation: 'ELIMINAR',
    }), { deleted: true, databaseName: 'perita_v110' });

    const fresh = makeStorage(f.factory);
    await fresh.open();
    t2.after(() => fresh.close());
    const state = await completeState(fresh);
    for (const storeName of IndexedDb.STORE_NAMES) {
      if (storeName === 'system') {
        assert.equal(state.system.find((record) => record.key === 'runtime').setupStatus, 'not_started');
        assert.equal(state.system.find((record) => record.key === 'runtime').dataRevision, 0);
      } else {
        assert.deepEqual(state[storeName], [], storeName);
      }
    }
  });
});

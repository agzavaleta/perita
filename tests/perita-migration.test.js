'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');

const Contracts = require('../perita-contracts.js');
const IndexedDb = require('../perita-indexeddb.js');
const Runtime = require('../perita-runtime.js');
const Integrity = require('../perita-integrity.js');
const Migration = require('../perita-migration.js');

const NOW = '2026-08-31T12:00:00.000Z';
const TAB_ID = id(900);

function id(number, prefix) {
  return `${prefix || '10000000'}-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function sequence(prefix) {
  let value = 0;
  return () => id(++value, prefix);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function deterministicUuid(name) {
  return Contracts.deterministicUuid(Contracts.PERITA_MIGRATION_NAMESPACE_UUID, name);
}

function state() {
  return {
    settings: { salary: 900000 },
    accounts: [
      { id: 1, name: 'Cuenta principal', type: 'bank', bank: 'Banco', balance: 150000 },
      { id: 2, name: 'Efectivo', type: 'cash', bank: '', balance: -5000 },
    ],
    debts: [{
      id: 3, name: 'Crédito', total: 500000, paid: 125000, monthly: 50000,
      dueDate: '2027-08-15', status: 'activa',
    }],
    wallets: [{
      id: 4, emoji: '🏠', name: 'Pie vivienda', bank: 'Banco', balance: 80000,
      monthly: 20000, goal: 1000000,
    }],
    budget: [{ id: 5, name: 'Arriendo', amount: 350000 }],
    varCategories: [{ id: 6, name: 'Alimentación' }],
    nextId: 100,
    activeMonth: {
      month: '2026-08',
      expenses: [{
        id: 101, date: '2026-08-05', description: 'Compra', amount: 5000,
        type: 'expense', account: 1, category: 6,
      }],
      pagosDeuda: [],
      aportesAhorro: [],
      gastosFijosPagados: [],
    },
    monthlyHistory: [{
      month: '2026-07', salary: 850000, closedAt: '2026-07-31',
      expenses: [], pagosDeuda: [], aportesAhorro: [], gastosFijosPagados: [],
    }],
    expenses: [{
      id: 101, date: '2026-08-05', description: 'Compra', amount: 5000,
      type: 'expense', account: 1, category: 6,
    }],
  };
}

function localSource(rawSource) {
  return {
    value: rawSource,
    reads: [],
    getItem(key) {
      this.reads.push(key);
      return this.value;
    },
  };
}

function makeStorage(factory) {
  return IndexedDb.createPeritaIndexedDb({
    indexedDB: factory,
    IDBKeyRange,
    crypto: crypto.webcrypto,
    now: () => NOW,
  });
}

function failingStorage(base, targetStore) {
  return Object.freeze({
    open: () => base.open(),
    close: () => base.close(),
    get: (...args) => base.get(...args),
    getAll: (...args) => base.getAll(...args),
    put: (...args) => base.put(...args),
    runTransaction: (stores, mode, worker) => base.runTransaction(stores, mode, (transaction) => (
      worker(Object.freeze({
        ...transaction,
        add: (storeName, value) => {
          if (storeName === targetStore) throw new Error(`induced ${storeName}.add`);
          return transaction.add(storeName, value);
        },
        put: (storeName, value) => {
          if (storeName === targetStore) throw new Error(`induced ${storeName}.put`);
          return transaction.put(storeName, value);
        },
      }))
    )),
  });
}

async function fixture(t, options) {
  const settings = options || {};
  const factory = new IDBFactory();
  const baseStorage = makeStorage(factory);
  await baseStorage.open();
  t.after(() => baseStorage.close());
  const bootstrapRuntime = Runtime.createPeritaRuntime({
    storage: baseStorage,
    now: () => NOW,
    tabId: TAB_ID,
    createUuid: sequence('81000000'),
  });
  await bootstrapRuntime.acquireWriter({ expectedEpoch: 0, leaseDurationMs: 60000 });
  await bootstrapRuntime.setWriteEnabled({ enabled: true, reason: 'confirmed migration test' });

  let storage = baseStorage;
  let runtime = bootstrapRuntime;
  if (settings.failStore) {
    storage = failingStorage(baseStorage, settings.failStore);
    runtime = Runtime.createPeritaRuntime({
      storage,
      now: () => NOW,
      tabId: TAB_ID,
      createUuid: sequence('82000000'),
    });
    await runtime.acquireWriter({ expectedEpoch: 1, leaseDurationMs: 60000 });
  }
  const rawSource = settings.rawSource === undefined ? JSON.stringify(state()) : settings.rawSource;
  const legacyStorage = localSource(rawSource);
  const migration = Migration.createPeritaMigration({
    storage,
    runtime,
    legacyStorage,
    now: () => NOW,
    createUuid: sequence('83000000'),
    createDeterministicUuid: deterministicUuid,
    sha256,
  });
  return { factory, baseStorage, storage, runtime, migration, legacyStorage, rawSource };
}

async function request(f) {
  const runtime = await f.baseStorage.get('system', 'runtime');
  return {
    expectedDataRevision: runtime.dataRevision,
    expectedWriterEpoch: 1,
    expectedSourceHash: sha256(f.rawSource),
  };
}

async function allState(storage) {
  return Object.fromEntries(await Promise.all(
    IndexedDb.STORE_NAMES.map(async (storeName) => [storeName, await storage.getAll(storeName)])
  ));
}

async function integrityData(storage) {
  const stores = [
    'system', 'periods', 'periodOpenings', 'accounts', 'savingsGoals', 'debts', 'categories',
    'fixedExpenseTemplates', 'fixedExpenseInstances', 'operations', 'movements',
    'operationRevisions', 'periodSnapshots', 'legacyEntries', 'migrations',
    'legacyIdMap', 'pendingIntents', 'commits',
  ];
  return Object.fromEntries(await Promise.all(
    stores.map(async (storeName) => [storeName, await storage.getAll(storeName)])
  ));
}

function issueCodes(report) {
  return report.issues.map((issue) => issue.code);
}

test('V1.1.0 confirmed migration source and dry-run', async (t) => {
  await t.test('distinguishes missing, empty, invalid, and exact valid sources', async (t2) => {
    const missing = await fixture(t2, { rawSource: null });
    await assert.rejects(
      missing.migration.createDryRun(),
      (error) => error.code === Contracts.ERROR_CODES.LEGACY_SOURCE_MISSING
    );
    const empty = await fixture(t2, { rawSource: '' });
    await assert.rejects(
      empty.migration.createDryRun(),
      (error) => error.code === Contracts.ERROR_CODES.LEGACY_JSON_INVALID
    );
    const invalid = await fixture(t2, { rawSource: '{broken' });
    await assert.rejects(
      invalid.migration.createDryRun(),
      (error) => error.code === Contracts.ERROR_CODES.LEGACY_JSON_INVALID &&
        error.context.sourceHash === sha256('{broken')
    );
    const valid = await fixture(t2);
    const result = await valid.migration.createDryRun();
    assert.equal(result.sourceHash, sha256(valid.rawSource));
    assert.deepEqual(valid.legacyStorage.reads, ['perita_v1']);
  });

  await t.test('blocks ambiguous data and source changes without writing', async (t2) => {
    const blockedState = state();
    blockedState.expenses = [{ ...blockedState.expenses[0], amount: 9999 }];
    const blocked = await fixture(t2, { rawSource: JSON.stringify(blockedState) });
    const before = await allState(blocked.baseStorage);
    await assert.rejects(
      blocked.migration.confirmMigration(await request(blocked)),
      (error) => error.code === Contracts.ERROR_CODES.MIGRATION_BLOCKED
    );
    assert.deepEqual(await allState(blocked.baseStorage), before);

    const changed = await fixture(t2);
    const originalRequest = await request(changed);
    changed.legacyStorage.value = `${changed.rawSource} `;
    await assert.rejects(
      changed.migration.confirmMigration(originalRequest),
      (error) => error.code === Contracts.ERROR_CODES.MIGRATION_SOURCE_MISMATCH
    );
  });
});

test('V1.1.0 confirmed migration baseline and cutover', async (t) => {
  await t.test('commits authoritative balances, openings, map, and hybrid legacy atomically', async (t2) => {
    const f = await fixture(t2);
    const result = await f.migration.confirmMigration(await request(f));
    const accounts = await f.baseStorage.getAll('accounts');
    const goals = await f.baseStorage.getAll('savingsGoals');
    const debts = await f.baseStorage.getAll('debts');
    const openings = await f.baseStorage.getAll('periodOpenings');
    const migration = (await f.baseStorage.getAll('migrations'))[0];
    const commits = await f.baseStorage.getAll('commits');
    const baselineCommit = commits.find((record) => record.commitId === migration.baselineCommitId);
    const runtime = await f.baseStorage.get('system', 'runtime');
    const writer = await f.baseStorage.get('coordination', 'writer');

    assert.deepEqual(accounts.map((record) => record.currentBalance).sort((a, b) => a - b), [-5000, 150000]);
    assert.deepEqual(accounts.map((record) => record.openingBalance).sort((a, b) => a - b), [-5000, 150000]);
    assert.equal(goals[0].openingBalance, 80000);
    assert.equal(goals[0].currentBalance, 80000);
    assert.equal(debts[0].openingOutstanding, 375000);
    assert.equal(debts[0].outstandingAmount, 375000);
    assert.equal(openings.length, 4);
    assert.deepEqual(await f.baseStorage.getAll('operations'), []);
    assert.deepEqual(await f.baseStorage.getAll('movements'), []);
    assert.equal(migration.sourceHash, sha256(f.rawSource));
    assert.equal(migration.cutoverAt, NOW);
    assert.equal(migration.cutoverPeriodId, runtime.activePeriodId);
    assert.equal(migration.baselineCommitId, result.commit.commitId);
    assert.equal(migration.baselineCommitId, baselineCommit.commitId);
    assert.deepEqual(baselineCommit, result.commit);
    assert.deepEqual(baselineCommit.affectedStores, Migration.AFFECTED_STORES);
    assert.deepEqual(baselineCommit.metadata, {
      sourceKey: 'perita_v1',
      sourceHash: sha256(f.rawSource),
      mapperVersion: '1.1.0-dry-run.1',
      classification: 'migratable',
    });
    assert.equal(migration.targetDataRevision, result.commit.dataRevision);
    assert.equal(result.commit.dataRevision, result.commit.previousDataRevision + 1);
    assert.equal(result.commit.commandType, 'migration.confirm');
    assert.equal(commits.length, 2);
    assert.equal(runtime.setupStatus, 'completed');
    assert.equal(runtime.writeEnabled, false);
    assert.equal(writer.status, 'unowned');
    assert.equal(result.requiresIntegrityCheckBeforeWriteEnablement, true);
    assert.deepEqual(await f.baseStorage.getAll('integrityReports'), []);
  });

  await t.test('preserves active and historical legacy as read-only entries without effects', async (t2) => {
    const f = await fixture(t2);
    await f.migration.confirmMigration(await request(f));
    const entries = await f.baseStorage.getAll('legacyEntries');
    const migration = (await f.baseStorage.getAll('migrations'))[0];
    assert.ok(entries.some((entry) => entry.legacyPath === 'activeMonth.expenses[0]'));
    assert.ok(entries.some((entry) => entry.legacyPath === 'monthlyHistory[0]'));
    assert.ok(entries.every((entry) => entry.migrationId === migration.id));
    assert.deepEqual(await f.baseStorage.getAll('movements'), []);
    assert.equal(f.legacyStorage.value, f.rawSource);
  });

  await t.test('persists exactly the deterministic dry-run legacyIdMap', async (t2) => {
    const f = await fixture(t2);
    const dryRun = await f.migration.createDryRun();
    await f.migration.confirmMigration(await request(f));
    const byId = (left, right) => left.id.localeCompare(right.id);
    assert.deepEqual(
      (await f.baseStorage.getAll('legacyIdMap')).slice().sort(byId),
      dryRun.proposedLegacyIdMap.slice().sort(byId)
    );
  });

  await t.test('accepts restricted legacy while preserving its diagnostics', async (t2) => {
    const restrictedState = state();
    restrictedState.activeMonth.expenses[0].account = undefined;
    restrictedState.expenses = structuredClone(restrictedState.activeMonth.expenses);
    const f = await fixture(t2, { rawSource: JSON.stringify(restrictedState) });
    const result = await f.migration.confirmMigration(await request(f));
    const migration = (await f.baseStorage.getAll('migrations'))[0];
    assert.equal(result.classification, 'restricted');
    assert.ok(migration.warnings.length > 0);
    const report = Integrity.inspectDataSnapshot(await integrityData(f.baseStorage), {
      checkedAt: NOW,
      sha256,
    });
    assert.equal(report.status, 'warning');
    assert.deepEqual(await f.baseStorage.getAll('integrityReports'), []);
  });
});

test('V1.1.0 migration idempotence and atomicity', async (t) => {
  await t.test('same source and a different source are diagnosed without duplication', async (t2) => {
    const f = await fixture(t2);
    const firstRequest = await request(f);
    await f.migration.confirmMigration(firstRequest);
    const before = await allState(f.baseStorage);
    await assert.rejects(
      f.migration.confirmMigration(firstRequest),
      (error) => error.code === Contracts.ERROR_CODES.MIGRATION_ALREADY_APPLIED
    );
    const changedState = state();
    changedState.settings.salary += 1;
    f.legacyStorage.value = JSON.stringify(changedState);
    await assert.rejects(
      f.migration.confirmMigration({
        ...firstRequest,
        expectedSourceHash: sha256(f.legacyStorage.value),
      }),
      (error) => error.code === Contracts.ERROR_CODES.MIGRATION_SOURCE_MISMATCH
    );
    assert.deepEqual(await allState(f.baseStorage), before);
  });

  await t.test('a failed atomic attempt can be retried explicitly without duplication', async (t2) => {
    const failed = await fixture(t2, { failStore: 'accounts' });
    await assert.rejects(failed.migration.confirmMigration(await request(failed)));
    assert.deepEqual(await failed.baseStorage.getAll('migrations'), []);

    const cleanRuntime = Runtime.createPeritaRuntime({
      storage: failed.baseStorage,
      now: () => NOW,
      tabId: TAB_ID,
      createUuid: sequence('84000000'),
    });
    await cleanRuntime.acquireWriter({ expectedEpoch: 1, leaseDurationMs: 60000 });
    const retry = Migration.createPeritaMigration({
      storage: failed.baseStorage,
      runtime: cleanRuntime,
      legacyStorage: failed.legacyStorage,
      now: () => NOW,
      createUuid: sequence('85000000'),
      createDeterministicUuid: deterministicUuid,
      sha256,
    });
    const result = await retry.confirmMigration(await request(failed));
    assert.equal(result.commit.commandType, 'migration.confirm');
    assert.equal((await failed.baseStorage.getAll('migrations')).length, 1);
    assert.equal((await failed.baseStorage.getAll('accounts')).length, 2);
  });

  await t.test('delegates stale revision, epoch, and writeEnabled gates to runtime', async (t2) => {
    const staleRevision = await fixture(t2);
    const valid = await request(staleRevision);
    await assert.rejects(
      staleRevision.migration.confirmMigration({ ...valid, expectedDataRevision: valid.expectedDataRevision - 1 }),
      (error) => error.code === Contracts.ERROR_CODES.STALE_REVISION
    );
    await assert.rejects(
      staleRevision.migration.confirmMigration({ ...valid, expectedWriterEpoch: 2 }),
      (error) => error.code === Contracts.ERROR_CODES.WRITER_EPOCH_LOST
    );
    await staleRevision.runtime.setWriteEnabled({ enabled: false, reason: 'migration gate test' });
    await assert.rejects(
      staleRevision.migration.confirmMigration({
        ...valid,
        expectedDataRevision: valid.expectedDataRevision + 1,
      }),
      (error) => error.code === Contracts.ERROR_CODES.WRITE_DISABLED
    );
    assert.deepEqual(await staleRevision.baseStorage.getAll('migrations'), []);
  });

  for (const storeName of [...Migration.WRITTEN_STORES, 'commits', 'system']) {
    await t.test(`rolls back completely when ${storeName} fails`, async (t2) => {
      const f = await fixture(t2, { failStore: storeName });
      const before = await allState(f.baseStorage);
      await assert.rejects(f.migration.confirmMigration(await request(f)));
      assert.deepEqual(await allState(f.baseStorage), before);
    });
  }
});

test('V1.1.0 migration integrity diagnostics', async (t) => {
  await t.test('detects baseline, source, cutover, opening, map, and pre-cutover corruption', async (t2) => {
    const f = await fixture(t2);
    await f.migration.confirmMigration(await request(f));
    const original = await integrityData(f.baseStorage);
    const cases = [
      ['MIGRATION_BASELINE_COMMIT_INVALID', (copy) => {
        copy.migrations[0].baselineCommitId = id(991, '99000000');
      }],
      ['LEGACY_ID_MAP_INVALID', (copy) => {
        copy.legacyIdMap[0].sourceHash = '0'.repeat(64);
      }],
      ['MIGRATION_CUTOVER_PERIOD_INVALID', (copy) => {
        copy.migrations[0].cutoverPeriodId = id(992, '99000000');
      }],
      ['MIGRATION_OPENING_INVALID', (copy) => {
        copy.periodOpenings[0].openingAmount += 1;
      }],
      ['LEGACY_ID_MAP_DUPLICATE', (copy) => {
        copy.legacyIdMap.push({ ...copy.legacyIdMap[0], id: id(993, '99000000') });
      }],
      ['MIGRATION_PRE_CUTOVER_MOVEMENT', (copy) => {
        const account = copy.accounts[0];
        copy.movements.push({
          id: id(994, '99000000'),
          operationId: id(995, '99000000'),
          periodId: copy.migrations[0].cutoverPeriodId,
          targetType: 'account',
          targetId: account.id,
          effectType: 'asset_balance',
          delta: 1,
          status: 'posted',
          createdAt: '2026-08-31T11:59:59.999Z',
          updatedAt: '2026-08-31T11:59:59.999Z',
        });
      }],
    ];
    for (const [code, mutate] of cases) {
      const copy = structuredClone(original);
      mutate(copy);
      const report = Integrity.inspectDataSnapshot(copy, { checkedAt: NOW, sha256 });
      assert.ok(issueCodes(report).includes(code), `${code}: ${JSON.stringify(report.issues)}`);
    }
  });
});

test('migration module is isolated from UI and the V1 core', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'perita-migration.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /Perita\.jsx|perita-core|innerHTML|document\./);
  assert.doesNotMatch(source, /\.removeItem\(|\.setItem\(/);
});

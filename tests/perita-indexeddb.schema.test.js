'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const Contracts = require('../perita-contracts.js');
const IndexedDb = require('../perita-indexeddb.js');

const FIXED_NOW = '2026-08-04T12:34:56.000Z';
const DATABASE_GENERATION = '123e4567-e89b-42d3-a456-426614174000';
const TEST_CRYPTO = Object.freeze({ randomUUID: () => DATABASE_GENERATION });

const EXPECTED_STORES = Object.freeze({
  system: { keyPath: 'key', indexes: [] },
  preferences: { keyPath: 'key', indexes: [] },
  financialSettings: { keyPath: 'key', indexes: [] },
  periods: {
    keyPath: 'id',
    indexes: [
      ['byPeriodKey', 'periodKey', true],
      ['byStatus', 'status', false],
    ],
  },
  periodOpenings: {
    keyPath: 'id',
    indexes: [['byPeriodTarget', ['periodId', 'targetType', 'targetId'], true]],
  },
  accounts: { keyPath: 'id', indexes: [['byStatus', 'status', false]] },
  savingsGoals: {
    keyPath: 'id',
    indexes: [['byLifecycleStatus', 'lifecycleStatus', false]],
  },
  debts: { keyPath: 'id', indexes: [['byPaymentStatus', 'paymentStatus', false]] },
  categories: { keyPath: 'id', indexes: [] },
  fixedExpenseTemplates: { keyPath: 'id', indexes: [] },
  fixedExpenseInstances: {
    keyPath: 'id',
    indexes: [['byPeriodTemplate', ['periodId', 'templateId'], true]],
  },
  operations: {
    keyPath: 'id',
    indexes: [
      ['byPeriodDate', ['periodId', 'operationDate'], false],
      ['byPeriodType', ['periodId', 'type'], false],
      ['byStatus', 'status', false],
    ],
  },
  movements: {
    keyPath: 'id',
    indexes: [
      ['byOperation', 'operationId', false],
      ['byTarget', ['targetType', 'targetId'], false],
    ],
  },
  operationRevisions: { keyPath: 'id', indexes: [] },
  auditEvents: { keyPath: 'id', indexes: [] },
  periodSnapshots: { keyPath: 'id', indexes: [['byPeriod', 'periodId', true]] },
  legacyEntries: {
    keyPath: 'id',
    indexes: [['byPeriodPath', ['periodId', 'legacyPath'], true]],
  },
  drafts: { keyPath: 'id', indexes: [] },
  pendingIntents: { keyPath: 'id', indexes: [] },
  commits: { keyPath: 'sequence', indexes: [['byCommitId', 'commitId', true]] },
  integrityReports: { keyPath: 'id', indexes: [] },
  migrations: {
    keyPath: 'id',
    indexes: [['bySource', ['sourceKey', 'sourceHash', 'mapperVersion'], true]],
  },
  legacyIdMap: {
    keyPath: 'id',
    indexes: [['byLegacySourcePath', ['sourceHash', 'entityKind', 'legacyPath'], true]],
  },
  coordination: { keyPath: 'key', indexes: [] },
});

const EXPECTED_SCHEMA = Object.freeze({
  key: 'schema',
  schemaVersion: '1.1.0',
  indexedDbVersion: 1,
  appVersion: '1.1.0',
  databaseName: 'perita_v110',
  databaseGeneration: DATABASE_GENERATION,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
});

const EXPECTED_RUNTIME = Object.freeze({
  key: 'runtime',
  setupStatus: 'not_started',
  activePeriodId: null,
  dataRevision: 0,
  lastCommitId: null,
  commitSequence: 0,
  healthStatus: 'ok',
  restrictedScopes: [],
  writeEnabled: false,
});

function makeStorage(factory, overrides) {
  return IndexedDb.createPeritaIndexedDb({
    indexedDB: factory,
    IDBKeyRange,
    now: () => FIXED_NOW,
    crypto: TEST_CRYPTO,
    ...(overrides || {}),
  });
}

function captureRejection(promise) {
  return promise.then(
    () => assert.fail('expected promise to reject'),
    (error) => error
  );
}

function openRaw(factory, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = version === undefined
      ? factory.open(IndexedDb.DATABASE_NAME)
      : factory.open(IndexedDb.DATABASE_NAME, version);
    request.onupgradeneeded = () => {
      if (upgrade) upgrade(request.result, request.transaction);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('raw IndexedDB request blocked'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
    transaction.onerror = () => {};
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function canonicalKeyPath(keyPath) {
  return Array.isArray(keyPath) ? keyPath.slice() : keyPath;
}

function addSystemRecords(store) {
  store.add({ ...EXPECTED_SCHEMA });
  store.add({ ...EXPECTED_RUNTIME, restrictedScopes: [] });
}

function createRawSchema(factory, mutation) {
  const change = mutation || {};
  return openRaw(factory, 1, (database, transaction) => {
    for (const [storeName, definition] of Object.entries(EXPECTED_STORES)) {
      if (change.missingStore === storeName) continue;
      const keyPath = change.keyPathStore === storeName ? 'wrongKey' : definition.keyPath;
      const autoIncrement = change.autoIncrementStore === storeName;
      const store = database.createObjectStore(storeName, { keyPath, autoIncrement });
      for (const [indexName, expectedKeyPath, expectedUnique] of definition.indexes) {
        if (change.missingIndex === `${storeName}.${indexName}`) continue;
        const indexKeyPath = change.indexKeyPath === `${storeName}.${indexName}`
          ? 'wrongIndexKey'
          : expectedKeyPath;
        const unique = change.indexUnique === `${storeName}.${indexName}`
          ? !expectedUnique
          : expectedUnique;
        store.createIndex(indexName, indexKeyPath, { unique });
      }
      if (change.extraIndexStore === storeName) {
        store.createIndex('unexpectedIndex', 'unexpectedValue');
      }
    }
    if (change.extraStore) {
      database.createObjectStore(change.extraStore, { keyPath: 'id', autoIncrement: false });
    }
    if (database.objectStoreNames.contains('system')) {
      addSystemRecords(transaction.objectStore('system'));
    }
  });
}

async function mutateSystemRecord(factory, key, action) {
  const database = await openRaw(factory);
  const transaction = database.transaction(['system'], 'readwrite');
  const done = transactionDone(transaction);
  const store = transaction.objectStore('system');
  if (action === 'delete') {
    store.delete(key);
  } else {
    const current = await requestResult(store.get(key));
    store.put(action(current));
  }
  await done;
  database.close();
}

test('IndexedDB V1.1.0 schema and opening', async (t) => {
  await t.test('exports exact immutable database constants', () => {
    assert.equal(IndexedDb.DATABASE_NAME, 'perita_v110');
    assert.equal(IndexedDb.DATABASE_VERSION, 1);
    assert.equal(IndexedDb.SCHEMA_VERSION, '1.1.0');
    assert.equal(Object.isFrozen(IndexedDb.STORE_NAMES), true);
    assert.equal(Object.isFrozen(IndexedDb.INDEX_NAMES), true);
  });

  await t.test('missing IndexedDB fails with a typed STORAGE_OPEN_FAILED error', async () => {
    const storage = makeStorage(undefined, { indexedDB: undefined });
    const error = await captureRejection(storage.open());
    assert.ok(error instanceof Contracts.StorageError);
    assert.ok(error instanceof Contracts.PeritaError);
    assert.ok(error instanceof Error);
    assert.equal(error.code, Contracts.ERROR_CODES.STORAGE_OPEN_FAILED);
    assert.equal(error.context.databaseName, 'perita_v110');
    assert.ok(error.cause instanceof Error);
    assert.match(error.stack, /StorageError/);
  });

  await t.test('initial open creates database version 1 with exactly 24 authorized stores', async () => {
    const factory = new IDBFactory();
    const storage = makeStorage(factory);
    await storage.open();
    const database = await openRaw(factory);
    assert.equal(database.name, 'perita_v110');
    assert.equal(database.version, 1);
    assert.deepEqual(
      Array.from(database.objectStoreNames).sort(),
      Object.keys(EXPECTED_STORES).sort()
    );
    assert.equal(database.objectStoreNames.length, 24);
    assert.equal(database.objectStoreNames.contains('recoverySnapshots'), false);
    database.close();
    storage.close();
  });

  await t.test('every store has the exact key path and autoIncrement false', async () => {
    const factory = new IDBFactory();
    const storage = makeStorage(factory);
    await storage.open();
    const database = await openRaw(factory);
    const transaction = database.transaction(IndexedDb.STORE_NAMES, 'readonly');
    for (const [storeName, definition] of Object.entries(EXPECTED_STORES)) {
      const store = transaction.objectStore(storeName);
      assert.deepEqual(canonicalKeyPath(store.keyPath), definition.keyPath, storeName);
      assert.equal(store.autoIncrement, false, storeName);
    }
    database.close();
    storage.close();
  });

  await t.test('there are exactly 17 indexes with exact names, key paths, and uniqueness', async () => {
    const factory = new IDBFactory();
    const storage = makeStorage(factory);
    await storage.open();
    const database = await openRaw(factory);
    const transaction = database.transaction(IndexedDb.STORE_NAMES, 'readonly');
    let indexCount = 0;
    for (const [storeName, definition] of Object.entries(EXPECTED_STORES)) {
      const store = transaction.objectStore(storeName);
      assert.deepEqual(
        Array.from(store.indexNames).sort(),
        definition.indexes.map(([name]) => name).sort(),
        storeName
      );
      assert.deepEqual(IndexedDb.INDEX_NAMES[storeName], definition.indexes.map(([name]) => name));
      for (const [indexName, keyPath, unique] of definition.indexes) {
        const index = store.index(indexName);
        assert.deepEqual(canonicalKeyPath(index.keyPath), keyPath, `${storeName}.${indexName}`);
        assert.equal(index.unique, unique, `${storeName}.${indexName}`);
        indexCount += 1;
      }
    }
    assert.equal(indexCount, 17);
    database.close();
    storage.close();
  });

  await t.test('system/schema and system/runtime contain exact technical initialization', async () => {
    const factory = new IDBFactory();
    const storage = makeStorage(factory);
    await storage.open();
    assert.deepEqual(await storage.get('system', 'schema'), EXPECTED_SCHEMA);
    assert.deepEqual(await storage.get('system', 'runtime'), EXPECTED_RUNTIME);
    assert.equal(
      Contracts.assertUuid((await storage.get('system', 'schema')).databaseGeneration, { version: 4 }),
      DATABASE_GENERATION
    );
    storage.close();
  });

  await t.test('schema creation and both system records are atomic on induced failure', async () => {
    const factory = new IDBFactory();
    const storage = makeStorage(factory, {
      now: () => { throw new Error('induced initialization failure'); },
    });
    const error = await captureRejection(storage.open());
    assert.equal(error.code, Contracts.ERROR_CODES.STORAGE_OPEN_FAILED);
    assert.match(error.cause.message, /induced initialization failure/);
    assert.deepEqual(await factory.databases(), []);
  });

  await t.test('reopening is idempotent and does not overwrite technical records', async () => {
    const factory = new IDBFactory();
    const first = makeStorage(factory);
    await first.open();
    const schemaBefore = await first.get('system', 'schema');
    const runtimeBefore = await first.get('system', 'runtime');
    first.close();

    const second = makeStorage(factory, {
      now: () => '2030-01-01T00:00:00.000Z',
      crypto: { randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    });
    await second.open();
    assert.deepEqual(await second.get('system', 'schema'), schemaBefore);
    assert.deepEqual(await second.get('system', 'runtime'), runtimeBefore);
    second.close();
  });

  await t.test('close allows the same instance to reopen', async () => {
    const factory = new IDBFactory();
    const storage = makeStorage(factory);
    await storage.open();
    storage.close();
    await storage.open();
    assert.deepEqual(await storage.get('system', 'runtime'), EXPECTED_RUNTIME);
    storage.close();
  });

  await t.test('test deletion removes the database and permits clean recreation', async () => {
    const factory = new IDBFactory();
    const storage = makeStorage(factory);
    await storage.open();
    storage.close();
    await IndexedDb.deletePeritaDatabaseForTests({ indexedDB: factory });
    assert.deepEqual(await factory.databases(), []);
    await storage.open();
    assert.deepEqual(await storage.get('system', 'schema'), EXPECTED_SCHEMA);
    storage.close();
  });

  await t.test('a newer physical version fails with SCHEMA_UNSUPPORTED', async () => {
    const factory = new IDBFactory();
    const newer = await openRaw(factory, 2, (database) => {
      database.createObjectStore('future', { keyPath: 'id' });
    });
    newer.close();
    const error = await captureRejection(makeStorage(factory).open());
    assert.equal(error.code, Contracts.ERROR_CODES.SCHEMA_UNSUPPORTED);
    assert.equal(error.cause.name, 'VersionError');
  });

  await t.test('all physical version-1 incompatibilities are rejected without repair or deletion', async (t2) => {
    const scenarios = [
      {
        name: 'missing store',
        mutation: { missingStore: 'categories' },
        verify: (database) => !database.objectStoreNames.contains('categories'),
      },
      {
        name: 'extra store',
        mutation: { extraStore: 'recoverySnapshots' },
        verify: (database) => database.objectStoreNames.contains('recoverySnapshots'),
      },
      {
        name: 'wrong store key path',
        mutation: { keyPathStore: 'accounts' },
        verify: (database) => database.transaction('accounts').objectStore('accounts').keyPath === 'wrongKey',
      },
      {
        name: 'wrong autoIncrement',
        mutation: { autoIncrementStore: 'accounts' },
        verify: (database) => database.transaction('accounts').objectStore('accounts').autoIncrement === true,
      },
      {
        name: 'missing index',
        mutation: { missingIndex: 'accounts.byStatus' },
        verify: (database) => !database.transaction('accounts').objectStore('accounts').indexNames.contains('byStatus'),
      },
      {
        name: 'extra index',
        mutation: { extraIndexStore: 'accounts' },
        verify: (database) => database.transaction('accounts').objectStore('accounts').indexNames.contains('unexpectedIndex'),
      },
      {
        name: 'wrong index key path',
        mutation: { indexKeyPath: 'accounts.byStatus' },
        verify: (database) => database.transaction('accounts').objectStore('accounts').index('byStatus').keyPath === 'wrongIndexKey',
      },
      {
        name: 'wrong index uniqueness',
        mutation: { indexUnique: 'accounts.byStatus' },
        verify: (database) => database.transaction('accounts').objectStore('accounts').index('byStatus').unique === true,
      },
    ];

    for (const scenario of scenarios) {
      await t2.test(scenario.name, async () => {
        const factory = new IDBFactory();
        const malformed = await createRawSchema(factory, scenario.mutation);
        malformed.close();
        const error = await captureRejection(makeStorage(factory).open());
        assert.equal(error.code, Contracts.ERROR_CODES.SCHEMA_UNSUPPORTED);
        const unchanged = await openRaw(factory);
        assert.equal(scenario.verify(unchanged), true);
        unchanged.close();
      });
    }
  });

  await t.test('incompatible schemaVersion is rejected without overwrite', async () => {
    const factory = new IDBFactory();
    const initial = makeStorage(factory);
    await initial.open();
    initial.close();
    await mutateSystemRecord(factory, 'schema', (schema) => ({
      ...schema,
      schemaVersion: '9.9.9',
    }));
    const error = await captureRejection(makeStorage(factory).open());
    assert.equal(error.code, Contracts.ERROR_CODES.SCHEMA_UNSUPPORTED);
    const database = await openRaw(factory);
    const saved = await requestResult(database.transaction('system').objectStore('system').get('schema'));
    assert.equal(saved.schemaVersion, '9.9.9');
    database.close();
  });

  await t.test('missing schema or runtime is rejected without default completion', async (t2) => {
    for (const missingKey of ['schema', 'runtime']) {
      await t2.test(`missing system/${missingKey}`, async () => {
        const factory = new IDBFactory();
        const initial = makeStorage(factory);
        await initial.open();
        initial.close();
        await mutateSystemRecord(factory, missingKey, 'delete');
        const error = await captureRejection(makeStorage(factory).open());
        assert.equal(error.code, Contracts.ERROR_CODES.SCHEMA_UNSUPPORTED);
        const database = await openRaw(factory);
        const missing = await requestResult(
          database.transaction('system').objectStore('system').get(missingKey)
        );
        assert.equal(missing, undefined);
        database.close();
      });
    }
  });

  await t.test('simultaneous open calls on one instance share the same promise', async () => {
    const storage = makeStorage(new IDBFactory());
    const first = storage.open();
    const second = storage.open();
    assert.equal(first, second);
    await Promise.all([first, second]);
    storage.close();
  });

  await t.test('blocked opening rejects with a typed error instead of remaining pending', async () => {
    const blockedFactory = {
      open() {
        const request = {};
        queueMicrotask(() => request.onblocked());
        return request;
      },
    };
    const error = await captureRejection(makeStorage(blockedFactory).open());
    assert.equal(error.code, Contracts.ERROR_CODES.STORAGE_OPEN_FAILED);
    assert.equal(error.context.blocked, true);
    assert.ok(error.cause instanceof Error);
  });

  await t.test('blocked test deletion rejects with a typed error instead of remaining pending', async () => {
    const factory = new IDBFactory();
    const database = await openRaw(factory, 1, (created) => {
      created.createObjectStore('held', { keyPath: 'id' });
    });
    const error = await captureRejection(
      IndexedDb.deletePeritaDatabaseForTests({ indexedDB: factory })
    );
    assert.equal(error.code, Contracts.ERROR_CODES.STORAGE_WRITE_FAILED);
    assert.equal(error.context.blocked, true);
    database.close();
  });
});

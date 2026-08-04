'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  IDBFactory,
  IDBKeyRange,
  IDBObjectStore,
} = require('fake-indexeddb');
const Contracts = require('../perita-contracts.js');
const IndexedDb = require('../perita-indexeddb.js');

const FIXED_NOW = '2026-08-04T12:34:56.000Z';
const TEST_CRYPTO = Object.freeze({
  randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
});

function makeStorage(factory) {
  return IndexedDb.createPeritaIndexedDb({
    indexedDB: factory,
    IDBKeyRange,
    now: () => FIXED_NOW,
    crypto: TEST_CRYPTO,
  });
}

async function fixture(t) {
  const factory = new IDBFactory();
  const storage = makeStorage(factory);
  await storage.open();
  t.after(() => storage.close());
  return { factory, storage };
}

function captureRejection(promise) {
  return promise.then(
    () => assert.fail('expected promise to reject'),
    (error) => error
  );
}

function assertStorageError(error, code) {
  assert.ok(error instanceof Contracts.StorageError);
  assert.ok(error instanceof Contracts.PeritaError);
  assert.ok(error instanceof Error);
  assert.equal(error.code, code);
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0);
  assert.equal(typeof error.context, 'object');
  assert.ok(error.cause);
  assert.match(error.stack, /StorageError/);
}

function openRaw(factory, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = factory.open(IndexedDb.DATABASE_NAME, version);
    request.onupgradeneeded = () => {
      if (upgrade) upgrade(request.result, request.transaction);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

test('IndexedDB V1.1.0 CRUD and structured clone', async (t) => {
  await t.test('add followed by get preserves a record', async (t2) => {
    const { storage } = await fixture(t2);
    const account = { id: 'account-1', name: 'Principal', status: 'active' };
    assert.equal(await storage.add('accounts', account), account.id);
    assert.deepEqual(await storage.get('accounts', account.id), account);
  });

  await t.test('get of a nonexistent key returns undefined', async (t2) => {
    const { storage } = await fixture(t2);
    assert.equal(await storage.get('accounts', 'missing'), undefined);
  });

  await t.test('put replaces an existing key', async (t2) => {
    const { storage } = await fixture(t2);
    await storage.add('accounts', { id: 'account-1', name: 'Before', status: 'active' });
    await storage.put('accounts', { id: 'account-1', name: 'After', status: 'inactive' });
    assert.deepEqual(await storage.get('accounts', 'account-1'), {
      id: 'account-1',
      name: 'After',
      status: 'inactive',
    });
  });

  await t.test('getAll returns all committed records', async (t2) => {
    const { storage } = await fixture(t2);
    await storage.add('categories', { id: 'category-1', name: 'A' });
    await storage.add('categories', { id: 'category-2', name: 'B' });
    assert.deepEqual(await storage.getAll('categories'), [
      { id: 'category-1', name: 'A' },
      { id: 'category-2', name: 'B' },
    ]);
  });

  await t.test('remove deletes only the selected key', async (t2) => {
    const { storage } = await fixture(t2);
    await storage.add('categories', { id: 'category-1', name: 'A' });
    await storage.add('categories', { id: 'category-2', name: 'B' });
    await storage.remove('categories', 'category-1');
    assert.equal(await storage.get('categories', 'category-1'), undefined);
    assert.deepEqual(await storage.get('categories', 'category-2'), {
      id: 'category-2',
      name: 'B',
    });
  });

  await t.test('duplicate primary key fails without overwriting the original', async (t2) => {
    const { storage } = await fixture(t2);
    await storage.add('accounts', { id: 'account-1', name: 'Original', status: 'active' });
    const error = await captureRejection(
      storage.add('accounts', { id: 'account-1', name: 'Duplicate', status: 'inactive' })
    );
    assertStorageError(error, Contracts.ERROR_CODES.STORAGE_WRITE_FAILED);
    assert.deepEqual(await storage.get('accounts', 'account-1'), {
      id: 'account-1',
      name: 'Original',
      status: 'active',
    });
  });

  await t.test('stored and retrieved values are isolated by structured clone', async (t2) => {
    const { storage } = await fixture(t2);
    const original = {
      id: 'draft-1',
      form: { name: 'Initial', values: [1, 2] },
    };
    await storage.add('drafts', original);
    original.form.name = 'Mutated outside';
    original.form.values.push(3);

    const firstRead = await storage.get('drafts', 'draft-1');
    assert.deepEqual(firstRead, {
      id: 'draft-1',
      form: { name: 'Initial', values: [1, 2] },
    });
    firstRead.form.name = 'Mutated read';
    firstRead.form.values.push(99);
    assert.deepEqual(await storage.get('drafts', 'draft-1'), {
      id: 'draft-1',
      form: { name: 'Initial', values: [1, 2] },
    });
  });
});

test('IndexedDB V1.1.0 index queries and uniqueness', async (t) => {
  await t.test('queries a simple index', async (t2) => {
    const { storage } = await fixture(t2);
    await storage.add('accounts', { id: 'a1', status: 'active' });
    await storage.add('accounts', { id: 'a2', status: 'inactive' });
    await storage.add('accounts', { id: 'a3', status: 'active' });
    assert.deepEqual(
      (await storage.queryIndex('accounts', 'byStatus', { query: 'active' })).map((item) => item.id),
      ['a1', 'a3']
    );
  });

  await t.test('queries a compound index in ascending and descending order with a limit', async (t2) => {
    const { storage } = await fixture(t2);
    for (const [id, date] of [['o3', '2026-08-03'], ['o1', '2026-08-01'], ['o2', '2026-08-02']]) {
      await storage.add('operations', {
        id,
        periodId: 'period-1',
        operationDate: date,
        type: 'expense',
        status: 'posted',
      });
    }
    await storage.add('operations', {
      id: 'other-period',
      periodId: 'period-2',
      operationDate: '2026-08-01',
      type: 'expense',
      status: 'posted',
    });
    const range = IDBKeyRange.bound(
      ['period-1', '0000-00-00'],
      ['period-1', '9999-99-99']
    );
    assert.deepEqual(
      (await storage.queryIndex('operations', 'byPeriodDate', {
        query: range,
        direction: 'next',
      })).map((item) => item.id),
      ['o1', 'o2', 'o3']
    );
    assert.deepEqual(
      (await storage.queryIndex('operations', 'byPeriodDate', {
        query: range,
        direction: 'prev',
        limit: 2,
      })).map((item) => item.id),
      ['o3', 'o2']
    );
  });

  await t.test('missing index produces a typed read error', async (t2) => {
    const { storage } = await fixture(t2);
    const error = await captureRejection(storage.queryIndex('accounts', 'missingIndex'));
    assertStorageError(error, Contracts.ERROR_CODES.STORAGE_READ_FAILED);
  });

  await t.test('all eight unique indexes reject duplicates without partial writes', async (t2) => {
    const cases = [
      {
        label: 'periods.byPeriodKey',
        store: 'periods',
        first: { id: 'p1', periodKey: '2026-08', status: 'open' },
        duplicate: { id: 'p2', periodKey: '2026-08', status: 'closed' },
      },
      {
        label: 'periodOpenings.byPeriodTarget',
        store: 'periodOpenings',
        first: { id: 'po1', periodId: 'p1', targetType: 'account', targetId: 'a1' },
        duplicate: { id: 'po2', periodId: 'p1', targetType: 'account', targetId: 'a1' },
      },
      {
        label: 'fixedExpenseInstances.byPeriodTemplate',
        store: 'fixedExpenseInstances',
        first: { id: 'fi1', periodId: 'p1', templateId: 'ft1' },
        duplicate: { id: 'fi2', periodId: 'p1', templateId: 'ft1' },
      },
      {
        label: 'periodSnapshots.byPeriod',
        store: 'periodSnapshots',
        first: { id: 'ps1', periodId: 'p1' },
        duplicate: { id: 'ps2', periodId: 'p1' },
      },
      {
        label: 'legacyEntries.byPeriodPath',
        store: 'legacyEntries',
        first: { id: 'le1', periodId: 'p1', legacyPath: 'activeMonth.expenses[0]' },
        duplicate: { id: 'le2', periodId: 'p1', legacyPath: 'activeMonth.expenses[0]' },
      },
      {
        label: 'migrations.bySource',
        store: 'migrations',
        first: { id: 'm1', sourceKey: 'perita_v1', sourceHash: 'hash', mapperVersion: '1' },
        duplicate: { id: 'm2', sourceKey: 'perita_v1', sourceHash: 'hash', mapperVersion: '1' },
      },
      {
        label: 'legacyIdMap.byLegacySourcePath',
        store: 'legacyIdMap',
        first: { id: 'lm1', sourceHash: 'hash', entityKind: 'account', legacyPath: 'accounts[0]' },
        duplicate: { id: 'lm2', sourceHash: 'hash', entityKind: 'account', legacyPath: 'accounts[0]' },
      },
      {
        label: 'commits.byCommitId',
        store: 'commits',
        first: { sequence: 1, commitId: 'commit-1' },
        duplicate: { sequence: 2, commitId: 'commit-1' },
      },
    ];

    for (const entry of cases) {
      await t2.test(entry.label, async (t3) => {
        const { storage } = await fixture(t3);
        await storage.add(entry.store, entry.first);
        const error = await captureRejection(storage.add(entry.store, entry.duplicate));
        assertStorageError(error, Contracts.ERROR_CODES.STORAGE_WRITE_FAILED);
        assert.deepEqual(await storage.getAll(entry.store), [entry.first]);
      });
    }
  });
});

test('IndexedDB V1.1.0 transactions and atomicity', async (t) => {
  await t.test('readwrite transaction commits changes in two stores', async (t2) => {
    const { storage } = await fixture(t2);
    const result = await storage.runTransaction(['accounts', 'debts'], 'readwrite', async (tx) => {
      await tx.add('accounts', { id: 'a1', status: 'active' });
      await tx.add('debts', { id: 'd1', paymentStatus: 'pending' });
      return 'committed';
    });
    assert.equal(result, 'committed');
    assert.deepEqual(await storage.get('accounts', 'a1'), { id: 'a1', status: 'active' });
    assert.deepEqual(await storage.get('debts', 'd1'), { id: 'd1', paymentStatus: 'pending' });
  });

  await t.test('synchronous exception after a request aborts all changes', async (t2) => {
    const { storage } = await fixture(t2);
    const error = await captureRejection(
      storage.runTransaction(['accounts', 'debts'], 'readwrite', async (tx) => {
        await tx.add('accounts', { id: 'a1', status: 'active' });
        throw new Error('induced callback exception');
      })
    );
    assertStorageError(error, Contracts.ERROR_CODES.STORAGE_WRITE_FAILED);
    assert.deepEqual(await storage.getAll('accounts'), []);
    assert.deepEqual(await storage.getAll('debts'), []);
  });

  await t.test('asynchronous callback rejection aborts all changes', async (t2) => {
    const { storage } = await fixture(t2);
    const error = await captureRejection(
      storage.runTransaction(['accounts', 'debts'], 'readwrite', async (tx) => {
        await tx.add('accounts', { id: 'a1', status: 'active' });
        await Promise.reject(new Error('induced async rejection'));
      })
    );
    assertStorageError(error, Contracts.ERROR_CODES.STORAGE_WRITE_FAILED);
    assert.deepEqual(await storage.getAll('accounts'), []);
    assert.deepEqual(await storage.getAll('debts'), []);
  });

  await t.test('failure of the second request rolls back the first', async (t2) => {
    const { storage } = await fixture(t2);
    await storage.add('periods', { id: 'existing', periodKey: '2026-08', status: 'open' });
    const error = await captureRejection(
      storage.runTransaction(['accounts', 'periods'], 'readwrite', async (tx) => {
        await tx.add('accounts', { id: 'a1', status: 'active' });
        await tx.add('periods', { id: 'duplicate', periodKey: '2026-08', status: 'closed' });
      })
    );
    assertStorageError(error, Contracts.ERROR_CODES.STORAGE_WRITE_FAILED);
    assert.deepEqual(await storage.getAll('accounts'), []);
    assert.deepEqual(await storage.getAll('periods'), [
      { id: 'existing', periodKey: '2026-08', status: 'open' },
    ]);
  });

  await t.test('explicit abort leaves no partial effects', async (t2) => {
    const { storage } = await fixture(t2);
    const reason = new Error('user cancelled transaction');
    const error = await captureRejection(
      storage.runTransaction(['accounts', 'debts'], 'readwrite', async (tx) => {
        await tx.add('accounts', { id: 'a1', status: 'active' });
        tx.abort(reason);
      })
    );
    assertStorageError(error, Contracts.ERROR_CODES.STORAGE_WRITE_FAILED);
    assert.equal(error.cause, reason);
    assert.deepEqual(await storage.getAll('accounts'), []);
    assert.deepEqual(await storage.getAll('debts'), []);
  });

  await t.test('runTransaction resolves only after committed data is readable', async (t2) => {
    const { storage } = await fixture(t2);
    const value = await storage.runTransaction(['accounts'], 'readwrite', async (tx) => {
      await tx.add('accounts', { id: 'a1', status: 'active' });
      return 'done';
    });
    assert.equal(value, 'done');
    assert.deepEqual(await storage.get('accounts', 'a1'), { id: 'a1', status: 'active' });
  });

  await t.test('write in readonly transaction is rejected', async (t2) => {
    const { storage } = await fixture(t2);
    const error = await captureRejection(
      storage.runTransaction(['accounts'], 'readonly', (tx) => (
        tx.add('accounts', { id: 'a1', status: 'active' })
      ))
    );
    assertStorageError(error, Contracts.ERROR_CODES.STORAGE_WRITE_FAILED);
    assert.deepEqual(await storage.getAll('accounts'), []);
  });

  await t.test('access to undeclared store is rejected', async (t2) => {
    const { storage } = await fixture(t2);
    const error = await captureRejection(
      storage.runTransaction(['accounts'], 'readonly', (tx) => tx.get('debts', 'd1'))
    );
    assertStorageError(error, Contracts.ERROR_CODES.STORAGE_READ_FAILED);
  });

  await t.test('legitimate sequential IndexedDB awaits remain active', async (t2) => {
    const { storage } = await fixture(t2);
    await storage.runTransaction(['accounts', 'debts'], 'readwrite', async (tx) => {
      await tx.add('accounts', { id: 'a1', status: 'active' });
      assert.deepEqual(await tx.get('accounts', 'a1'), { id: 'a1', status: 'active' });
      await tx.put('accounts', { id: 'a1', status: 'inactive' });
      await tx.add('debts', { id: 'd1', paymentStatus: 'pending' });
      assert.deepEqual(await tx.getAll('debts'), [{ id: 'd1', paymentStatus: 'pending' }]);
    });
    assert.equal((await storage.get('accounts', 'a1')).status, 'inactive');
    assert.equal((await storage.getAll('debts')).length, 1);
  });

  await t.test('external event-loop wait is controlled and rolls back prior writes', async (t2) => {
    const { storage } = await fixture(t2);
    const error = await captureRejection(
      storage.runTransaction(['accounts', 'debts'], 'readwrite', async (tx) => {
        await tx.add('accounts', { id: 'a1', status: 'active' });
        await new Promise((resolve) => setImmediate(resolve));
        await tx.add('debts', { id: 'd1', paymentStatus: 'pending' });
      })
    );
    assertStorageError(error, Contracts.ERROR_CODES.STORAGE_WRITE_FAILED);
    assert.match(error.message, /External waits/);
    assert.deepEqual(await storage.getAll('accounts'), []);
    assert.deepEqual(await storage.getAll('debts'), []);
  });
});

test('IndexedDB V1.1.0 typed persistence errors', async (t) => {
  await t.test('read failure maps to STORAGE_READ_FAILED', async (t2) => {
    const { storage } = await fixture(t2);
    const error = await captureRejection(storage.get('accounts', undefined));
    assertStorageError(error, Contracts.ERROR_CODES.STORAGE_READ_FAILED);
    assert.equal(error.context.operation, 'get');
  });

  await t.test('write failure maps to STORAGE_WRITE_FAILED', async (t2) => {
    const { storage } = await fixture(t2);
    await storage.add('accounts', { id: 'a1', status: 'active' });
    const error = await captureRejection(
      storage.add('accounts', { id: 'a1', status: 'inactive' })
    );
    assertStorageError(error, Contracts.ERROR_CODES.STORAGE_WRITE_FAILED);
    assert.equal(error.context.operation, 'add');
  });

  await t.test('opening failure maps to STORAGE_OPEN_FAILED and preserves cause', async () => {
    const cause = new Error('native open failed');
    const storage = IndexedDb.createPeritaIndexedDb({
      indexedDB: { open: () => { throw cause; } },
      IDBKeyRange,
      now: () => FIXED_NOW,
      crypto: TEST_CRYPTO,
    });
    const error = await captureRejection(storage.open());
    assertStorageError(error, Contracts.ERROR_CODES.STORAGE_OPEN_FAILED);
    assert.equal(error.cause, cause);
  });

  await t.test('incompatible schema maps to SCHEMA_UNSUPPORTED', async () => {
    const factory = new IDBFactory();
    const future = await openRaw(factory, 2, (database) => {
      database.createObjectStore('future', { keyPath: 'id' });
    });
    future.close();
    const error = await captureRejection(makeStorage(factory).open());
    assertStorageError(error, Contracts.ERROR_CODES.SCHEMA_UNSUPPORTED);
  });

  await t.test('controlled QuotaExceededError maps to QUOTA_EXCEEDED', async (t2) => {
    const { storage } = await fixture(t2);
    const originalAdd = IDBObjectStore.prototype.add;
    const quotaCause = new Error('simulated quota exhaustion');
    quotaCause.name = 'QuotaExceededError';
    IDBObjectStore.prototype.add = function patchedAdd(value) {
      if (value && value.simulateQuotaExceeded) throw quotaCause;
      return originalAdd.apply(this, arguments);
    };
    try {
      const error = await captureRejection(
        storage.add('accounts', {
          id: 'a1',
          status: 'active',
          simulateQuotaExceeded: true,
        })
      );
      assertStorageError(error, Contracts.ERROR_CODES.QUOTA_EXCEEDED);
      assert.equal(error.cause, quotaCause);
      assert.deepEqual(await storage.getAll('accounts'), []);
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
    }
  });
});

test('IndexedDB V1.1.0 remains isolated from the V1 application', async (t) => {
  await t.test('source has no localStorage, perita_v1, UI, or HTML integration', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'perita-indexeddb.js'), 'utf8');
    assert.doesNotMatch(source, /\blocalStorage\s*\./);
    assert.doesNotMatch(source, /['"]perita_v1['"]/);
    assert.doesNotMatch(source, /require\([^)]*Perita\.jsx/);
    assert.doesNotMatch(source, /require\([^)]*index\.html/);
    assert.doesNotMatch(source, /PeritaCore/);
  });

  await t.test('initialization leaves every non-system store empty', async (t2) => {
    const { storage } = await fixture(t2);
    for (const storeName of IndexedDb.STORE_NAMES.filter((name) => name !== 'system')) {
      assert.deepEqual(await storage.getAll(storeName), [], storeName);
    }
    assert.deepEqual(
      (await storage.getAll('system')).map((record) => record.key).sort(),
      ['runtime', 'schema']
    );
  });
});

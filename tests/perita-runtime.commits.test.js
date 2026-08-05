'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const Contracts = require('../perita-contracts.js');
const IndexedDb = require('../perita-indexeddb.js');
const Runtime = require('../perita-runtime.js');

const FIXED_NOW = '2026-08-04T12:00:00.000Z';
const LEASE_MS = 60_000;
const DATABASE_CRYPTO = Object.freeze({
  randomUUID: () => '10000000-0000-4000-8000-000000000000',
});

function uuidSequence(start) {
  let value = start || 1;
  return () => {
    const suffix = String(value).padStart(12, '0');
    value += 1;
    return `20000000-0000-4000-8000-${suffix}`;
  };
}

function makeStorage(factory) {
  return IndexedDb.createPeritaIndexedDb({
    indexedDB: factory,
    IDBKeyRange,
    now: () => FIXED_NOW,
    crypto: DATABASE_CRYPTO,
  });
}

async function fixture(t) {
  const factory = new IDBFactory();
  const storage = makeStorage(factory);
  await storage.open();
  t.after(() => storage.close());
  const runtime = Runtime.createPeritaRuntime({
    storage,
    now: () => FIXED_NOW,
    createUuid: uuidSequence(),
    tabId: 'tab-a',
  });
  return { factory, storage, runtime };
}

function captureRejection(promise) {
  return promise.then(
    () => assert.fail('expected promise to reject'),
    (error) => error
  );
}

function assertRuntimeError(error, code) {
  assert.ok(error instanceof Runtime.RuntimeError);
  assert.ok(error instanceof Contracts.PeritaError);
  assert.ok(error instanceof Error);
  assert.equal(error.code, code);
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0);
  assert.equal(typeof error.context, 'object');
}

async function acquireAndEnable(runtime) {
  const writer = await runtime.acquireWriter({ expectedEpoch: 0, leaseDurationMs: LEASE_MS });
  const enabled = await runtime.setWriteEnabled({ enabled: true, reason: 'test bootstrap' });
  return { writer, enabled };
}

async function currentRuntime(storage) {
  return storage.get('system', 'runtime');
}

async function addDraft(runtime, storage, options) {
  const settings = options || {};
  const state = await currentRuntime(storage);
  return runtime.executeCommand({
    commandType: settings.commandType || 'test.add-draft',
    expectedDataRevision: settings.expectedDataRevision === undefined
      ? state.dataRevision
      : settings.expectedDataRevision,
    expectedWriterEpoch: settings.expectedWriterEpoch || 1,
    affectedStores: settings.affectedStores || ['drafts'],
    intent: settings.intent,
    metadata: settings.metadata,
    execute: settings.execute || (async (transaction) => {
      await transaction.add('drafts', {
        id: settings.id || 'draft-1',
        value: settings.value || 'saved',
      });
      return settings.result || 'ok';
    }),
  });
}

function wrapTransactionApi(storage, mutateApi) {
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
      (transaction) => worker(mutateApi(transaction, stores, mode))
    ),
  });
}

function runtimeWithStorage(storage, createUuid) {
  return Runtime.createPeritaRuntime({
    storage,
    now: () => FIXED_NOW,
    createUuid: createUuid || uuidSequence(100),
    tabId: 'tab-a',
  });
}

test('V1.1.0 technical command commits', async (t) => {
  await t.test('technical enablement is the first commit with sequence 1', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    const { enabled } = await acquireAndEnable(runtime);
    assert.equal(enabled.commit.sequence, 1);
    assert.equal(enabled.commit.previousDataRevision, 0);
    assert.equal(enabled.commit.dataRevision, 1);
    assert.equal(enabled.commit.commandType, 'runtime.set-write-enabled');
    assert.deepEqual(enabled.commit.affectedStores, ['system']);
    assert.equal(enabled.commit.metadata.reason, 'test bootstrap');
    assert.equal(Contracts.assertUuid(enabled.commit.commitId, { version: 4 }), enabled.commit.commitId);
    assert.deepEqual(await storage.get('commits', 1), enabled.commit);
  });

  await t.test('the second successful command uses sequence 2 and advances once', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    const completed = await addDraft(runtime, storage);
    assert.equal(completed.result, 'ok');
    assert.equal(completed.commit.sequence, 2);
    assert.equal(completed.commit.previousDataRevision, 1);
    assert.equal(completed.commit.dataRevision, 2);
    assert.deepEqual(completed.commit.affectedStores, ['drafts']);
    assert.equal(Contracts.assertUuid(completed.commit.commitId, { version: 4 }), completed.commit.commitId);
  });

  await t.test('runtime lastCommitId and commitSequence match the confirmed commit', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    const { commit } = await addDraft(runtime, storage);
    const state = await currentRuntime(storage);
    assert.equal(state.dataRevision, 2);
    assert.equal(state.commitSequence, commit.sequence);
    assert.equal(state.lastCommitId, commit.commitId);
  });

  await t.test('commit metadata and writer fencing fields are exact', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    const { commit } = await addDraft(runtime, storage, {
      metadata: { source: 'unit-test', nested: { stable: true } },
    });
    assert.equal(commit.writerTabId, 'tab-a');
    assert.equal(commit.writerEpoch, 1);
    assert.equal(commit.intentId, null);
    assert.equal(commit.committedAt, FIXED_NOW);
    assert.deepEqual(commit.metadata, { source: 'unit-test', nested: { stable: true } });
  });

  await t.test('declared stores are exact, deduplicated, and restrict callback access', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    const state = await currentRuntime(storage);
    const completed = await runtime.executeCommand({
      commandType: 'test.two-stores',
      expectedDataRevision: state.dataRevision,
      expectedWriterEpoch: 1,
      affectedStores: ['drafts', 'preferences', 'drafts'],
      execute: async (transaction) => {
        await transaction.add('drafts', { id: 'draft-1' });
        await transaction.put('preferences', { key: 'theme', value: 'dark' });
      },
    });
    assert.deepEqual(completed.commit.affectedStores, ['drafts', 'preferences']);

    const nextState = await currentRuntime(storage);
    const error = await captureRejection(runtime.executeCommand({
      commandType: 'test.undeclared-store',
      expectedDataRevision: nextState.dataRevision,
      expectedWriterEpoch: 1,
      affectedStores: ['drafts'],
      execute: (transaction) => transaction.put('preferences', { key: 'bad' }),
    }));
    assertRuntimeError(error, Contracts.ERROR_CODES.COMMAND_FAILED);
    assert.equal(await storage.get('preferences', 'bad'), undefined);
  });

  await t.test('domain changes, commit, and runtime update are atomic', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    const { commit } = await addDraft(runtime, storage);
    assert.deepEqual(await storage.get('drafts', 'draft-1'), { id: 'draft-1', value: 'saved' });
    assert.deepEqual(await storage.get('commits', commit.sequence), commit);
    const state = await currentRuntime(storage);
    assert.equal(state.lastCommitId, commit.commitId);
  });

  await t.test('a failed domain request rolls back changes, commit, and revision', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    const before = await currentRuntime(storage);
    const error = await captureRejection(addDraft(runtime, storage, {
      execute: async (transaction) => {
        await transaction.add('drafts', { id: 'duplicate' });
        await transaction.add('drafts', { id: 'duplicate' });
      },
    }));
    assert.ok(error instanceof Contracts.PeritaError);
    assert.deepEqual(await storage.getAll('drafts'), []);
    assert.equal((await storage.getAll('commits')).length, 1);
    assert.deepEqual(await currentRuntime(storage), before);
  });

  await t.test('a commit-store failure rolls back the domain change', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    const before = await currentRuntime(storage);
    const wrapped = wrapTransactionApi(storage, (transaction) => Object.freeze({
      ...transaction,
      add: (storeName, value) => storeName === 'commits'
        ? Promise.reject(new Error('induced commit write failure'))
        : transaction.add(storeName, value),
    }));
    const faultyRuntime = runtimeWithStorage(wrapped);
    const error = await captureRejection(addDraft(faultyRuntime, wrapped));
    assertRuntimeError(error, Contracts.ERROR_CODES.COMMAND_FAILED);
    assert.equal(error.cause instanceof Error, true);
    assert.deepEqual(await storage.getAll('drafts'), []);
    assert.equal((await storage.getAll('commits')).length, 1);
    assert.deepEqual(await currentRuntime(storage), before);
  });

  await t.test('a runtime update failure rolls back change and commit', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    const before = await currentRuntime(storage);
    const wrapped = wrapTransactionApi(storage, (transaction) => Object.freeze({
      ...transaction,
      put: (storeName, value) => storeName === 'system' && value.key === 'runtime'
        ? Promise.reject(new Error('induced runtime write failure'))
        : transaction.put(storeName, value),
    }));
    const faultyRuntime = runtimeWithStorage(wrapped);
    const error = await captureRejection(addDraft(faultyRuntime, wrapped));
    assertRuntimeError(error, Contracts.ERROR_CODES.COMMAND_FAILED);
    assert.deepEqual(await storage.getAll('drafts'), []);
    assert.equal((await storage.getAll('commits')).length, 1);
    assert.deepEqual(await currentRuntime(storage), before);
  });

  await t.test('a callback exception creates neither change nor commit', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    const before = await currentRuntime(storage);
    const error = await captureRejection(addDraft(runtime, storage, {
      execute: async (transaction) => {
        await transaction.add('drafts', { id: 'rolled-back' });
        throw new Error('induced callback failure');
      },
    }));
    assertRuntimeError(error, Contracts.ERROR_CODES.COMMAND_FAILED);
    assert.equal(error.cause instanceof Error, true);
    assert.deepEqual(await storage.getAll('drafts'), []);
    assert.equal((await storage.getAll('commits')).length, 1);
    assert.deepEqual(await currentRuntime(storage), before);
  });

  await t.test('an explicit abort creates neither change nor commit', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    const before = await currentRuntime(storage);
    const error = await captureRejection(addDraft(runtime, storage, {
      execute: async (transaction) => {
        await transaction.add('drafts', { id: 'rolled-back' });
        transaction.abort('stop command');
      },
    }));
    assert.ok(error instanceof Contracts.PeritaError);
    assert.deepEqual(await storage.getAll('drafts'), []);
    assert.equal((await storage.getAll('commits')).length, 1);
    assert.deepEqual(await currentRuntime(storage), before);
  });

  await t.test('two commands with the same expected revision cannot both commit', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    const expectedDataRevision = (await currentRuntime(storage)).dataRevision;
    const results = await Promise.allSettled([
      addDraft(runtime, storage, { id: 'concurrent-a', expectedDataRevision }),
      addDraft(runtime, storage, { id: 'concurrent-b', expectedDataRevision }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected').reason;
    assertRuntimeError(rejected, Contracts.ERROR_CODES.STALE_REVISION);
    assert.equal(rejected.context.expectedDataRevision, expectedDataRevision);
    assert.equal(rejected.context.actualDataRevision, expectedDataRevision + 1);
    assert.equal(rejected.context.commandType, 'test.add-draft');
    assert.equal((await storage.getAll('drafts')).length, 1);
    assert.equal((await storage.getAll('commits')).length, 2);
  });

  await t.test('STALE_REVISION has no effects on data, sequence, or lastCommitId', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    await addDraft(runtime, storage, { id: 'first' });
    const before = await currentRuntime(storage);
    const commitsBefore = await storage.getAll('commits');
    const error = await captureRejection(addDraft(runtime, storage, {
      id: 'stale',
      expectedDataRevision: before.dataRevision - 1,
    }));
    assertRuntimeError(error, Contracts.ERROR_CODES.STALE_REVISION);
    assert.equal(await storage.get('drafts', 'stale'), undefined);
    assert.deepEqual(await storage.getAll('commits'), commitsBefore);
    assert.deepEqual(await currentRuntime(storage), before);
  });

  await t.test('the command promise resolves only after commit and runtime are readable', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    const completed = await addDraft(runtime, storage, { result: 'confirmed' });
    assert.equal(completed.result, 'confirmed');
    assert.deepEqual(await storage.get('commits', completed.commit.sequence), completed.commit);
    const state = await currentRuntime(storage);
    assert.equal(state.lastCommitId, completed.commit.commitId);
    assert.deepEqual(await storage.get('drafts', 'draft-1'), { id: 'draft-1', value: 'saved' });
  });

  await t.test('invalid command declarations fail before any write', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    const before = await currentRuntime(storage);
    for (const affectedStores of [[], ['commits'], ['missing-store']]) {
      const error = await captureRejection(runtime.executeCommand({
        commandType: 'test.invalid',
        expectedDataRevision: before.dataRevision,
        expectedWriterEpoch: 1,
        affectedStores,
        execute: async () => {},
      }));
      assertRuntimeError(error, Contracts.ERROR_CODES.COMMAND_FAILED);
    }
    assert.deepEqual(await currentRuntime(storage), before);
    assert.equal((await storage.getAll('commits')).length, 1);
  });
});

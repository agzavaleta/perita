'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const Contracts = require('../perita-contracts.js');
const IndexedDb = require('../perita-indexeddb.js');
const Runtime = require('../perita-runtime.js');

const START = '2026-08-04T12:00:00.000Z';
const LEASE_MS = 60_000;
const DATABASE_CRYPTO = Object.freeze({
  randomUUID: () => '30000000-0000-4000-8000-000000000000',
});

function makeClock(start) {
  let milliseconds = Date.parse(start || START);
  return {
    now: () => new Date(milliseconds).toISOString(),
    advance: (delta) => { milliseconds += delta; },
    value: () => milliseconds,
  };
}

function uuidSequence() {
  let value = 1;
  return () => {
    const suffix = String(value).padStart(12, '0');
    value += 1;
    return `40000000-0000-4000-8000-${suffix}`;
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

function makeRuntime(storage, clock, createUuid, tabId) {
  return Runtime.createPeritaRuntime({
    storage,
    now: clock.now,
    createUuid,
    tabId,
  });
}

async function fixture(t) {
  const factory = new IDBFactory();
  const storageA = makeStorage(factory);
  const storageB = makeStorage(factory);
  await storageA.open();
  await storageB.open();
  t.after(() => {
    storageA.close();
    storageB.close();
  });
  const clock = makeClock();
  const createUuid = uuidSequence();
  const runtimeA = makeRuntime(storageA, clock, createUuid, 'tab-a');
  const runtimeB = makeRuntime(storageB, clock, createUuid, 'tab-b');
  return { factory, storageA, storageB, clock, createUuid, runtimeA, runtimeB };
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

async function acquire(runtime, expectedEpoch, leaseDurationMs) {
  return runtime.acquireWriter({
    expectedEpoch,
    leaseDurationMs: leaseDurationMs || LEASE_MS,
  });
}

async function acquireAndEnable(runtime) {
  const writer = await acquire(runtime, 0);
  const enabled = await runtime.setWriteEnabled({ enabled: true, reason: 'test bootstrap' });
  return { writer, enabled };
}

async function runDraftCommand(runtime, storage, options) {
  const settings = options || {};
  const state = await storage.get('system', 'runtime');
  return runtime.executeCommand({
    commandType: settings.commandType || 'test.writer-command',
    expectedDataRevision: settings.expectedDataRevision === undefined
      ? state.dataRevision
      : settings.expectedDataRevision,
    expectedWriterEpoch: settings.expectedWriterEpoch || 1,
    affectedStores: ['drafts'],
    intent: settings.intent,
    metadata: settings.metadata,
    execute: settings.execute || (async (transaction) => {
      await transaction.add('drafts', { id: settings.id || 'draft-1' });
      return 'saved';
    }),
  });
}

function hookTransactions(storage, afterTransaction) {
  return Object.freeze({
    open: () => storage.open(),
    close: () => storage.close(),
    get: (...args) => storage.get(...args),
    getAll: (...args) => storage.getAll(...args),
    add: (...args) => storage.add(...args),
    put: (...args) => storage.put(...args),
    remove: (...args) => storage.remove(...args),
    queryIndex: (...args) => storage.queryIndex(...args),
    runTransaction: async (stores, mode, worker) => {
      const result = await storage.runTransaction(stores, mode, worker);
      await afterTransaction(stores, mode);
      return result;
    },
  });
}

test('V1.1.0 single-writer lease coordination', async (t) => {
  await t.test('initial acquisition creates the authoritative writer with epoch 1', async (t2) => {
    const { storageA, runtimeA } = await fixture(t2);
    const writer = await acquire(runtimeA, 0);
    assert.deepEqual(writer, {
      key: 'writer',
      ownerTabId: 'tab-a',
      epoch: 1,
      acquiredAt: START,
      heartbeatAt: START,
      expiresAt: '2026-08-04T12:01:00.000Z',
      status: 'active',
    });
    assert.deepEqual(await storageA.get('coordination', 'writer'), writer);
  });

  await t.test('the same owner renews without changing epoch or acquiredAt', async (t2) => {
    const { clock, runtimeA } = await fixture(t2);
    const initial = await acquire(runtimeA, 0);
    clock.advance(10_000);
    const renewed = await acquire(runtimeA, 1);
    assert.equal(renewed.epoch, 1);
    assert.equal(renewed.acquiredAt, initial.acquiredAt);
    assert.equal(renewed.heartbeatAt, '2026-08-04T12:00:10.000Z');
    assert.equal(renewed.expiresAt, '2026-08-04T12:01:10.000Z');
  });

  await t.test('another tab is blocked while the lease is active', async (t2) => {
    const { runtimeA, runtimeB } = await fixture(t2);
    await acquire(runtimeA, 0);
    const error = await captureRejection(acquire(runtimeB, 1));
    assertRuntimeError(error, Contracts.ERROR_CODES.WRITER_ALREADY_OWNED);
    assert.equal(error.context.ownerTabId, 'tab-a');
  });

  await t.test('another tab takes over only after expiration and increments epoch', async (t2) => {
    const { clock, runtimeA, runtimeB } = await fixture(t2);
    await acquire(runtimeA, 0, 1_000);
    clock.advance(1_001);
    const takeover = await acquire(runtimeB, 1, 2_000);
    assert.equal(takeover.ownerTabId, 'tab-b');
    assert.equal(takeover.epoch, 2);
    assert.equal(takeover.acquiredAt, '2026-08-04T12:00:01.001Z');
  });

  await t.test('heartbeat extends a valid lease without changing epoch', async (t2) => {
    const { clock, runtimeA } = await fixture(t2);
    await acquire(runtimeA, 0);
    clock.advance(20_000);
    const heartbeat = await runtimeA.heartbeat({ expectedEpoch: 1, leaseDurationMs: LEASE_MS });
    assert.equal(heartbeat.epoch, 1);
    assert.equal(heartbeat.acquiredAt, START);
    assert.equal(heartbeat.heartbeatAt, '2026-08-04T12:00:20.000Z');
    assert.equal(heartbeat.expiresAt, '2026-08-04T12:01:20.000Z');
  });

  await t.test('heartbeat with a stale epoch is rejected', async (t2) => {
    const { clock, runtimeA, runtimeB } = await fixture(t2);
    await acquire(runtimeA, 0, 1_000);
    clock.advance(1_001);
    await acquire(runtimeB, 1);
    const error = await captureRejection(runtimeA.heartbeat({
      expectedEpoch: 1,
      leaseDurationMs: LEASE_MS,
    }));
    assertRuntimeError(error, Contracts.ERROR_CODES.WRITER_EPOCH_LOST);
  });

  await t.test('an expired owner cannot heartbeat its own expired lease', async (t2) => {
    const { clock, runtimeA } = await fixture(t2);
    await acquire(runtimeA, 0, 1_000);
    clock.advance(1_000);
    const error = await captureRejection(runtimeA.heartbeat({
      expectedEpoch: 1,
      leaseDurationMs: LEASE_MS,
    }));
    assertRuntimeError(error, Contracts.ERROR_CODES.WRITER_LEASE_EXPIRED);
  });

  await t.test('valid release preserves epoch and clears active lease fields', async (t2) => {
    const { runtimeA } = await fixture(t2);
    await acquire(runtimeA, 0);
    const released = await runtimeA.releaseWriter({ expectedEpoch: 1 });
    assert.deepEqual(released, {
      key: 'writer',
      ownerTabId: null,
      epoch: 1,
      acquiredAt: null,
      heartbeatAt: null,
      expiresAt: null,
      status: 'unowned',
    });
  });

  await t.test('a stale tab cannot release the current owner', async (t2) => {
    const { clock, runtimeA, runtimeB } = await fixture(t2);
    await acquire(runtimeA, 0, 1_000);
    clock.advance(1_001);
    await acquire(runtimeB, 1);
    const error = await captureRejection(runtimeA.releaseWriter({ expectedEpoch: 1 }));
    assertRuntimeError(error, Contracts.ERROR_CODES.WRITER_EPOCH_LOST);
    assert.equal((await runtimeB.getWriterState()).ownerTabId, 'tab-b');
  });

  await t.test('two concurrent initial acquisitions leave exactly one owner', async (t2) => {
    const { runtimeA, runtimeB } = await fixture(t2);
    const results = await Promise.allSettled([
      acquire(runtimeA, 0),
      acquire(runtimeB, 0),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const states = await Promise.all([runtimeA.getWriterState(), runtimeB.getWriterState()]);
    assert.deepEqual(states[0], states[1]);
    assert.equal(states[0].epoch, 1);
    assert.ok(['tab-a', 'tab-b'].includes(states[0].ownerTabId));
  });

  await t.test('epoch never decreases across release and reacquisition', async (t2) => {
    const { runtimeA, runtimeB } = await fixture(t2);
    const first = await acquire(runtimeA, 0);
    await runtimeA.releaseWriter({ expectedEpoch: first.epoch });
    const second = await acquire(runtimeB, first.epoch);
    await runtimeB.releaseWriter({ expectedEpoch: second.epoch });
    const third = await acquire(runtimeA, second.epoch);
    assert.deepEqual([first.epoch, second.epoch, third.epoch], [1, 2, 3]);
  });

  await t.test('lease duration rejects zero, negatives, decimals, and unsafe integers', async (t2) => {
    const { runtimeA } = await fixture(t2);
    for (const leaseDurationMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const error = await captureRejection(runtimeA.acquireWriter({
        expectedEpoch: 0,
        leaseDurationMs,
      }));
      assertRuntimeError(error, Contracts.ERROR_CODES.INVALID_LEASE_DURATION);
    }
  });

  await t.test('a non-owner can inspect coordination but cannot write', async (t2) => {
    const { storageA, runtimeA, runtimeB } = await fixture(t2);
    await acquireAndEnable(runtimeA);
    assert.equal((await runtimeB.getWriterState()).ownerTabId, 'tab-a');
    assert.deepEqual(await runtimeB.getPendingIntents(), []);
    const error = await captureRejection(runDraftCommand(runtimeB, storageA, {
      expectedWriterEpoch: 1,
    }));
    assertRuntimeError(error, Contracts.ERROR_CODES.WRITER_EPOCH_LOST);
    assert.deepEqual(await storageA.getAll('drafts'), []);
  });

  await t.test('the previous owner cannot write after takeover', async (t2) => {
    const { storageA, clock, runtimeA, runtimeB } = await fixture(t2);
    await acquireAndEnable(runtimeA);
    clock.advance(LEASE_MS + 1);
    await acquire(runtimeB, 1);
    const error = await captureRejection(runDraftCommand(runtimeA, storageA, {
      expectedWriterEpoch: 1,
    }));
    assertRuntimeError(error, Contracts.ERROR_CODES.WRITER_EPOCH_LOST);
    assert.deepEqual(await storageA.getAll('drafts'), []);
  });

  await t.test('lease expiration during final revalidation aborts the command', async (t2) => {
    const { storageA, runtimeA, createUuid } = await fixture(t2);
    await acquireAndEnable(runtimeA);
    const values = [
      START,
      START,
      '2026-08-04T12:01:00.001Z',
    ];
    let index = 0;
    const expiringRuntime = Runtime.createPeritaRuntime({
      storage: storageA,
      now: () => values[Math.min(index++, values.length - 1)],
      createUuid,
      tabId: 'tab-a',
    });
    const before = await storageA.get('system', 'runtime');
    const error = await captureRejection(runDraftCommand(expiringRuntime, storageA));
    assertRuntimeError(error, Contracts.ERROR_CODES.WRITER_LEASE_EXPIRED);
    assert.deepEqual(await storageA.getAll('drafts'), []);
    assert.deepEqual(await storageA.get('system', 'runtime'), before);
  });
});

test('V1.1.0 writeEnabled technical gate', async (t) => {
  await t.test('opening leaves writeEnabled false and creates no commit', async (t2) => {
    const { storageA } = await fixture(t2);
    const state = await storageA.get('system', 'runtime');
    assert.equal(state.writeEnabled, false);
    assert.equal(state.dataRevision, 0);
    assert.deepEqual(await storageA.getAll('commits'), []);
  });

  await t.test('a normal command fails with WRITE_DISABLED before any effect', async (t2) => {
    const { storageA, runtimeA } = await fixture(t2);
    await acquire(runtimeA, 0);
    const error = await captureRejection(runDraftCommand(runtimeA, storageA));
    assertRuntimeError(error, Contracts.ERROR_CODES.WRITE_DISABLED);
    assert.deepEqual(await storageA.getAll('drafts'), []);
    assert.deepEqual(await storageA.getAll('commits'), []);
  });

  await t.test('technical enablement requires a writer acquired by the instance', async (t2) => {
    const { runtimeB } = await fixture(t2);
    const error = await captureRejection(runtimeB.setWriteEnabled({
      enabled: true,
      reason: 'not owner',
    }));
    assertRuntimeError(error, Contracts.ERROR_CODES.WRITER_NOT_OWNED);
  });

  await t.test('technical enablement creates a commit and advances revision', async (t2) => {
    const { storageA, runtimeA } = await fixture(t2);
    await acquire(runtimeA, 0);
    const enabled = await runtimeA.setWriteEnabled({ enabled: true, reason: 'configuration ready' });
    const state = await storageA.get('system', 'runtime');
    assert.equal(state.writeEnabled, true);
    assert.equal(state.dataRevision, 1);
    assert.equal(state.commitSequence, 1);
    assert.equal(state.lastCommitId, enabled.commit.commitId);
    assert.deepEqual(enabled.commit.metadata, {
      enabled: true,
      reason: 'configuration ready',
    });
  });

  await t.test('technical disablement creates its own commit', async (t2) => {
    const { storageA, runtimeA } = await fixture(t2);
    await acquireAndEnable(runtimeA);
    const disabled = await runtimeA.setWriteEnabled({ enabled: false, reason: 'maintenance' });
    const state = await storageA.get('system', 'runtime');
    assert.equal(state.writeEnabled, false);
    assert.equal(disabled.commit.sequence, 2);
    assert.equal(disabled.commit.dataRevision, 2);
    assert.equal(state.lastCommitId, disabled.commit.commitId);
  });

  await t.test('normal commands cannot commit after disablement', async (t2) => {
    const { storageA, runtimeA } = await fixture(t2);
    await acquireAndEnable(runtimeA);
    await runtimeA.setWriteEnabled({ enabled: false, reason: 'maintenance' });
    const before = await storageA.get('system', 'runtime');
    const error = await captureRejection(runDraftCommand(runtimeA, storageA));
    assertRuntimeError(error, Contracts.ERROR_CODES.WRITE_DISABLED);
    assert.deepEqual(await storageA.get('system', 'runtime'), before);
    assert.equal((await storageA.getAll('commits')).length, 2);
  });

  await t.test('an obsolete writer cannot enable or disable writes', async (t2) => {
    const { clock, runtimeA, runtimeB } = await fixture(t2);
    await acquireAndEnable(runtimeA);
    clock.advance(LEASE_MS + 1);
    await acquire(runtimeB, 1);
    for (const enabled of [true, false]) {
      const error = await captureRejection(runtimeA.setWriteEnabled({
        enabled,
        reason: 'stale writer attempt',
      }));
      assertRuntimeError(error, Contracts.ERROR_CODES.WRITER_EPOCH_LOST);
    }
  });

  await t.test('enablement reason must be non-empty', async (t2) => {
    const { runtimeA } = await fixture(t2);
    await acquire(runtimeA, 0);
    const error = await captureRejection(runtimeA.setWriteEnabled({
      enabled: true,
      reason: '   ',
    }));
    assertRuntimeError(error, Contracts.ERROR_CODES.COMMAND_FAILED);
  });
});

test('V1.1.0 pending intents and writer fencing', async (t) => {
  await t.test('requested intent is pending before the atomic command transaction', async (t2) => {
    const { storageA, clock, createUuid, runtimeA } = await fixture(t2);
    await acquireAndEnable(runtimeA);
    let captured = null;
    let inspected = false;
    const hooked = hookTransactions(storageA, async (stores, mode) => {
      if (
        !inspected && mode === 'readwrite' &&
        stores.includes('pendingIntents') && !stores.includes('commits')
      ) {
        inspected = true;
        captured = await storageA.getAll('pendingIntents');
      }
    });
    const hookedRuntime = makeRuntime(hooked, clock, createUuid, 'tab-a');
    await runDraftCommand(hookedRuntime, hooked, { intent: true });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].status, 'pending');
    assert.equal(captured[0].commitId, null);
  });

  await t.test('successful intent is completed and linked to its exact commit', async (t2) => {
    const { storageA, runtimeA } = await fixture(t2);
    await acquireAndEnable(runtimeA);
    const completed = await runDraftCommand(runtimeA, storageA, {
      intent: { metadata: { recovery: 'manual-only' } },
    });
    const intents = await storageA.getAll('pendingIntents');
    assert.equal(intents.length, 1);
    assert.equal(intents[0].status, 'completed');
    assert.equal(intents[0].commitId, completed.commit.commitId);
    assert.equal(completed.commit.intentId, intents[0].id);
    assert.equal(intents[0].completedAt, completed.commit.committedAt);
    assert.deepEqual(intents[0].metadata, { recovery: 'manual-only' });
  });

  await t.test('failed command never leaves an intent falsely completed', async (t2) => {
    const { storageA, runtimeA } = await fixture(t2);
    await acquireAndEnable(runtimeA);
    const before = await storageA.get('system', 'runtime');
    const error = await captureRejection(runDraftCommand(runtimeA, storageA, {
      intent: true,
      execute: async (transaction) => {
        await transaction.add('drafts', { id: 'rolled-back' });
        throw new Error('intent command failed');
      },
    }));
    assertRuntimeError(error, Contracts.ERROR_CODES.COMMAND_FAILED);
    const intents = await storageA.getAll('pendingIntents');
    assert.equal(intents.length, 1);
    assert.equal(intents[0].status, 'failed');
    assert.equal(intents[0].commitId, null);
    assert.equal(intents[0].failureCode, Contracts.ERROR_CODES.COMMAND_FAILED);
    assert.deepEqual(await storageA.getAll('drafts'), []);
    assert.deepEqual(await storageA.get('system', 'runtime'), before);
  });

  await t.test('commands without explicit intent create no intent records', async (t2) => {
    const { storageA, runtimeA } = await fixture(t2);
    await acquireAndEnable(runtimeA);
    await runDraftCommand(runtimeA, storageA);
    assert.deepEqual(await storageA.getAll('pendingIntents'), []);
    assert.deepEqual(await runtimeA.getPendingIntents(), []);
  });

  await t.test('takeover between pending intent and command aborts obsolete writer', async (t2) => {
    const { storageA, clock, createUuid, runtimeA, runtimeB } = await fixture(t2);
    await acquire(runtimeA, 0, 1_000);
    await runtimeA.setWriteEnabled({ enabled: true, reason: 'test bootstrap' });
    let takeoverDone = false;
    const hooked = hookTransactions(storageA, async (stores, mode) => {
      if (
        !takeoverDone && mode === 'readwrite' &&
        stores.includes('pendingIntents') && !stores.includes('commits')
      ) {
        takeoverDone = true;
        clock.advance(1_001);
        await runtimeB.acquireWriter({ expectedEpoch: 1, leaseDurationMs: LEASE_MS });
      }
    });
    const obsoleteRuntime = makeRuntime(hooked, clock, createUuid, 'tab-a');
    const before = await storageA.get('system', 'runtime');
    const error = await captureRejection(runDraftCommand(obsoleteRuntime, hooked, {
      intent: true,
      expectedWriterEpoch: 1,
    }));
    assertRuntimeError(error, Contracts.ERROR_CODES.WRITER_EPOCH_LOST);
    assert.deepEqual(await storageA.getAll('drafts'), []);
    assert.deepEqual(await storageA.get('system', 'runtime'), before);
    assert.equal((await storageA.getAll('commits')).length, 1);
    const pending = await runtimeB.getPendingIntents();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'pending');
    assert.equal(pending[0].isStale, true);
    assert.equal(pending[0].writerEpoch, 1);
  });

  await t.test('pending intents are detected but never resumed automatically', async (t2) => {
    const { storageA, clock, createUuid, runtimeA, runtimeB } = await fixture(t2);
    await acquire(runtimeA, 0, 1_000);
    await runtimeA.setWriteEnabled({ enabled: true, reason: 'test bootstrap' });
    let takeoverDone = false;
    const hooked = hookTransactions(storageA, async (stores, mode) => {
      if (
        !takeoverDone && mode === 'readwrite' &&
        stores.includes('pendingIntents') && !stores.includes('commits')
      ) {
        takeoverDone = true;
        clock.advance(1_001);
        await runtimeB.acquireWriter({ expectedEpoch: 1, leaseDurationMs: LEASE_MS });
      }
    });
    const obsoleteRuntime = makeRuntime(hooked, clock, createUuid, 'tab-a');
    await captureRejection(runDraftCommand(obsoleteRuntime, hooked, {
      intent: true,
      expectedWriterEpoch: 1,
    }));
    const firstRead = await runtimeB.getPendingIntents();
    const secondRuntime = makeRuntime(storageA, clock, createUuid, 'tab-b');
    const secondRead = await secondRuntime.getPendingIntents();
    assert.deepEqual(secondRead, firstRead);
    assert.equal((await storageA.getAll('pendingIntents'))[0].status, 'pending');
    assert.deepEqual(await storageA.getAll('drafts'), []);
  });

  await t.test('invalid intent options are rejected without persistence', async (t2) => {
    const { storageA, runtimeA } = await fixture(t2);
    await acquireAndEnable(runtimeA);
    const error = await captureRejection(runDraftCommand(runtimeA, storageA, { intent: 'yes' }));
    assertRuntimeError(error, Contracts.ERROR_CODES.INTENT_STATE_INVALID);
    assert.deepEqual(await storageA.getAll('pendingIntents'), []);
  });
});

test('V1.1.0 runtime remains isolated', async (t) => {
  await t.test('source does not reference UI, localStorage, legacy key, migration, or timers', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'perita-runtime.js'), 'utf8');
    for (const [label, pattern] of [
      ['Perita.jsx', /Perita\.jsx/],
      ['index.html', /index\.html/],
      ['localStorage API', /\blocalStorage\s*[.(]/],
      ['perita_v1', /perita_v1/],
      ['BroadcastChannel', /\bBroadcastChannel\s*\(/],
      ['setInterval', /\bsetInterval\s*\(/],
      ['setTimeout', /\bsetTimeout\s*\(/],
    ]) {
      assert.equal(pattern.test(source), false, `unexpected integration: ${label}`);
    }
  });
});

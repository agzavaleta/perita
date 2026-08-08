'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const Contracts = require('../perita-contracts.js');
const IndexedDb = require('../perita-indexeddb.js');
const Runtime = require('../perita-runtime.js');
const Integrity = require('../perita-integrity.js');

const NOW = '2026-08-05T13:00:00.000Z';
const DB_UUID = '60000000-0000-4000-8000-000000000000';

function uuidSequence(start) {
  let value = start || 1;
  return () => {
    const suffix = String(value).padStart(12, '0');
    value += 1;
    return `60000000-0000-4000-8000-${suffix}`;
  };
}

function makeStorage(factory) {
  return IndexedDb.createPeritaIndexedDb({
    indexedDB: factory,
    IDBKeyRange,
    now: () => NOW,
    crypto: { randomUUID: () => DB_UUID },
  });
}

function makeIntegrity(storage, createUuid) {
  return Integrity.createPeritaIntegrity({
    storage,
    now: () => NOW,
    createUuid: createUuid || uuidSequence(100),
  });
}

async function fixture(t) {
  const factory = new IDBFactory();
  const storage = makeStorage(factory);
  await storage.open();
  t.after(() => storage.close());
  const createUuid = uuidSequence();
  const runtime = Runtime.createPeritaRuntime({
    storage,
    now: () => NOW,
    createUuid,
    tabId: 'tab-a',
  });
  const integrity = makeIntegrity(storage, createUuid);
  return { factory, storage, runtime, integrity, createUuid };
}

async function acquireAndEnable(runtime) {
  await runtime.acquireWriter({ expectedEpoch: 0, leaseDurationMs: 60_000 });
  await runtime.setWriteEnabled({ enabled: true, reason: 'integrity runtime test' });
}

async function runtimeState(storage) {
  return storage.get('system', 'runtime');
}

async function setHealth(storage, healthStatus, restrictedScopes, writeEnabled) {
  const current = await runtimeState(storage);
  await storage.put('system', {
    ...current,
    healthStatus,
    restrictedScopes: restrictedScopes || [],
    writeEnabled: writeEnabled === undefined ? current.writeEnabled : writeEnabled,
  });
}

async function executeDraft(runtime, storage, options) {
  const settings = options || {};
  const state = await runtimeState(storage);
  return runtime.executeCommand({
    commandType: 'test.integrity-scope',
    expectedDataRevision: state.dataRevision,
    expectedWriterEpoch: 1,
    affectedStores: ['drafts'],
    affectedScopes: settings.affectedScopes,
    execute: async (transaction) => {
      await transaction.add('drafts', { id: settings.id || 'draft-1' });
    },
  });
}

function captureRejection(promise) {
  return promise.then(
    () => assert.fail('expected promise to reject'),
    (error) => error
  );
}

function assertTypedError(error, code, Type) {
  assert.ok(error instanceof (Type || Contracts.PeritaError));
  assert.ok(error instanceof Contracts.PeritaError);
  assert.ok(error instanceof Error);
  assert.equal(error.code, code);
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0);
  assert.equal(typeof error.context, 'object');
}

function wrapTransactions(storage, mutateApi) {
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

test('V1.1.0 integrity reports and health policy', async (t) => {
  await t.test('every checker persists a typed immutable report', async (t2) => {
    const { integrity } = await fixture(t2);
    const reports = [
      await integrity.checkRuntime(),
      await integrity.checkCommits(),
      await integrity.checkRelationships(),
      await integrity.checkBalances(),
      await integrity.runFullCheck(),
    ];
    assert.deepEqual(reports.map((report) => report.checkType), [
      'runtime', 'commits', 'relationships', 'balances', 'full',
    ]);
    for (const report of reports) {
      assert.equal(Object.isFrozen(report), true);
      assert.equal(Object.isFrozen(report.summary), true);
      assert.equal(Object.isFrozen(report.issues), true);
      assert.equal(Contracts.assertUuid(report.id, { version: 4 }), report.id);
      assert.equal(report.startedAt, NOW);
      assert.equal(report.completedAt, NOW);
    }
    assert.equal((await integrity.getReports()).length, 5);
    assert.deepEqual(await integrity.getLatestReport(), reports[4]);
  });

  await t.test('report values are protected from external mutation', async (t2) => {
    const { integrity } = await fixture(t2);
    const report = await integrity.runFullCheck();
    assert.throws(() => { report.status = 'restricted'; }, TypeError);
    assert.throws(() => { report.issues.push({}); }, TypeError);
    const reread = await integrity.getLatestReport();
    assert.equal(reread.status, 'ok');
    assert.deepEqual(reread.issues, []);
  });

  await t.test('two checks produce equivalent diagnostics without mutating financial records', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await storage.add('operations', {
      id: 'broken-operation',
      periodId: 'missing-period',
      type: 'additional_income',
      status: 'posted',
    });
    const before = await storage.getAll('operations');
    const first = await integrity.checkRelationships();
    const second = await integrity.checkRelationships();
    assert.equal(first.status, second.status);
    assert.deepEqual(first.issues, second.issues);
    assert.deepEqual(await storage.getAll('operations'), before);
  });

  await t.test('warning, restricted, and diagnostic_only map to health policy', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await storage.add('legacyEntries', {
      id: 'legacy-warning', periodId: 'missing', legacyPath: 'x',
    });
    let report = await integrity.runFullCheck();
    assert.equal(report.status, 'warning');
    assert.equal((await runtimeState(storage)).healthStatus, 'warning');

    await storage.add('operations', {
      id: 'operation-restricted', periodId: 'missing', type: 'additional_income', status: 'posted',
    });
    report = await integrity.runFullCheck();
    assert.equal(report.status, 'restricted');
    assert.equal((await runtimeState(storage)).healthStatus, 'restricted');
    assert.ok((await runtimeState(storage)).restrictedScopes.includes('period:missing'));

    const schema = await storage.get('system', 'schema');
    await storage.put('system', { ...schema, databaseGeneration: 'bad' });
    await setHealth(storage, 'restricted', ['period:missing'], true);
    report = await integrity.runFullCheck();
    assert.equal(report.status, 'diagnostic_only');
    const state = await runtimeState(storage);
    assert.equal(state.healthStatus, 'diagnostic_only');
    assert.equal(state.writeEnabled, false);
  });

  await t.test('a full check updates only permitted runtime health fields', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await storage.add('operations', {
      id: 'operation-restricted', periodId: 'missing', type: 'additional_income', status: 'posted',
    });
    const before = await runtimeState(storage);
    await integrity.runFullCheck();
    const after = await runtimeState(storage);
    assert.equal(after.dataRevision, before.dataRevision);
    assert.equal(after.commitSequence, before.commitSequence);
    assert.equal(after.lastCommitId, before.lastCommitId);
    assert.equal(after.writeEnabled, before.writeEnabled);
    assert.equal(after.healthStatus, 'restricted');
    assert.deepEqual(after.restrictedScopes, ['period:missing']);
  });

  await t.test('diagnostic health is recorded without repairing other invalid runtime fields', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    const before = await runtimeState(storage);
    await storage.put('system', {
      ...before,
      dataRevision: -9,
      commitSequence: 1.5,
      lastCommitId: 'invalid',
      writeEnabled: true,
    });
    const report = await integrity.runFullCheck();
    const after = await runtimeState(storage);
    assert.equal(report.status, 'diagnostic_only');
    assert.equal(after.healthStatus, 'diagnostic_only');
    assert.equal(after.writeEnabled, false);
    assert.equal(after.dataRevision, -9);
    assert.equal(after.commitSequence, 1.5);
    assert.equal(after.lastCommitId, 'invalid');
  });

  await t.test('manual fixture repair allows a later full check to return to ok', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await storage.add('accounts', {
      id: 'account-1', openingBalance: 100, currentBalance: 999, status: 'active',
    });
    let report = await integrity.runFullCheck();
    assert.equal(report.status, 'restricted');
    assert.equal((await runtimeState(storage)).healthStatus, 'restricted');

    await storage.put('accounts', {
      id: 'account-1', openingBalance: 100, currentBalance: 100, status: 'active',
    });
    report = await integrity.runFullCheck();
    assert.equal(report.status, 'ok');
    assert.equal((await runtimeState(storage)).healthStatus, 'ok');
    assert.deepEqual((await runtimeState(storage)).restrictedScopes, []);
  });

  await t.test('checks never create, delete, or repair operations, movements, or balances', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await storage.add('accounts', {
      id: 'account-1', openingBalance: 100, currentBalance: 777, status: 'active',
    });
    await storage.add('operations', {
      id: 'operation-1', periodId: 'missing-period', type: 'balance_adjustment', status: 'posted',
    });
    await storage.add('movements', {
      id: 'movement-1',
      operationId: 'operation-1',
      periodId: 'missing-period',
      targetType: 'account',
      targetId: 'account-1',
      effectType: 'asset_balance',
      delta: 10,
      status: 'posted',
    });
    const before = {
      accounts: await storage.getAll('accounts'),
      operations: await storage.getAll('operations'),
      movements: await storage.getAll('movements'),
    };
    await integrity.runFullCheck();
    assert.deepEqual(await storage.getAll('accounts'), before.accounts);
    assert.deepEqual(await storage.getAll('operations'), before.operations);
    assert.deepEqual(await storage.getAll('movements'), before.movements);
  });
});

test('V1.1.0 atomic integrity persistence', async (t) => {
  await t.test('report write failure leaves runtime health unchanged and no report', async (t2) => {
    const { storage } = await fixture(t2);
    const before = await runtimeState(storage);
    const wrapped = wrapTransactions(storage, (transaction) => Object.freeze({
      ...transaction,
      add: (storeName, value) => storeName === 'integrityReports'
        ? Promise.reject(new Error('induced report failure'))
        : transaction.add(storeName, value),
    }));
    const error = await captureRejection(makeIntegrity(wrapped).runFullCheck());
    assertTypedError(error, Contracts.ERROR_CODES.INTEGRITY_FAILED, Integrity.IntegrityError);
    assert.ok(error.cause);
    assert.deepEqual(await runtimeState(storage), before);
    assert.deepEqual(await storage.getAll('integrityReports'), []);
  });

  await t.test('runtime health write failure rolls back the report', async (t2) => {
    const { storage } = await fixture(t2);
    const before = await runtimeState(storage);
    const wrapped = wrapTransactions(storage, (transaction) => Object.freeze({
      ...transaction,
      put: (storeName, value) => storeName === 'system' && value.key === 'runtime'
        ? Promise.reject(new Error('induced health failure'))
        : transaction.put(storeName, value),
    }));
    const error = await captureRejection(makeIntegrity(wrapped).runFullCheck());
    assertTypedError(error, Contracts.ERROR_CODES.INTEGRITY_FAILED, Integrity.IntegrityError);
    assert.ok(error.cause);
    assert.deepEqual(await runtimeState(storage), before);
    assert.deepEqual(await storage.getAll('integrityReports'), []);
  });
});

test('V1.1.0 runtime integrity restrictions', async (t) => {
  await t.test('a command affecting a restricted scope is blocked without effects', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    await setHealth(storage, 'restricted', ['account:account-1']);
    const before = await runtimeState(storage);
    const error = await captureRejection(executeDraft(runtime, storage, {
      affectedScopes: ['account:account-1'],
    }));
    assertTypedError(error, Contracts.ERROR_CODES.RESTRICTED_SCOPE, Runtime.RuntimeError);
    assert.deepEqual(error.context.blockedScopes, ['account:account-1']);
    assert.deepEqual(await storage.getAll('drafts'), []);
    assert.deepEqual(await runtimeState(storage), before);
  });

  await t.test('a command outside restricted scopes can commit normally', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    await setHealth(storage, 'restricted', ['account:account-1']);
    const completed = await executeDraft(runtime, storage, {
      id: 'allowed',
      affectedScopes: ['account:account-2'],
    });
    assert.equal(completed.commit.dataRevision, 2);
    assert.deepEqual(await storage.get('drafts', 'allowed'), { id: 'allowed' });
  });

  await t.test('affectedScopes are deduplicated and validated', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    await setHealth(storage, 'restricted', ['account:account-1']);
    const error = await captureRejection(executeDraft(runtime, storage, {
      affectedScopes: ['account:account-1', 'account:account-1'],
    }));
    assertTypedError(error, Contracts.ERROR_CODES.RESTRICTED_SCOPE, Runtime.RuntimeError);
    assert.deepEqual(error.context.affectedScopes, ['account:account-1']);

    const invalid = await captureRejection(executeDraft(runtime, storage, {
      affectedScopes: [''],
    }));
    assertTypedError(invalid, Contracts.ERROR_CODES.COMMAND_FAILED, Runtime.RuntimeError);
  });

  await t.test('diagnostic_only blocks every normal command before WRITE_DISABLED', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    await setHealth(storage, 'diagnostic_only', [], false);
    const before = await runtimeState(storage);
    const error = await captureRejection(executeDraft(runtime, storage, {
      affectedScopes: ['account:account-2'],
    }));
    assertTypedError(error, Contracts.ERROR_CODES.DIAGNOSTIC_ONLY, Runtime.RuntimeError);
    assert.deepEqual(await runtimeState(storage), before);
    assert.deepEqual(await storage.getAll('drafts'), []);
  });

  await t.test('setWriteEnabled(true) fails while diagnostic_only', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    await setHealth(storage, 'diagnostic_only', [], false);
    const error = await captureRejection(runtime.setWriteEnabled({
      enabled: true,
      reason: 'must remain disabled',
    }));
    assertTypedError(error, Contracts.ERROR_CODES.DIAGNOSTIC_ONLY, Runtime.RuntimeError);
    assert.equal((await runtimeState(storage)).writeEnabled, false);
  });

  await t.test('setWriteEnabled(false) remains available as a safety operation', async (t2) => {
    const { storage, runtime } = await fixture(t2);
    await acquireAndEnable(runtime);
    await setHealth(storage, 'diagnostic_only', [], true);
    const disabled = await runtime.setWriteEnabled({ enabled: false, reason: 'integrity safety' });
    assert.equal(disabled.commit.commandType, 'runtime.set-write-enabled');
    assert.equal((await runtimeState(storage)).writeEnabled, false);
  });
});

test('V1.1.0 integrity remains isolated', async (t) => {
  await t.test('source has no UI, legacy storage, migration, domain commands, or repair integration', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'perita-integrity.js'), 'utf8');
    for (const [label, pattern] of [
      ['Perita.jsx', /Perita\.jsx/],
      ['index.html', /index\.html/],
      ['localStorage API', /\blocalStorage\s*[.(]/],
      ['perita_v1', /perita_v1/],
      ['BroadcastChannel', /\bBroadcastChannel\s*\(/],
      ['automatic timer', /\bset(?:Interval|Timeout)\s*\(/],
      [
        'financial command',
        /perita-domain-commands(?:\.js)?|PeritaDomainCommands|(?:salaryReceipt|additionalIncome|variableExpense|fixedExpensePayment)\s*\.\s*(?:create|edit|void)\s*\(/,
      ],
    ]) {
      assert.equal(pattern.test(source), false, `unexpected integration: ${label}`);
    }
  });
});

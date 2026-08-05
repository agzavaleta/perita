'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const Contracts = require('../perita-contracts.js');
const IndexedDb = require('../perita-indexeddb.js');
const Runtime = require('../perita-runtime.js');
const Integrity = require('../perita-integrity.js');

const NOW = '2026-08-05T12:00:00.000Z';
const DB_UUID = '50000000-0000-4000-8000-000000000000';
const COMMIT_UUID = '50000000-0000-4000-8000-000000000001';

function uuidSequence(start) {
  let value = start || 10;
  return () => {
    const suffix = String(value).padStart(12, '0');
    value += 1;
    return `50000000-0000-4000-8000-${suffix}`;
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
    createUuid: createUuid || uuidSequence(),
  });
}

async function fixture(t) {
  const factory = new IDBFactory();
  const storage = makeStorage(factory);
  await storage.open();
  t.after(() => storage.close());
  return { factory, storage, integrity: makeIntegrity(storage) };
}

async function getRuntime(storage) {
  return storage.get('system', 'runtime');
}

async function putRuntime(storage, changes) {
  const runtime = await getRuntime(storage);
  await storage.put('system', { ...runtime, ...changes });
}

function issueCodes(report) {
  return report.issues.map((issue) => issue.code);
}

function captureRejection(promise) {
  return promise.then(
    () => assert.fail('expected promise to reject'),
    (error) => error
  );
}

async function addPeriod(storage, overrides) {
  const period = {
    id: 'period-1',
    periodKey: '2026-08',
    status: 'open',
    snapshotId: null,
    ...(overrides || {}),
  };
  await storage.add('periods', period);
  return period;
}

async function addOperation(storage, overrides) {
  const operation = {
    id: 'operation-1',
    periodId: 'period-1',
    type: 'balance_adjustment',
    operationDate: '2026-08-05',
    amount: 50,
    status: 'posted',
    ...(overrides || {}),
  };
  await storage.add('operations', operation);
  return operation;
}

async function addMovement(storage, overrides) {
  const movement = {
    id: 'movement-1',
    operationId: 'operation-1',
    periodId: 'period-1',
    targetType: 'account',
    targetId: 'account-1',
    effectType: 'asset_balance',
    delta: 50,
    status: 'posted',
    ...(overrides || {}),
  };
  await storage.add('movements', movement);
  return movement;
}

async function addValidFinancialFixture(storage) {
  await addPeriod(storage);
  await putRuntime(storage, { activePeriodId: 'period-1' });
  await storage.add('accounts', {
    id: 'account-1',
    openingBalance: 100,
    currentBalance: 150,
    status: 'active',
  });
  await storage.add('savingsGoals', {
    id: 'goal-1',
    openingBalance: 20,
    currentBalance: 50,
    lifecycleStatus: 'active',
  });
  await storage.add('debts', {
    id: 'debt-1',
    openingOutstanding: 500,
    outstandingAmount: 400,
    paymentStatus: 'active',
  });
  await addOperation(storage);
  await storage.add('operations', {
    id: 'operation-2',
    periodId: 'period-1',
    type: 'savings_deposit',
    operationDate: '2026-08-05',
    amount: 30,
    status: 'posted',
  });
  await storage.add('operations', {
    id: 'operation-3',
    periodId: 'period-1',
    type: 'debt_payment',
    operationDate: '2026-08-05',
    amount: 100,
    status: 'posted',
  });
  await addMovement(storage);
  await storage.add('movements', {
    id: 'movement-2',
    operationId: 'operation-2',
    periodId: 'period-1',
    targetType: 'savings_goal',
    targetId: 'goal-1',
    effectType: 'asset_balance',
    delta: 30,
    status: 'posted',
  });
  await storage.add('movements', {
    id: 'movement-3',
    operationId: 'operation-3',
    periodId: 'period-1',
    targetType: 'debt',
    targetId: 'debt-1',
    effectType: 'debt_outstanding',
    delta: -100,
    status: 'posted',
  });
  await storage.add('movements', {
    id: 'movement-voided',
    operationId: 'operation-1',
    periodId: 'period-1',
    targetType: 'account',
    targetId: 'account-1',
    effectType: 'asset_balance',
    delta: 9999,
    status: 'voided',
  });
  for (const [id, targetType, targetId, openingAmount] of [
    ['opening-account', 'account', 'account-1', 100],
    ['opening-goal', 'savings_goal', 'goal-1', 20],
    ['opening-debt', 'debt', 'debt-1', 500],
  ]) {
    await storage.add('periodOpenings', {
      id,
      periodId: 'period-1',
      targetType,
      targetId,
      openingAmount,
    });
  }
  await storage.add('legacyEntries', {
    id: 'legacy-1',
    periodId: 'period-1',
    legacyPath: 'accounts[0]',
    amount: 999999,
  });
}

test('V1.1.0 integrity runtime and schema checks', async (t) => {
  await t.test('a valid empty system produces an ok full report', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    const report = await integrity.runFullCheck();
    assert.equal(report.checkType, 'full');
    assert.equal(report.status, 'ok');
    assert.deepEqual(report.issues, []);
    assert.equal(report.databaseGeneration, DB_UUID);
    assert.equal(report.dataRevision, 0);
    assert.equal(report.commitSequence, 0);
    assert.equal((await getRuntime(storage)).healthStatus, 'ok');
  });

  await t.test('missing schema produces diagnostic_only and disables writes', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await putRuntime(storage, { writeEnabled: true });
    await storage.remove('system', 'schema');
    const report = await integrity.runFullCheck();
    assert.equal(report.status, 'diagnostic_only');
    assert.ok(issueCodes(report).includes('SYSTEM_SCHEMA_MISSING'));
    const runtime = await getRuntime(storage);
    assert.equal(runtime.healthStatus, 'diagnostic_only');
    assert.equal(runtime.writeEnabled, false);
  });

  await t.test('missing runtime is reported without recreating it', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await storage.remove('system', 'runtime');
    const report = await integrity.runFullCheck();
    assert.equal(report.status, 'diagnostic_only');
    assert.ok(issueCodes(report).includes('SYSTEM_RUNTIME_MISSING'));
    assert.equal(await storage.get('system', 'runtime'), undefined);
    assert.deepEqual(await storage.get('integrityReports', report.id), JSON.parse(JSON.stringify(report)));
  });

  await t.test('schema version, physical version, and generation UUID are validated', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    const schema = await storage.get('system', 'schema');
    await storage.put('system', {
      ...schema,
      schemaVersion: '2.0.0',
      indexedDbVersion: 2,
      databaseGeneration: 'not-a-uuid',
    });
    const report = await integrity.checkRuntime();
    assert.equal(report.status, 'diagnostic_only');
    assert.deepEqual(issueCodes(report), [
      'SCHEMA_VERSION_UNSUPPORTED',
      'INDEXEDDB_VERSION_UNSUPPORTED',
      'DATABASE_GENERATION_INVALID',
    ]);
  });

  await t.test('invalid runtime fields are diagnostic_only', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await putRuntime(storage, {
      dataRevision: -1,
      commitSequence: 1.5,
      lastCommitId: 'bad',
      restrictedScopes: 'account:a',
      writeEnabled: 'yes',
      healthStatus: 'unknown',
    });
    const report = await integrity.checkRuntime();
    assert.equal(report.status, 'diagnostic_only');
    for (const code of [
      'RUNTIME_REVISION_INVALID',
      'LAST_COMMIT_ID_INVALID',
      'RESTRICTED_SCOPES_INVALID',
      'WRITE_ENABLED_INVALID',
      'HEALTH_STATUS_INVALID',
    ]) {
      assert.ok(issueCodes(report).includes(code));
    }
  });

  await t.test('more than one open period is diagnostic_only', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await addPeriod(storage, { id: 'period-1', periodKey: '2026-08' });
    await addPeriod(storage, { id: 'period-2', periodKey: '2026-09' });
    await putRuntime(storage, { activePeriodId: 'period-1' });
    const report = await integrity.checkRuntime();
    assert.equal(report.status, 'diagnostic_only');
    assert.ok(issueCodes(report).includes('MULTIPLE_OPEN_PERIODS'));
  });

  await t.test('activePeriodId must match the sole open period', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await addPeriod(storage);
    const report = await integrity.checkRuntime();
    assert.equal(report.status, 'diagnostic_only');
    assert.ok(issueCodes(report).includes('ACTIVE_PERIOD_MISMATCH'));
  });
});

test('V1.1.0 integrity commit-chain checks', async (t) => {
  await t.test('the runtime command chain is valid and consecutive', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    const runtime = Runtime.createPeritaRuntime({
      storage,
      now: () => NOW,
      createUuid: uuidSequence(100),
      tabId: 'tab-a',
    });
    await runtime.acquireWriter({ expectedEpoch: 0, leaseDurationMs: 60_000 });
    await runtime.setWriteEnabled({ enabled: true, reason: 'integrity test' });
    const report = await integrity.checkCommits();
    assert.equal(report.status, 'ok');
    assert.deepEqual(report.issues, []);
  });

  await t.test('a sequence gap and revision discontinuity are diagnostic_only', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await storage.add('commits', {
      sequence: 2,
      commitId: COMMIT_UUID,
      previousDataRevision: 4,
      dataRevision: 5,
      affectedStores: ['accounts'],
    });
    await putRuntime(storage, {
      commitSequence: 2,
      dataRevision: 5,
      lastCommitId: COMMIT_UUID,
    });
    const report = await integrity.checkCommits();
    assert.equal(report.status, 'diagnostic_only');
    assert.ok(issueCodes(report).includes('COMMIT_SEQUENCE_GAP'));
    assert.ok(issueCodes(report).includes('COMMIT_REVISION_CHAIN_INVALID'));
  });

  await t.test('duplicate logical sequence and commitId are detected', async (t2) => {
    const { storage } = await fixture(t2);
    const duplicateCommits = [
      {
        sequence: 1,
        commitId: COMMIT_UUID,
        previousDataRevision: 0,
        dataRevision: 1,
        affectedStores: ['accounts'],
      },
      {
        sequence: 1,
        commitId: COMMIT_UUID,
        previousDataRevision: 1,
        dataRevision: 2,
        affectedStores: ['accounts'],
      },
    ];
    const wrapped = {
      ...storage,
      runTransaction: (stores, mode, worker) => storage.runTransaction(
        stores,
        mode,
        (transaction) => worker(Object.freeze({
          ...transaction,
          getAll: (storeName) => storeName === 'commits'
            ? Promise.resolve(duplicateCommits)
            : transaction.getAll(storeName),
        }))
      ),
    };
    const report = await makeIntegrity(wrapped).checkCommits();
    assert.equal(report.status, 'diagnostic_only');
    assert.ok(issueCodes(report).includes('COMMIT_SEQUENCE_DUPLICATE'));
    assert.ok(issueCodes(report).includes('COMMIT_ID_DUPLICATE'));
  });

  await t.test('runtime revision and lastCommitId discordance are detected', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await storage.add('commits', {
      sequence: 1,
      commitId: COMMIT_UUID,
      previousDataRevision: 0,
      dataRevision: 1,
      affectedStores: ['accounts'],
    });
    await putRuntime(storage, {
      commitSequence: 7,
      dataRevision: 9,
      lastCommitId: '50000000-0000-4000-8000-000000000099',
    });
    const report = await integrity.checkCommits();
    assert.equal(report.status, 'diagnostic_only');
    assert.ok(issueCodes(report).includes('RUNTIME_COMMIT_HEAD_INVALID'));
  });

  await t.test('affectedStores duplicates invalidate a commit', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await storage.add('commits', {
      sequence: 1,
      commitId: COMMIT_UUID,
      previousDataRevision: 0,
      dataRevision: 1,
      affectedStores: ['accounts', 'accounts'],
    });
    await putRuntime(storage, {
      commitSequence: 1,
      dataRevision: 1,
      lastCommitId: COMMIT_UUID,
    });
    const report = await integrity.checkCommits();
    assert.equal(report.status, 'diagnostic_only');
    assert.ok(issueCodes(report).includes('COMMIT_AFFECTED_STORES_INVALID'));
  });
});

test('V1.1.0 integrity relationship checks', async (t) => {
  await t.test('valid cross-store relationships produce ok', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await addPeriod(storage, { status: 'closed', snapshotId: 'snapshot-1' });
    await storage.add('accounts', { id: 'account-1', status: 'active' });
    await storage.add('periodOpenings', {
      id: 'opening-1', periodId: 'period-1', targetType: 'account', targetId: 'account-1',
    });
    await storage.add('fixedExpenseTemplates', { id: 'template-1', status: 'active' });
    await storage.add('fixedExpenseInstances', {
      id: 'instance-1', periodId: 'period-1', templateId: 'template-1',
    });
    await addOperation(storage);
    await addMovement(storage);
    await storage.add('periodSnapshots', { id: 'snapshot-1', periodId: 'period-1' });
    await storage.add('migrations', { id: 'migration-1' });
    await storage.add('legacyEntries', {
      id: 'legacy-1', periodId: 'period-1', legacyPath: 'x', migrationId: 'migration-1',
    });
    await storage.add('commits', {
      sequence: 1,
      commitId: COMMIT_UUID,
      intentId: 'intent-1',
      previousDataRevision: 0,
      dataRevision: 1,
      affectedStores: [],
    });
    await storage.add('pendingIntents', {
      id: 'intent-1', status: 'completed', commitId: COMMIT_UUID,
    });
    const report = await integrity.checkRelationships();
    assert.equal(report.status, 'ok');
  });

  await t.test('broken period, operation, target, template, and snapshot links are restricted', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await storage.add('periodOpenings', {
      id: 'opening-bad', periodId: 'missing-period', targetType: 'account', targetId: 'missing-account',
    });
    await storage.add('fixedExpenseInstances', {
      id: 'instance-bad', periodId: 'missing-period', templateId: 'missing-template',
    });
    await addOperation(storage, { periodId: 'missing-period' });
    await addMovement(storage, { operationId: 'missing-operation', periodId: 'other-period' });
    await storage.add('periodSnapshots', { id: 'snapshot-bad', periodId: 'missing-period' });
    const report = await integrity.checkRelationships();
    assert.equal(report.status, 'restricted');
    for (const code of [
      'PERIOD_OPENING_PERIOD_MISSING',
      'PERIOD_OPENING_TARGET_MISSING',
      'FIXED_INSTANCE_PERIOD_MISSING',
      'FIXED_INSTANCE_TEMPLATE_MISSING',
      'OPERATION_PERIOD_MISSING',
      'MOVEMENT_OPERATION_MISSING',
      'SNAPSHOT_PERIOD_MISSING',
    ]) {
      assert.ok(issueCodes(report).includes(code), code);
    }
  });

  await t.test('legacy and intent metadata inconsistencies are warnings', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await storage.add('legacyEntries', {
      id: 'legacy-bad', periodId: 'missing-period', legacyPath: 'x', migrationId: 'missing-migration',
    });
    await storage.add('pendingIntents', {
      id: 'intent-bad', status: 'completed', commitId: null,
    });
    const report = await integrity.checkRelationships();
    assert.equal(report.status, 'warning');
    assert.deepEqual(new Set(issueCodes(report)), new Set([
      'LEGACY_ENTRY_PERIOD_MISSING',
      'LEGACY_ENTRY_MIGRATION_MISSING',
      'COMPLETED_INTENT_COMMIT_MISSING',
    ]));
  });

  await t.test('movement period and effect type must match operation and entity', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await addPeriod(storage);
    await storage.add('accounts', { id: 'account-1' });
    await addOperation(storage);
    await addMovement(storage, {
      periodId: 'period-2',
      effectType: 'debt_outstanding',
    });
    const report = await integrity.checkRelationships();
    assert.equal(report.status, 'restricted');
    assert.ok(issueCodes(report).includes('MOVEMENT_PERIOD_MISMATCH'));
    assert.ok(issueCodes(report).includes('MOVEMENT_EFFECT_INCOMPATIBLE'));
  });
});

test('V1.1.0 integrity balance checks', async (t) => {
  await t.test('account, savings goal, and debt balances reconcile exactly', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await addValidFinancialFixture(storage);
    const report = await integrity.checkBalances();
    assert.equal(report.status, 'ok');
    assert.deepEqual(report.issues, []);
  });

  await t.test('voided movements and legacy entries do not affect balances', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await addValidFinancialFixture(storage);
    const report = await integrity.checkBalances();
    assert.equal(report.status, 'ok');
    assert.equal(issueCodes(report).includes('ENTITY_BALANCE_DIVERGENCE'), false);
  });

  await t.test('cached account, goal, and debt divergences restrict their exact scopes', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await addValidFinancialFixture(storage);
    await storage.put('accounts', {
      ...(await storage.get('accounts', 'account-1')),
      currentBalance: 151,
    });
    await storage.put('savingsGoals', {
      ...(await storage.get('savingsGoals', 'goal-1')),
      currentBalance: 51,
    });
    await storage.put('debts', {
      ...(await storage.get('debts', 'debt-1')),
      outstandingAmount: 399,
    });
    const report = await integrity.checkBalances();
    assert.equal(report.status, 'restricted');
    assert.equal(report.issues.filter((issue) => issue.code === 'ENTITY_BALANCE_DIVERGENCE').length, 3);
    assert.deepEqual(new Set(report.issues
      .filter((issue) => issue.code === 'ENTITY_BALANCE_DIVERGENCE')
      .map((issue) => `${issue.scopeType}:${issue.scopeId}`)), new Set([
      'account:account-1',
      'savings_goal:goal-1',
      'debt:debt-1',
    ]));
  });

  await t.test('invalid monetary fields and deltas produce incidents without correction', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await addValidFinancialFixture(storage);
    const account = await storage.get('accounts', 'account-1');
    const movement = await storage.get('movements', 'movement-1');
    await storage.put('accounts', { ...account, openingBalance: 1.5 });
    await storage.put('movements', { ...movement, delta: '50' });
    const report = await integrity.checkBalances();
    assert.equal(report.status, 'restricted');
    assert.ok(issueCodes(report).includes('ENTITY_BALANCE_AMOUNT_INVALID'));
    assert.ok(issueCodes(report).includes('MOVEMENT_AMOUNT_INVALID'));
    assert.equal((await storage.get('accounts', 'account-1')).openingBalance, 1.5);
    assert.equal((await storage.get('movements', 'movement-1')).delta, '50');
  });

  await t.test('PeriodOpening is used once and never added to entity openingBalance', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await addPeriod(storage);
    await storage.add('accounts', {
      id: 'account-1', openingBalance: 100, currentBalance: 150, status: 'active',
    });
    await addOperation(storage);
    await addMovement(storage);
    await storage.add('periodOpenings', {
      id: 'opening-1',
      periodId: 'period-1',
      targetType: 'account',
      targetId: 'account-1',
      openingAmount: 100,
    });
    const report = await integrity.checkBalances();
    assert.equal(report.status, 'ok');
    assert.deepEqual(report.issues, []);
  });

  await t.test('closed period without demonstrable closing balance yields warning, not invented data', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await addPeriod(storage, { status: 'closed' });
    await storage.add('accounts', {
      id: 'account-1', openingBalance: 100, currentBalance: 100, status: 'active',
    });
    await storage.add('periodOpenings', {
      id: 'opening-1', periodId: 'period-1', targetType: 'account', targetId: 'account-1', openingAmount: 100,
    });
    const report = await integrity.checkBalances();
    assert.equal(report.status, 'warning');
    assert.ok(issueCodes(report).includes('PERIOD_CLOSING_BALANCE_UNAVAILABLE'));
  });

  await t.test('closed period can use its immutable snapshot closing balance', async (t2) => {
    const { storage, integrity } = await fixture(t2);
    await addPeriod(storage, { status: 'closed', snapshotId: 'snapshot-1' });
    await storage.add('accounts', {
      id: 'account-1', openingBalance: 100, currentBalance: 150, status: 'active',
    });
    await addOperation(storage);
    await addMovement(storage);
    await storage.add('periodOpenings', {
      id: 'opening-1', periodId: 'period-1', targetType: 'account', targetId: 'account-1', openingAmount: 100,
    });
    await storage.add('periodSnapshots', {
      id: 'snapshot-1',
      periodId: 'period-1',
      data: { closingBalances: { 'account:account-1': 150 } },
    });
    const report = await integrity.checkBalances();
    assert.equal(report.status, 'ok');
  });
});

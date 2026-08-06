'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const Contracts = require('../perita-contracts.js');
const IndexedDb = require('../perita-indexeddb.js');
const Runtime = require('../perita-runtime.js');
const Integrity = require('../perita-integrity.js');
const DomainCommands = require('../perita-domain-commands.js');

const START = '2026-08-05T12:00:00.000Z';
const LEASE_MS = 60_000;
const DATABASE_CRYPTO = Object.freeze({
  randomUUID: () => 'c0000000-0000-4000-8000-000000000000',
});

function id(number) {
  return `c1000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
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

function makeRuntime(storage, clock) {
  return Runtime.createPeritaRuntime({
    storage,
    now: clock.now,
    tabId: 'tab-financial',
    createUuid: uuidSequence('c2000000'),
  });
}

function makeCommands(runtime, clock, capture, createUuid) {
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
    createUuid: createUuid || uuidSequence('c3000000'),
  });
}

function settings() {
  return {
    key: 'current',
    salaryReferenceAmount: 0,
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
    plannedSalaryAmount: 0,
    variableExpenseBudgetAmount: 0,
    plannedSavingsAmount: 0,
    openedAt: START,
    closedAt: null,
    snapshotId: null,
    revision: 1,
    ...(overrides || {}),
  };
}

function account(overrides) {
  return {
    id: id(2),
    name: 'Cuenta principal',
    openingBalance: 100000,
    currentBalance: 100000,
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
  const runtime = makeRuntime(storage, clock);
  const capture = {};
  const commands = makeCommands(runtime, clock, capture, config.commandUuid);
  await runtime.acquireWriter({ expectedEpoch: 0, leaseDurationMs: LEASE_MS });
  await runtime.setWriteEnabled({ enabled: true, reason: 'financial engine bootstrap' });
  const runtimeState = await storage.get('system', 'runtime');
  await commands.setup.complete({
    expectedDataRevision: runtimeState.dataRevision,
    expectedWriterEpoch: 1,
    currentCivilDate: '2026-08-05',
    financialSettings: settings(),
    period: period(),
    accounts: [account(config.account)],
  });
  clock.advance(1000);
  return { factory, clock, storage, runtime, commands, capture };
}

async function commonInput(f) {
  const runtimeState = await f.storage.get('system', 'runtime');
  const storedAccount = await f.storage.get('accounts', id(2));
  return {
    expectedDataRevision: runtimeState.dataRevision,
    expectedWriterEpoch: 1,
    periodId: id(1),
    accountId: id(2),
    expectedAccountRevision: storedAccount.revision,
  };
}

async function createAdjustment(f, overrides) {
  return f.commands.balanceAdjustment.create({
    ...await commonInput(f),
    operationDate: '2026-08-05',
    delta: 20000,
    reason: 'Conciliar saldo real',
    ...(overrides || {}),
  });
}

async function editAdjustment(f, operation, overrides) {
  return f.commands.balanceAdjustment.edit({
    ...await commonInput(f),
    operationId: operation.id,
    expectedOperationRevision: operation.revision,
    ...(overrides || {}),
  });
}

async function voidAdjustment(f, operation, overrides) {
  return f.commands.operation.void({
    ...await commonInput(f),
    operationId: operation.id,
    expectedOperationRevision: operation.revision,
    ...(overrides || {}),
  });
}

function rejection(promise) {
  return promise.then(
    () => assert.fail('expected command to reject'),
    (error) => error
  );
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
        add: (storeName, value) => {
          if (storeName === targetStore && targetMethod === 'add') {
            throw new Error(`induced ${storeName}.add failure`);
          }
          return transaction.add(storeName, value);
        },
        put: (storeName, value) => {
          if (storeName === targetStore && targetMethod === 'put') {
            throw new Error(`induced ${storeName}.put failure`);
          }
          return transaction.put(storeName, value);
        },
      }))
    ),
  });
}

async function financialSnapshot(storage) {
  const runtimeState = await storage.get('system', 'runtime');
  return {
    account: await storage.get('accounts', id(2)),
    operations: await storage.getAll('operations'),
    movements: await storage.getAll('movements'),
    revisions: await storage.getAll('operationRevisions'),
    dataRevision: runtimeState.dataRevision,
    commitSequence: runtimeState.commitSequence,
    lastCommitId: runtimeState.lastCommitId,
  };
}

test('V1.1.0 balance-adjustment.create', async (t) => {
  await t.test('positive delta creates one canonical operation and movement atomically', async (t2) => {
    const f = await fixture(t2);
    const auditsBefore = await f.storage.getAll('auditEvents');
    const beforeRuntime = await f.storage.get('system', 'runtime');
    const completed = await createAdjustment(f);
    const { operation, movement, account: updatedAccount } = completed.result;

    assert.equal(operation.type, 'balance_adjustment');
    assert.equal(operation.amount, 20000);
    assert.equal(operation.status, 'posted');
    assert.equal(operation.revision, 1);
    assert.deepEqual(operation.details, {
      accountId: id(2), reason: 'Conciliar saldo real',
    });
    assert.equal(Object.hasOwn(operation.details, 'delta'), false);
    assert.equal(movement.operationId, operation.id);
    assert.equal(movement.targetType, 'account');
    assert.equal(movement.targetId, id(2));
    assert.equal(movement.effectType, 'asset_balance');
    assert.equal(movement.delta, 20000);
    assert.equal(updatedAccount.currentBalance, 120000);
    assert.equal(updatedAccount.openingBalance, 100000);
    assert.equal(updatedAccount.revision, 2);
    assert.equal((await f.storage.getAll('operations')).length, 1);
    assert.equal((await f.storage.getAll('movements')).length, 1);
    assert.deepEqual(await f.storage.getAll('operationRevisions'), []);
    assert.deepEqual(await f.storage.getAll('auditEvents'), auditsBefore);
    assert.deepEqual(completed.commit.affectedStores, DomainCommands.FINANCIAL_OPERATION_CREATE_STORES);
    assert.deepEqual(f.capture.command.affectedScopes, [
      `period:${id(1)}`, `account:${id(2)}`,
    ]);
    assert.equal(completed.commit.dataRevision, beforeRuntime.dataRevision + 1);
  });

  await t.test('negative delta and an exact zero resulting balance are valid', async (t2) => {
    const f = await fixture(t2);
    const completed = await createAdjustment(f, { delta: -100000 });
    assert.equal(completed.result.operation.amount, 100000);
    assert.equal(completed.result.movement.delta, -100000);
    assert.equal(completed.result.account.currentBalance, 0);
  });

  await t.test('a negative setup account can only be adjusted to a nonnegative result', async (t2) => {
    const valid = await fixture(t2, {
      account: { openingBalance: -1000, currentBalance: -1000 },
    });
    assert.equal((await createAdjustment(valid, { delta: 1000 })).result.account.currentBalance, 0);

    const invalid = await fixture(t2, {
      account: { openingBalance: -1000, currentBalance: -1000 },
    });
    assert.equal(
      (await rejection(createAdjustment(invalid, { delta: 999 }))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
  });

  await t.test('zero, decimal, unsafe delta, and empty reason are rejected without effects', async (t2) => {
    const cases = [
      { delta: 0 },
      { delta: 1.5 },
      { delta: Number.MAX_SAFE_INTEGER + 1 },
      { reason: '' },
      { reason: '   ' },
    ];
    for (const patch of cases) {
      const f = await fixture(t2);
      await rejection(createAdjustment(f, patch));
      assert.deepEqual(await f.storage.getAll('operations'), []);
      assert.deepEqual(await f.storage.getAll('movements'), []);
      assert.equal((await f.storage.get('accounts', id(2))).currentBalance, 100000);
    }
  });

  await t.test('insufficient balance, missing account, and inactive account are rejected', async (t2) => {
    const insufficient = await fixture(t2);
    assert.equal(
      (await rejection(createAdjustment(insufficient, { delta: -100001 }))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const missing = await fixture(t2);
    const input = await commonInput(missing);
    await missing.storage.remove('accounts', id(2));
    assert.equal(
      (await rejection(missing.commands.balanceAdjustment.create({
        ...input, operationDate: '2026-08-05', delta: 1, reason: 'Corrección',
      }))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const inactive = await fixture(t2);
    const stored = await inactive.storage.get('accounts', id(2));
    await inactive.storage.put('accounts', { ...stored, currentBalance: 0, status: 'inactive' });
    assert.equal(
      (await rejection(createAdjustment(inactive, { delta: 1 }))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
  });

  await t.test('invalid, outside-period, and future dates are rejected', async (t2) => {
    for (const operationDate of ['2026-02-30', '2026-07-31', '2026-08-06']) {
      const f = await fixture(t2);
      await rejection(createAdjustment(f, { operationDate }));
      assert.deepEqual(await f.storage.getAll('operations'), []);
    }
  });

  await t.test('missing, closed, or non-active Period is rejected', async (t2) => {
    const missing = await fixture(t2);
    await missing.storage.remove('periods', id(1));
    assert.equal((await rejection(createAdjustment(missing))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);

    const closed = await fixture(t2);
    await closed.storage.put('periods', period({ status: 'closed', closedAt: START }));
    assert.equal((await rejection(createAdjustment(closed))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);

    const other = await fixture(t2);
    const runtimeState = await other.storage.get('system', 'runtime');
    await other.storage.put('system', { ...runtimeState, activePeriodId: id(9) });
    assert.equal((await rejection(createAdjustment(other))).code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
  });
});

test('V1.1.0 balance-adjustment.edit', async (t) => {
  await t.test('amount, sign, date, reason, and combined edits reuse one Movement', async (t2) => {
    const f = await fixture(t2);
    let created = (await createAdjustment(f)).result;
    const movementId = created.movement.id;
    const changes = [
      { delta: 30000 },
      { delta: -10000 },
      { operationDate: '2026-08-04' },
      { reason: 'Motivo actualizado' },
      { operationDate: '2026-08-03', delta: 5000, reason: 'Edición conjunta' },
    ];
    for (const patch of changes) {
      f.clock.advance(1000);
      const completed = await editAdjustment(f, created.operation, patch);
      created = completed.result;
      assert.equal(created.movement.id, movementId);
      assert.equal((await f.storage.getAll('movements')).length, 1);
      assert.equal(created.operation.revision, created.operationRevision.revisionNumber + 1);
    }
    assert.equal(created.operation.operationDate, '2026-08-03');
    assert.deepEqual(created.operation.details, {
      accountId: id(2), reason: 'Edición conjunta',
    });
    assert.equal(Object.hasOwn(created.operation.details, 'delta'), false);
    assert.equal(created.account.currentBalance, 105000);
    assert.equal((await f.storage.getAll('operationRevisions')).length, 5);
  });

  await t.test('reversal and reapplication are atomic and snapshot the complete prior state', async (t2) => {
    const f = await fixture(t2);
    const auditsBefore = await f.storage.getAll('auditEvents');
    const created = (await createAdjustment(f)).result;
    f.clock.advance(1000);
    const completed = await editAdjustment(f, created.operation, { delta: 10000 });
    const revision = completed.result.operationRevision;
    assert.equal(completed.result.account.currentBalance, 110000);
    assert.equal(revision.changeType, 'edit');
    assert.deepEqual(revision.previousOperation, created.operation);
    assert.deepEqual(revision.previousMovements, [created.movement]);
    assert.equal(Object.isFrozen(revision.previousOperation), true);
    assert.equal(Object.isFrozen(revision.previousMovements[0]), true);
    assert.equal(revision.reason, null);
    assert.equal(completed.result.operation.createdAt, created.operation.createdAt);
    assert.equal(completed.result.movement.createdAt, created.movement.createdAt);
    assert.deepEqual(completed.commit.affectedStores, DomainCommands.FINANCIAL_OPERATION_CHANGE_STORES);
    assert.deepEqual(f.capture.command.affectedScopes, [
      `period:${id(1)}`, `account:${id(2)}`,
    ]);
    assert.deepEqual(await f.storage.getAll('auditEvents'), auditsBefore);
  });

  await t.test('no-op, extra fields, stale revisions, missing and wrong operations are rejected', async (t2) => {
    const noOp = await fixture(t2);
    const created = (await createAdjustment(noOp)).result;
    assert.equal(
      (await rejection(editAdjustment(noOp, created.operation, { delta: 20000 }))).code,
      Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD
    );
    assert.equal(
      (await rejection(editAdjustment(noOp, created.operation, { memo: 'x' }))).code,
      Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD
    );
    assert.equal(
      (await rejection(editAdjustment(noOp, { ...created.operation, revision: 99 }, { delta: 1 }))).code,
      Contracts.ERROR_CODES.REVISION_CONFLICT
    );

    const missing = await fixture(t2);
    assert.equal(
      (await rejection(editAdjustment(missing, { id: id(90), revision: 1 }, { delta: 1 }))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const wrongType = await fixture(t2);
    const wrong = (await createAdjustment(wrongType)).result;
    await wrongType.storage.put('operations', { ...wrong.operation, type: 'salary_receipt' });
    assert.equal(
      (await rejection(editAdjustment(wrongType, wrong.operation, { delta: 1 }))).code,
      Contracts.ERROR_CODES.DOMAIN_RELATION_MISMATCH
    );
  });

  await t.test('a voided operation and insufficient reversal or reapplication are rejected', async (t2) => {
    const voidedFixture = await fixture(t2);
    const created = (await createAdjustment(voidedFixture)).result;
    const voided = (await voidAdjustment(voidedFixture, created.operation)).result;
    assert.equal(
      (await rejection(editAdjustment(voidedFixture, voided.operation, { delta: 1 }))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const reapply = await fixture(t2);
    const negative = (await createAdjustment(reapply, { delta: -50000 })).result;
    assert.equal(
      (await rejection(editAdjustment(reapply, negative.operation, { delta: -100001 }))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const reverse = await fixture(t2, { account: { openingBalance: 0, currentBalance: 0 } });
    const positive = (await createAdjustment(reverse, { delta: 100 })).result;
    await createAdjustment(reverse, { delta: -100, reason: 'Consumir saldo' });
    assert.equal(
      (await rejection(editAdjustment(reverse, positive.operation, { delta: 200 }))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
  });

  await t.test('logical OperationRevision duplicates are rejected atomically', async (t2) => {
    const f = await fixture(t2);
    const created = (await createAdjustment(f)).result;
    await f.storage.add('operationRevisions', {
      id: id(80),
      operationId: created.operation.id,
      periodId: id(1),
      revisionNumber: 1,
      changeType: 'edit',
      previousOperation: created.operation,
      previousMovements: [created.movement],
      reason: null,
      createdAt: '2026-08-05T12:00:02.000Z',
    });
    const before = await financialSnapshot(f.storage);
    await rejection(editAdjustment(f, created.operation, { delta: 30000 }));
    assert.deepEqual(await financialSnapshot(f.storage), before);
  });
});

test('V1.1.0 operation.void for balance adjustments', async (t) => {
  await t.test('voids a positive adjustment, restores balance, and preserves history', async (t2) => {
    const f = await fixture(t2);
    const auditsBefore = await f.storage.getAll('auditEvents');
    const created = (await createAdjustment(f)).result;
    f.clock.advance(1000);
    const completed = await voidAdjustment(f, created.operation, { reason: 'Ajuste incorrecto' });
    assert.equal(completed.result.account.currentBalance, 100000);
    assert.equal(completed.result.operation.status, 'voided');
    assert.equal(completed.result.operation.revision, 2);
    assert.equal(completed.result.operation.voidReason, 'Ajuste incorrecto');
    assert.ok(completed.result.operation.voidedAt);
    assert.equal(completed.result.movement.status, 'voided');
    assert.equal(completed.result.movement.id, created.movement.id);
    assert.equal(completed.result.movement.delta, created.movement.delta);
    assert.equal(completed.result.operationRevision.changeType, 'void');
    assert.deepEqual(completed.result.operationRevision.previousOperation, created.operation);
    assert.deepEqual(completed.result.operationRevision.previousMovements, [created.movement]);
    assert.equal(completed.result.operationRevision.reason, 'Ajuste incorrecto');
    assert.deepEqual(completed.commit.affectedStores, DomainCommands.FINANCIAL_OPERATION_CHANGE_STORES);
    assert.deepEqual(f.capture.command.affectedScopes, [
      `period:${id(1)}`, `account:${id(2)}`,
    ]);
    assert.deepEqual(await f.storage.getAll('auditEvents'), auditsBefore);
  });

  await t.test('voids a negative adjustment and permits an omitted reason', async (t2) => {
    const f = await fixture(t2);
    const created = (await createAdjustment(f, { delta: -30000 })).result;
    const completed = await voidAdjustment(f, created.operation);
    assert.equal(completed.result.account.currentBalance, 100000);
    assert.equal(completed.result.operation.voidReason, null);
    assert.equal(completed.result.operationRevision.reason, null);
  });

  await t.test('double void, stale revision, and unsupported type are rejected', async (t2) => {
    const double = await fixture(t2);
    const created = (await createAdjustment(double)).result;
    const voided = (await voidAdjustment(double, created.operation)).result;
    assert.equal(
      (await rejection(voidAdjustment(double, voided.operation))).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );

    const stale = await fixture(t2);
    const staleCreated = (await createAdjustment(stale)).result;
    assert.equal(
      (await rejection(voidAdjustment(stale, { ...staleCreated.operation, revision: 2 }))).code,
      Contracts.ERROR_CODES.REVISION_CONFLICT
    );

    const wrong = await fixture(t2);
    const wrongCreated = (await createAdjustment(wrong)).result;
    await wrong.storage.put('operations', { ...wrongCreated.operation, type: 'additional_income' });
    assert.equal(
      (await rejection(voidAdjustment(wrong, wrongCreated.operation))).code,
      Contracts.ERROR_CODES.DOMAIN_RELATION_MISMATCH
    );
  });

  await t.test('void is blocked when reversing an entry would leave a negative balance', async (t2) => {
    const f = await fixture(t2, { account: { openingBalance: 0, currentBalance: 0 } });
    const incoming = (await createAdjustment(f, { delta: 100 })).result;
    await createAdjustment(f, { delta: -100, reason: 'Salida posterior' });
    const before = await financialSnapshot(f.storage);
    const error = await rejection(voidAdjustment(f, incoming.operation));
    assert.equal(error.code, Contracts.ERROR_CODES.DOMAIN_STATE_INVALID);
    assert.equal(error.context.missingAmount, 100);
    assert.deepEqual(await financialSnapshot(f.storage), before);
  });
});

test('V1.1.0 financial engine runtime gates and atomicity', async (t) => {
  await t.test('stale data revision, stale epoch, expired lease, and write disabled are delegated', async (t2) => {
    const staleData = await fixture(t2);
    assert.equal(
      (await rejection(createAdjustment(staleData, { expectedDataRevision: 0 }))).code,
      Contracts.ERROR_CODES.STALE_REVISION
    );

    const staleEpoch = await fixture(t2);
    assert.equal(
      (await rejection(createAdjustment(staleEpoch, { expectedWriterEpoch: 2 }))).code,
      Contracts.ERROR_CODES.WRITER_EPOCH_LOST
    );

    const expired = await fixture(t2);
    expired.clock.advance(LEASE_MS + 1);
    assert.equal(
      (await rejection(createAdjustment(expired))).code,
      Contracts.ERROR_CODES.WRITER_LEASE_EXPIRED
    );

    const disabled = await fixture(t2);
    await disabled.runtime.setWriteEnabled({ enabled: false, reason: 'test' });
    assert.equal(
      (await rejection(createAdjustment(disabled))).code,
      Contracts.ERROR_CODES.WRITE_DISABLED
    );
  });

  await t.test('restricted account/period scopes and diagnostic_only are delegated', async (t2) => {
    for (const policy of [
      { healthStatus: 'restricted', restrictedScopes: [`account:${id(2)}`], code: 'RESTRICTED_SCOPE' },
      { healthStatus: 'restricted', restrictedScopes: [`period:${id(1)}`], code: 'RESTRICTED_SCOPE' },
      { healthStatus: 'diagnostic_only', restrictedScopes: [], code: 'DIAGNOSTIC_ONLY' },
    ]) {
      const f = await fixture(t2);
      const state = await f.storage.get('system', 'runtime');
      await f.storage.put('system', {
        ...state,
        healthStatus: policy.healthStatus,
        restrictedScopes: policy.restrictedScopes,
      });
      assert.equal((await rejection(createAdjustment(f))).code, policy.code);
    }
  });

  await t.test('failures in every financial/technical write roll back the whole command', async (t2) => {
    const failures = [
      ['accounts', 'put', 'create'],
      ['operations', 'add', 'create'],
      ['movements', 'add', 'create'],
      ['accounts', 'put', 'edit'],
      ['operations', 'put', 'edit'],
      ['movements', 'put', 'edit'],
      ['operationRevisions', 'add', 'edit'],
      ['commits', 'add', 'create'],
      ['system', 'put', 'create'],
    ];
    for (const [storeName, method, commandType] of failures) {
      const factory = new IDBFactory();
      const base = await fixture(t2, { factory });
      let created;
      if (commandType === 'edit') created = (await createAdjustment(base)).result;
      const before = await financialSnapshot(base.storage);
      const failingStorage = wrapFailingStorage(base.storage, storeName, method);
      const failingRuntime = makeRuntime(failingStorage, base.clock);
      const failingCommands = makeCommands(failingRuntime, base.clock, null, uuidSequence('c5000000'));
      await rejection(commandType === 'create'
        ? failingCommands.balanceAdjustment.create({
          ...await commonInput(base),
          operationDate: '2026-08-05', delta: 10, reason: 'Fallo inducido',
        })
        : failingCommands.balanceAdjustment.edit({
          ...await commonInput(base),
          operationId: created.operation.id,
          expectedOperationRevision: created.operation.revision,
          delta: 10,
        }));
      assert.deepEqual(await financialSnapshot(base.storage), before, `${storeName}.${method}`);
    }
  });

  await t.test('create, edit, and void each advance dataRevision exactly once and reload coherently', async (t2) => {
    const factory = new IDBFactory();
    const f = await fixture(t2, { factory });
    const initial = await f.storage.get('system', 'runtime');
    const created = await createAdjustment(f);
    f.clock.advance(1000);
    const edited = await editAdjustment(f, created.result.operation, { delta: 10000 });
    f.clock.advance(1000);
    const voided = await voidAdjustment(f, edited.result.operation);
    assert.equal(created.commit.dataRevision, initial.dataRevision + 1);
    assert.equal(edited.commit.dataRevision, initial.dataRevision + 2);
    assert.equal(voided.commit.dataRevision, initial.dataRevision + 3);
    assert.equal((await f.storage.get('accounts', id(2))).currentBalance, 100000);
    f.storage.close();
    const reloaded = makeStorage(factory);
    await reloaded.open();
    t2.after(() => reloaded.close());
    assert.equal((await reloaded.get('operations', created.result.operation.id)).status, 'voided');
    assert.equal((await reloaded.getAll('movements'))[0].status, 'voided');
    assert.equal((await reloaded.getAll('operationRevisions')).length, 2);
    assert.equal((await reloaded.get('accounts', id(2))).currentBalance, 100000);
  });
});

test('V1.1.0 financial engine integrity invariants', async (t) => {
  function makeIntegrity(f) {
    if (!f.integrity) {
      f.integrity = Integrity.createPeritaIntegrity({
        storage: f.storage,
        now: f.clock.now,
        createUuid: uuidSequence('c6000000'),
      });
    }
    return f.integrity;
  }

  await t.test('state remains integral after create, edit, and void', async (t2) => {
    const f = await fixture(t2);
    const created = await createAdjustment(f);
    f.clock.advance(1000);
    const edited = await editAdjustment(f, created.result.operation, { delta: -10000 });
    assert.equal((await makeIntegrity(f).runFullCheck()).status, 'ok');
    f.clock.advance(1000);
    await voidAdjustment(f, edited.result.operation);
    assert.equal((await makeIntegrity(f).runFullCheck()).status, 'ok');
  });

  await t.test('wrong cardinality and wrong target are detected', async (t2) => {
    const cardinality = await fixture(t2);
    const created = (await createAdjustment(cardinality)).result;
    await cardinality.storage.add('movements', {
      ...created.movement,
      id: id(70),
    });
    let report = await makeIntegrity(cardinality).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'BALANCE_ADJUSTMENT_MOVEMENT_CARDINALITY'));

    const target = await fixture(t2);
    const targetCreated = (await createAdjustment(target)).result;
    await target.storage.put('movements', {
      ...targetCreated.movement,
      targetType: 'savings_goal',
    });
    report = await makeIntegrity(target).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'BALANCE_ADJUSTMENT_TARGET_INVALID'));
  });

  await t.test('operation/movement status mismatch and logical revision duplicate are detected', async (t2) => {
    const mismatch = await fixture(t2);
    const created = (await createAdjustment(mismatch)).result;
    await mismatch.storage.put('movements', { ...created.movement, status: 'voided' });
    let report = await makeIntegrity(mismatch).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'MOVEMENT_OPERATION_STATUS_MISMATCH'));

    const duplicate = await fixture(t2);
    const duplicateCreated = (await createAdjustment(duplicate)).result;
    const edited = (await editAdjustment(duplicate, duplicateCreated.operation, { delta: 10000 })).result;
    await duplicate.storage.add('operationRevisions', {
      ...edited.operationRevision,
      id: id(71),
    });
    report = await makeIntegrity(duplicate).checkRelationships();
    assert.ok(report.issues.some((issue) => issue.code === 'OPERATION_REVISION_LOGICAL_DUPLICATE'));
  });

  await t.test('posted movements participate in balance and voided movements do not', async (t2) => {
    const f = await fixture(t2);
    const created = (await createAdjustment(f)).result;
    assert.equal((await makeIntegrity(f).checkBalances()).status, 'ok');
    await f.storage.put('accounts', { ...created.account, currentBalance: 100000 });
    let report = await makeIntegrity(f).checkBalances();
    assert.ok(report.issues.some((issue) => issue.code === 'ENTITY_BALANCE_DIVERGENCE'));
    await f.storage.put('movements', { ...created.movement, status: 'voided' });
    await f.storage.put('operations', { ...created.operation, status: 'voided', voidedAt: START });
    report = await makeIntegrity(f).checkBalances();
    assert.equal(report.status, 'ok');
  });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const IndexedDb = require('../perita-indexeddb.js');
const PeritaApp = require('../perita-app.js');

const NOW = '2026-08-05T12:00:00.000Z';
const DATE = '2026-08-05';

function id(number) {
  return `f1000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function sequence(prefix) {
  let number = 1;
  return () => `${prefix}-0000-4000-8000-${String(number++).padStart(12, '0')}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function legacyStorage(raw) {
  const writes = [];
  return {
    writes,
    getItem: (key) => key === 'perita_v1' ? raw : null,
    setItem: (...args) => writes.push(args),
    removeItem: (...args) => writes.push(args),
  };
}

function sessionStore() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    clone: () => {
      const copy = sessionStore();
      values.forEach((value, key) => copy.setItem(key, value));
      return copy;
    },
  };
}

function application(factory, options) {
  const settings = options || {};
  return PeritaApp.createPeritaApplication({
    indexedDB: factory,
    IDBKeyRange,
    crypto: { randomUUID: () => id(900) },
    legacyStorage: settings.legacyStorage || legacyStorage(null),
    now: () => NOW,
    createUuid: sequence(settings.prefix || 'f2000000'),
    sha256,
    tabId: settings.tabId || 'integration-tab-a',
    channel: null,
  });
}

function setupPayload() {
  return {
    currentCivilDate: DATE,
    financialSettings: {
      key: 'current', salaryReferenceAmount: 900000, currency: 'CLP',
      timezone: 'America/Santiago', revision: 1, createdAt: NOW, updatedAt: NOW,
    },
    period: {
      id: id(1), periodKey: '2026-08', status: 'open', plannedSalaryAmount: 900000,
      openedAt: NOW, closedAt: null, snapshotId: null, revision: 1,
    },
    accounts: [{
      id: id(2), name: 'Cuenta principal', openingBalance: 100000,
      currentBalance: 100000, status: 'active', revision: 1,
      createdAt: NOW, updatedAt: NOW,
    }],
  };
}

function legacyState() {
  return {
    settings:{salary:900000},
    accounts:[{id:1,name:'Cuenta legado',type:'bank',bank:'Banco',balance:150000}],
    debts:[],wallets:[],budget:[],varCategories:[],nextId:2,
    activeMonth:{month:'2026-08',expenses:[],pagosDeuda:[],aportesAhorro:[],gastosFijosPagados:[]},
    monthlyHistory:[{month:'2026-07',salary:850000,closedAt:'2026-07-31T23:00:00.000Z',expenses:[],pagosDeuda:[],aportesAhorro:[],gastosFijosPagados:[]}],
    expenses:[],
  };
}

test('application integration initializes a new install without touching legacy storage', async (t) => {
  const factory = new IDBFactory();
  const source = legacyStorage(null);
  const app = application(factory, { legacyStorage: source });
  t.after(() => app.close());
  const initialized = await app.initialize();
  assert.equal(initialized.phase, 'setup_required');
  assert.equal(initialized.writer, true);
  assert.equal(source.writes.length, 0);

  const completed = await app.completeSetup(setupPayload());
  assert.equal(completed.state.runtime.setupStatus, 'completed');
  assert.equal(completed.state.accounts[0].balance, 100000);
  assert.equal(completed.state.summary.totalIncomeAmount, 0);
  assert.equal(source.writes.length, 0);
});

test('application adapter delegates a UI intent to a domain command and reloads IndexedDB', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory);
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());

  const updated = await app.execute('financial-settings.update-reference-salary', {
    salaryReferenceAmount: 950000,
  });
  assert.equal(updated.state.settings.salary, 950000);
  assert.equal(updated.state.financialSettings.revision, 2);
  assert.equal(updated.state.runtime.dataRevision, 3);
  assert.equal(updated.state.operations.length, 0);
  assert.equal(updated.state.movements.length, 0);
});

test('an incomplete setup renews its writer after page teardown and reload', async (t) => {
  const factory = new IDBFactory();
  const tabSession = sessionStore();
  const create = (prefix, navigationType) => PeritaApp.createPeritaApplication({
    indexedDB: factory,
    IDBKeyRange,
    crypto: { randomUUID: () => id(900) },
    legacyStorage: legacyStorage(null),
    sessionStorage: tabSession,
    navigationType,
    now: () => NOW,
    createUuid: sequence(prefix),
    channel: null,
  });
  const first = create('f3100000', 'navigate');
  const initial = await first.initialize();
  assert.equal(initial.phase, 'setup_required');
  assert.equal(initial.writer, true);
  const originalEpoch = initial.writerEpoch;
  first.suspend();

  const reopened = create('f3200000', 'reload');
  t.after(() => reopened.close());
  const next = await reopened.initialize();
  assert.equal(next.phase, 'setup_required');
  assert.equal(next.writer, true);
  assert.equal(next.writerEpoch, originalEpoch);
  assert.equal(next.error, undefined);
});

test('a duplicated or separate tab never reuses the active writer identity', async (t) => {
  const factory = new IDBFactory();
  const firstSession = sessionStore();
  const create = (prefix, tabSession) => PeritaApp.createPeritaApplication({
    indexedDB: factory,
    IDBKeyRange,
    crypto: { randomUUID: () => id(900) },
    legacyStorage: legacyStorage(null),
    sessionStorage: tabSession,
    navigationType: 'navigate',
    now: () => NOW,
    createUuid: sequence(prefix),
    channel: null,
  });
  const first = create('f3500000', firstSession);
  t.after(() => first.close());
  assert.equal((await first.initialize()).phase, 'setup_required');

  const duplicate = create('f3600000', firstSession.clone());
  t.after(() => duplicate.close());
  const duplicateState = await duplicate.initialize();
  assert.equal(duplicateState.phase, 'read_only');
  assert.equal(duplicateState.writer, false);
  assert.equal(duplicateState.error.code, 'WRITER_ALREADY_OWNED');

  const separate = create('f3700000', sessionStore());
  t.after(() => separate.close());
  const separateState = await separate.initialize();
  assert.equal(separateState.phase, 'read_only');
  assert.equal(separateState.writer, false);
  assert.equal(separateState.error.code, 'WRITER_ALREADY_OWNED');
});

test('retired monthly-planning values in an existing V1.1.0 Period are ignored compatibly', async (t) => {
  const factory = new IDBFactory();
  const first = application(factory, { tabId: 'compatibility-tab-a', prefix: 'f3300000' });
  await first.initialize();
  await first.completeSetup(setupPayload());
  await first.close();

  const storage = IndexedDb.createPeritaIndexedDb({ indexedDB: factory, IDBKeyRange });
  await storage.open();
  const period = await storage.get('periods', id(1));
  await storage.put('periods', {
    ...period,
    variableExpenseBudgetAmount: 123456,
    plannedSavingsAmount: 654321,
  });
  storage.close();

  const reopened = application(factory, { tabId: 'compatibility-tab-b', prefix: 'f3400000' });
  t.after(() => reopened.close());
  const initialized = await reopened.initialize();
  assert.notEqual(initialized.phase, 'error');
  assert.equal(Object.hasOwn(initialized.state.period, 'variableExpenseBudgetAmount'), false);
  assert.equal(Object.hasOwn(initialized.state.period, 'plannedSavingsAmount'), false);
  const backup = await reopened.exportBackup();
  assert.equal(Object.hasOwn(backup.data.periods[0], 'variableExpenseBudgetAmount'), false);
  assert.equal(Object.hasOwn(backup.data.periods[0], 'plannedSavingsAmount'), false);
});

test('financial UI adapter enriches create, edit, and void revisions from canonical state', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory, { prefix: 'f7000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  const categoryId = id(30);
  await app.execute('category.create', { category: {
    id: categoryId, name: 'Comida', status: 'active', revision: 1, createdAt: NOW, updatedAt: NOW,
  } });
  const created = await app.execute('variable-expense.create', {
    accountId: id(2), categoryId, operationDate: DATE, amount: 10000,
    concept: 'Almuerzo', observation: null,
  });
  const operationId = created.result.result.operation.id;
  const edited = await app.execute('variable-expense.edit', {
    operationId, accountId: id(2), categoryId, amount: 12000,
  });
  assert.equal(edited.result.result.operation.revision, 2);
  const voided = await app.execute('variable-expense.void', {
    operationId, reason: 'Duplicado',
  });
  assert.equal(voided.result.result.operation.status, 'voided');
  assert.equal(voided.state.accounts[0].balance, 100000);
  assert.equal(voided.state.operationRevisions.length, 2);
});

test('a second tab is visibly read-only while the first writer lease is active', async (t) => {
  const factory = new IDBFactory();
  const first = application(factory, { tabId: 'integration-tab-a', prefix: 'f3000000' });
  const second = application(factory, { tabId: 'integration-tab-b', prefix: 'f4000000' });
  t.after(async () => { await second.close(); await first.close(); });
  await first.initialize();
  await first.completeSetup(setupPayload());

  const initialized = await second.initialize();
  assert.equal(initialized.phase, 'ready_read_only');
  assert.equal(initialized.writer, false);
  await assert.rejects(
    second.execute('financial-settings.update-reference-salary', { salaryReferenceAmount: 1 }),
    /solo lectura/
  );
});

test('a read-only tab can take over after the previous writer releases its lease', async (t) => {
  const factory = new IDBFactory();
  const first = application(factory, { tabId: 'takeover-tab-a', prefix: 'fb000000' });
  const second = application(factory, { tabId: 'takeover-tab-b', prefix: 'fc000000' });
  t.after(() => second.close());
  await first.initialize();
  await first.completeSetup(setupPayload());
  assert.equal((await second.initialize()).phase, 'ready_read_only');
  await first.close();

  const takeover = await second.takeOverWriter();
  assert.equal(takeover.writer.ownerTabId, 'takeover-tab-b');
  assert.equal(takeover.state.runtime.writeEnabled, true);
  assert.notEqual(takeover.report.status, 'diagnostic_only');
});

test('a lost writer epoch is surfaced as a typed error and persists no command effect', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory, { tabId: 'stale-tab-a', prefix: 'fd000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  const storage = IndexedDb.createPeritaIndexedDb({ indexedDB: factory, IDBKeyRange });
  t.after(() => storage.close());
  await storage.open();
  const previous = await storage.get('coordination', 'writer');
  await storage.put('coordination', {
    ...previous,
    ownerTabId: 'stale-tab-b',
    epoch: previous.epoch + 1,
    heartbeatAt: NOW,
    expiresAt: '2026-08-05T12:01:00.000Z',
    status: 'active',
  });

  await assert.rejects(
    app.execute('financial-settings.update-reference-salary', { salaryReferenceAmount: 950000 }),
    (error) => error.code === 'WRITER_EPOCH_LOST'
  );
  assert.equal((await app.refresh()).settings.salary, 900000);
});

test('an integrity mismatch initializes visibly restricted instead of silently repairing data', async (t) => {
  const factory = new IDBFactory();
  const first = application(factory, { tabId: 'integrity-tab-a', prefix: 'fe000000' });
  await first.initialize();
  await first.completeSetup(setupPayload());
  await first.close();
  const storage = IndexedDb.createPeritaIndexedDb({ indexedDB: factory, IDBKeyRange });
  await storage.open();
  const account = await storage.get('accounts', id(2));
  await storage.put('accounts', { ...account, currentBalance: account.currentBalance + 1 });
  storage.close();

  const second = application(factory, { tabId: 'integrity-tab-b', prefix: 'ff000000' });
  t.after(() => second.close());
  const initialized = await second.initialize();
  assert.ok(['warning', 'restricted', 'diagnostic'].includes(initialized.phase), initialized.phase);
  assert.notEqual(initialized.report.status, 'ok');
  assert.equal(initialized.state.accounts[0].balance, 100001);
});

test('legacy initialization performs dry-run, confirms cutover, and preserves perita_v1', async (t) => {
  const factory = new IDBFactory();
  const raw = JSON.stringify(legacyState());
  const source = legacyStorage(raw);
  const app = application(factory, { legacyStorage: source, prefix: 'f8000000' });
  t.after(() => app.close());
  const initialized = await app.initialize();
  assert.equal(initialized.phase, 'migration_pending');
  assert.notEqual(initialized.dryRun.classification, 'blocked');
  const migrated = await app.confirmMigration(initialized.dryRun);
  assert.equal(migrated.state.runtime.setupStatus, 'completed');
  assert.equal(migrated.state.operations.length, 0);
  assert.equal(migrated.state.movements.length, 0);
  assert.equal(migrated.state.migrations.length, 1);
  assert.equal(source.getItem('perita_v1'), raw);
  assert.equal(source.writes.length, 0);
});

test('a blocked legacy dry-run never enables V1.1.0 writes', async (t) => {
  const factory = new IDBFactory();
  const blocked = legacyState();
  blocked.expenses = [{ id: 99, type: 'income', date: DATE, amount: 1, account: 1 }];
  const app = application(factory, {
    legacyStorage: legacyStorage(JSON.stringify(blocked)), prefix: 'be000000',
  });
  t.after(() => app.close());
  const initialized = await app.initialize();
  assert.equal(initialized.phase, 'migration_blocked');
  assert.equal(initialized.state.runtime.writeEnabled, false);
  assert.equal(initialized.state.runtime.dataRevision, 0);
});

test('a storage read failure is an explicit error and never a fresh install', async () => {
  const storage = {
    open: async () => { throw new Error('induced read failure'); },
    runTransaction: async () => { throw new Error('must not run'); },
  };
  const noop = () => Promise.resolve();
  const app = PeritaApp.createPeritaApplication({
    storage,
    runtime: { getWriterState: noop, acquireWriter: noop, setWriteEnabled: noop },
    commands: {},
    integrity: { runFullCheck: noop },
    migration: {},
    backup: {},
    legacyStorage: legacyStorage(null),
    createUuid: sequence('f5000000'),
    tabId: 'failure-tab',
    channel: null,
  });
  const initialized = await app.initialize();
  assert.equal(initialized.phase, 'error');
  assert.equal(initialized.state, null);
  assert.match(initialized.error.message, /induced read failure/);
});

test('all approved V1.1.0 UI command paths are exposed by the adapter', () => {
  const names = Object.keys(PeritaApp.COMMANDS);
  for (const required of [
    'balance-adjustment.create', 'salary-receipt.create', 'additional-income.edit',
    'variable-expense.void', 'fixed-expense-payment.create', 'debt-payment.edit',
    'debt-total-adjustment.create', 'savings-deposit.create', 'savings-withdrawal.void',
    'transfer.edit', 'period.close-and-open-next', 'fixed-expense-instance.update-planned-amount',
  ]) assert.ok(names.includes(required), required);
});

test('browser synchronous SHA-256 matches standard vectors required by monthly close', () => {
  assert.equal(PeritaApp.browserSha256(''), sha256(''));
  assert.equal(PeritaApp.browserSha256('Perita 💰'), sha256('Perita 💰'));
});

test('backup restore integration replaces state, rechecks integrity, and re-enables normal writing', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory, { prefix: 'f6000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  const target = await app.exportBackup();
  await app.execute('financial-settings.update-reference-salary', { salaryReferenceAmount: 1 });
  const restored = await app.restoreBackup(target);
  assert.equal(restored.state.settings.salary, 900000);
  assert.equal(restored.state.runtime.writeEnabled, true);
  assert.notEqual(restored.report.status, 'diagnostic_only');
});

test('an invalid backup is rejected before restore and leaves canonical data intact', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory, { prefix: 'ab000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  const backup = await app.exportBackup();
  const invalid = { ...backup, dataRevision: backup.dataRevision + 1 };
  const validation = await app.validateBackup(invalid);
  assert.equal(validation.status, 'invalid');
  assert.ok(validation.errors.some((error) => error.code === 'BACKUP_HASH_MISMATCH'));
  assert.equal((await app.refresh()).settings.salary, 900000);
});

test('monthly-close adapter derives exact revisions and reloads the new period plus snapshot history', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory, { prefix: 'f9000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  await app.execute('salary-receipt.create', { accountId:id(2), operationDate:DATE, amount:900000 });
  const closed = await app.execute('period.close-and-open-next', {});
  assert.equal(closed.state.period.periodKey, '2026-09');
  assert.equal(closed.state.monthlyHistory.length, 1);
  assert.equal(closed.state.monthlyHistory[0].totals.totalIncomeAmount, 900000);
  assert.equal(closed.state.accounts[0].balance, 1000000);
});

test('fixed-expense monthly amount is updated independently from its future reference', async (t) => {
  const factory = new IDBFactory();
  const app = application(factory, { prefix: 'bd000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  await app.execute('fixed-expense-template.create', { template: {
    id: id(20), name: 'Arriendo', referenceAmount: 50000, status: 'active', revision: 1,
    createdAt: NOW, updatedAt: NOW,
  } });
  await app.execute('salary-receipt.create', { accountId: id(2), operationDate: DATE, amount: 900000 });
  const closed = await app.execute('period.close-and-open-next', {});
  const instance = closed.state.budget[0].instance;
  const updated = await app.execute('fixed-expense-instance.update-planned-amount', {
    instanceId: instance.id, plannedAmount: 62000,
  });
  assert.equal(updated.state.budget[0].instance.plannedAmount, 62000);
  assert.equal(updated.state.budget[0].amount, 50000);
});

test('definitive deletion integration requires external backup and exact ELIMINAR', async (t) => {
  const factory = new IDBFactory();
  const source = legacyStorage(null);
  const app = application(factory, { legacyStorage:source, prefix:'fa000000' });
  t.after(() => app.close());
  await app.initialize();
  await app.completeSetup(setupPayload());
  const externalBackup = await app.exportBackup();
  await assert.rejects(app.deleteAllData(externalBackup, 'Eliminar'));
  assert.notEqual(app.writerEpoch, null);
  const result = await app.deleteAllData(externalBackup, 'ELIMINAR');
  assert.equal(result.deleted, true);
  assert.equal(source.writes.length, 0);
});

test('static integration loads V1.1.0 modules in order and caches the complete offline shell', () => {
  const html = readFileSync(`${__dirname}/../index.html`, 'utf8');
  const jsx = readFileSync(`${__dirname}/../Perita.jsx`, 'utf8');
  const worker = readFileSync(`${__dirname}/../service-worker.js`, 'utf8');
  const ordered = [
    'perita-contracts.js','perita-indexeddb.js','perita-domain.js','perita-runtime.js',
    'perita-integrity.js','perita-legacy.js','perita-domain-commands.js','perita-backup.js',
    'perita-migration.js','perita-app.js',
  ];
  let cursor = -1;
  for (const file of ordered) {
    const index = html.indexOf(`src="${file}"`);
    assert.ok(index > cursor, file);
    cursor = index;
    assert.match(worker, new RegExp(`/${file.replace('.', '\\.')}`));
  }
  assert.doesNotMatch(jsx, /PeritaCore|localStorage\.(setItem|removeItem)/);
  assert.match(jsx, /fixed-expense-instance\.update-planned-amount/);
  assert.match(jsx, /La cuenta debe crearse en cero/);
  assert.match(jsx, /La meta debe crearse en cero/);
  assert.match(jsx, /const MoneyInput/);
  assert.match(jsx, /const OtherPage/);
  assert.match(jsx, /history',label:'Historial',icon:'document'/);
  assert.doesNotMatch(jsx, /Presupuesto variable|Ahorro planificado|Guardar planificación/);
  assert.match(worker, /perita-v110-shell-v1/);
  assert.match(html, /IndexedDB perita_v110/);
});

test('UI integration keeps setup, navigation, icons, hierarchy, and unsaved guards coherent', () => {
  const html = readFileSync(`${__dirname}/../index.html`, 'utf8');
  const jsx = readFileSync(`${__dirname}/../Perita.jsx`, 'utf8');

  assert.doesNotMatch(jsx, /Agregar otra cuenta|Quitar cuenta/);
  assert.match(jsx, /accounts:\[\{id:recordId\(\),name:account\.name\.trim\(\)/);
  assert.match(jsx, /window\.scrollTo\(\{top:0,left:0,behavior:'auto'\}\)/);
  assert.match(jsx, /EmptyState icon="document" title="Aún no hay meses cerrados\."/);
  assert.match(jsx, /Agregar gasto fijo<\/button>/);
  assert.match(jsx, /className="btn btn-ghost" disabled=.*salary_receipt/);
  assert.match(jsx, /const \[pendingClose, setPendingClose\] = useState\(null\)/);
  assert.match(jsx, /setPendingClose\(\(\) => closeFn\)/);
  assert.equal((jsx.match(/if\(valid\) resetAndCloseForm\(\)/g)||[]).length, 2);

  assert.match(html, /\.form-input\{width:100%;min-width:0;max-width:100%/);
  assert.match(html, /\.items-start\{align-items:flex-start\}/);
  assert.match(html, /\.mb-1\{margin-bottom:4px\}.*\.mb-3\{margin-bottom:12px\}.*\.mb-5\{margin-bottom:20px\}/);
});

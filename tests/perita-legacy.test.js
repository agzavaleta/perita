'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const Contracts = require('../perita-contracts.js');
const Legacy = require('../perita-legacy.js');

function sha256(rawSource) {
  return createHash('sha256').update(rawSource, 'utf8').digest('hex');
}

function deterministicUuid(name) {
  return Contracts.deterministicUuid(Contracts.PERITA_MIGRATION_NAMESPACE_UUID, name);
}

function makeState() {
  return {
    settings: { salary: 900000 },
    accounts: [
      { id: 1, name: 'Cuenta principal', type: 'bank', bank: 'Banco', balance: 150000 },
      { id: 2, name: 'Efectivo', type: 'cash', bank: '', balance: -5000 },
    ],
    debts: [
      {
        id: 3,
        name: 'Crédito',
        total: 500000,
        paid: 125000,
        monthly: 50000,
        dueDate: '2027-08-15',
        status: 'activa',
      },
    ],
    wallets: [
      {
        id: 4,
        emoji: '🏠',
        name: 'Pie vivienda',
        bank: 'Banco',
        balance: 80000,
        monthly: 20000,
        goal: 1000000,
      },
    ],
    budget: [{ id: 5, name: 'Arriendo', amount: 350000 }],
    varCategories: [{ id: 6, name: 'Alimentación' }],
    nextId: 100,
    activeMonth: {
      month: '2026-08',
      expenses: [],
      pagosDeuda: [],
      aportesAhorro: [],
      gastosFijosPagados: [],
    },
    monthlyHistory: [],
    expenses: [],
  };
}

function raw(state) {
  return JSON.stringify(state);
}

async function dryRun(state, overrides) {
  return Legacy.createMigrationDryRun(raw(state), {
    sha256,
    createDeterministicUuid: deterministicUuid,
    ...(overrides || {}),
  });
}

function warningCodes(result) {
  return result.warnings.map((warning) => warning.code);
}

function blockerCodes(result) {
  return result.blockers.map((blocker) => blocker.code);
}

test('parseLegacySource hashes the exact raw source before parsing', async () => {
  const source = ' {\n  "settings": {"salary": 1}\n} ';
  const calls = [];
  const result = await Legacy.parseLegacySource(source, {
    sha256(value) {
      calls.push(value);
      return sha256(value);
    },
  });
  assert.deepEqual(calls, [source]);
  assert.equal(result.sourceHash, sha256(source));
  assert.equal(result.rawSource, source);
});

test('different insignificant JSON whitespace produces a different source hash', async () => {
  const compact = raw(makeState());
  const formatted = JSON.stringify(makeState(), null, 2);
  const first = await Legacy.parseLegacySource(compact, { sha256 });
  const second = await Legacy.parseLegacySource(formatted, { sha256 });
  assert.notEqual(first.sourceHash, second.sourceHash);
});

test('invalid JSON is hashed and rejected without an empty fallback', async () => {
  let hashed;
  await assert.rejects(
    Legacy.parseLegacySource('{broken', {
      sha256(value) {
        hashed = value;
        return sha256(value);
      },
    }),
    (error) => {
      assert.equal(error.code, Contracts.ERROR_CODES.LEGACY_JSON_INVALID);
      assert.equal(error.context.sourceHash, sha256('{broken'));
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    }
  );
  assert.equal(hashed, '{broken');
});

test('non-object JSON roots are rejected as an invalid legacy structure', async () => {
  await assert.rejects(
    Legacy.parseLegacySource('[]', { sha256 }),
    (error) => error.code === Contracts.ERROR_CODES.LEGACY_STRUCTURE_INVALID
  );
});

test('hash failures preserve their typed error and cause', async () => {
  const cause = new Error('digest unavailable');
  await assert.rejects(
    Legacy.parseLegacySource('{}', { sha256: async () => { throw cause; } }),
    (error) => {
      assert.equal(error.code, Contracts.ERROR_CODES.HASH_FAILED);
      assert.equal(error.cause, cause);
      return true;
    }
  );
});

test('a digest with a non-SHA-256 byte length is rejected as HASH_FAILED', async () => {
  await assert.rejects(
    Legacy.parseLegacySource('{}', { sha256: () => new Uint8Array(31) }),
    (error) => error.code === Contracts.ERROR_CODES.HASH_FAILED && error.cause instanceof TypeError
  );
});

test('the recognized complete V1 shape is migratable', async () => {
  const result = await dryRun(makeState());
  assert.equal(result.classification, 'migratable');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.blockers, []);
});

test('missing activeMonth is restricted and keeps top-level expenses as legacy-only', async () => {
  const state = makeState();
  delete state.activeMonth;
  state.expenses.push({
    id: 100,
    date: '2026-08-03',
    description: 'Ingreso extra',
    amount: 40000,
    type: 'income',
    account: 1,
  });
  const result = await dryRun(state);
  assert.equal(result.classification, 'restricted');
  assert.ok(warningCodes(result).includes('LEGACY_ACTIVE_MONTH_MISSING'));
  assert.equal(result.proposedEntities.periods.length, 0);
  assert.equal(result.proposedPeriodOpenings.length, 0);
  assert.equal(result.proposedLegacyEntries.length, 1);
  assert.equal(result.proposedLegacyEntries[0].periodId, null);
});

test('a partial activeMonth can preserve its validated top-level expenses alias', async () => {
  const state = makeState();
  delete state.activeMonth.expenses;
  state.expenses = [{
    id: 100,
    date: '2026-08-03',
    description: 'Ingreso extra',
    amount: 40000,
    type: 'income',
    account: 1,
  }];
  const result = await dryRun(state);
  assert.equal(result.classification, 'restricted');
  assert.ok(warningCodes(result).includes('LEGACY_MONTH_COLLECTION_MISSING'));
  assert.equal(result.proposedLegacyEntries.length, 1);
  assert.equal(result.proposedLegacyEntries[0].periodKey, '2026-08');
});

test('a historical month without salary is restricted and explicitly incomplete', async () => {
  const state = makeState();
  state.monthlyHistory.push({
    month: '2026-07',
    expenses: [],
    pagosDeuda: [],
    aportesAhorro: [],
    gastosFijosPagados: [],
  });
  const result = await dryRun(state);
  assert.equal(result.classification, 'restricted');
  assert.ok(warningCodes(result).includes('LEGACY_HISTORY_SALARY_MISSING'));
  assert.equal(result.proposedLegacySnapshots[0].salary, null);
  assert.equal(result.proposedLegacySnapshots[0].incomplete, true);
});

test('identical expenses aliases are deduplicated', async () => {
  const state = makeState();
  const entry = {
    id: 100,
    date: '2026-08-02',
    description: 'Venta',
    amount: 25000,
    type: 'income',
    account: 1,
  };
  state.activeMonth.expenses = [entry];
  state.expenses = [{ account: 1, type: 'income', amount: 25000, description: 'Venta', date: '2026-08-02', id: 100 }];
  const result = await dryRun(state);
  assert.equal(result.classification, 'migratable');
  assert.equal(result.proposedLegacyEntries.length, 1);
  assert.equal(result.counts.legacy.activeExpenses, 1);
});

test('different expenses aliases block the dry-run', async () => {
  const state = makeState();
  state.activeMonth.expenses = [{
    id: 100,
    date: '2026-08-02',
    description: 'Venta',
    amount: 25000,
    type: 'income',
    account: 1,
  }];
  state.expenses = [{ ...state.activeMonth.expenses[0], amount: 26000 }];
  const result = await dryRun(state);
  assert.equal(result.classification, 'blocked');
  assert.ok(blockerCodes(result).includes(Contracts.ERROR_CODES.LEGACY_ALIAS_MISMATCH));
  assert.equal(result.proposedEntities.accounts.length, 0);
});

test('unknown fields are diagnosed without inventing conversions', async () => {
  const state = makeState();
  state.futureRoot = { value: 1 };
  state.accounts[0].futureAccountField = 'opaque';
  const result = await dryRun(state);
  assert.equal(result.classification, 'migratable');
  assert.equal(warningCodes(result).filter((code) => code === 'LEGACY_UNKNOWN_FIELD').length, 2);
  assert.equal(result.proposedEntities.accounts[0].futureAccountField, undefined);
});

test('a recognized collection with the wrong type blocks mapping', async () => {
  const state = makeState();
  state.accounts = {};
  const result = await dryRun(state);
  assert.equal(result.classification, 'blocked');
  assert.ok(blockerCodes(result).includes(Contracts.ERROR_CODES.LEGACY_STRUCTURE_INVALID));
});

test('duplicate IDs across permanent legacy entities block mapping', async () => {
  const state = makeState();
  state.wallets[0].id = state.accounts[0].id;
  const result = await dryRun(state);
  assert.equal(result.classification, 'blocked');
  assert.ok(blockerCodes(result).includes(Contracts.ERROR_CODES.LEGACY_AMBIGUITY));
});

test('duplicate transaction IDs across active and historical months block mapping', async () => {
  const state = makeState();
  state.activeMonth.expenses = [{ id: 100, date: '2026-08-02', description: 'Extra', amount: 1, type: 'income', account: 1 }];
  state.expenses = structuredClone(state.activeMonth.expenses);
  state.monthlyHistory = [{
    month: '2026-07', salary: 900000,
    expenses: [{ id: 100, date: '2026-07-02', description: 'Extra', amount: 1, type: 'income', account: 1 }],
    pagosDeuda: [], aportesAhorro: [], gastosFijosPagados: [],
  }];
  const result = await dryRun(state);
  assert.equal(result.classification, 'blocked');
  assert.ok(blockerCodes(result).includes(Contracts.ERROR_CODES.LEGACY_AMBIGUITY));
});

test('duplicate explicit IDs in non-expense monthly collections also block mapping', async () => {
  const state = makeState();
  state.activeMonth.pagosDeuda = [
    { id: 100, debtId: 3, debtName: 'Crédito', amount: 1, date: '2026-08-01' },
  ];
  state.activeMonth.aportesAhorro = [
    { id: 100, walletId: 4, walletName: 'Pie vivienda', amount: 1, date: '2026-08-01' },
  ];
  const result = await dryRun(state);
  assert.equal(result.classification, 'blocked');
  assert.ok(blockerCodes(result).includes(Contracts.ERROR_CODES.LEGACY_AMBIGUITY));
});

test('a broken active income account relationship blocks mapping', async () => {
  const state = makeState();
  state.activeMonth.expenses = [{ id: 100, date: '2026-08-02', description: 'Extra', amount: 1, type: 'income', account: 999 }];
  state.expenses = structuredClone(state.activeMonth.expenses);
  const result = await dryRun(state);
  assert.equal(result.classification, 'blocked');
  assert.ok(blockerCodes(result).includes(Contracts.ERROR_CODES.LEGACY_RELATION_MISSING));
});

test('an unverifiable historical relationship is restricted rather than reassigned', async () => {
  const state = makeState();
  state.monthlyHistory = [{
    month: '2026-07', salary: 900000,
    expenses: [{ id: 100, date: '2026-07-02', description: 'Extra', amount: 1, type: 'income', account: 999 }],
    pagosDeuda: [], aportesAhorro: [], gastosFijosPagados: [],
  }];
  const result = await dryRun(state);
  assert.equal(result.classification, 'restricted');
  assert.ok(warningCodes(result).includes(Contracts.ERROR_CODES.LEGACY_RELATION_MISSING));
  assert.equal(result.proposedLegacySnapshots[0].data.expenses[0].account, 999);
});

test('invalid active periods block mapping', async () => {
  const state = makeState();
  state.activeMonth.month = '2026-13';
  const result = await dryRun(state);
  assert.equal(result.classification, 'blocked');
  assert.ok(blockerCodes(result).includes(Contracts.ERROR_CODES.LEGACY_STRUCTURE_INVALID));
});

test('operations outside their declared month block mapping', async () => {
  const state = makeState();
  state.activeMonth.expenses = [{ id: 100, date: '2026-07-31', description: 'Extra', amount: 1, type: 'income', account: 1 }];
  state.expenses = structuredClone(state.activeMonth.expenses);
  const result = await dryRun(state);
  assert.equal(result.classification, 'blocked');
  assert.match(result.blockers.find((item) => item.path.endsWith('.date')).message, /outside/);
});

test('unknown operation types block as legacy ambiguity', async () => {
  const state = makeState();
  state.activeMonth.expenses = [{ id: 100, date: '2026-08-01', description: 'Otro', amount: 1, type: 'transfer' }];
  state.expenses = structuredClone(state.activeMonth.expenses);
  const result = await dryRun(state);
  assert.equal(result.classification, 'blocked');
  assert.ok(blockerCodes(result).includes(Contracts.ERROR_CODES.LEGACY_AMBIGUITY));
});

test('invalid or unsafe monetary values block mapping without rounding', async () => {
  for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, -1]) {
    const state = makeState();
    state.wallets[0].balance = value;
    const result = await dryRun(state);
    assert.equal(result.classification, 'blocked');
  }
});

test('a non-finite monetary value encoded as JSON exponent blocks mapping', async () => {
  const source = raw(makeState()).replace('"balance":150000', '"balance":1e400');
  const result = await Legacy.createMigrationDryRun(source, {
    sha256,
    createDeterministicUuid: deterministicUuid,
  });
  assert.equal(result.classification, 'blocked');
  assert.ok(blockerCodes(result).includes(Contracts.ERROR_CODES.LEGACY_STRUCTURE_INVALID));
});

test('a debt with paid greater than total blocks mapping', async () => {
  const state = makeState();
  state.debts[0].paid = state.debts[0].total + 1;
  const result = await dryRun(state);
  assert.equal(result.classification, 'blocked');
  assert.ok(blockerCodes(result).includes(Contracts.ERROR_CODES.LEGACY_AMBIGUITY));
});

test('invalid debt dates and statuses block mapping', async () => {
  const invalidDate = makeState();
  invalidDate.debts[0].dueDate = '2026-02-30';
  assert.equal((await dryRun(invalidDate)).classification, 'blocked');

  const invalidStatus = makeState();
  invalidStatus.debts[0].status = 'suspendida';
  assert.equal((await dryRun(invalidStatus)).classification, 'blocked');
});

test('legacy variable expenses without an account are restricted and remain legacy-only', async () => {
  const state = makeState();
  state.activeMonth.expenses = [{ id: 100, date: '2026-08-01', description: 'Comida', amount: 5000, type: 'expense' }];
  state.expenses = structuredClone(state.activeMonth.expenses);
  const result = await dryRun(state);
  assert.equal(result.classification, 'restricted');
  assert.ok(warningCodes(result).includes(Contracts.ERROR_CODES.LEGACY_RELATION_MISSING));
  assert.equal(result.proposedMovements.length, 0);
});

test('legacy debt payments without an origin account are restricted', async () => {
  const state = makeState();
  state.activeMonth.pagosDeuda.push({ id: 100, debtId: 3, debtName: 'Crédito', amount: 1000, date: '2026-08-01' });
  const result = await dryRun(state);
  assert.equal(result.classification, 'restricted');
  assert.ok(warningCodes(result).includes(Contracts.ERROR_CODES.LEGACY_RELATION_MISSING));
});

test('legacy saving deposits without a demonstrable origin are restricted', async () => {
  const state = makeState();
  state.activeMonth.aportesAhorro.push({ id: 100, walletId: 4, walletName: 'Pie vivienda', amount: 1000, date: '2026-08-01' });
  const result = await dryRun(state);
  assert.equal(result.classification, 'restricted');
  assert.ok(warningCodes(result).includes(Contracts.ERROR_CODES.LEGACY_RELATION_MISSING));
});

test('legacy fixed payments without a source account are restricted', async () => {
  const state = makeState();
  state.activeMonth.gastosFijosPagados.push({ id: 100, budgetId: 5, name: 'Arriendo', amount: 350000, date: '2026-08-01' });
  const result = await dryRun(state);
  assert.equal(result.classification, 'restricted');
  assert.ok(warningCodes(result).includes(Contracts.ERROR_CODES.LEGACY_RELATION_MISSING));
});

test('paused debt compatibility is preserved explicitly', async () => {
  const state = makeState();
  state.debts[0].status = 'pausada';
  const result = await dryRun(state);
  assert.equal(result.proposedEntities.debts[0].legacyStatus, 'pausada');
  assert.equal(result.proposedEntities.debts[0].compatibility.paused, true);
  assert.equal(result.proposedEntities.debts[0].paymentStatus, 'active');
});

test('authoritative balances become entity and period openings without movements', async () => {
  const result = await dryRun(makeState());
  assert.deepEqual(
    result.proposedEntities.accounts.map((account) => account.openingBalance),
    [150000, -5000]
  );
  assert.equal(result.proposedEntities.savingsGoals[0].openingBalance, 80000);
  assert.equal(result.proposedEntities.debts[0].openingOutstanding, 375000);
  assert.equal(result.proposedEntities.debts[0].paidAmount, 125000);
  assert.equal(result.proposedPeriodOpenings.length, 4);
  assert.equal(result.proposedMovements.length, 0);
});

test('opening reconciliation is exact and does not double-count history', async () => {
  const state = makeState();
  state.monthlyHistory = [{
    month: '2026-07', salary: 900000,
    expenses: [{ id: 100, date: '2026-07-01', description: 'Comida', amount: 999999, type: 'expense' }],
    pagosDeuda: [], aportesAhorro: [], gastosFijosPagados: [],
  }];
  const result = await dryRun(state);
  assert.equal(result.classification, 'restricted');
  assert.deepEqual(result.reconciliation.accounts, {
    legacyTotal: 145000,
    proposedTotal: 145000,
    matches: true,
  });
  assert.equal(result.reconciliation.savingsGoals.matches, true);
  assert.equal(result.reconciliation.debts.matches, true);
  assert.equal(result.reconciliation.matches, true);
  assert.equal(result.proposedMovements.length, 0);
});

test('an unsafe aggregate reconciliation blocks the dry-run', async () => {
  const state = makeState();
  state.accounts[0].balance = Number.MAX_SAFE_INTEGER;
  state.accounts[1].balance = 1;
  const result = await dryRun(state);
  assert.equal(result.classification, 'blocked');
  assert.equal(result.reconciliation.accounts.matches, false);
  assert.ok(blockerCodes(result).includes(Contracts.ERROR_CODES.LEGACY_AMBIGUITY));
});

test('valid permanent fields and historical salary are preserved', async () => {
  const state = makeState();
  state.monthlyHistory = [{
    month: '2026-07', salary: 875000, closedAt: '2026-07-31',
    expenses: [], pagosDeuda: [], aportesAhorro: [], gastosFijosPagados: [],
  }];
  const result = await dryRun(state);
  assert.equal(result.proposedEntities.accounts[0].institution, 'Banco');
  assert.equal(result.proposedEntities.savingsGoals[0].targetAmount, 1000000);
  assert.equal(result.proposedEntities.fixedExpenseTemplates[0].referenceAmount, 350000);
  assert.equal(result.proposedEntities.categories[0].name, 'Alimentación');
  assert.equal(result.proposedLegacySnapshots[0].salary, 875000);
});

test('deterministic UUID names use the required exact tuple', async () => {
  const names = [];
  const state = makeState();
  const source = raw(state);
  const sourceHash = sha256(source);
  const result = await Legacy.createMigrationDryRun(source, {
    sha256,
    createDeterministicUuid(name) {
      names.push(name);
      return deterministicUuid(name);
    },
  });
  assert.ok(names.includes(`${sourceHash}:account:accounts[0]:1`));
  assert.ok(names.includes(`${sourceHash}:period:activeMonth:2026-08`));
  assert.equal(result.proposedEntities.accounts[0].id, deterministicUuid(`${sourceHash}:account:accounts[0]:1`));
});

test('equal raw sources produce deeply equivalent dry-runs', async () => {
  const source = raw(makeState());
  const options = { sha256, createDeterministicUuid: deterministicUuid };
  const first = await Legacy.createMigrationDryRun(source, options);
  const second = await Legacy.createMigrationDryRun(source, options);
  assert.deepEqual(first, second);
});

test('the proposed legacyIdMap has stable source and target information', async () => {
  const result = await dryRun(makeState());
  const accountMap = result.proposedLegacyIdMap.find((entry) => entry.entityKind === 'account');
  assert.equal(accountMap.sourceHash, result.sourceHash);
  assert.equal(accountMap.legacyPath, 'accounts[0]');
  assert.equal(accountMap.stableKey, '1');
  assert.equal(accountMap.targetId, result.proposedEntities.accounts[0].id);
});

test('invalid deterministic UUID output is a typed failure and preserves cause', async () => {
  await assert.rejects(
    dryRun(makeState(), { createDeterministicUuid: () => 'not-a-uuid' }),
    (error) => {
      assert.equal(error.code, Contracts.ERROR_CODES.LEGACY_STRUCTURE_INVALID);
      assert.ok(error.cause instanceof Error);
      return true;
    }
  );
});

test('salary-like active income is blocked as an explicit ambiguity', async () => {
  const state = makeState();
  state.activeMonth.expenses = [{ id: 100, date: '2026-08-01', description: 'Sueldo empresa', amount: 900000, type: 'income', account: 1 }];
  state.expenses = structuredClone(state.activeMonth.expenses);
  const result = await dryRun(state);
  assert.equal(result.classification, 'blocked');
  assert.ok(blockerCodes(result).includes(Contracts.ERROR_CODES.LEGACY_AMBIGUITY));
});

test('an active salary snapshot is blocked rather than counted twice', async () => {
  const state = makeState();
  state.activeMonth.salary = 900000;
  const result = await dryRun(state);
  assert.equal(result.classification, 'blocked');
  assert.ok(blockerCodes(result).includes(Contracts.ERROR_CODES.LEGACY_AMBIGUITY));
});

test('classification is pure and does not mutate the parsed legacy state', async () => {
  const state = makeState();
  const parsed = await Legacy.parseLegacySource(raw(state), { sha256 });
  const before = JSON.stringify(parsed.parsedState);
  const first = Legacy.classifyLegacyState(parsed);
  const second = Legacy.classifyLegacyState(parsed);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(parsed.parsedState), before);
});

test('parser and dry-run results are deeply immutable', async () => {
  const parsed = await Legacy.parseLegacySource(raw(makeState()), { sha256 });
  const result = await dryRun(makeState());
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.parsedState.accounts[0]));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.proposedEntities.accounts[0]));
  assert.ok(Object.isFrozen(result.warnings));
  assert.throws(() => { result.proposedEntities.accounts[0].name = 'Mutada'; }, TypeError);
});

test('the parser does not mutate the caller raw source', async () => {
  const source = raw(makeState());
  const before = source.slice();
  await Legacy.createMigrationDryRun(source, { sha256, createDeterministicUuid: deterministicUuid });
  assert.equal(source, before);
});

test('the module remains isolated from storage, core loading, and migration writes', () => {
  const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'perita-legacy.js'), 'utf8');
  assert.doesNotMatch(moduleSource, /localStorage|PeritaCore|storage\.(?:add|put|remove)|runTransaction|executeCommand/);
  assert.doesNotMatch(moduleSource, /require\(['"]\.\/perita-(?:indexeddb|runtime|core)/);
});

test('the public factory injects hashing and deterministic identity consistently', async () => {
  const parser = Legacy.createPeritaLegacy({ sha256, createDeterministicUuid: deterministicUuid });
  const source = raw(makeState());
  const parsed = await parser.parseLegacySource(source);
  const result = await parser.createMigrationDryRun(source);
  assert.equal(parsed.sourceHash, result.sourceHash);
  assert.equal(result.sourceKey, 'perita_v1');
  assert.equal(result.mapperVersion, Legacy.MAPPER_VERSION);
});

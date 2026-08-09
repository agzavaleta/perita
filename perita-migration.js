/* perita-migration.js — confirmed one-way migration from Perita V1
 *
 * The legacy parser remains the only interpreter of perita_v1. This module
 * coordinates its validated dry-run with the V1.1.0 runtime and IndexedDB.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./perita-contracts.js'),
      require('./perita-domain.js'),
      require('./perita-legacy.js')
    );
  } else {
    root.PeritaMigration = factory(
      root.PeritaContracts,
      root.PeritaDomain,
      root.PeritaLegacy
    );
  }
})(typeof self !== 'undefined' ? self : this, function (
  Contracts,
  Domain,
  Legacy
) {
  'use strict';

  if (!Contracts) throw new Error('PeritaContracts is required');
  if (!Domain) throw new Error('PeritaDomain is required');
  if (!Legacy) throw new Error('PeritaLegacy is required');

  const {
    CHILE_TIME_ZONE,
    ERROR_CODES,
    PeritaError,
    assertRevision,
    assertUuid,
    civilDateInChile,
    createUuidV4,
    periodFromCivilDate,
  } = Contracts;

  const COMMAND_TYPE = 'migration.confirm';
  const MIGRATION_STATUS = 'completed';
  const AFFECTED_STORES = Object.freeze([
    'financialSettings',
    'periods',
    'periodOpenings',
    'accounts',
    'savingsGoals',
    'debts',
    'categories',
    'fixedExpenseTemplates',
    'fixedExpenseInstances',
    'operations',
    'movements',
    'operationRevisions',
    'auditEvents',
    'periodSnapshots',
    'legacyEntries',
    'migrations',
    'legacyIdMap',
  ]);
  const WRITTEN_STORES = Object.freeze([
    'financialSettings',
    'periods',
    'periodOpenings',
    'accounts',
    'savingsGoals',
    'debts',
    'categories',
    'fixedExpenseTemplates',
    'legacyEntries',
    'migrations',
    'legacyIdMap',
  ]);
  class MigrationError extends PeritaError {}

  function migrationError(code, message, context, cause) {
    return new MigrationError(code, message, context, cause);
  }

  function hasOwn(value, field) {
    return Object.prototype.hasOwnProperty.call(value, field);
  }

  function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
  }

  function immutableCopy(value) {
    return deepFreeze(JSON.parse(JSON.stringify(value)));
  }

  function timestamp(now) {
    let value;
    try {
      value = now();
    } catch (cause) {
      throw migrationError(ERROR_CODES.MIGRATION_FAILED, 'migration clock failed', {}, cause);
    }
    const parsed = typeof value === 'string' ? new Date(value) : null;
    if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
      throw migrationError(
        ERROR_CODES.MIGRATION_FAILED,
        'migration clock must return a canonical ISO UTC timestamp',
        { value }
      );
    }
    return value;
  }

  function requireExpectedHash(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
      throw migrationError(
        ERROR_CODES.MIGRATION_SOURCE_MISMATCH,
        'expectedSourceHash must be a SHA-256 hexadecimal string',
        { expectedSourceHash: value }
      );
    }
    return value.toLowerCase();
  }

  function uniqueIds(records, label) {
    const ids = records.map((record) => record && record.id);
    if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
      throw migrationError(
        ERROR_CODES.MIGRATION_BASELINE_INVALID,
        `${label} contains missing or duplicate IDs`,
        { label }
      );
    }
  }

  function validateDryRun(dryRun, expectedSourceHash, cutoverAt) {
    if (!isRecord(dryRun) || dryRun.sourceKey !== Legacy.SOURCE_KEY) {
      throw migrationError(
        ERROR_CODES.MIGRATION_BASELINE_INVALID,
        'legacy dry-run has an incompatible source identity'
      );
    }
    if (dryRun.sourceHash !== expectedSourceHash) {
      throw migrationError(
        ERROR_CODES.MIGRATION_SOURCE_MISMATCH,
        'legacy source changed after the confirmed dry-run',
        { expectedSourceHash, actualSourceHash: dryRun.sourceHash }
      );
    }
    if (dryRun.mapperVersion !== Legacy.MAPPER_VERSION) {
      throw migrationError(
        ERROR_CODES.MIGRATION_SOURCE_MISMATCH,
        'legacy mapper version changed before confirmation',
        { expectedMapperVersion: Legacy.MAPPER_VERSION, actualMapperVersion: dryRun.mapperVersion }
      );
    }
    if (dryRun.classification === 'blocked') {
      throw migrationError(
        ERROR_CODES.MIGRATION_BLOCKED,
        'blocked legacy data cannot be migrated',
        { blockers: dryRun.blockers }
      );
    }
    if (!['migratable', 'restricted'].includes(dryRun.classification)) {
      throw migrationError(
        ERROR_CODES.MIGRATION_BASELINE_INVALID,
        'legacy dry-run classification is unsupported',
        { classification: dryRun.classification }
      );
    }
    if (!dryRun.reconciliation || dryRun.reconciliation.matches !== true) {
      throw migrationError(
        ERROR_CODES.MIGRATION_BASELINE_INVALID,
        'legacy monetary reconciliation did not pass',
        { reconciliation: dryRun.reconciliation }
      );
    }
    if (!Array.isArray(dryRun.proposedMovements) || dryRun.proposedMovements.length !== 0) {
      throw migrationError(
        ERROR_CODES.MIGRATION_BASELINE_INVALID,
        'pre-cutover legacy data must not propose canonical movements'
      );
    }
    const periods = dryRun.proposedEntities && dryRun.proposedEntities.periods;
    if (!Array.isArray(periods) || periods.length !== 1) {
      throw migrationError(
        ERROR_CODES.MIGRATION_BASELINE_INVALID,
        'migration requires exactly one active cutover period',
        { periodCount: periods && periods.length }
      );
    }
    const currentPeriodKey = periodFromCivilDate(civilDateInChile(new Date(cutoverAt)));
    if (periods[0].periodKey > currentPeriodKey) {
      throw migrationError(
        ERROR_CODES.MIGRATION_BASELINE_INVALID,
        'cutover period cannot be in the future',
        { cutoverPeriodKey: periods[0].periodKey, currentPeriodKey }
      );
    }
    const collections = [
      ...Object.values(dryRun.proposedEntities),
      dryRun.proposedPeriodOpenings,
      dryRun.proposedLegacyEntries,
      dryRun.proposedLegacySnapshots,
      dryRun.proposedLegacyIdMap,
    ];
    collections.forEach((records, index) => {
      if (!Array.isArray(records)) {
        throw migrationError(
          ERROR_CODES.MIGRATION_BASELINE_INVALID,
          'legacy dry-run contains a non-array proposal',
          { collectionIndex: index }
        );
      }
      uniqueIds(records, `dryRun[${index}]`);
    });
    uniqueIds(collections.flat(), 'combined dry-run proposals');
    return dryRun;
  }

  function migrationData(dryRun, cutoverAt, migrationId) {
    const proposed = dryRun.proposedEntities;
    const proposedPeriod = proposed.periods[0];
    const salary = proposedPeriod.plannedSalaryAmount === null
      ? 0
      : proposedPeriod.plannedSalaryAmount;
    const financialSettings = Domain.validateFinancialSettings({
      key: 'current',
      salaryReferenceAmount: salary,
      currency: 'CLP',
      timezone: CHILE_TIME_ZONE,
      revision: 1,
      createdAt: cutoverAt,
      updatedAt: cutoverAt,
    });
    const period = Domain.validatePeriod({
      id: proposedPeriod.id,
      periodKey: proposedPeriod.periodKey,
      status: 'open',
      plannedSalaryAmount: salary,
      openedAt: cutoverAt,
      closedAt: null,
      snapshotId: null,
      revision: 1,
    });
    const accounts = proposed.accounts.map((record) => Domain.validateAccount({
      id: record.id,
      name: record.name,
      openingBalance: record.openingBalance,
      currentBalance: record.currentBalance,
      status: 'active',
      revision: 1,
      createdAt: cutoverAt,
      updatedAt: cutoverAt,
    }));
    const savingsGoals = proposed.savingsGoals.map((record) => Domain.validateSavingsGoal({
      id: record.id,
      name: record.name,
      targetAmount: record.targetAmount,
      openingBalance: record.openingBalance,
      currentBalance: record.currentBalance,
      plannedMonthlyAmount: record.plannedMonthlyAmount,
      lifecycleStatus: 'active',
      progressStatus: record.currentBalance >= record.targetAmount ? 'completed' : 'in_progress',
      closedAt: null,
      revision: 1,
      createdAt: cutoverAt,
      updatedAt: cutoverAt,
    }));
    const debts = proposed.debts.map((record) => Domain.validateDebt({
      id: record.id,
      name: record.name,
      totalAmount: record.totalAmount,
      openingOutstanding: record.openingOutstanding,
      outstandingAmount: record.outstandingAmount,
      dueDate: record.dueDate,
      lifecycleStatus: 'active',
      paymentStatus: record.outstandingAmount === 0 ? 'paid' : record.paymentStatus,
      revision: 1,
      createdAt: cutoverAt,
      updatedAt: cutoverAt,
    }));
    const categories = proposed.categories.map((record) => Domain.validateCategory({
      id: record.id,
      name: record.name,
      status: record.status,
      revision: 1,
      createdAt: cutoverAt,
      updatedAt: cutoverAt,
    }));
    const fixedExpenseTemplates = proposed.fixedExpenseTemplates.map((record) => (
      Domain.validateFixedExpenseTemplate({
        id: record.id,
        name: record.name,
        referenceAmount: record.referenceAmount,
        status: record.status,
        revision: 1,
        createdAt: cutoverAt,
        updatedAt: cutoverAt,
      })
    ));
    const periodOpenings = dryRun.proposedPeriodOpenings.map((record) => (
      Domain.validatePeriodOpening({
        id: record.id,
        periodId: record.periodId,
        targetType: record.targetType,
        targetId: record.targetId,
        openingAmount: record.openingAmount,
      })
    ));
    const legacyEntries = [
      ...dryRun.proposedLegacyEntries.map((record) => ({
        ...record,
        migrationId,
      })),
      ...dryRun.proposedLegacySnapshots.map((record, index) => ({
        id: record.id,
        periodId: null,
        periodKey: record.periodKey,
        legacyPath: `monthlyHistory[${index}]`,
        entryKind: 'monthly_history',
        payload: record.data,
        migrationId,
      })),
    ].map(immutableCopy);
    const legacyIdMap = dryRun.proposedLegacyIdMap.map(immutableCopy);

    const targetAmounts = new Map([
      ...accounts.map((record) => [`account:${record.id}`, record.openingBalance]),
      ...savingsGoals.map((record) => [`savings_goal:${record.id}`, record.openingBalance]),
      ...debts.map((record) => [`debt:${record.id}`, record.openingOutstanding]),
    ]);
    if (
      periodOpenings.length !== targetAmounts.size ||
      periodOpenings.some((opening) => (
        opening.periodId !== period.id ||
        targetAmounts.get(`${opening.targetType}:${opening.targetId}`) !== opening.openingAmount
      ))
    ) {
      throw migrationError(
        ERROR_CODES.MIGRATION_BASELINE_INVALID,
        'PeriodOpening proposals do not match authoritative legacy balances'
      );
    }

    return immutableCopy({
      financialSettings: [financialSettings],
      periods: [period],
      periodOpenings,
      accounts,
      savingsGoals,
      debts,
      categories,
      fixedExpenseTemplates,
      legacyEntries,
      legacyIdMap,
    });
  }

  function affectedScopes(data, sourceHash) {
    return [
      `migration:${sourceHash}`,
      'financial_settings:current',
      `period:${data.periods[0].id}`,
      ...data.accounts.map((record) => `account:${record.id}`),
      ...data.savingsGoals.map((record) => `savings_goal:${record.id}`),
      ...data.debts.map((record) => `debt:${record.id}`),
      ...data.categories.map((record) => `category:${record.id}`),
      ...data.fixedExpenseTemplates.map((record) => `fixed_expense_template:${record.id}`),
    ];
  }

  function createPeritaMigration(options) {
    const settings = options || {};
    const storage = settings.storage;
    const runtime = settings.runtime;
    const legacyStorage = settings.legacyStorage;
    const now = settings.now || (() => new Date().toISOString());
    const createUuid = settings.createUuid || (() => createUuidV4());
    const sha256 = settings.sha256;
    const legacy = settings.legacy || Legacy.createPeritaLegacy({
      sha256,
      createDeterministicUuid: settings.createDeterministicUuid,
    });
    if (!storage || typeof storage.getAll !== 'function') {
      throw migrationError(ERROR_CODES.MIGRATION_FAILED, 'IndexedDB storage is required');
    }
    if (!runtime || typeof runtime.executeCommand !== 'function') {
      throw migrationError(ERROR_CODES.MIGRATION_FAILED, 'Perita runtime is required');
    }
    if (!legacyStorage || typeof legacyStorage.getItem !== 'function') {
      throw migrationError(ERROR_CODES.MIGRATION_FAILED, 'legacy localStorage adapter is required');
    }
    if (!legacy || typeof legacy.createMigrationDryRun !== 'function') {
      throw migrationError(ERROR_CODES.MIGRATION_FAILED, 'legacy dry-run service is required');
    }

    function newMigrationId() {
      try {
        return assertUuid(createUuid(), { field: 'migrationId', version: 4 });
      } catch (cause) {
        throw migrationError(ERROR_CODES.MIGRATION_FAILED, 'migration UUID generation failed', {}, cause);
      }
    }

    function readRawSource() {
      let rawSource;
      try {
        rawSource = legacyStorage.getItem(Legacy.SOURCE_KEY);
      } catch (cause) {
        throw migrationError(
          ERROR_CODES.MIGRATION_FAILED,
          'legacy source could not be read',
          { sourceKey: Legacy.SOURCE_KEY },
          cause
        );
      }
      if (rawSource === null) {
        throw migrationError(
          ERROR_CODES.LEGACY_SOURCE_MISSING,
          'localStorage does not contain the Perita V1 source',
          { sourceKey: Legacy.SOURCE_KEY }
        );
      }
      if (typeof rawSource !== 'string') {
        throw migrationError(
          ERROR_CODES.MIGRATION_FAILED,
          'legacy storage returned a non-string value',
          { sourceKey: Legacy.SOURCE_KEY, actualType: typeof rawSource }
        );
      }
      return rawSource;
    }

    async function createDryRun() {
      return legacy.createMigrationDryRun(readRawSource());
    }

    async function existingMigration(sourceHash) {
      await storage.open();
      const migrations = await storage.getAll('migrations');
      const same = migrations.find((record) => (
        record.sourceKey === Legacy.SOURCE_KEY &&
        record.sourceHash === sourceHash &&
        record.mapperVersion === Legacy.MAPPER_VERSION &&
        record.status === MIGRATION_STATUS
      ));
      if (same) {
        throw migrationError(
          ERROR_CODES.MIGRATION_ALREADY_APPLIED,
          'this exact legacy source was already migrated',
          { migrationId: same.id, sourceHash }
        );
      }
      const completed = migrations.find((record) => record.status === MIGRATION_STATUS);
      if (completed) {
        throw migrationError(
          ERROR_CODES.MIGRATION_SOURCE_MISMATCH,
          'a different legacy source was already migrated into this installation',
          { migrationId: completed.id, existingSourceHash: completed.sourceHash, sourceHash }
        );
      }
    }

    async function confirmMigration(input) {
      const request = isRecord(input) ? input : {};
      assertRevision(request.expectedDataRevision, {
        field: 'expectedDataRevision', allowZero: true,
      });
      assertRevision(request.expectedWriterEpoch, { field: 'expectedWriterEpoch' });
      const expectedSourceHash = requireExpectedHash(request.expectedSourceHash);
      const rawSource = readRawSource();
      const dryRun = await legacy.createMigrationDryRun(rawSource);
      const cutoverAt = timestamp(now);
      validateDryRun(dryRun, expectedSourceHash, cutoverAt);
      await existingMigration(dryRun.sourceHash);
      const migrationId = newMigrationId();
      const data = migrationData(dryRun, cutoverAt, migrationId);

      const command = await runtime.executeCommand({
        commandType: COMMAND_TYPE,
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: AFFECTED_STORES,
        affectedScopes: affectedScopes(data, dryRun.sourceHash),
        runtimePatch: {
          setupStatus: 'completed',
          activePeriodId: data.periods[0].id,
          writeEnabled: false,
        },
        metadata: {
          sourceKey: Legacy.SOURCE_KEY,
          sourceHash: dryRun.sourceHash,
          mapperVersion: dryRun.mapperVersion,
          classification: dryRun.classification,
        },
        execute: async (transaction, context) => {
          if (readRawSource() !== rawSource) {
            throw migrationError(
              ERROR_CODES.MIGRATION_SOURCE_MISMATCH,
              'legacy source changed while migration confirmation was in progress',
              { sourceHash: dryRun.sourceHash }
            );
          }
          if (context.runtime.setupStatus !== 'not_started' || context.runtime.activePeriodId !== null) {
            throw migrationError(
              ERROR_CODES.MIGRATION_ALREADY_APPLIED,
              'migration requires a fresh V1.1.0 installation',
              {
                setupStatus: context.runtime.setupStatus,
                activePeriodId: context.runtime.activePeriodId,
              }
            );
          }
          for (const storeName of AFFECTED_STORES) {
            if ((await transaction.getAll(storeName)).length !== 0) {
              throw migrationError(
                storeName === 'migrations'
                  ? ERROR_CODES.MIGRATION_ALREADY_APPLIED
                  : ERROR_CODES.MIGRATION_BASELINE_INVALID,
                'migration destination is not empty',
                { storeName }
              );
            }
          }
          const migration = immutableCopy({
            id: migrationId,
            sourceKey: Legacy.SOURCE_KEY,
            sourceHash: dryRun.sourceHash,
            mapperVersion: dryRun.mapperVersion,
            startedAt: cutoverAt,
            completedAt: cutoverAt,
            status: MIGRATION_STATUS,
            warnings: dryRun.warnings,
            targetDataRevision: context.runtime.dataRevision + 1,
            cutoverAt,
            cutoverPeriodId: data.periods[0].id,
            baselineCommitId: context.commitId,
          });
          for (const [storeName, records] of Object.entries(data)) {
            for (const record of records) await transaction.add(storeName, record);
          }
          await transaction.add('migrations', migration);
          return immutableCopy({ migration, classification: dryRun.classification });
        },
      });

      await runtime.releaseWriter({ expectedEpoch: request.expectedWriterEpoch });
      return immutableCopy({
        ...command.result,
        commit: command.commit,
        requiresIntegrityCheckBeforeWriteEnablement: true,
      });
    }

    return Object.freeze({
      createDryRun,
      confirmMigration,
    });
  }

  return Object.freeze({
    COMMAND_TYPE,
    MIGRATION_STATUS,
    AFFECTED_STORES,
    WRITTEN_STORES,
    MigrationError,
    createPeritaMigration,
  });
});

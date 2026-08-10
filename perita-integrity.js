/* perita-integrity.js — isolated integrity diagnostics for Perita V1.1.0
 *
 * Checks are read-only over financial stores. A full check atomically writes
 * only its integrity report and the permitted system/runtime health fields.
 * This module never repairs, migrates, resumes, or deletes financial data.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./perita-contracts.js'),
      require('./perita-indexeddb.js')
    );
  } else {
    root.PeritaIntegrity = factory(root.PeritaContracts, root.PeritaIndexedDb);
  }
})(typeof self !== 'undefined' ? self : this, function (Contracts, IndexedDb) {
  'use strict';

  if (!Contracts) throw new Error('PeritaContracts is required');
  if (!IndexedDb) throw new Error('PeritaIndexedDb is required');

  const {
    ERROR_CODES,
    PeritaError,
    assertUuid,
    civilDateInChile,
    createUuidV4,
    nextPeriod,
  } = Contracts;

  const CHECK_TYPES = Object.freeze({
    FULL: 'full',
    RUNTIME: 'runtime',
    COMMITS: 'commits',
    RELATIONSHIPS: 'relationships',
    BALANCES: 'balances',
  });
  const STATUSES = Object.freeze(['ok', 'warning', 'restricted', 'diagnostic_only']);
  const SEVERITY_ORDER = Object.freeze({
    warning: 1,
    restricted: 2,
    diagnostic_only: 3,
  });
  const SNAPSHOT_STORES = Object.freeze([
    'system',
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
    'periodSnapshots',
    'legacyEntries',
    'migrations',
    'legacyIdMap',
    'pendingIntents',
    'commits',
  ]);
  const TARGETS = Object.freeze({
    account: Object.freeze({
      storeName: 'accounts',
      openingField: 'openingBalance',
      currentField: 'currentBalance',
      effectType: 'asset_balance',
    }),
    savings_goal: Object.freeze({
      storeName: 'savingsGoals',
      openingField: 'openingBalance',
      currentField: 'currentBalance',
      effectType: 'asset_balance',
    }),
    debt: Object.freeze({
      storeName: 'debts',
      openingField: 'openingOutstanding',
      currentField: 'outstandingAmount',
      effectType: 'debt_outstanding',
    }),
  });
  const ACCOUNT_OPERATION_SIGNS = Object.freeze({
    salary_receipt: 1,
    additional_income: 1,
    variable_expense: -1,
    fixed_expense_payment: -1,
  });
  const BLOCK_FOUR_OPERATION_TYPES = Object.freeze(new Set([
    'debt_payment',
    'debt_total_adjustment',
    'savings_deposit',
    'savings_withdrawal',
    'transfer',
  ]));
  const SAVINGS_OPERATION_SIGNS = Object.freeze({
    savings_deposit: 1,
    savings_withdrawal: -1,
  });

  class IntegrityError extends PeritaError {}

  function integrityError(message, context, cause) {
    return new IntegrityError(ERROR_CODES.INTEGRITY_FAILED, message, context, cause);
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
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

  function serializableContext(context) {
    try {
      return JSON.parse(JSON.stringify(context || {}));
    } catch (_) {
      return {};
    }
  }

  function timestampFromNow(now) {
    let value;
    try {
      value = now();
    } catch (cause) {
      throw integrityError('the integrity clock failed', { field: 'now' }, cause);
    }
    const parsed = typeof value === 'string' ? new Date(value) : null;
    if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
      throw integrityError(
        'now() must return a canonical ISO UTC timestamp',
        { field: 'now', value }
      );
    }
    return value;
  }

  function mapById(records) {
    return new Map(records.map((record) => [record.id, record]));
  }

  function scopeForTarget(targetType, targetId) {
    return typeof targetType === 'string' && targetId !== undefined && targetId !== null
      ? `${targetType}:${targetId}`
      : null;
  }

  function scopeForPeriod(periodId) {
    return periodId === undefined || periodId === null ? null : `period:${periodId}`;
  }

  function addIssue(issues, details) {
    const severity = details.severity;
    if (!hasOwn(SEVERITY_ORDER, severity)) {
      throw integrityError('integrity issue has an invalid severity', { severity });
    }
    issues.push({
      code: details.code,
      severity,
      scopeType: details.scopeType || null,
      scopeId: details.scopeId === undefined ? null : details.scopeId,
      storeName: details.storeName || null,
      recordId: details.recordId === undefined ? null : details.recordId,
      message: details.message,
      context: serializableContext(details.context),
    });
  }

  function catchesValidation(action) {
    try {
      action();
      return true;
    } catch (_) {
      return false;
    }
  }

  function validNonNegativeRevision(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function validIsoTimestamp(value) {
    const parsed = typeof value === 'string' ? new Date(value) : null;
    return Boolean(parsed && Number.isFinite(parsed.getTime()) && parsed.toISOString() === value);
  }

  function canonicalJsonValue(value) {
    if (Array.isArray(value)) return value.map(canonicalJsonValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])])
    );
  }

  function canonicalJson(value) {
    return JSON.stringify(canonicalJsonValue(value));
  }

  function normalizedSha256(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
      ? value.toLowerCase()
      : null;
  }

  function snapshotPayload(snapshot) {
    const payload = { ...snapshot };
    delete payload.integrity;
    return payload;
  }

  function addSnapshotAmount(total, amount) {
    const next = total + amount;
    return Number.isSafeInteger(next) ? next : null;
  }

  function canonicalSnapshotTotals(periodSnapshot) {
    const data = periodSnapshot && periodSnapshot.data;
    const plan = data && data.periodPlan;
    const operations = data && data.operations;
    const fixedExpenses = data && data.fixedExpenses;
    if (!plan || !Array.isArray(operations) || !Array.isArray(fixedExpenses)) return null;
    const totals = {
      receivedSalaryAmount: 0,
      additionalIncomeAmount: 0,
      fixedExpensePaidAmount: 0,
      variableExpenseAmount: 0,
      debtPaymentAmount: 0,
      netSavingsAmount: 0,
    };
    for (const operation of operations) {
      if (!operation || operation.status !== 'posted' || !Number.isSafeInteger(operation.amount)) continue;
      let field = null;
      let delta = operation.amount;
      if (operation.type === 'salary_receipt') field = 'receivedSalaryAmount';
      if (operation.type === 'additional_income') field = 'additionalIncomeAmount';
      if (operation.type === 'fixed_expense_payment') field = 'fixedExpensePaidAmount';
      if (operation.type === 'variable_expense') field = 'variableExpenseAmount';
      if (operation.type === 'debt_payment') field = 'debtPaymentAmount';
      if (operation.type === 'savings_deposit') field = 'netSavingsAmount';
      if (operation.type === 'savings_withdrawal') {
        field = 'netSavingsAmount';
        delta = -operation.amount;
      }
      if (operation.type === 'transfer') {
        const details = operation.details || {};
        if (details.sourceType === 'account' && details.destinationType === 'savings_goal') {
          field = 'netSavingsAmount';
        } else if (
          details.sourceType === 'savings_goal' && details.destinationType === 'account'
        ) {
          field = 'netSavingsAmount';
          delta = -operation.amount;
        }
      }
      if (field) {
        const next = addSnapshotAmount(totals[field], delta);
        if (next === null) return null;
        totals[field] = next;
      }
    }
    let fixedExpensePlannedAmount = 0;
    let fixedExpenseUnpaidAmount = 0;
    for (const instance of fixedExpenses) {
      if (!instance || !Number.isSafeInteger(instance.plannedAmount)) return null;
      fixedExpensePlannedAmount = addSnapshotAmount(
        fixedExpensePlannedAmount, instance.plannedAmount
      );
      if (fixedExpensePlannedAmount === null) return null;
      if (instance.status !== 'paid') {
        fixedExpenseUnpaidAmount = addSnapshotAmount(
          fixedExpenseUnpaidAmount, instance.plannedAmount
        );
        if (fixedExpenseUnpaidAmount === null) return null;
      }
    }
    const totalIncomeAmount = addSnapshotAmount(
      totals.receivedSalaryAmount, totals.additionalIncomeAmount
    );
    if (totalIncomeAmount === null) return null;
    let availableAmount = totalIncomeAmount;
    for (const amount of [
      -totals.fixedExpensePaidAmount,
      -totals.variableExpenseAmount,
      -totals.debtPaymentAmount,
      -totals.netSavingsAmount,
    ]) {
      availableAmount = addSnapshotAmount(availableAmount, amount);
      if (availableAmount === null) return null;
    }
    return {
      plannedSalaryAmount: plan.plannedSalaryAmount,
      receivedSalaryAmount: totals.receivedSalaryAmount,
      additionalIncomeAmount: totals.additionalIncomeAmount,
      totalIncomeAmount,
      fixedExpensePlannedAmount,
      fixedExpensePaidAmount: totals.fixedExpensePaidAmount,
      fixedExpenseUnpaidAmount,
      variableExpenseAmount: totals.variableExpenseAmount,
      debtPaymentAmount: totals.debtPaymentAmount,
      netSavingsAmount: totals.netSavingsAmount,
      availableAmount,
    };
  }

  function checkRuntimeSnapshot(snapshot, issues) {
    const schema = snapshot.schema;
    const runtime = snapshot.runtime;

    if (!schema) {
      addIssue(issues, {
        code: 'SYSTEM_SCHEMA_MISSING',
        severity: 'diagnostic_only',
        storeName: 'system',
        recordId: 'schema',
        message: 'system/schema is missing',
      });
    } else {
      if (schema.schemaVersion !== IndexedDb.SCHEMA_VERSION) {
        addIssue(issues, {
          code: 'SCHEMA_VERSION_UNSUPPORTED',
          severity: 'diagnostic_only',
          storeName: 'system',
          recordId: 'schema',
          message: 'schemaVersion is not supported',
          context: { expected: IndexedDb.SCHEMA_VERSION, actual: schema.schemaVersion },
        });
      }
      if (schema.indexedDbVersion !== IndexedDb.DATABASE_VERSION) {
        addIssue(issues, {
          code: 'INDEXEDDB_VERSION_UNSUPPORTED',
          severity: 'diagnostic_only',
          storeName: 'system',
          recordId: 'schema',
          message: 'indexedDbVersion is not supported',
          context: { expected: IndexedDb.DATABASE_VERSION, actual: schema.indexedDbVersion },
        });
      }
      if (!catchesValidation(() => assertUuid(schema.databaseGeneration, {
        field: 'databaseGeneration',
      }))) {
        addIssue(issues, {
          code: 'DATABASE_GENERATION_INVALID',
          severity: 'diagnostic_only',
          storeName: 'system',
          recordId: 'schema',
          message: 'databaseGeneration is not a valid UUID',
          context: { databaseGeneration: schema.databaseGeneration },
        });
      }
    }

    if (!runtime) {
      addIssue(issues, {
        code: 'SYSTEM_RUNTIME_MISSING',
        severity: 'diagnostic_only',
        storeName: 'system',
        recordId: 'runtime',
        message: 'system/runtime is missing',
      });
    } else {
      for (const field of ['dataRevision', 'commitSequence']) {
        if (!validNonNegativeRevision(runtime[field])) {
          addIssue(issues, {
            code: 'RUNTIME_REVISION_INVALID',
            severity: 'diagnostic_only',
            storeName: 'system',
            recordId: 'runtime',
            message: `${field} must be a non-negative safe integer`,
            context: { field, value: runtime[field] },
          });
        }
      }
      if (
        runtime.lastCommitId !== null &&
        !catchesValidation(() => assertUuid(runtime.lastCommitId, { field: 'lastCommitId' }))
      ) {
        addIssue(issues, {
          code: 'LAST_COMMIT_ID_INVALID',
          severity: 'diagnostic_only',
          storeName: 'system',
          recordId: 'runtime',
          message: 'lastCommitId must be null or a valid UUID',
          context: { lastCommitId: runtime.lastCommitId },
        });
      }
      if (!Array.isArray(runtime.restrictedScopes)) {
        addIssue(issues, {
          code: 'RESTRICTED_SCOPES_INVALID',
          severity: 'diagnostic_only',
          storeName: 'system',
          recordId: 'runtime',
          message: 'restrictedScopes must be an array',
        });
      }
      if (typeof runtime.writeEnabled !== 'boolean') {
        addIssue(issues, {
          code: 'WRITE_ENABLED_INVALID',
          severity: 'diagnostic_only',
          storeName: 'system',
          recordId: 'runtime',
          message: 'writeEnabled must be boolean',
        });
      }
      if (!STATUSES.includes(runtime.healthStatus)) {
        addIssue(issues, {
          code: 'HEALTH_STATUS_INVALID',
          severity: 'diagnostic_only',
          storeName: 'system',
          recordId: 'runtime',
          message: 'healthStatus is invalid',
          context: { healthStatus: runtime.healthStatus },
        });
      }
    }

    const openPeriods = snapshot.periods.filter((period) => period.status === 'open');
    if (openPeriods.length > 1) {
      addIssue(issues, {
        code: 'MULTIPLE_OPEN_PERIODS',
        severity: 'diagnostic_only',
        scopeType: 'global',
        storeName: 'periods',
        message: 'more than one period is open',
        context: { periodIds: openPeriods.map((period) => period.id) },
      });
    }
    if (runtime) {
      const expectedActivePeriodId = openPeriods.length === 1 ? openPeriods[0].id : null;
      if (runtime.activePeriodId !== expectedActivePeriodId) {
        addIssue(issues, {
          code: 'ACTIVE_PERIOD_MISMATCH',
          severity: 'diagnostic_only',
          scopeType: 'period',
          scopeId: runtime.activePeriodId || expectedActivePeriodId,
          storeName: 'system',
          recordId: 'runtime',
          message: 'activePeriodId does not match the single open period',
          context: {
            activePeriodId: runtime.activePeriodId,
            openPeriodIds: openPeriods.map((period) => period.id),
          },
        });
      }
    }
  }

  function checkCommitSnapshot(snapshot, issues) {
    const runtime = snapshot.runtime;
    const commits = snapshot.commits.slice().sort((left, right) => left.sequence - right.sequence);
    const seenSequences = new Set();
    const seenCommitIds = new Set();
    let previousRevision = 0;

    commits.forEach((commit, index) => {
      const expectedSequence = index + 1;
      if (!Number.isSafeInteger(commit.sequence) || commit.sequence <= 0) {
        addIssue(issues, {
          code: 'COMMIT_SEQUENCE_INVALID',
          severity: 'diagnostic_only',
          storeName: 'commits',
          recordId: commit.sequence,
          message: 'commit sequence must be a positive safe integer',
          context: { sequence: commit.sequence },
        });
      } else {
        if (seenSequences.has(commit.sequence)) {
          addIssue(issues, {
            code: 'COMMIT_SEQUENCE_DUPLICATE',
            severity: 'diagnostic_only',
            storeName: 'commits',
            recordId: commit.sequence,
            message: 'commit sequence is duplicated',
          });
        }
        seenSequences.add(commit.sequence);
        if (commit.sequence !== expectedSequence) {
          addIssue(issues, {
            code: 'COMMIT_SEQUENCE_GAP',
            severity: 'diagnostic_only',
            storeName: 'commits',
            recordId: commit.sequence,
            message: 'commit sequences are not consecutive from 1',
            context: { expectedSequence, actualSequence: commit.sequence },
          });
        }
      }

      const commitIdValid = catchesValidation(() => assertUuid(commit.commitId, {
        field: 'commitId',
        version: 4,
      }));
      if (!commitIdValid || seenCommitIds.has(commit.commitId)) {
        addIssue(issues, {
          code: commitIdValid ? 'COMMIT_ID_DUPLICATE' : 'COMMIT_ID_INVALID',
          severity: 'diagnostic_only',
          storeName: 'commits',
          recordId: commit.sequence,
          message: commitIdValid ? 'commitId is duplicated' : 'commitId is not a valid UUID v4',
          context: { commitId: commit.commitId },
        });
      }
      seenCommitIds.add(commit.commitId);

      const expectedDataRevision = previousRevision + 1;
      if (
        !Number.isSafeInteger(commit.previousDataRevision) ||
        commit.previousDataRevision !== previousRevision ||
        !Number.isSafeInteger(commit.dataRevision) ||
        commit.dataRevision !== expectedDataRevision
      ) {
        addIssue(issues, {
          code: 'COMMIT_REVISION_CHAIN_INVALID',
          severity: 'diagnostic_only',
          storeName: 'commits',
          recordId: commit.sequence,
          message: 'commit data revisions are not consecutive',
          context: {
            expectedPreviousDataRevision: previousRevision,
            actualPreviousDataRevision: commit.previousDataRevision,
            expectedDataRevision,
            actualDataRevision: commit.dataRevision,
          },
        });
      }
      if (Number.isSafeInteger(commit.dataRevision)) previousRevision = commit.dataRevision;

      if (
        !Array.isArray(commit.affectedStores) ||
        new Set(commit.affectedStores).size !== commit.affectedStores.length
      ) {
        addIssue(issues, {
          code: 'COMMIT_AFFECTED_STORES_INVALID',
          severity: 'diagnostic_only',
          storeName: 'commits',
          recordId: commit.sequence,
          message: 'affectedStores must be an array without duplicates',
        });
      }
    });

    if (!runtime) return;
    if (commits.length === 0) {
      if (
        runtime.commitSequence !== 0 || runtime.dataRevision !== 0 ||
        runtime.lastCommitId !== null
      ) {
        addIssue(issues, {
          code: 'RUNTIME_COMMIT_HEAD_INVALID',
          severity: 'diagnostic_only',
          storeName: 'system',
          recordId: 'runtime',
          message: 'runtime must have an empty commit head when no commits exist',
          context: {
            commitSequence: runtime.commitSequence,
            dataRevision: runtime.dataRevision,
            lastCommitId: runtime.lastCommitId,
          },
        });
      }
      return;
    }
    const last = commits[commits.length - 1];
    if (
      runtime.commitSequence !== last.sequence ||
      runtime.dataRevision !== last.dataRevision ||
      runtime.lastCommitId !== last.commitId
    ) {
      addIssue(issues, {
        code: 'RUNTIME_COMMIT_HEAD_INVALID',
        severity: 'diagnostic_only',
        storeName: 'system',
        recordId: 'runtime',
        message: 'runtime commit head does not match the last commit',
        context: {
          runtimeCommitSequence: runtime.commitSequence,
          lastSequence: last.sequence,
          runtimeDataRevision: runtime.dataRevision,
          lastDataRevision: last.dataRevision,
          runtimeLastCommitId: runtime.lastCommitId,
          lastCommitId: last.commitId,
        },
      });
    }
  }

  function checkMigrationSnapshot(snapshot, issues) {
    const migrationsById = mapById(snapshot.migrations);
    const commitsById = new Map(snapshot.commits.map((record) => [record.commitId, record]));
    const periods = mapById(snapshot.periods);
    const targets = Object.fromEntries(Object.entries(TARGETS).map(([targetType, definition]) => [
      targetType,
      mapById(snapshot[definition.storeName]),
    ]));
    const mappedTargets = {
      ...targets,
      period: mapById(snapshot.periods),
      category: mapById(snapshot.categories),
      fixed_expense_template: mapById(snapshot.fixedExpenseTemplates),
    };
    const seenSources = new Set();
    const seenMappings = new Set();
    const seenLegacyEntries = new Set();

    snapshot.migrations.forEach((migration) => {
      const sourceKey = `${migration.sourceKey}:${migration.sourceHash}:${migration.mapperVersion}`;
      const valid = (
        catchesValidation(() => assertUuid(migration.id, { field: 'migration.id', version: 4 })) &&
        migration.sourceKey === 'perita_v1' &&
        normalizedSha256(migration.sourceHash) !== null &&
        typeof migration.mapperVersion === 'string' && migration.mapperVersion.trim() !== '' &&
        migration.status === 'completed' &&
        validIsoTimestamp(migration.startedAt) &&
        validIsoTimestamp(migration.completedAt) &&
        validIsoTimestamp(migration.cutoverAt) &&
        migration.startedAt === migration.completedAt &&
        migration.completedAt === migration.cutoverAt &&
        Array.isArray(migration.warnings) &&
        Number.isSafeInteger(migration.targetDataRevision) && migration.targetDataRevision > 0 &&
        catchesValidation(() => assertUuid(migration.cutoverPeriodId, { field: 'cutoverPeriodId' })) &&
        catchesValidation(() => assertUuid(migration.baselineCommitId, {
          field: 'baselineCommitId', version: 4,
        }))
      );
      if (!valid || seenSources.has(sourceKey)) {
        addIssue(issues, {
          code: seenSources.has(sourceKey)
            ? 'MIGRATION_SOURCE_DUPLICATE'
            : 'MIGRATION_RECORD_INVALID',
          severity: 'diagnostic_only',
          scopeType: 'migration',
          scopeId: migration.id,
          storeName: 'migrations',
          recordId: migration.id,
          message: seenSources.has(sourceKey)
            ? 'the same legacy source was migrated more than once'
            : 'migration record shape or cutover metadata is invalid',
        });
      }
      seenSources.add(sourceKey);

      const baselineCommit = commitsById.get(migration.baselineCommitId);
      if (
        !baselineCommit ||
        baselineCommit.commandType !== 'migration.confirm' ||
        baselineCommit.dataRevision !== migration.targetDataRevision
      ) {
        addIssue(issues, {
          code: 'MIGRATION_BASELINE_COMMIT_INVALID',
          severity: 'diagnostic_only',
          scopeType: 'migration',
          scopeId: migration.id,
          storeName: 'migrations',
          recordId: migration.id,
          message: 'baselineCommitId does not identify the confirmed migration commit',
          context: { baselineCommitId: migration.baselineCommitId },
        });
      }
      const period = periods.get(migration.cutoverPeriodId);
      if (
        !period || period.status !== 'open' ||
        !snapshot.runtime || snapshot.runtime.activePeriodId !== migration.cutoverPeriodId
      ) {
        addIssue(issues, {
          code: 'MIGRATION_CUTOVER_PERIOD_INVALID',
          severity: 'diagnostic_only',
          scopeType: 'period',
          scopeId: migration.cutoverPeriodId,
          storeName: 'migrations',
          recordId: migration.id,
          message: 'cutoverPeriodId must identify the active open hybrid period',
        });
      }
      if (migration.warnings && migration.warnings.length > 0) {
        addIssue(issues, {
          code: 'MIGRATION_RESTRICTED_LEGACY',
          severity: 'warning',
          scopeType: 'migration',
          scopeId: migration.id,
          storeName: 'migrations',
          recordId: migration.id,
          message: 'migration preserved restricted legacy diagnostics',
          context: { warningCount: migration.warnings.length },
        });
      }
      snapshot.operations.forEach((operation) => {
        if (operation.createdAt < migration.cutoverAt) {
          addIssue(issues, {
            code: 'MIGRATION_PRE_CUTOVER_OPERATION',
            severity: 'diagnostic_only',
            scopeType: 'period',
            scopeId: operation.periodId,
            storeName: 'operations',
            recordId: operation.id,
            message: 'canonical Operation predates the confirmed cutover',
          });
        }
      });
      snapshot.movements.forEach((movement) => {
        if (movement.createdAt < migration.cutoverAt) {
          addIssue(issues, {
            code: 'MIGRATION_PRE_CUTOVER_MOVEMENT',
            severity: 'diagnostic_only',
            scopeType: movement.targetType,
            scopeId: movement.targetId,
            storeName: 'movements',
            recordId: movement.id,
            message: 'canonical Movement predates the confirmed cutover',
          });
        }
      });
    });

    snapshot.legacyIdMap.forEach((mapping) => {
      const logicalKey = `${mapping.sourceHash}:${mapping.entityKind}:${mapping.legacyPath}`;
      const migration = snapshot.migrations.find((record) => record.sourceHash === mapping.sourceHash);
      if (
        seenMappings.has(logicalKey) || !migration ||
        !catchesValidation(() => assertUuid(mapping.id, { field: 'legacyIdMap.id' })) ||
        !catchesValidation(() => assertUuid(mapping.targetId, { field: 'legacyIdMap.targetId' })) ||
        typeof mapping.entityKind !== 'string' || mapping.entityKind.trim() === '' ||
        typeof mapping.legacyPath !== 'string' || mapping.legacyPath.trim() === '' ||
        typeof mapping.stableKey !== 'string'
      ) {
        addIssue(issues, {
          code: seenMappings.has(logicalKey)
            ? 'LEGACY_ID_MAP_DUPLICATE'
            : 'LEGACY_ID_MAP_INVALID',
          severity: 'restricted',
          scopeType: 'migration',
          scopeId: migration ? migration.id : null,
          storeName: 'legacyIdMap',
          recordId: mapping.id,
          message: 'legacy ID mapping is duplicated or inconsistent with its migration',
        });
      }
      seenMappings.add(logicalKey);
      if (hasOwn(TARGETS, mapping.entityKind)) {
        const entity = targets[mapping.entityKind].get(mapping.targetId);
        const opening = migration && snapshot.periodOpenings.filter((record) => (
          record.periodId === migration.cutoverPeriodId &&
          record.targetType === mapping.entityKind &&
          record.targetId === mapping.targetId
        ));
        const definition = TARGETS[mapping.entityKind];
        if (
          !entity || !opening || opening.length !== 1 ||
          opening[0].openingAmount !== entity[definition.openingField]
        ) {
          addIssue(issues, {
            code: 'MIGRATION_OPENING_INVALID',
            severity: 'restricted',
            scopeType: mapping.entityKind,
            scopeId: mapping.targetId,
            storeName: 'periodOpenings',
            recordId: opening && opening[0] ? opening[0].id : null,
            message: 'migrated entity lacks its exact authoritative cutover opening',
          });
        }
      } else if (!hasOwn(mappedTargets, mapping.entityKind) || !mappedTargets[mapping.entityKind].has(mapping.targetId)) {
        addIssue(issues, {
          code: 'LEGACY_ID_MAP_TARGET_MISSING',
          severity: 'restricted',
          scopeType: 'migration',
          scopeId: migration ? migration.id : null,
          storeName: 'legacyIdMap',
          recordId: mapping.id,
          message: 'legacy ID mapping references a missing or unsupported target',
          context: { entityKind: mapping.entityKind, targetId: mapping.targetId },
        });
      }
    });

    snapshot.legacyEntries.forEach((entry) => {
      const logicalKey = `${entry.periodId}:${entry.legacyPath}`;
      if (seenLegacyEntries.has(logicalKey)) {
        addIssue(issues, {
          code: 'LEGACY_ENTRY_DUPLICATE',
          severity: 'restricted',
          scopeType: 'migration',
          scopeId: entry.migrationId,
          storeName: 'legacyEntries',
          recordId: entry.id,
          message: 'legacy entry path is duplicated within its period',
        });
      }
      seenLegacyEntries.add(logicalKey);
      if (entry.migrationId && !migrationsById.has(entry.migrationId)) {
        addIssue(issues, {
          code: 'LEGACY_ENTRY_MIGRATION_MISSING',
          severity: 'restricted',
          scopeType: 'migration',
          scopeId: entry.migrationId,
          storeName: 'legacyEntries',
          recordId: entry.id,
          message: 'legacy entry references a missing migration',
        });
      }
    });
  }

  function missingRelation(issues, details) {
    addIssue(issues, {
      code: details.code,
      severity: details.severity || 'restricted',
      scopeType: details.scopeType,
      scopeId: details.scopeId,
      storeName: details.storeName,
      recordId: details.recordId,
      message: details.message,
      context: details.context,
    });
  }

  function checkRelationshipSnapshot(snapshot, issues, checkedAt, options) {
    const currentCivilDate = civilDateInChile(new Date(checkedAt));
    const periods = mapById(snapshot.periods);
    const templates = mapById(snapshot.fixedExpenseTemplates);
    const fixedInstances = mapById(snapshot.fixedExpenseInstances);
    const operations = mapById(snapshot.operations);
    const snapshots = mapById(snapshot.periodSnapshots);
    const migrations = mapById(snapshot.migrations);
    const commitsById = new Map(snapshot.commits.map((commit) => [commit.commitId, commit]));
    const targets = Object.fromEntries(Object.entries(TARGETS).map(([type, definition]) => [
      type,
      mapById(snapshot[definition.storeName]),
    ]));

    snapshot.periodOpenings.forEach((opening) => {
      if (!periods.has(opening.periodId)) {
        missingRelation(issues, {
          code: 'PERIOD_OPENING_PERIOD_MISSING',
          scopeType: 'period',
          scopeId: opening.periodId,
          storeName: 'periodOpenings',
          recordId: opening.id,
          message: 'period opening references a missing period',
        });
      }
      if (!hasOwn(TARGETS, opening.targetType) || !targets[opening.targetType].has(opening.targetId)) {
        missingRelation(issues, {
          code: 'PERIOD_OPENING_TARGET_MISSING',
          severity: hasOwn(TARGETS, opening.targetType) ? 'restricted' : 'diagnostic_only',
          scopeType: opening.targetType,
          scopeId: opening.targetId,
          storeName: 'periodOpenings',
          recordId: opening.id,
          message: 'period opening references a missing or incompatible target',
          context: { targetType: opening.targetType, targetId: opening.targetId },
        });
      }
    });

    snapshot.fixedExpenseInstances.forEach((instance) => {
      if (!periods.has(instance.periodId)) {
        missingRelation(issues, {
          code: 'FIXED_INSTANCE_PERIOD_MISSING',
          scopeType: 'period',
          scopeId: instance.periodId,
          storeName: 'fixedExpenseInstances',
          recordId: instance.id,
          message: 'fixed expense instance references a missing period',
        });
      }
      if (!templates.has(instance.templateId)) {
        missingRelation(issues, {
          code: 'FIXED_INSTANCE_TEMPLATE_MISSING',
          scopeType: 'fixed_expense_template',
          scopeId: instance.templateId,
          storeName: 'fixedExpenseInstances',
          recordId: instance.id,
          message: 'fixed expense instance references a missing template',
        });
      }
    });

    snapshot.operations.forEach((operation) => {
      if (!periods.has(operation.periodId)) {
        missingRelation(issues, {
          code: 'OPERATION_PERIOD_MISSING',
          scopeType: 'period',
          scopeId: operation.periodId,
          storeName: 'operations',
          recordId: operation.id,
          message: 'operation references a missing period',
        });
      }
    });

    snapshot.movements.forEach((movement) => {
      const operation = operations.get(movement.operationId);
      if (!operation) {
        missingRelation(issues, {
          code: 'MOVEMENT_OPERATION_MISSING',
          scopeType: movement.targetType,
          scopeId: movement.targetId,
          storeName: 'movements',
          recordId: movement.id,
          message: 'movement references a missing operation',
        });
      } else if (movement.periodId !== operation.periodId) {
        missingRelation(issues, {
          code: 'MOVEMENT_PERIOD_MISMATCH',
          scopeType: movement.targetType,
          scopeId: movement.targetId,
          storeName: 'movements',
          recordId: movement.id,
          message: 'movement period does not match its operation',
          context: { movementPeriodId: movement.periodId, operationPeriodId: operation.periodId },
        });
      } else if (
        (
          operation.type === 'balance_adjustment' ||
          hasOwn(ACCOUNT_OPERATION_SIGNS, operation.type) ||
          BLOCK_FOUR_OPERATION_TYPES.has(operation.type)
        ) &&
        movement.status !== operation.status
      ) {
        missingRelation(issues, {
          code: 'MOVEMENT_OPERATION_STATUS_MISMATCH',
          scopeType: movement.targetType,
          scopeId: movement.targetId,
          storeName: 'movements',
          recordId: movement.id,
          message: 'movement status does not match its operation',
          context: { movementStatus: movement.status, operationStatus: operation.status },
        });
      }
      const definition = TARGETS[movement.targetType];
      if (!definition || !targets[movement.targetType].has(movement.targetId)) {
        missingRelation(issues, {
          code: 'MOVEMENT_TARGET_MISSING',
          severity: definition ? 'restricted' : 'diagnostic_only',
          scopeType: movement.targetType,
          scopeId: movement.targetId,
          storeName: 'movements',
          recordId: movement.id,
          message: 'movement references a missing or incompatible target',
          context: { targetType: movement.targetType, targetId: movement.targetId },
        });
      } else if (movement.effectType !== undefined && movement.effectType !== definition.effectType) {
        missingRelation(issues, {
          code: 'MOVEMENT_EFFECT_INCOMPATIBLE',
          scopeType: movement.targetType,
          scopeId: movement.targetId,
          storeName: 'movements',
          recordId: movement.id,
          message: 'movement effectType is incompatible with its target',
          context: { expected: definition.effectType, actual: movement.effectType },
        });
      }
    });

    snapshot.operations.forEach((operation) => {
      if (operation.type !== 'balance_adjustment') return;
      const related = snapshot.movements.filter((movement) => movement.operationId === operation.id);
      if (related.length !== 1) {
        missingRelation(issues, {
          code: 'BALANCE_ADJUSTMENT_MOVEMENT_CARDINALITY',
          scopeType: 'period',
          scopeId: operation.periodId,
          storeName: 'operations',
          recordId: operation.id,
          message: 'balance_adjustment must have exactly one movement',
          context: { movementCount: related.length },
        });
        return;
      }
      const movement = related[0];
      const targetField = movement.targetType === 'account'
        ? 'accountId'
        : movement.targetType === 'savings_goal'
          ? 'goalId'
          : null;
      const details = operation.details && typeof operation.details === 'object'
        ? operation.details
        : null;
      if (
        targetField === null || movement.effectType !== 'asset_balance' ||
        !details || details[targetField] !== movement.targetId
      ) {
        missingRelation(issues, {
          code: 'BALANCE_ADJUSTMENT_TARGET_INVALID',
          scopeType: movement.targetType,
          scopeId: movement.targetId,
          storeName: 'movements',
          recordId: movement.id,
          message: 'balance_adjustment movement must target an account or savings-goal balance',
          context: {
            targetType: movement.targetType,
            targetId: movement.targetId,
            effectType: movement.effectType,
            details,
          },
        });
      }
    });

    snapshot.operations.forEach((operation) => {
      if (!hasOwn(ACCOUNT_OPERATION_SIGNS, operation.type)) return;
      const related = snapshot.movements.filter((movement) => movement.operationId === operation.id);
      if (related.length !== 1) {
        missingRelation(issues, {
          code: 'ACCOUNT_OPERATION_MOVEMENT_CARDINALITY',
          scopeType: 'period',
          scopeId: operation.periodId,
          storeName: 'operations',
          recordId: operation.id,
          message: 'income or expense Operation must have exactly one account Movement',
          context: { operationType: operation.type, movementCount: related.length },
        });
        return;
      }
      const movement = related[0];
      const expectedDelta = ACCOUNT_OPERATION_SIGNS[operation.type] * operation.amount;
      if (
        movement.targetType !== 'account' ||
        movement.effectType !== 'asset_balance' ||
        movement.delta !== expectedDelta
      ) {
        missingRelation(issues, {
          code: 'ACCOUNT_OPERATION_MOVEMENT_INVALID',
          scopeType: movement.targetType,
          scopeId: movement.targetId,
          storeName: 'movements',
          recordId: movement.id,
          message: 'income or expense Movement has an invalid account target or sign',
          context: {
            operationType: operation.type,
            operationAmount: operation.amount,
            targetType: movement.targetType,
            effectType: movement.effectType,
            expectedDelta,
            actualDelta: movement.delta,
          },
        });
      }
    });

    const postedDebtPaymentsByDebt = new Map();
    snapshot.operations.forEach((operation) => {
      if (operation.type !== 'debt_payment') return;
      const related = snapshot.movements.filter((movement) => movement.operationId === operation.id);
      const details = operation.details || {};
      const accountMovement = related.find((movement) => movement.targetType === 'account');
      const debtMovement = related.find((movement) => movement.targetType === 'debt');
      if (related.length !== 2 || !accountMovement || !debtMovement) {
        missingRelation(issues, {
          code: 'DEBT_PAYMENT_MOVEMENT_CARDINALITY',
          scopeType: 'debt',
          scopeId: details.debtId,
          storeName: 'operations',
          recordId: operation.id,
          message: 'debt payment must have exactly one Account and one Debt Movement',
          context: { movementCount: related.length },
        });
        return;
      }
      if (
        accountMovement.targetId !== details.accountId ||
        debtMovement.targetId !== details.debtId ||
        accountMovement.delta !== -operation.amount ||
        debtMovement.delta !== -operation.amount
      ) {
        missingRelation(issues, {
          code: 'DEBT_PAYMENT_MOVEMENT_INVALID',
          scopeType: 'debt',
          scopeId: details.debtId,
          storeName: 'operations',
          recordId: operation.id,
          message: 'debt payment Movements must reduce Account and Debt by the same amount',
        });
      }
      if (operation.status === 'posted' && typeof details.debtId === 'string') {
        postedDebtPaymentsByDebt.set(
          details.debtId,
          (postedDebtPaymentsByDebt.get(details.debtId) || 0) + operation.amount
        );
      }
    });

    snapshot.operations.forEach((operation) => {
      if (operation.type !== 'debt_total_adjustment') return;
      const related = snapshot.movements.filter((movement) => movement.operationId === operation.id);
      const details = operation.details || {};
      const movement = related[0];
      const expectedDelta = details.newOutstandingAmount - details.previousOutstandingAmount;
      if (
        related.length !== 1 ||
        !movement ||
        movement.targetType !== 'debt' ||
        movement.targetId !== details.debtId ||
        movement.effectType !== 'debt_outstanding' ||
        !Number.isSafeInteger(expectedDelta) ||
        expectedDelta === 0 ||
        movement.delta !== expectedDelta ||
        operation.amount !== Math.abs(expectedDelta)
      ) {
        missingRelation(issues, {
          code: 'DEBT_TOTAL_ADJUSTMENT_MOVEMENT_INVALID',
          scopeType: 'debt',
          scopeId: details.debtId,
          storeName: 'operations',
          recordId: operation.id,
          message: 'debt total adjustment must contain its one approved signed Debt Movement',
          context: { movementCount: related.length, expectedDelta },
        });
      }
    });

    snapshot.operations.forEach((operation) => {
      if (!hasOwn(SAVINGS_OPERATION_SIGNS, operation.type)) return;
      const related = snapshot.movements.filter((movement) => movement.operationId === operation.id);
      const details = operation.details || {};
      const movement = related[0];
      const expectedDelta = SAVINGS_OPERATION_SIGNS[operation.type] * operation.amount;
      if (
        related.length !== 1 ||
        !movement ||
        movement.targetType !== 'savings_goal' ||
        movement.targetId !== details.goalId ||
        movement.effectType !== 'asset_balance' ||
        movement.delta !== expectedDelta
      ) {
        missingRelation(issues, {
          code: 'SAVINGS_OPERATION_MOVEMENT_INVALID',
          scopeType: 'savings_goal',
          scopeId: details.goalId,
          storeName: 'operations',
          recordId: operation.id,
          message: 'savings operation must have one correctly signed SavingsGoal Movement',
          context: { operationType: operation.type, movementCount: related.length, expectedDelta },
        });
      }
    });

    snapshot.operations.forEach((operation) => {
      if (operation.type !== 'transfer') return;
      const related = snapshot.movements.filter((movement) => movement.operationId === operation.id);
      const details = operation.details || {};
      const source = related.find((movement) => movement.delta < 0);
      const destination = related.find((movement) => movement.delta > 0);
      const allowed = new Set(['account', 'savings_goal']);
      const endpointsDiffer = details.sourceType !== details.destinationType ||
        details.sourceId !== details.destinationId;
      if (
        related.length !== 2 ||
        !source || !destination ||
        !allowed.has(source.targetType) ||
        !allowed.has(destination.targetType) ||
        !endpointsDiffer ||
        source.targetType !== details.sourceType ||
        source.targetId !== details.sourceId ||
        destination.targetType !== details.destinationType ||
        destination.targetId !== details.destinationId ||
        source.delta !== -operation.amount ||
        destination.delta !== operation.amount ||
        source.delta + destination.delta !== 0
      ) {
        missingRelation(issues, {
          code: 'TRANSFER_MOVEMENTS_INVALID',
          scopeType: 'period',
          scopeId: operation.periodId,
          storeName: 'operations',
          recordId: operation.id,
          message: 'transfer must have two balanced Movements over distinct allowed endpoints',
          context: { movementCount: related.length },
        });
      }
    });

    snapshot.savingsGoals.forEach((goal) => {
      if (
        Number.isSafeInteger(goal.currentBalance) &&
        Number.isSafeInteger(goal.targetAmount) &&
        typeof goal.progressStatus === 'string'
      ) {
        const expected = goal.currentBalance >= goal.targetAmount ? 'completed' : 'in_progress';
        if (goal.currentBalance < 0 || goal.progressStatus !== expected) {
          missingRelation(issues, {
            code: 'SAVINGS_GOAL_STATE_INCONSISTENT',
            scopeType: 'savings_goal',
            scopeId: goal.id,
            storeName: 'savingsGoals',
            recordId: goal.id,
            message: 'SavingsGoal balance and progress status are inconsistent',
            context: { currentBalance: goal.currentBalance, expected, actual: goal.progressStatus },
          });
        }
      }
    });

    snapshot.debts.forEach((debt) => {
      const postedPayments = postedDebtPaymentsByDebt.get(debt.id) || 0;
      if (
        Number.isSafeInteger(debt.totalAmount) &&
        postedPayments > debt.totalAmount
      ) {
        missingRelation(issues, {
          code: 'DEBT_POSTED_PAYMENTS_OVER_TOTAL',
          scopeType: 'debt',
          scopeId: debt.id,
          storeName: 'debts',
          recordId: debt.id,
          message: 'posted Debt payments cannot exceed the current Debt total',
          context: { postedPayments, totalAmount: debt.totalAmount },
        });
      }
      if (Number.isSafeInteger(debt.outstandingAmount)) {
        const expectedPaymentStatus = debt.outstandingAmount === 0
          ? 'paid'
          : debt.dueDate !== null && debt.dueDate < currentCivilDate
            ? 'overdue'
            : 'active';
        if (debt.paymentStatus === expectedPaymentStatus) return;
        missingRelation(issues, {
          code: 'DEBT_PAYMENT_STATE_INCONSISTENT',
          scopeType: 'debt',
          scopeId: debt.id,
          storeName: 'debts',
          recordId: debt.id,
          message: 'Debt payment status must match its outstanding amount and due date',
          context: {
            outstandingAmount: debt.outstandingAmount,
            dueDate: debt.dueDate,
            currentCivilDate,
            expected: expectedPaymentStatus,
            actual: debt.paymentStatus,
          },
        });
      }
    });

    const postedSalariesByPeriod = new Map();
    snapshot.operations.forEach((operation) => {
      if (operation.type !== 'salary_receipt' || operation.status !== 'posted') return;
      const count = (postedSalariesByPeriod.get(operation.periodId) || 0) + 1;
      postedSalariesByPeriod.set(operation.periodId, count);
      if (count > 1) {
        missingRelation(issues, {
          code: 'SALARY_RECEIPT_POSTED_DUPLICATE',
          scopeType: 'period',
          scopeId: operation.periodId,
          storeName: 'operations',
          recordId: operation.id,
          message: 'only one posted salary receipt is allowed per Period',
        });
      }
    });

    const postedFixedPayments = new Map();
    snapshot.operations.forEach((operation) => {
      if (operation.type !== 'fixed_expense_payment') return;
      const instanceId = operation.details && operation.details.fixedExpenseInstanceId;
      if (typeof instanceId !== 'string' || !fixedInstances.has(instanceId)) {
        missingRelation(issues, {
          code: 'FIXED_PAYMENT_INSTANCE_MISSING',
          scopeType: 'fixed_expense_instance',
          scopeId: instanceId,
          storeName: 'operations',
          recordId: operation.id,
          message: 'fixed expense payment references a missing instance',
          context: { fixedExpenseInstanceId: instanceId },
        });
        return;
      }
      const instance = fixedInstances.get(instanceId);
      if (instance.periodId !== operation.periodId) {
        missingRelation(issues, {
          code: 'FIXED_PAYMENT_INSTANCE_PERIOD_MISMATCH',
          scopeType: 'fixed_expense_instance',
          scopeId: instanceId,
          storeName: 'operations',
          recordId: operation.id,
          message: 'fixed expense payment and instance must share a Period',
          context: { operationPeriodId: operation.periodId, instancePeriodId: instance.periodId },
        });
      }
      if (operation.status === 'posted') {
        const prior = postedFixedPayments.get(instanceId);
        if (prior) {
          missingRelation(issues, {
            code: 'FIXED_PAYMENT_POSTED_DUPLICATE',
            scopeType: 'fixed_expense_instance',
            scopeId: instanceId,
            storeName: 'operations',
            recordId: operation.id,
            message: 'only one posted payment is allowed per FixedExpenseInstance',
            context: { previousOperationId: prior, operationId: operation.id },
          });
        } else {
          postedFixedPayments.set(instanceId, operation.id);
        }
      }
    });

    snapshot.fixedExpenseInstances.forEach((instance) => {
      const postedOperationId = postedFixedPayments.get(instance.id) || null;
      if (
        (instance.status === 'paid' && instance.activePaymentOperationId !== postedOperationId) ||
        (instance.status === 'pending' && (
          instance.activePaymentOperationId !== null || postedOperationId !== null
        ))
      ) {
        missingRelation(issues, {
          code: 'FIXED_INSTANCE_PAYMENT_STATE_INCONSISTENT',
          scopeType: 'fixed_expense_instance',
          scopeId: instance.id,
          storeName: 'fixedExpenseInstances',
          recordId: instance.id,
          message: 'FixedExpenseInstance state does not match its posted payment',
          context: {
            status: instance.status,
            activePaymentOperationId: instance.activePaymentOperationId,
            postedOperationId,
          },
        });
      }
    });

    const logicalRevisions = new Set();
    snapshot.operationRevisions.forEach((revision) => {
      const logicalKey = `${revision.operationId}:${revision.revisionNumber}`;
      if (logicalRevisions.has(logicalKey)) {
        missingRelation(issues, {
          code: 'OPERATION_REVISION_LOGICAL_DUPLICATE',
          scopeType: 'period',
          scopeId: revision.periodId,
          storeName: 'operationRevisions',
          recordId: revision.id,
          message: 'operationId and revisionNumber must be logically unique',
          context: {
            operationId: revision.operationId,
            revisionNumber: revision.revisionNumber,
          },
        });
      } else {
        logicalRevisions.add(logicalKey);
      }
    });

    snapshot.periodSnapshots.forEach((periodSnapshot) => {
      if (!periods.has(periodSnapshot.periodId)) {
        missingRelation(issues, {
          code: 'SNAPSHOT_PERIOD_MISSING',
          scopeType: 'period',
          scopeId: periodSnapshot.periodId,
          storeName: 'periodSnapshots',
          recordId: periodSnapshot.id,
          message: 'period snapshot references a missing period',
        });
      }
    });

    snapshot.legacyEntries.forEach((entry) => {
      if (!periods.has(entry.periodId)) {
        missingRelation(issues, {
          code: 'LEGACY_ENTRY_PERIOD_MISSING',
          severity: 'warning',
          scopeType: 'period',
          scopeId: entry.periodId,
          storeName: 'legacyEntries',
          recordId: entry.id,
          message: 'legacy entry references a missing period',
        });
      }
      if (entry.migrationId !== undefined && entry.migrationId !== null && !migrations.has(entry.migrationId)) {
        missingRelation(issues, {
          code: 'LEGACY_ENTRY_MIGRATION_MISSING',
          severity: 'warning',
          scopeType: 'migration',
          scopeId: entry.migrationId,
          storeName: 'legacyEntries',
          recordId: entry.id,
          message: 'legacy entry references a missing migration',
        });
      }
    });

    snapshot.pendingIntents.forEach((intent) => {
      const commit = intent.commitId === null || intent.commitId === undefined
        ? null
        : commitsById.get(intent.commitId);
      if (intent.status === 'completed' && !intent.commitId) {
        missingRelation(issues, {
          code: 'COMPLETED_INTENT_COMMIT_MISSING',
          severity: 'warning',
          scopeType: 'runtime',
          scopeId: 'pendingIntents',
          storeName: 'pendingIntents',
          recordId: intent.id,
          message: 'completed intent has no commitId',
        });
      } else if (intent.commitId && !commit) {
        missingRelation(issues, {
          code: 'INTENT_COMMIT_NOT_FOUND',
          severity: 'warning',
          scopeType: 'runtime',
          scopeId: 'pendingIntents',
          storeName: 'pendingIntents',
          recordId: intent.id,
          message: 'intent commitId does not reference a commit',
          context: { commitId: intent.commitId },
        });
      } else if (commit && commit.intentId !== intent.id) {
        missingRelation(issues, {
          code: 'INTENT_COMMIT_LINK_MISMATCH',
          severity: 'warning',
          scopeType: 'runtime',
          scopeId: 'pendingIntents',
          storeName: 'pendingIntents',
          recordId: intent.id,
          message: 'intent and commit do not link to each other',
          context: { commitId: intent.commitId, commitIntentId: commit.intentId },
        });
      }
    });

    snapshot.periods.forEach((period) => {
      if (period.snapshotId === null || period.snapshotId === undefined) return;
      const periodSnapshot = snapshots.get(period.snapshotId);
      if (!periodSnapshot || periodSnapshot.periodId !== period.id) {
        missingRelation(issues, {
          code: 'PERIOD_SNAPSHOT_LINK_INVALID',
          scopeType: 'period',
          scopeId: period.id,
          storeName: 'periods',
          recordId: period.id,
          message: 'period snapshotId does not reference a snapshot of the same period',
          context: { snapshotId: period.snapshotId },
        });
      }
    });

    const snapshotsByPeriod = new Map();
    snapshot.periodSnapshots.forEach((periodSnapshot) => {
      const records = snapshotsByPeriod.get(periodSnapshot.periodId) || [];
      records.push(periodSnapshot);
      snapshotsByPeriod.set(periodSnapshot.periodId, records);
    });
    for (const [periodId, records] of snapshotsByPeriod) {
      if (records.length > 1) {
        missingRelation(issues, {
          code: 'PERIOD_SNAPSHOT_DUPLICATE',
          scopeType: 'period',
          scopeId: periodId,
          storeName: 'periodSnapshots',
          recordId: records[1].id,
          message: 'a Period can have only one close snapshot',
          context: { snapshotIds: records.map((record) => record.id) },
        });
      }
    }

    snapshot.periods.forEach((period) => {
      const linked = snapshotsByPeriod.get(period.id) || [];
      if (period.status === 'closed' && linked.length === 0) {
        missingRelation(issues, {
          code: 'CLOSED_PERIOD_SNAPSHOT_MISSING',
          scopeType: 'period',
          scopeId: period.id,
          storeName: 'periodSnapshots',
          recordId: period.id,
          message: 'a closed Period requires exactly one PeriodSnapshot',
        });
      }
      if (period.status === 'open' && linked.length > 0) {
        missingRelation(issues, {
          code: 'OPEN_PERIOD_HAS_SNAPSHOT',
          scopeType: 'period',
          scopeId: period.id,
          storeName: 'periodSnapshots',
          recordId: linked[0].id,
          message: 'an open Period cannot already have a close snapshot',
        });
      }
      if (period.status === 'closed' && typeof period.closedAt === 'string') {
        snapshot.operations
          .filter((operation) => operation.periodId === period.id)
          .forEach((operation) => {
            if (
              (typeof operation.createdAt === 'string' && operation.createdAt > period.closedAt) ||
              (typeof operation.updatedAt === 'string' && operation.updatedAt > period.closedAt)
            ) {
              missingRelation(issues, {
                code: 'CLOSED_PERIOD_OPERATION_AFTER_CLOSE',
                scopeType: 'period',
                scopeId: period.id,
                storeName: 'operations',
                recordId: operation.id,
                message: 'a closed Period contains an Operation created or modified after close',
                context: { closedAt: period.closedAt, createdAt: operation.createdAt, updatedAt: operation.updatedAt },
              });
            }
          });
      }
    });

    const orderedPeriods = snapshot.periods
      .filter((period) => typeof period.periodKey === 'string' && /^\d{4}-\d{2}$/.test(period.periodKey))
      .slice()
      .sort((left, right) => left.periodKey.localeCompare(right.periodKey));
    for (let index = 1; index < orderedPeriods.length; index += 1) {
      const previous = orderedPeriods[index - 1];
      const current = orderedPeriods[index];
      let expected;
      try {
        expected = nextPeriod(previous.periodKey);
      } catch (_) {
        expected = null;
      }
      if (expected !== current.periodKey) {
        missingRelation(issues, {
          code: 'PERIOD_SEQUENCE_INVALID',
          scopeType: 'period',
          scopeId: current.id,
          storeName: 'periods',
          recordId: current.id,
          message: 'persisted Periods must form a consecutive monthly sequence',
          context: { previousPeriodKey: previous.periodKey, expectedPeriodKey: expected, actualPeriodKey: current.periodKey },
        });
      }
    }

    const logicalOpenings = new Set();
    snapshot.periodOpenings.forEach((opening) => {
      const key = `${opening.periodId}:${opening.targetType}:${opening.targetId}`;
      if (logicalOpenings.has(key)) {
        missingRelation(issues, {
          code: 'PERIOD_OPENING_DUPLICATE',
          scopeType: opening.targetType,
          scopeId: opening.targetId,
          storeName: 'periodOpenings',
          recordId: opening.id,
          message: 'PeriodOpening must be unique per Period and financial target',
          context: { periodId: opening.periodId },
        });
      }
      logicalOpenings.add(key);
    });

    for (let index = 1; index < orderedPeriods.length; index += 1) {
      const previous = orderedPeriods[index - 1];
      const current = orderedPeriods[index];
      const previousSnapshots = snapshotsByPeriod.get(previous.id) || [];
      if (previousSnapshots.length !== 1) continue;
      const balances = previousSnapshots[0].data && previousSnapshots[0].data.closingBalances;
      if (!balances || typeof balances !== 'object') continue;
      snapshot.periodOpenings
        .filter((opening) => opening.periodId === current.id)
        .forEach((opening) => {
          const key = `${opening.targetType}:${opening.targetId}`;
          if (hasOwn(balances, key) && balances[key] !== opening.openingAmount) {
            missingRelation(issues, {
              code: 'PERIOD_OPENING_CONTINUITY_INVALID',
              scopeType: opening.targetType,
              scopeId: opening.targetId,
              storeName: 'periodOpenings',
              recordId: opening.id,
              message: 'next Period opening must match the preceding verified closing balance',
              context: {
                previousPeriodId: previous.id,
                periodId: current.id,
                expectedOpeningAmount: balances[key],
                actualOpeningAmount: opening.openingAmount,
              },
            });
          }
        });
    }

    const logicalInstances = new Set();
    snapshot.fixedExpenseInstances.forEach((instance) => {
      const key = `${instance.periodId}:${instance.templateId}`;
      if (logicalInstances.has(key)) {
        missingRelation(issues, {
          code: 'FIXED_INSTANCE_PERIOD_TEMPLATE_DUPLICATE',
          scopeType: 'fixed_expense_template',
          scopeId: instance.templateId,
          storeName: 'fixedExpenseInstances',
          recordId: instance.id,
          message: 'only one FixedExpenseInstance is allowed per Period and Template',
          context: { periodId: instance.periodId },
        });
      }
      logicalInstances.add(key);
      if (
        instance.status !== undefined &&
        !['pending', 'paid', 'unpaid'].includes(instance.status)
      ) {
        missingRelation(issues, {
          code: 'FIXED_INSTANCE_STATUS_INVALID',
          scopeType: 'fixed_expense_instance',
          scopeId: instance.id,
          storeName: 'fixedExpenseInstances',
          recordId: instance.id,
          message: 'FixedExpenseInstance status is invalid',
          context: { status: instance.status },
        });
      }
      const template = templates.get(instance.templateId);
      if (
        template && template.status === 'inactive' &&
        typeof instance.createdAt === 'string' && typeof template.updatedAt === 'string' &&
        instance.createdAt >= template.updatedAt
      ) {
        missingRelation(issues, {
          code: 'INACTIVE_FIXED_TEMPLATE_COPIED',
          scopeType: 'fixed_expense_template',
          scopeId: template.id,
          storeName: 'fixedExpenseInstances',
          recordId: instance.id,
          message: 'a FixedExpenseInstance was created after its Template became inactive',
          context: { instanceCreatedAt: instance.createdAt, templateUpdatedAt: template.updatedAt },
        });
      }
    });

    snapshot.periodSnapshots.forEach((periodSnapshot) => {
      if (periodSnapshot.snapshotKind !== 'canonical') return;
      const period = periods.get(periodSnapshot.periodId);
      const data = periodSnapshot.data;
      const shapeValid = period && period.status === 'closed' &&
        periodSnapshot.periodKey === period.periodKey &&
        periodSnapshot.schemaVersion === IndexedDb.SCHEMA_VERSION &&
        periodSnapshot.closedAt === period.closedAt &&
        data && typeof data === 'object' &&
        Array.isArray(data.operations) && Array.isArray(data.movements) &&
        Array.isArray(data.fixedExpenses) && Array.isArray(data.periodOpenings) &&
        data.totals && typeof data.totals === 'object' &&
        periodSnapshot.integrity && periodSnapshot.integrity.algorithm === 'SHA-256';
      if (!shapeValid) {
        missingRelation(issues, {
          code: 'CANONICAL_SNAPSHOT_SHAPE_INVALID',
          scopeType: 'period',
          scopeId: periodSnapshot.periodId,
          storeName: 'periodSnapshots',
          recordId: periodSnapshot.id,
          message: 'canonical PeriodSnapshot shape or Period metadata is invalid',
        });
        return;
      }
      const liveOperations = snapshot.operations.filter(
        (operation) => operation.periodId === periodSnapshot.periodId
      );
      const liveMovements = snapshot.movements.filter(
        (movement) => movement.periodId === periodSnapshot.periodId
      );
      const liveOpenings = snapshot.periodOpenings.filter(
        (opening) => opening.periodId === periodSnapshot.periodId
      );
      const liveInstances = snapshot.fixedExpenseInstances.filter(
        (instance) => instance.periodId === periodSnapshot.periodId
      );
      if (
        canonicalJson(data.operations) !== canonicalJson(liveOperations) ||
        canonicalJson(data.movements) !== canonicalJson(liveMovements) ||
        canonicalJson(data.periodOpenings) !== canonicalJson(liveOpenings) ||
        canonicalJson(data.fixedExpenses) !== canonicalJson(liveInstances)
      ) {
        missingRelation(issues, {
          code: 'CANONICAL_SNAPSHOT_CONTENT_DIVERGENCE',
          scopeType: 'period',
          scopeId: periodSnapshot.periodId,
          storeName: 'periodSnapshots',
          recordId: periodSnapshot.id,
          message: 'canonical snapshot history differs from persisted closed-Period records',
        });
      }
      const recalculated = canonicalSnapshotTotals(periodSnapshot);
      if (!recalculated || Object.entries(recalculated).some(
        ([field, value]) => data.totals[field] !== value
      )) {
        missingRelation(issues, {
          code: 'CANONICAL_SNAPSHOT_TOTALS_INVALID',
          scopeType: 'period',
          scopeId: periodSnapshot.periodId,
          storeName: 'periodSnapshots',
          recordId: periodSnapshot.id,
          message: 'canonical snapshot totals do not match its posted Operations',
        });
      }
      const expectedHash = periodSnapshot.integrity.payloadHash;
      if (!options || typeof options.sha256 !== 'function') {
        addIssue(issues, {
          code: 'CANONICAL_SNAPSHOT_HASH_UNVERIFIED',
          severity: 'warning',
          scopeType: 'period',
          scopeId: periodSnapshot.periodId,
          storeName: 'periodSnapshots',
          recordId: periodSnapshot.id,
          message: 'canonical snapshot hash cannot be verified without SHA-256 capability',
        });
      } else {
        let actualHash = null;
        try {
          const result = options.sha256(canonicalJson(snapshotPayload(periodSnapshot)));
          if (!result || typeof result.then !== 'function') actualHash = normalizedSha256(result);
        } catch (_) {
          actualHash = null;
        }
        if (!actualHash || actualHash !== expectedHash) {
          missingRelation(issues, {
            code: 'CANONICAL_SNAPSHOT_HASH_INVALID',
            scopeType: 'period',
            scopeId: periodSnapshot.periodId,
            storeName: 'periodSnapshots',
            recordId: periodSnapshot.id,
            message: 'canonical snapshot SHA-256 does not match its payload',
            context: { expectedHash, actualHash },
          });
        }
      }
    });
  }

  function safeAmount(value) {
    return Number.isSafeInteger(value);
  }

  function sumPostedMovements(movements, issues, scope) {
    let total = 0;
    let reliable = true;
    movements.forEach((movement) => {
      if (!['posted', 'voided'].includes(movement.status)) {
        addIssue(issues, {
          code: 'MOVEMENT_STATUS_INVALID',
          severity: 'restricted',
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          storeName: 'movements',
          recordId: movement.id,
          message: 'movement status must be posted or voided',
          context: { status: movement.status },
        });
        reliable = false;
        return;
      }
      if (!safeAmount(movement.delta) || movement.delta === 0) {
        addIssue(issues, {
          code: 'MOVEMENT_AMOUNT_INVALID',
          severity: 'restricted',
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          storeName: 'movements',
          recordId: movement.id,
          message: 'movement delta must be a non-zero safe integer',
          context: { delta: movement.delta },
        });
        reliable = false;
        return;
      }
      if (movement.status === 'voided') return;
      const next = total + movement.delta;
      if (!Number.isSafeInteger(next)) {
        addIssue(issues, {
          code: 'MOVEMENT_SUM_UNSAFE',
          severity: 'restricted',
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          storeName: 'movements',
          recordId: movement.id,
          message: 'movement sum exceeds the safe integer range',
        });
        reliable = false;
        return;
      }
      total = next;
    });
    return { total, reliable };
  }

  function closingBalanceFromSnapshot(periodSnapshot, targetType, targetId) {
    const balances = periodSnapshot && periodSnapshot.data && periodSnapshot.data.closingBalances;
    if (!balances || typeof balances !== 'object') return undefined;
    const flatKey = `${targetType}:${targetId}`;
    if (safeAmount(balances[flatKey])) return balances[flatKey];
    const definition = TARGETS[targetType];
    for (const key of [targetType, definition && definition.storeName]) {
      if (key && balances[key] && safeAmount(balances[key][targetId])) {
        return balances[key][targetId];
      }
    }
    return undefined;
  }

  function checkBalanceSnapshot(snapshot, issues) {
    const targetRecords = {};
    Object.entries(TARGETS).forEach(([targetType, definition]) => {
      targetRecords[targetType] = mapById(snapshot[definition.storeName]);
      snapshot[definition.storeName].forEach((entity) => {
        const scopeId = entity.id;
        const scope = { scopeType: targetType, scopeId };
        const opening = entity[definition.openingField];
        const current = entity[definition.currentField];
        if (!safeAmount(opening) || !safeAmount(current)) {
          addIssue(issues, {
            code: 'ENTITY_BALANCE_AMOUNT_INVALID',
            severity: 'restricted',
            scopeType: targetType,
            scopeId,
            storeName: definition.storeName,
            recordId: entity.id,
            message: 'entity opening and current balances must be safe integers',
            context: {
              openingField: definition.openingField,
              openingValue: opening,
              currentField: definition.currentField,
              currentValue: current,
            },
          });
          return;
        }
        const related = snapshot.movements.filter(
          (movement) => movement.targetType === targetType && movement.targetId === entity.id
        );
        const sum = sumPostedMovements(related, issues, scope);
        const calculated = opening + sum.total;
        if (!Number.isSafeInteger(calculated)) {
          addIssue(issues, {
            code: 'ENTITY_BALANCE_UNSAFE',
            severity: 'restricted',
            scopeType: targetType,
            scopeId,
            storeName: definition.storeName,
            recordId: entity.id,
            message: 'calculated entity balance exceeds the safe integer range',
          });
        } else if (sum.reliable && calculated !== current) {
          addIssue(issues, {
            code: 'ENTITY_BALANCE_DIVERGENCE',
            severity: 'restricted',
            scopeType: targetType,
            scopeId,
            storeName: definition.storeName,
            recordId: entity.id,
            message: 'cached entity balance differs from opening plus posted movements',
            context: {
              opening,
              postedMovementDelta: sum.total,
              calculated,
              cached: current,
            },
          });
        }
      });
    });

    const periods = mapById(snapshot.periods);
    const periodSnapshots = new Map(snapshot.periodSnapshots.map((record) => [record.periodId, record]));
    snapshot.periodOpenings.forEach((opening) => {
      const scopeId = scopeForTarget(opening.targetType, opening.targetId);
      if (!safeAmount(opening.openingAmount)) {
        addIssue(issues, {
          code: 'PERIOD_OPENING_AMOUNT_INVALID',
          severity: 'restricted',
          scopeType: opening.targetType,
          scopeId: opening.targetId,
          storeName: 'periodOpenings',
          recordId: opening.id,
          message: 'period openingAmount must be a safe integer',
          context: { openingAmount: opening.openingAmount },
        });
        return;
      }
      const related = snapshot.movements.filter(
        (movement) => (
          movement.periodId === opening.periodId &&
          movement.targetType === opening.targetType &&
          movement.targetId === opening.targetId
        )
      );
      const sum = sumPostedMovements(related, issues, {
        scopeType: opening.targetType,
        scopeId: opening.targetId,
      });
      const calculated = opening.openingAmount + sum.total;
      const period = periods.get(opening.periodId);
      const entity = targetRecords[opening.targetType] &&
        targetRecords[opening.targetType].get(opening.targetId);
      const definition = TARGETS[opening.targetType];
      let verifiableClosing;
      if (period && period.status === 'open' && entity && definition) {
        verifiableClosing = entity[definition.currentField];
      } else if (period) {
        verifiableClosing = closingBalanceFromSnapshot(
          periodSnapshots.get(opening.periodId),
          opening.targetType,
          opening.targetId
        );
      }
      if (!safeAmount(verifiableClosing)) {
        addIssue(issues, {
          code: 'PERIOD_CLOSING_BALANCE_UNAVAILABLE',
          severity: 'warning',
          scopeType: 'period',
          scopeId: opening.periodId,
          storeName: 'periodOpenings',
          recordId: opening.id,
          message: 'period closing balance cannot be demonstrated from current records',
          context: { targetScope: scopeId },
        });
      } else if (sum.reliable && safeAmount(calculated) && calculated !== verifiableClosing) {
        addIssue(issues, {
          code: 'PERIOD_BALANCE_DIVERGENCE',
          severity: 'restricted',
          scopeType: opening.targetType,
          scopeId: opening.targetId,
          storeName: 'periodOpenings',
          recordId: opening.id,
          message: 'period opening plus posted movements differs from verifiable closing balance',
          context: {
            periodId: opening.periodId,
            openingAmount: opening.openingAmount,
            postedMovementDelta: sum.total,
            calculated,
            verifiableClosing,
          },
        });
      }
    });
  }

  function classify(issues) {
    let highest = 0;
    issues.forEach((issue) => {
      highest = Math.max(highest, SEVERITY_ORDER[issue.severity]);
    });
    return ['ok', 'warning', 'restricted', 'diagnostic_only'][highest];
  }

  function restrictedScopes(issues) {
    return [...new Set(issues
      .filter((issue) => issue.severity === 'restricted')
      .map((issue) => {
        if (issue.scopeType === 'period') return scopeForPeriod(issue.scopeId);
        return scopeForTarget(issue.scopeType, issue.scopeId);
      })
      .filter(Boolean))].sort();
  }

  function summaryFor(snapshot, issues) {
    const issueCounts = { warning: 0, restricted: 0, diagnostic_only: 0 };
    issues.forEach((issue) => { issueCounts[issue.severity] += 1; });
    return {
      recordCounts: Object.fromEntries(SNAPSHOT_STORES.map((storeName) => [
        storeName,
        storeName === 'system'
          ? Number(snapshot.schema !== undefined) + Number(snapshot.runtime !== undefined)
          : snapshot[storeName].length,
      ])),
      issueCount: issues.length,
      issueCounts,
    };
  }

  function runtimeCanReceiveHealth(runtime) {
    return Boolean(runtime && runtime.key === 'runtime');
  }

  function findIntegrityError(error) {
    let current = error;
    while (current) {
      if (current instanceof IntegrityError) return current;
      current = current.cause;
    }
    return null;
  }

  function inspectDataSnapshot(data, options) {
    const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const system = Array.isArray(source.system) ? source.system : [];
    const snapshot = {
      schema: system.find((record) => record && record.key === 'schema'),
      runtime: system.find((record) => record && record.key === 'runtime'),
    };
    for (const storeName of SNAPSHOT_STORES) {
      if (storeName !== 'system') {
        snapshot[storeName] = Array.isArray(source[storeName]) ? source[storeName] : [];
      }
    }
    const settings = options || {};
    const checkedAt = settings.checkedAt || new Date(0).toISOString();
    const issues = [];
    [
      checkRuntimeSnapshot,
      checkCommitSnapshot,
      checkMigrationSnapshot,
      checkRelationshipSnapshot,
      checkBalanceSnapshot,
    ].forEach((check) => check(snapshot, issues, checkedAt, { sha256: settings.sha256 }));
    return immutableCopy({
      status: classify(issues),
      restrictedScopes: restrictedScopes(issues),
      summary: summaryFor(snapshot, issues),
      issues,
    });
  }

  function createPeritaIntegrity(options) {
    const settings = options || {};
    const storage = settings.storage;
    const now = settings.now || (() => new Date().toISOString());
    const createUuid = settings.createUuid || (() => createUuidV4());
    const sha256 = settings.sha256;
    if (!storage || typeof storage.open !== 'function' || typeof storage.runTransaction !== 'function') {
      throw integrityError('a Perita IndexedDB storage instance is required', { field: 'storage' });
    }

    function newReportId() {
      try {
        return assertUuid(createUuid(), { field: 'integrityReportId', version: 4 });
      } catch (cause) {
        if (cause instanceof IntegrityError) throw cause;
        throw integrityError('integrity report UUID generation failed', {}, cause);
      }
    }

    async function readSnapshot() {
      await storage.open();
      try {
        return await storage.runTransaction(
          SNAPSHOT_STORES,
          'readonly',
          async (transaction) => {
            const system = await transaction.getAll('system');
            const snapshot = {
              schema: system.find((record) => record.key === 'schema'),
              runtime: system.find((record) => record.key === 'runtime'),
            };
            for (const storeName of SNAPSHOT_STORES) {
              if (storeName !== 'system') snapshot[storeName] = await transaction.getAll(storeName);
            }
            return snapshot;
          }
        );
      } catch (cause) {
        const typed = findIntegrityError(cause);
        throw typed || integrityError('integrity snapshot could not be read', {}, cause);
      }
    }

    async function persistReport(report, snapshot, updateHealth) {
      try {
        await storage.runTransaction(
          ['integrityReports', 'system'],
          'readwrite',
          async (transaction) => {
            const currentRuntime = await transaction.get('system', 'runtime');
            if (updateHealth && runtimeCanReceiveHealth(snapshot.runtime)) {
              if (
                !currentRuntime ||
                currentRuntime.dataRevision !== snapshot.runtime.dataRevision ||
                currentRuntime.commitSequence !== snapshot.runtime.commitSequence ||
                currentRuntime.lastCommitId !== snapshot.runtime.lastCommitId
              ) {
                throw integrityError(
                  'runtime changed while the integrity report was being prepared',
                  {
                    expectedDataRevision: snapshot.runtime.dataRevision,
                    actualDataRevision: currentRuntime && currentRuntime.dataRevision,
                  }
                );
              }
            }
            await transaction.add('integrityReports', report);
            if (updateHealth && runtimeCanReceiveHealth(snapshot.runtime)) {
              await transaction.put('system', {
                ...currentRuntime,
                healthStatus: report.status,
                restrictedScopes: restrictedScopes(report.issues),
                writeEnabled: report.status === 'diagnostic_only'
                  ? false
                  : currentRuntime.writeEnabled,
              });
            }
          }
        );
      } catch (cause) {
        const typed = findIntegrityError(cause);
        throw typed || integrityError(
          'integrity report and runtime health could not be saved atomically',
          { reportId: report.id, checkType: report.checkType },
          cause
        );
      }
    }

    async function runCheck(checkType, checks, updateHealth) {
      const startedAt = timestampFromNow(now);
      const snapshot = await readSnapshot();
      const issues = [];
      checks.forEach((check) => check(snapshot, issues, startedAt, { sha256 }));
      const completedAt = timestampFromNow(now);
      const report = {
        id: newReportId(),
        checkType,
        status: classify(issues),
        startedAt,
        completedAt,
        databaseGeneration: snapshot.schema ? snapshot.schema.databaseGeneration : null,
        dataRevision: snapshot.runtime && validNonNegativeRevision(snapshot.runtime.dataRevision)
          ? snapshot.runtime.dataRevision
          : null,
        commitSequence: snapshot.runtime && validNonNegativeRevision(snapshot.runtime.commitSequence)
          ? snapshot.runtime.commitSequence
          : null,
        summary: summaryFor(snapshot, issues),
        issues,
      };
      await persistReport(report, snapshot, updateHealth);
      return immutableCopy(report);
    }

    function runFullCheck() {
      return runCheck(CHECK_TYPES.FULL, [
        checkRuntimeSnapshot,
        checkCommitSnapshot,
        checkMigrationSnapshot,
        checkRelationshipSnapshot,
        checkBalanceSnapshot,
      ], true);
    }

    function checkRuntime() {
      return runCheck(CHECK_TYPES.RUNTIME, [checkRuntimeSnapshot], false);
    }

    function checkCommits() {
      return runCheck(CHECK_TYPES.COMMITS, [checkCommitSnapshot], false);
    }

    function checkRelationships() {
      return runCheck(CHECK_TYPES.RELATIONSHIPS, [checkRelationshipSnapshot], false);
    }

    function checkBalances() {
      return runCheck(CHECK_TYPES.BALANCES, [checkBalanceSnapshot], false);
    }

    async function getReports() {
      await storage.open();
      try {
        const reports = await storage.getAll('integrityReports');
        reports.sort((left, right) => (
          left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id)
        ));
        return immutableCopy(reports);
      } catch (cause) {
        throw integrityError('integrity reports could not be read', {}, cause);
      }
    }

    async function getLatestReport() {
      const reports = await getReports();
      return reports.length === 0 ? undefined : reports[reports.length - 1];
    }

    return Object.freeze({
      runFullCheck,
      checkRuntime,
      checkCommits,
      checkRelationships,
      checkBalances,
      getLatestReport,
      getReports,
    });
  }

  return Object.freeze({
    CHECK_TYPES,
    STATUSES,
    IntegrityError,
    inspectDataSnapshot,
    createPeritaIntegrity,
  });
});

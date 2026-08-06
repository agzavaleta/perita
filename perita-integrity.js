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
    createUuidV4,
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
    'fixedExpenseTemplates',
    'fixedExpenseInstances',
    'operations',
    'movements',
    'operationRevisions',
    'periodSnapshots',
    'legacyEntries',
    'migrations',
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

  function checkRelationshipSnapshot(snapshot, issues) {
    const periods = mapById(snapshot.periods);
    const templates = mapById(snapshot.fixedExpenseTemplates);
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
        operation.type === 'balance_adjustment' &&
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
      if (movement.targetType !== 'account' || movement.effectType !== 'asset_balance') {
        missingRelation(issues, {
          code: 'BALANCE_ADJUSTMENT_TARGET_INVALID',
          scopeType: movement.targetType,
          scopeId: movement.targetId,
          storeName: 'movements',
          recordId: movement.id,
          message: 'balance_adjustment movement must target an account balance',
          context: { targetType: movement.targetType, effectType: movement.effectType },
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

  function createPeritaIntegrity(options) {
    const settings = options || {};
    const storage = settings.storage;
    const now = settings.now || (() => new Date().toISOString());
    const createUuid = settings.createUuid || (() => createUuidV4());
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
      checks.forEach((check) => check(snapshot, issues));
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
    createPeritaIntegrity,
  });
});

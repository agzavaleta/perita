/* perita-backup.js — isolated V1.1.0 backup, restore, and definitive deletion
 *
 * This module does not download files, touch UI or localStorage, migrate V1
 * data, create financial commits, or retain a local recovery copy.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./perita-contracts.js'),
      require('./perita-indexeddb.js'),
      require('./perita-domain.js'),
      require('./perita-integrity.js')
    );
  } else {
    root.PeritaBackup = factory(
      root.PeritaContracts,
      root.PeritaIndexedDb,
      root.PeritaDomain,
      root.PeritaIntegrity
    );
  }
})(typeof self !== 'undefined' ? self : this, function (
  Contracts,
  IndexedDb,
  Domain,
  Integrity
) {
  'use strict';

  if (!Contracts) throw new Error('PeritaContracts is required');
  if (!IndexedDb) throw new Error('PeritaIndexedDb is required');
  if (!Domain) throw new Error('PeritaDomain is required');
  if (!Integrity) throw new Error('PeritaIntegrity is required');

  const {
    CHILE_TIME_ZONE,
    ERROR_CODES,
    PeritaError,
  } = Contracts;

  const BACKUP_DOCUMENT_TYPE = 'perita-backup';
  const BACKUP_FORMAT_VERSION = '1.0.0';
  const BACKUP_CANONICALIZATION = 'perita-stable-json-v1';
  const BACKUP_STORE_NAMES = Object.freeze([
    'system',
    'preferences',
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
    'commits',
    'integrityReports',
    'migrations',
    'legacyIdMap',
  ]);
  const EXCLUDED_BACKUP_STORE_NAMES = Object.freeze([
    'drafts',
    'pendingIntents',
    'coordination',
  ]);
  const BACKUP_TOP_LEVEL_FIELDS = Object.freeze([
    'documentType',
    'backupFormatVersion',
    'schemaVersion',
    'appVersion',
    'exportedAt',
    'timezone',
    'dataRevision',
    'data',
    'integrity',
  ]);
  const DOMAIN_VALIDATORS = Object.freeze({
    financialSettings: Domain.validateFinancialSettings,
    periods: Domain.validatePeriod,
    periodOpenings: Domain.validatePeriodOpening,
    accounts: Domain.validateAccount,
    savingsGoals: Domain.validateSavingsGoal,
    debts: Domain.validateDebt,
    categories: Domain.validateCategory,
    fixedExpenseTemplates: Domain.validateFixedExpenseTemplate,
    fixedExpenseInstances: Domain.validateFixedExpenseInstance,
    operations: Domain.validateOperation,
    movements: Domain.validateMovement,
    operationRevisions: Domain.validateOperationRevision,
    auditEvents: Domain.validateAuditEvent,
  });
  const STORE_KEY_FIELDS = Object.freeze({
    system: 'key',
    preferences: 'key',
    financialSettings: 'key',
    commits: 'sequence',
    coordination: 'key',
  });

  class BackupError extends PeritaError {}

  function backupError(code, message, context, cause) {
    return new BackupError(code, message, context, cause);
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
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

  function exactFields(value, fields) {
    if (!isRecord(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = fields.slice().sort();
    return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
  }

  function canonicalJsonValue(value) {
    if (Array.isArray(value)) return value.map(canonicalJsonValue);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])])
    );
  }

  function canonicalJson(value) {
    return JSON.stringify(canonicalJsonValue(value));
  }

  function timestamp(now) {
    let value;
    try {
      value = now();
    } catch (cause) {
      throw backupError(ERROR_CODES.BACKUP_INVALID, 'the backup clock failed', {}, cause);
    }
    const parsed = typeof value === 'string' ? new Date(value) : null;
    if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
      throw backupError(
        ERROR_CODES.BACKUP_INVALID,
        'backup timestamps must be canonical ISO UTC strings',
        { value }
      );
    }
    return value;
  }

  function isIsoUtcTimestamp(value) {
    const parsed = typeof value === 'string' ? new Date(value) : null;
    return Boolean(parsed && Number.isFinite(parsed.getTime()) && parsed.toISOString() === value);
  }

  async function sha256Hex(sha256, serialized) {
    if (typeof sha256 !== 'function') {
      throw backupError(
        ERROR_CODES.HASH_FAILED,
        'backup SHA-256 capability is required',
        { algorithm: 'SHA-256' }
      );
    }
    let digest;
    try {
      digest = await sha256(serialized);
    } catch (cause) {
      throw backupError(
        ERROR_CODES.HASH_FAILED,
        'backup SHA-256 calculation failed',
        { algorithm: 'SHA-256' },
        cause
      );
    }
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/i.test(digest)) {
      throw backupError(
        ERROR_CODES.HASH_FAILED,
        'backup SHA-256 must be a 64-character hexadecimal string',
        { algorithm: 'SHA-256' }
      );
    }
    return digest.toLowerCase();
  }

  function payloadWithoutIntegrity(backup) {
    const payload = { ...backup };
    delete payload.integrity;
    return payload;
  }

  function parseBackup(value) {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch (cause) {
        throw backupError(ERROR_CODES.BACKUP_INVALID, 'backup JSON is invalid', {}, cause);
      }
    }
    if (!isRecord(value)) {
      throw backupError(ERROR_CODES.BACKUP_INVALID, 'backup must be an object or JSON string');
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (cause) {
      throw backupError(ERROR_CODES.BACKUP_INVALID, 'backup is not JSON-serializable', {}, cause);
    }
  }

  function validationIssue(code, message, context) {
    return { code, message, context: context || {} };
  }

  function recordKey(storeName, record) {
    const field = STORE_KEY_FIELDS[storeName] || 'id';
    return isRecord(record) ? record[field] : undefined;
  }

  function validateStoreRecords(data, errors) {
    for (const storeName of BACKUP_STORE_NAMES) {
      const records = data[storeName];
      if (!Array.isArray(records)) continue;
      const seen = new Set();
      for (const record of records) {
        const key = recordKey(storeName, record);
        if (!isRecord(record) || key === undefined || key === null) {
          errors.push(validationIssue(
            ERROR_CODES.BACKUP_INVALID,
            `${storeName} contains a record without its primary key`,
            { storeName }
          ));
          continue;
        }
        const serializedKey = canonicalJson(key);
        if (seen.has(serializedKey)) {
          errors.push(validationIssue(
            ERROR_CODES.BACKUP_INVALID,
            `${storeName} contains a duplicate primary key`,
            { storeName, key }
          ));
        }
        seen.add(serializedKey);
      }
      const validator = DOMAIN_VALIDATORS[storeName];
      if (validator) {
        records.forEach((record) => {
          try {
            validator(record);
          } catch (cause) {
            errors.push(validationIssue(
              ERROR_CODES.BACKUP_INVALID,
              `${storeName} contains an invalid domain record`,
              { storeName, recordId: recordKey(storeName, record), causeCode: cause && cause.code }
            ));
          }
        });
      }
    }
  }

  function validateSystemRecords(backup, errors) {
    const system = backup.data.system;
    const schema = system.find((record) => record && record.key === 'schema');
    const runtime = system.find((record) => record && record.key === 'runtime');
    const schemaFields = [
      'key', 'schemaVersion', 'indexedDbVersion', 'appVersion', 'databaseName',
      'databaseGeneration', 'createdAt', 'updatedAt',
    ];
    const runtimeFields = [
      'key', 'setupStatus', 'activePeriodId', 'dataRevision', 'lastCommitId',
      'commitSequence', 'healthStatus', 'restrictedScopes', 'writeEnabled',
    ];
    if (
      system.length !== 2 ||
      !exactFields(schema, schemaFields) ||
      schema.schemaVersion !== backup.schemaVersion ||
      schema.appVersion !== backup.appVersion ||
      schema.databaseName !== IndexedDb.DATABASE_NAME ||
      !isIsoUtcTimestamp(schema.createdAt) ||
      !isIsoUtcTimestamp(schema.updatedAt)
    ) {
      errors.push(validationIssue(
        ERROR_CODES.BACKUP_INVALID,
        'backup system/schema record is invalid or inconsistent'
      ));
    }
    if (
      !exactFields(runtime, runtimeFields) ||
      !['not_started', 'in_progress', 'completed', 'deleted'].includes(runtime.setupStatus) ||
      !['ok', 'warning', 'restricted', 'diagnostic_only'].includes(runtime.healthStatus) ||
      !Array.isArray(runtime.restrictedScopes) ||
      typeof runtime.writeEnabled !== 'boolean'
    ) {
      errors.push(validationIssue(
        ERROR_CODES.BACKUP_INVALID,
        'backup system/runtime record is invalid'
      ));
    }
  }

  function safeRuntime(runtime) {
    return {
      ...runtime,
      writeEnabled: false,
    };
  }

  function safeRestoreData(data) {
    const copy = JSON.parse(JSON.stringify(data));
    copy.periods = copy.periods.map((record) => Domain.validatePeriod(record));
    copy.accounts = copy.accounts.map((record) => Domain.validateAccount(record));
    copy.savingsGoals = copy.savingsGoals.map((record) => Domain.validateSavingsGoal(record));
    copy.debts = copy.debts.map((record) => Domain.validateDebt(record));
    copy.system = copy.system.map((record) => (
      record.key === 'runtime' ? safeRuntime(record) : record
    ));
    return copy;
  }

  function validationResult(status, backup, errors, integrityReport) {
    return immutableCopy({
      status,
      backup: status === 'valid' ? backup : null,
      errors,
      integrity: integrityReport || null,
    });
  }

  function statusError(result, fallbackCode) {
    const first = result.errors[0] || {};
    return backupError(
      first.code || fallbackCode,
      first.message || 'backup validation failed',
      first.context || {}
    );
  }

  function createPeritaBackup(options) {
    const settings = options || {};
    const storage = settings.storage;
    const indexedDbFactory = hasOwn(settings, 'indexedDB')
      ? settings.indexedDB
      : typeof globalThis !== 'undefined'
        ? globalThis.indexedDB
        : undefined;
    const now = settings.now || (() => new Date().toISOString());
    const sha256 = settings.sha256;
    if (!storage || typeof storage.open !== 'function' || typeof storage.runTransaction !== 'function') {
      throw backupError(
        ERROR_CODES.BACKUP_INVALID,
        'a Perita IndexedDB storage instance is required',
        { field: 'storage' }
      );
    }

    async function readData() {
      await storage.open();
      try {
        return await storage.runTransaction(
          BACKUP_STORE_NAMES,
          'readonly',
          async (transaction) => {
            const entries = [];
            for (const storeName of BACKUP_STORE_NAMES) {
              const records = await transaction.getAll(storeName);
              entries.push([
                storeName,
                storeName === 'periods'
                  ? records.map(Domain.validatePeriod)
                  : storeName === 'accounts'
                    ? records.map(Domain.validateAccount)
                    : storeName === 'savingsGoals'
                      ? records.map(Domain.validateSavingsGoal)
                    : storeName === 'debts'
                      ? records.map(Domain.validateDebt)
                    : records,
              ]);
            }
            return immutableCopy(Object.fromEntries(entries));
          }
        );
      } catch (cause) {
        throw backupError(
          ERROR_CODES.BACKUP_INVALID,
          'backup data could not be read consistently',
          { stores: BACKUP_STORE_NAMES },
          cause
        );
      }
    }

    async function exportBackup() {
      const exportedAt = timestamp(now);
      const data = await readData();
      const schema = data.system.find((record) => record.key === 'schema');
      const runtime = data.system.find((record) => record.key === 'runtime');
      if (!schema || !runtime) {
        throw backupError(
          ERROR_CODES.BACKUP_INVALID,
          'system schema and runtime are required for export'
        );
      }
      const payload = immutableCopy({
        documentType: BACKUP_DOCUMENT_TYPE,
        backupFormatVersion: BACKUP_FORMAT_VERSION,
        schemaVersion: schema.schemaVersion,
        appVersion: schema.appVersion,
        exportedAt,
        timezone: CHILE_TIME_ZONE,
        dataRevision: runtime.dataRevision,
        data,
      });
      return immutableCopy({
        ...payload,
        integrity: {
          algorithm: 'SHA-256',
          canonicalization: BACKUP_CANONICALIZATION,
          payloadHash: await sha256Hex(sha256, canonicalJson(payload)),
        },
      });
    }

    async function analyzeBackup(value) {
      let backup;
      try {
        backup = parseBackup(value);
      } catch (cause) {
        return validationResult('invalid', null, [validationIssue(
          cause.code || ERROR_CODES.BACKUP_INVALID,
          cause.message,
          cause.context
        )]);
      }
      if (!exactFields(backup, BACKUP_TOP_LEVEL_FIELDS)) {
        return validationResult('invalid', null, [validationIssue(
          ERROR_CODES.BACKUP_INVALID,
          'backup top-level fields are incomplete or unsupported'
        )]);
      }
      if (
        backup.documentType !== BACKUP_DOCUMENT_TYPE ||
        backup.backupFormatVersion !== BACKUP_FORMAT_VERSION
      ) {
        return validationResult('incompatible', null, [validationIssue(
          ERROR_CODES.BACKUP_INCOMPATIBLE,
          'backup document type or format version is incompatible',
          {
            documentType: backup.documentType,
            backupFormatVersion: backup.backupFormatVersion,
          }
        )]);
      }
      if (
        backup.schemaVersion !== IndexedDb.SCHEMA_VERSION ||
        backup.appVersion !== IndexedDb.SCHEMA_VERSION
      ) {
        return validationResult('incompatible', null, [validationIssue(
          ERROR_CODES.BACKUP_INCOMPATIBLE,
          'backup schema or app version is incompatible',
          { schemaVersion: backup.schemaVersion, appVersion: backup.appVersion }
        )]);
      }
      if (
        backup.timezone !== CHILE_TIME_ZONE ||
        !isIsoUtcTimestamp(backup.exportedAt) ||
        !isRecord(backup.data) ||
        !exactFields(backup.data, BACKUP_STORE_NAMES) ||
        !isRecord(backup.integrity) ||
        !exactFields(backup.integrity, ['algorithm', 'canonicalization', 'payloadHash'])
      ) {
        return validationResult('invalid', null, [validationIssue(
          ERROR_CODES.BACKUP_INVALID,
          'backup data stores, timezone, or integrity metadata are invalid'
        )]);
      }
      const schema = backup.data.system.find((record) => record && record.key === 'schema');
      if (!schema || schema.indexedDbVersion !== IndexedDb.DATABASE_VERSION) {
        return validationResult('incompatible', null, [validationIssue(
          ERROR_CODES.BACKUP_INCOMPATIBLE,
          'backup physical IndexedDB version is incompatible',
          { indexedDbVersion: schema && schema.indexedDbVersion }
        )]);
      }
      if (
        backup.integrity.algorithm !== 'SHA-256' ||
        backup.integrity.canonicalization !== BACKUP_CANONICALIZATION
      ) {
        return validationResult('incompatible', null, [validationIssue(
          ERROR_CODES.BACKUP_INCOMPATIBLE,
          'backup integrity mechanism is incompatible',
          backup.integrity
        )]);
      }
      let actualHash;
      try {
        actualHash = await sha256Hex(sha256, canonicalJson(payloadWithoutIntegrity(backup)));
      } catch (cause) {
        return validationResult('invalid', null, [validationIssue(
          cause.code || ERROR_CODES.HASH_FAILED,
          cause.message,
          cause.context
        )]);
      }
      if (
        typeof backup.integrity.payloadHash !== 'string' ||
        actualHash !== backup.integrity.payloadHash.toLowerCase()
      ) {
        return validationResult('invalid', null, [validationIssue(
          ERROR_CODES.BACKUP_HASH_MISMATCH,
          'backup SHA-256 does not match its canonical payload',
          { expectedHash: backup.integrity.payloadHash, actualHash }
        )]);
      }
      const errors = [];
      if (!Number.isSafeInteger(backup.dataRevision) || backup.dataRevision < 0) {
        errors.push(validationIssue(
          ERROR_CODES.BACKUP_INVALID,
          'backup dataRevision must be a non-negative safe integer'
        ));
      }
      for (const storeName of BACKUP_STORE_NAMES) {
        if (!Array.isArray(backup.data[storeName])) {
          errors.push(validationIssue(
            ERROR_CODES.BACKUP_INVALID,
            'backup store data must be an array',
            { storeName }
          ));
        }
      }
      if (errors.length === 0) {
        validateSystemRecords(backup, errors);
        validateStoreRecords(backup.data, errors);
      }
      const runtime = backup.data.system.find((record) => record && record.key === 'runtime');
      if (!runtime || runtime.dataRevision !== backup.dataRevision) {
        errors.push(validationIssue(
          ERROR_CODES.BACKUP_INVALID,
          'backup dataRevision does not match system/runtime',
          { dataRevision: backup.dataRevision, runtimeDataRevision: runtime && runtime.dataRevision }
        ));
      }
      let integrityReport = null;
      if (errors.length === 0) {
        integrityReport = Integrity.inspectDataSnapshot(backup.data, {
          checkedAt: backup.exportedAt,
          sha256,
        });
        if (!['ok', 'warning'].includes(integrityReport.status)) {
          errors.push(validationIssue(
            ERROR_CODES.BACKUP_INVALID,
            'backup integrity is insufficient for restoration',
            { status: integrityReport.status, issues: integrityReport.issues }
          ));
        }
      }
      return validationResult(
        errors.length === 0 ? 'valid' : 'invalid',
        errors.length === 0 ? immutableCopy(backup) : null,
        errors,
        integrityReport
      );
    }

    async function validateBackup(value) {
      return analyzeBackup(value);
    }

    async function restoreBackup(input) {
      const request = isRecord(input) ? input : {};
      if (!hasOwn(request, 'backup') || !hasOwn(request, 'preventiveBackup')) {
        throw backupError(
          ERROR_CODES.BACKUP_INVALID,
          'restore requires the target backup and a preventive backup of the current state'
        );
      }
      const targetResult = await analyzeBackup(request.backup);
      if (targetResult.status !== 'valid') throw statusError(targetResult, ERROR_CODES.BACKUP_INVALID);
      const preventiveResult = await analyzeBackup(request.preventiveBackup);
      if (preventiveResult.status !== 'valid') throw statusError(preventiveResult, ERROR_CODES.BACKUP_INVALID);
      const restoreData = safeRestoreData(targetResult.backup.data);
      let preventiveMismatch = false;
      try {
        await storage.runTransaction(
          IndexedDb.STORE_NAMES,
          'readwrite',
          async (transaction) => {
            const currentEntries = [];
            for (const storeName of BACKUP_STORE_NAMES) {
              const records = await transaction.getAll(storeName);
              currentEntries.push([
                storeName,
                storeName === 'periods' ? records.map(Domain.validatePeriod) : records,
              ]);
            }
            if (
              canonicalJson(preventiveResult.backup.data) !==
              canonicalJson(Object.fromEntries(currentEntries))
            ) {
              preventiveMismatch = true;
              throw backupError(
                ERROR_CODES.BACKUP_INVALID,
                'preventive backup does not match the current database state'
              );
            }
            for (const storeName of IndexedDb.STORE_NAMES) {
              const existing = await transaction.getAll(storeName);
              for (const record of existing) {
                await transaction.remove(storeName, recordKey(storeName, record));
              }
            }
            for (const storeName of BACKUP_STORE_NAMES) {
              for (const record of restoreData[storeName]) {
                await transaction.add(storeName, record);
              }
            }
          }
        );
      } catch (cause) {
        if (preventiveMismatch) {
          throw backupError(
            ERROR_CODES.BACKUP_INVALID,
            'preventive backup does not match the current database state',
            {},
            cause
          );
        }
        throw backupError(
          ERROR_CODES.RESTORE_FAILED,
          'backup restoration failed; the previous database remains intact',
          { stores: IndexedDb.STORE_NAMES },
          cause
        );
      }
      return immutableCopy({
        restored: true,
        restoredAt: timestamp(now),
        dataRevision: targetResult.backup.dataRevision,
        runtime: restoreData.system.find((record) => record.key === 'runtime'),
      });
    }

    function deleteDatabase() {
      if (!indexedDbFactory || typeof indexedDbFactory.deleteDatabase !== 'function') {
        return Promise.reject(backupError(
          ERROR_CODES.DELETE_FAILED,
          'IndexedDB deletion is unavailable',
          { databaseName: IndexedDb.DATABASE_NAME }
        ));
      }
      storage.close();
      return new Promise((resolve, reject) => {
        let request;
        try {
          request = indexedDbFactory.deleteDatabase(IndexedDb.DATABASE_NAME);
        } catch (cause) {
          reject(backupError(
            ERROR_CODES.DELETE_FAILED,
            'definitive database deletion could not start',
            { databaseName: IndexedDb.DATABASE_NAME },
            cause
          ));
          return;
        }
        request.onsuccess = () => resolve();
        request.onerror = () => reject(backupError(
          ERROR_CODES.DELETE_FAILED,
          'definitive database deletion failed',
          { databaseName: IndexedDb.DATABASE_NAME },
          request.error
        ));
        request.onblocked = () => {
          if (typeof settings.onDeleteBlocked === 'function') settings.onDeleteBlocked();
        };
      });
    }

    async function deleteAllData(input) {
      const request = isRecord(input) ? input : {};
      if (!hasOwn(request, 'backup')) {
        throw backupError(
          ERROR_CODES.DELETE_BACKUP_REQUIRED,
          'definitive deletion requires a complete external backup'
        );
      }
      if (request.confirmation !== 'ELIMINAR') {
        throw backupError(
          ERROR_CODES.DELETE_CONFIRMATION_INVALID,
          'definitive deletion requires the exact confirmation ELIMINAR'
        );
      }
      const result = await analyzeBackup(request.backup);
      if (result.status !== 'valid') {
        throw backupError(
          ERROR_CODES.DELETE_BACKUP_INVALID,
          'definitive deletion requires a valid V1.1.0 backup',
          { validationStatus: result.status, errors: result.errors }
        );
      }
      try {
        await deleteDatabase();
      } catch (cause) {
        if (cause instanceof BackupError) throw cause;
        throw backupError(
          ERROR_CODES.DELETE_FAILED,
          'definitive database deletion failed',
          { databaseName: IndexedDb.DATABASE_NAME },
          cause
        );
      }
      return immutableCopy({ deleted: true, databaseName: IndexedDb.DATABASE_NAME });
    }

    return Object.freeze({
      exportBackup,
      validateBackup,
      restoreBackup,
      deleteAllData,
    });
  }

  return Object.freeze({
    BACKUP_DOCUMENT_TYPE,
    BACKUP_FORMAT_VERSION,
    BACKUP_CANONICALIZATION,
    BACKUP_STORE_NAMES,
    EXCLUDED_BACKUP_STORE_NAMES,
    BackupError,
    canonicalJson,
    createPeritaBackup,
  });
});

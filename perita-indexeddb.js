/* perita-indexeddb.js — isolated IndexedDB persistence for Perita V1.1.0
 *
 * This module owns only physical storage concerns. It does not read localStorage,
 * migrate legacy data, implement financial operations, or connect itself to UI.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./perita-contracts.js'));
  } else {
    root.PeritaIndexedDb = factory(root.PeritaContracts);
  }
})(typeof self !== 'undefined' ? self : this, function (Contracts) {
  'use strict';

  if (!Contracts) throw new Error('PeritaContracts is required');

  const {
    ERROR_CODES,
    StorageError,
    assertRevision,
    assertUuid,
    createUuidV4,
  } = Contracts;

  const DATABASE_NAME = 'perita_v110';
  const DATABASE_VERSION = 1;
  const SCHEMA_VERSION = '1.1.0';

  const STORE_DEFINITIONS = {
    system: { keyPath: 'key', indexes: [] },
    preferences: { keyPath: 'key', indexes: [] },
    financialSettings: { keyPath: 'key', indexes: [] },
    periods: {
      keyPath: 'id',
      indexes: [
        { name: 'byPeriodKey', keyPath: 'periodKey', unique: true },
        { name: 'byStatus', keyPath: 'status', unique: false },
      ],
    },
    periodOpenings: {
      keyPath: 'id',
      indexes: [
        {
          name: 'byPeriodTarget',
          keyPath: ['periodId', 'targetType', 'targetId'],
          unique: true,
        },
      ],
    },
    accounts: {
      keyPath: 'id',
      indexes: [{ name: 'byStatus', keyPath: 'status', unique: false }],
    },
    savingsGoals: {
      keyPath: 'id',
      indexes: [{ name: 'byLifecycleStatus', keyPath: 'lifecycleStatus', unique: false }],
    },
    debts: {
      keyPath: 'id',
      indexes: [{ name: 'byPaymentStatus', keyPath: 'paymentStatus', unique: false }],
    },
    categories: { keyPath: 'id', indexes: [] },
    fixedExpenseTemplates: { keyPath: 'id', indexes: [] },
    fixedExpenseInstances: {
      keyPath: 'id',
      indexes: [
        {
          name: 'byPeriodTemplate',
          keyPath: ['periodId', 'templateId'],
          unique: true,
        },
      ],
    },
    operations: {
      keyPath: 'id',
      indexes: [
        {
          name: 'byPeriodDate',
          keyPath: ['periodId', 'operationDate'],
          unique: false,
        },
        { name: 'byPeriodType', keyPath: ['periodId', 'type'], unique: false },
        { name: 'byStatus', keyPath: 'status', unique: false },
      ],
    },
    movements: {
      keyPath: 'id',
      indexes: [
        { name: 'byOperation', keyPath: 'operationId', unique: false },
        { name: 'byTarget', keyPath: ['targetType', 'targetId'], unique: false },
      ],
    },
    operationRevisions: { keyPath: 'id', indexes: [] },
    auditEvents: { keyPath: 'id', indexes: [] },
    periodSnapshots: {
      keyPath: 'id',
      indexes: [{ name: 'byPeriod', keyPath: 'periodId', unique: true }],
    },
    legacyEntries: {
      keyPath: 'id',
      indexes: [
        { name: 'byPeriodPath', keyPath: ['periodId', 'legacyPath'], unique: true },
      ],
    },
    drafts: { keyPath: 'id', indexes: [] },
    pendingIntents: { keyPath: 'id', indexes: [] },
    commits: {
      keyPath: 'sequence',
      indexes: [{ name: 'byCommitId', keyPath: 'commitId', unique: true }],
    },
    integrityReports: { keyPath: 'id', indexes: [] },
    migrations: {
      keyPath: 'id',
      indexes: [
        {
          name: 'bySource',
          keyPath: ['sourceKey', 'sourceHash', 'mapperVersion'],
          unique: true,
        },
      ],
    },
    legacyIdMap: {
      keyPath: 'id',
      indexes: [
        {
          name: 'byLegacySourcePath',
          keyPath: ['sourceHash', 'entityKind', 'legacyPath'],
          unique: true,
        },
      ],
    },
    coordination: { keyPath: 'key', indexes: [] },
  };

  Object.values(STORE_DEFINITIONS).forEach((definition) => {
    definition.indexes.forEach(Object.freeze);
    Object.freeze(definition.indexes);
    Object.freeze(definition);
  });
  Object.freeze(STORE_DEFINITIONS);

  const STORE_NAMES = Object.freeze(Object.keys(STORE_DEFINITIONS));
  const INDEX_NAMES = Object.freeze(Object.fromEntries(
    Object.entries(STORE_DEFINITIONS).map(([storeName, definition]) => [
      storeName,
      Object.freeze(definition.indexes.map((index) => index.name)),
    ])
  ));

  const ALLOWED_DIRECTIONS = Object.freeze(['next', 'nextunique', 'prev', 'prevunique']);
  const scheduleMicrotask = typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (callback) => Promise.resolve().then(callback);

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function originalCause(cause, fallbackMessage) {
    return cause === undefined || cause === null ? new Error(fallbackMessage) : cause;
  }

  function makeStorageError(code, message, context, cause) {
    return new StorageError(code, message, context, originalCause(cause, message));
  }

  function schemaUnsupported(message, context, cause) {
    return makeStorageError(ERROR_CODES.SCHEMA_UNSUPPORTED, message, context, cause);
  }

  function isQuotaError(cause) {
    let current = cause;
    while (current) {
      if (current.name === 'QuotaExceededError' || current.code === ERROR_CODES.QUOTA_EXCEEDED) {
        return true;
      }
      current = current.cause;
    }
    return false;
  }

  function mapOperationError(kind, message, context, cause) {
    if (cause instanceof StorageError) return cause;
    const code = kind === 'write' && isQuotaError(cause)
      ? ERROR_CODES.QUOTA_EXCEEDED
      : kind === 'read'
        ? ERROR_CODES.STORAGE_READ_FAILED
        : ERROR_CODES.STORAGE_WRITE_FAILED;
    return makeStorageError(code, message, context, cause);
  }

  function sortedNames(list) {
    return Array.from(list).sort();
  }

  function sameNameSet(actual, expected) {
    const left = sortedNames(actual);
    const right = sortedNames(expected);
    return left.length === right.length && left.every((name, index) => name === right[index]);
  }

  function normalizedKeyPath(keyPath) {
    if (Array.isArray(keyPath)) return keyPath.slice();
    if (keyPath && typeof keyPath !== 'string' && typeof keyPath[Symbol.iterator] === 'function') {
      return Array.from(keyPath);
    }
    return keyPath;
  }

  function sameKeyPath(actual, expected) {
    return JSON.stringify(normalizedKeyPath(actual)) === JSON.stringify(expected);
  }

  function assertPhysicalSchema(database) {
    if (database.version !== DATABASE_VERSION) {
      throw schemaUnsupported(
        `Unsupported IndexedDB version: ${database.version}`,
        { databaseName: DATABASE_NAME, expectedVersion: DATABASE_VERSION, actualVersion: database.version }
      );
    }
    if (!sameNameSet(database.objectStoreNames, STORE_NAMES)) {
      throw schemaUnsupported(
        'IndexedDB object stores do not match the V1.1.0 schema',
        {
          databaseName: DATABASE_NAME,
          expectedStores: STORE_NAMES,
          actualStores: Array.from(database.objectStoreNames),
        }
      );
    }

    let transaction;
    try {
      transaction = database.transaction(STORE_NAMES, 'readonly');
      for (const storeName of STORE_NAMES) {
        const expected = STORE_DEFINITIONS[storeName];
        const store = transaction.objectStore(storeName);
        if (!sameKeyPath(store.keyPath, expected.keyPath) || store.autoIncrement !== false) {
          throw schemaUnsupported(
            `Object store ${storeName} has an incompatible key definition`,
            {
              storeName,
              expectedKeyPath: expected.keyPath,
              actualKeyPath: normalizedKeyPath(store.keyPath),
              expectedAutoIncrement: false,
              actualAutoIncrement: store.autoIncrement,
            }
          );
        }
        const expectedIndexNames = expected.indexes.map((index) => index.name);
        if (!sameNameSet(store.indexNames, expectedIndexNames)) {
          throw schemaUnsupported(
            `Object store ${storeName} has incompatible indexes`,
            {
              storeName,
              expectedIndexes: expectedIndexNames,
              actualIndexes: Array.from(store.indexNames),
            }
          );
        }
        for (const indexDefinition of expected.indexes) {
          const index = store.index(indexDefinition.name);
          if (
            !sameKeyPath(index.keyPath, indexDefinition.keyPath) ||
            index.unique !== indexDefinition.unique
          ) {
            throw schemaUnsupported(
              `Index ${storeName}.${indexDefinition.name} is incompatible`,
              {
                storeName,
                indexName: indexDefinition.name,
                expectedKeyPath: indexDefinition.keyPath,
                actualKeyPath: normalizedKeyPath(index.keyPath),
                expectedUnique: indexDefinition.unique,
                actualUnique: index.unique,
              }
            );
          }
        }
      }
    } catch (cause) {
      if (transaction) {
        try { transaction.abort(); } catch (_) {}
      }
      if (cause instanceof StorageError) throw cause;
      throw schemaUnsupported(
        'IndexedDB physical schema could not be inspected',
        { databaseName: DATABASE_NAME },
        cause
      );
    }
    return transaction;
  }

  function isIsoUtcTimestamp(value) {
    if (typeof value !== 'string') return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  }

  function exactKeys(value, expectedKeys) {
    return value && typeof value === 'object' && sameNameSet(Object.keys(value), expectedKeys);
  }

  function assertSystemRecords(schema, runtime) {
    const schemaKeys = [
      'key',
      'schemaVersion',
      'indexedDbVersion',
      'appVersion',
      'databaseName',
      'databaseGeneration',
      'createdAt',
      'updatedAt',
    ];
    const runtimeKeys = [
      'key',
      'setupStatus',
      'activePeriodId',
      'dataRevision',
      'lastCommitId',
      'commitSequence',
      'healthStatus',
      'restrictedScopes',
      'writeEnabled',
    ];

    try {
      if (!exactKeys(schema, schemaKeys)) throw new Error('system/schema fields are incompatible');
      if (
        schema.key !== 'schema' ||
        schema.schemaVersion !== SCHEMA_VERSION ||
        schema.indexedDbVersion !== DATABASE_VERSION ||
        schema.appVersion !== SCHEMA_VERSION ||
        schema.databaseName !== DATABASE_NAME ||
        !isIsoUtcTimestamp(schema.createdAt) ||
        !isIsoUtcTimestamp(schema.updatedAt)
      ) {
        throw new Error('system/schema values are incompatible');
      }
      assertUuid(schema.databaseGeneration, { field: 'databaseGeneration', version: 4 });

      if (!exactKeys(runtime, runtimeKeys)) throw new Error('system/runtime fields are incompatible');
      if (
        runtime.key !== 'runtime' ||
        !['not_started', 'in_progress', 'completed', 'deleted'].includes(runtime.setupStatus) ||
        !['ok', 'warning', 'restricted'].includes(runtime.healthStatus) ||
        !Array.isArray(runtime.restrictedScopes) ||
        !runtime.restrictedScopes.every((scope) => typeof scope === 'string') ||
        typeof runtime.writeEnabled !== 'boolean'
      ) {
        throw new Error('system/runtime values are incompatible');
      }
      assertRevision(runtime.dataRevision, { field: 'dataRevision', allowZero: true });
      assertRevision(runtime.commitSequence, { field: 'commitSequence', allowZero: true });
      if (runtime.activePeriodId !== null) {
        assertUuid(runtime.activePeriodId, { field: 'activePeriodId' });
      }
      if (runtime.lastCommitId !== null) {
        assertUuid(runtime.lastCommitId, { field: 'lastCommitId' });
      }
    } catch (cause) {
      throw schemaUnsupported(
        'IndexedDB system records are missing or incompatible',
        {
          databaseName: DATABASE_NAME,
          schemaPresent: schema !== undefined,
          runtimePresent: runtime !== undefined,
        },
        cause
      );
    }
  }

  function readAndValidateSystemRecords(database, transaction) {
    return new Promise((resolve, reject) => {
      let schema;
      let runtime;
      let requestCause;
      const store = transaction.objectStore('system');
      const schemaRequest = store.get('schema');
      const runtimeRequest = store.get('runtime');

      schemaRequest.onsuccess = () => { schema = schemaRequest.result; };
      runtimeRequest.onsuccess = () => { runtime = runtimeRequest.result; };
      schemaRequest.onerror = () => { requestCause = schemaRequest.error; };
      runtimeRequest.onerror = () => { requestCause = runtimeRequest.error; };
      transaction.oncomplete = () => {
        try {
          assertSystemRecords(schema, runtime);
          resolve();
        } catch (cause) {
          reject(cause);
        }
      };
      transaction.onabort = () => {
        reject(makeStorageError(
          ERROR_CODES.STORAGE_READ_FAILED,
          'IndexedDB system records could not be read',
          { databaseName: database.name, storeName: 'system' },
          requestCause || transaction.error
        ));
      };
    });
  }

  function createPhysicalSchema(database, transaction, now, cryptoSource, setUpgradeCause) {
    for (const storeName of STORE_NAMES) {
      const definition = STORE_DEFINITIONS[storeName];
      const store = database.createObjectStore(storeName, {
        keyPath: definition.keyPath,
        autoIncrement: false,
      });
      for (const index of definition.indexes) {
        store.createIndex(index.name, index.keyPath, { unique: index.unique });
      }
    }

    const timestamp = now();
    if (!isIsoUtcTimestamp(timestamp)) {
      throw new TypeError('now() must return a canonical ISO UTC timestamp');
    }
    const databaseGeneration = createUuidV4(cryptoSource);
    const system = transaction.objectStore('system');
    const schemaRequest = system.add({
      key: 'schema',
      schemaVersion: SCHEMA_VERSION,
      indexedDbVersion: DATABASE_VERSION,
      appVersion: SCHEMA_VERSION,
      databaseName: DATABASE_NAME,
      databaseGeneration,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const runtimeRequest = system.add({
      key: 'runtime',
      setupStatus: 'not_started',
      activePeriodId: null,
      dataRevision: 0,
      lastCommitId: null,
      commitSequence: 0,
      healthStatus: 'ok',
      restrictedScopes: [],
      writeEnabled: false,
    });
    schemaRequest.onerror = () => setUpgradeCause(schemaRequest.error);
    runtimeRequest.onerror = () => setUpgradeCause(runtimeRequest.error);
  }

  function createPeritaIndexedDb(options) {
    const settings = options || {};
    const indexedDbFactory = hasOwn(settings, 'indexedDB')
      ? settings.indexedDB
      : typeof globalThis !== 'undefined'
        ? globalThis.indexedDB
        : undefined;
    const idbKeyRange = hasOwn(settings, 'IDBKeyRange')
      ? settings.IDBKeyRange
      : typeof globalThis !== 'undefined'
        ? globalThis.IDBKeyRange
        : undefined;
    const cryptoSource = hasOwn(settings, 'crypto')
      ? settings.crypto
      : typeof globalThis !== 'undefined'
        ? globalThis.crypto
        : undefined;
    const now = settings.now || (() => new Date().toISOString());

    let database = null;
    let openingPromise = null;

    function openDatabase() {
      return new Promise((resolve, reject) => {
        if (!indexedDbFactory || typeof indexedDbFactory.open !== 'function') {
          reject(makeStorageError(
            ERROR_CODES.STORAGE_OPEN_FAILED,
            'IndexedDB is not available',
            { databaseName: DATABASE_NAME },
            new TypeError('indexedDB.open is not available')
          ));
          return;
        }

        let request;
        let settled = false;
        let upgradeCause;
        const rejectOnce = (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };

        try {
          request = indexedDbFactory.open(DATABASE_NAME, DATABASE_VERSION);
        } catch (cause) {
          rejectOnce(makeStorageError(
            ERROR_CODES.STORAGE_OPEN_FAILED,
            'IndexedDB could not be opened',
            { databaseName: DATABASE_NAME, databaseVersion: DATABASE_VERSION },
            cause
          ));
          return;
        }

        request.onblocked = () => {
          rejectOnce(makeStorageError(
            ERROR_CODES.STORAGE_OPEN_FAILED,
            'IndexedDB opening was blocked by another connection',
            { databaseName: DATABASE_NAME, databaseVersion: DATABASE_VERSION, blocked: true },
            new Error('IndexedDB open request was blocked')
          ));
        };

        request.onupgradeneeded = (event) => {
          const transaction = request.transaction;
          if (event.oldVersion !== 0) {
            upgradeCause = schemaUnsupported(
              `Unsupported IndexedDB upgrade from version ${event.oldVersion}`,
              {
                databaseName: DATABASE_NAME,
                oldVersion: event.oldVersion,
                requestedVersion: DATABASE_VERSION,
              }
            );
            transaction.abort();
            return;
          }
          try {
            createPhysicalSchema(
              request.result,
              transaction,
              now,
              cryptoSource,
              (cause) => { upgradeCause = cause; }
            );
          } catch (cause) {
            upgradeCause = cause;
            try { transaction.abort(); } catch (_) {}
          }
        };

        request.onerror = () => {
          const cause = upgradeCause || request.error;
          if (cause instanceof StorageError) {
            rejectOnce(cause);
            return;
          }
          const versionUnsupported = cause && cause.name === 'VersionError';
          rejectOnce(makeStorageError(
            versionUnsupported ? ERROR_CODES.SCHEMA_UNSUPPORTED : ERROR_CODES.STORAGE_OPEN_FAILED,
            versionUnsupported
              ? 'IndexedDB physical version is newer than supported'
              : 'IndexedDB could not be opened or initialized',
            {
              databaseName: DATABASE_NAME,
              expectedVersion: DATABASE_VERSION,
              upgradeFailed: upgradeCause !== undefined,
            },
            cause
          ));
        };

        request.onsuccess = async () => {
          const openedDatabase = request.result;
          if (settled) {
            openedDatabase.close();
            return;
          }
          openedDatabase.onversionchange = () => {
            openedDatabase.close();
            if (database === openedDatabase) database = null;
          };
          try {
            const validationTransaction = assertPhysicalSchema(openedDatabase);
            await readAndValidateSystemRecords(openedDatabase, validationTransaction);
            if (settled) {
              openedDatabase.close();
              return;
            }
            database = openedDatabase;
            settled = true;
            resolve();
          } catch (cause) {
            openedDatabase.close();
            rejectOnce(cause instanceof StorageError
              ? cause
              : schemaUnsupported(
                'IndexedDB schema validation failed',
                { databaseName: DATABASE_NAME },
                cause
              ));
          }
        };
      });
    }

    function open() {
      if (database) return Promise.resolve();
      if (openingPromise) return openingPromise;
      openingPromise = openDatabase().finally(() => {
        openingPromise = null;
      });
      return openingPromise;
    }

    function close() {
      if (!database) return;
      database.close();
      database = null;
    }

    function normalizeTransactionStores(storeNames) {
      const names = typeof storeNames === 'string' ? [storeNames] : storeNames;
      if (!Array.isArray(names) || names.length === 0) {
        throw new TypeError('runTransaction requires at least one object store');
      }
      const uniqueNames = [...new Set(names)];
      for (const storeName of uniqueNames) {
        if (!hasOwn(STORE_DEFINITIONS, storeName)) {
          throw new TypeError(`Unknown object store: ${storeName}`);
        }
      }
      return uniqueNames;
    }

    async function runTransaction(storeNames, mode, worker) {
      let names;
      try {
        names = normalizeTransactionStores(storeNames);
        if (!['readonly', 'readwrite'].includes(mode)) {
          throw new TypeError(`Unsupported transaction mode: ${mode}`);
        }
        if (typeof worker !== 'function') throw new TypeError('transaction worker must be a function');
      } catch (cause) {
        throw mapOperationError(
          mode === 'readonly' ? 'read' : 'write',
          'IndexedDB transaction arguments are invalid',
          { databaseName: DATABASE_NAME, storeNames, mode },
          cause
        );
      }

      await open();
      let nativeTransaction;
      try {
        nativeTransaction = database.transaction(names, mode);
      } catch (cause) {
        throw mapOperationError(
          mode === 'readonly' ? 'read' : 'write',
          'IndexedDB transaction could not be started',
          { databaseName: DATABASE_NAME, storeNames: names, mode },
          cause
        );
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        let completed = false;
        let workerSettled = false;
        let workerValue;
        let pendingRequests = 0;
        let requestFailure;
        let abortFailure;
        let guardScheduled = false;
        let keepalivePending = false;

        const operationContext = (storeName, operation, indexName) => ({
          databaseName: DATABASE_NAME,
          storeNames: names,
          storeName,
          indexName: indexName || null,
          mode,
          operation,
        });

        const settleReject = (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };

        const abortNative = (error) => {
          if (!abortFailure) abortFailure = error;
          try {
            nativeTransaction.abort();
          } catch (cause) {
            if (!completed && !settled) {
              settleReject(requestFailure || abortFailure || mapOperationError(
                mode === 'readonly' ? 'read' : 'write',
                'IndexedDB transaction could not be aborted',
                { databaseName: DATABASE_NAME, storeNames: names, mode },
                cause
              ));
            }
          }
        };

        const startKeepalive = () => {
          if (keepalivePending || workerSettled || completed) return;
          let request;
          try {
            request = nativeTransaction.objectStore(names[0]).get('__perita_transaction_keepalive__');
          } catch (cause) {
            abortNative(mapOperationError(
              mode === 'readonly' ? 'read' : 'write',
              'IndexedDB transaction keepalive could not be created',
              { databaseName: DATABASE_NAME, storeNames: names, mode },
              cause
            ));
            return;
          }
          keepalivePending = true;
          request.onsuccess = () => { keepalivePending = false; };
          request.onerror = () => {
            keepalivePending = false;
            if (abortFailure) return;
            requestFailure = mapOperationError(
              'read',
              'IndexedDB transaction keepalive failed',
              { databaseName: DATABASE_NAME, storeNames: names, mode },
              request.error
            );
            abortNative(requestFailure);
          };
        };

        const scheduleExternalWaitGuard = () => {
          if (guardScheduled || workerSettled || pendingRequests !== 0 || completed) return;
          guardScheduled = true;
          // An async worker can require three promise-continuation turns after
          // its final request settles (request -> nested worker -> observer).
          // Waiting all three avoids mistaking a legitimate rejection/return
          // for an external wait while still aborting before a timer can run.
          scheduleMicrotask(() => scheduleMicrotask(() => scheduleMicrotask(() => {
            guardScheduled = false;
            if (!workerSettled && pendingRequests === 0 && !completed) {
              const cause = new Error(
                'transaction callback may only await operations from its transaction context'
              );
              abortNative(mapOperationError(
                mode === 'readonly' ? 'read' : 'write',
                'External waits are not allowed inside an IndexedDB transaction callback',
                { databaseName: DATABASE_NAME, storeNames: names, mode },
                cause
              ));
            }
          })));
        };

        const assertStoreAccess = (storeName, operation, write) => {
          if (!names.includes(storeName)) {
            const cause = new Error(`Store ${storeName} is not declared in this transaction`);
            const error = mapOperationError(
              write ? 'write' : 'read',
              'IndexedDB transaction attempted to access an undeclared store',
              operationContext(storeName, operation),
              cause
            );
            abortNative(error);
            throw error;
          }
          if (write && mode !== 'readwrite') {
            const cause = new Error('Cannot write inside a readonly transaction');
            const error = mapOperationError(
              'write',
              'IndexedDB write requires a readwrite transaction',
              operationContext(storeName, operation),
              cause
            );
            abortNative(error);
            throw error;
          }
          return nativeTransaction.objectStore(storeName);
        };

        const requestPromise = (storeName, operation, write, createRequest, transform) => {
          let request;
          try {
            const store = assertStoreAccess(storeName, operation, write);
            request = createRequest(store);
          } catch (cause) {
            const error = cause instanceof StorageError
              ? cause
              : mapOperationError(
                write ? 'write' : 'read',
                `IndexedDB ${operation} request could not be created`,
                operationContext(storeName, operation),
                cause
              );
            if (!abortFailure) requestFailure = error;
            abortNative(error);
            return Promise.reject(error);
          }

          pendingRequests += 1;
          return new Promise((requestResolve, requestReject) => {
            request.onsuccess = () => {
              pendingRequests -= 1;
              startKeepalive();
              try {
                requestResolve(transform ? transform(request.result) : request.result);
              } catch (cause) {
                const error = mapOperationError(
                  write ? 'write' : 'read',
                  `IndexedDB ${operation} result could not be processed`,
                  operationContext(storeName, operation),
                  cause
                );
                requestFailure = error;
                abortNative(error);
                requestReject(error);
              }
              scheduleExternalWaitGuard();
            };
            request.onerror = () => {
              pendingRequests -= 1;
              const error = mapOperationError(
                write ? 'write' : 'read',
                `IndexedDB ${operation} request failed`,
                operationContext(storeName, operation),
                request.error
              );
              requestFailure = error;
              requestReject(error);
              scheduleExternalWaitGuard();
            };
          });
        };

        const queryIndex = (storeName, indexName, options) => {
          const queryOptions = options || {};
          const direction = queryOptions.direction || 'next';
          const limit = queryOptions.limit === undefined ? Infinity : queryOptions.limit;
          if (
            !ALLOWED_DIRECTIONS.includes(direction) ||
            !(limit === Infinity || (Number.isSafeInteger(limit) && limit >= 0))
          ) {
            const cause = new TypeError('Invalid index query direction or limit');
            const error = mapOperationError(
              'read',
              'IndexedDB index query options are invalid',
              operationContext(storeName, 'queryIndex', indexName),
              cause
            );
            abortNative(error);
            return Promise.reject(error);
          }
          if (limit === 0) return Promise.resolve([]);

          let request;
          try {
            const store = assertStoreAccess(storeName, 'queryIndex', false);
            const index = store.index(indexName);
            const query = hasOwn(queryOptions, 'query') ? queryOptions.query : undefined;
            request = index.openCursor(query, direction);
          } catch (cause) {
            const error = mapOperationError(
              'read',
              'IndexedDB index query could not be created',
              operationContext(storeName, 'queryIndex', indexName),
              cause
            );
            requestFailure = error;
            abortNative(error);
            return Promise.reject(error);
          }

          pendingRequests += 1;
          return new Promise((requestResolve, requestReject) => {
            const records = [];
            request.onsuccess = () => {
              const cursor = request.result;
              if (cursor && records.length < limit) {
                records.push(cursor.value);
                if (records.length < limit) {
                  cursor.continue();
                  return;
                }
              }
              pendingRequests -= 1;
              startKeepalive();
              requestResolve(records);
              scheduleExternalWaitGuard();
            };
            request.onerror = () => {
              pendingRequests -= 1;
              const error = mapOperationError(
                'read',
                'IndexedDB index query failed',
                operationContext(storeName, 'queryIndex', indexName),
                request.error
              );
              requestFailure = error;
              requestReject(error);
              scheduleExternalWaitGuard();
            };
          });
        };

        const transactionApi = Object.freeze({
          get: (storeName, key) => requestPromise(
            storeName,
            'get',
            false,
            (store) => store.get(key)
          ),
          getAll: (storeName) => requestPromise(
            storeName,
            'getAll',
            false,
            (store) => store.getAll()
          ),
          add: (storeName, value) => requestPromise(
            storeName,
            'add',
            true,
            (store) => store.add(value)
          ),
          put: (storeName, value) => requestPromise(
            storeName,
            'put',
            true,
            (store) => store.put(value)
          ),
          remove: (storeName, key) => requestPromise(
            storeName,
            'remove',
            true,
            (store) => store.delete(key)
          ),
          queryIndex,
          abort: (reason) => {
            const cause = reason instanceof Error
              ? reason
              : new Error(reason === undefined ? 'Transaction explicitly aborted' : String(reason));
            abortNative(mapOperationError(
              mode === 'readonly' ? 'read' : 'write',
              'IndexedDB transaction was explicitly aborted',
              { databaseName: DATABASE_NAME, storeNames: names, mode, operation: 'abort' },
              cause
            ));
          },
        });

        nativeTransaction.oncomplete = () => {
          completed = true;
          if (!workerSettled) {
            settleReject(mapOperationError(
              mode === 'readonly' ? 'read' : 'write',
              'IndexedDB transaction completed before its callback settled',
              { databaseName: DATABASE_NAME, storeNames: names, mode },
              new Error('External asynchronous work ended the IndexedDB transaction early')
            ));
            return;
          }
          if (!settled) {
            settled = true;
            resolve(workerValue);
          }
        };
        nativeTransaction.onabort = () => {
          settleReject(
            abortFailure ||
            requestFailure ||
            mapOperationError(
              mode === 'readonly' ? 'read' : 'write',
              'IndexedDB transaction was aborted',
              { databaseName: DATABASE_NAME, storeNames: names, mode },
              nativeTransaction.error
            )
          );
        };
        nativeTransaction.onerror = () => {
          if (!requestFailure && nativeTransaction.error) {
            requestFailure = mapOperationError(
              mode === 'readonly' ? 'read' : 'write',
              'IndexedDB transaction failed',
              { databaseName: DATABASE_NAME, storeNames: names, mode },
              nativeTransaction.error
            );
          }
        };

        startKeepalive();
        let workerResult;
        try {
          workerResult = worker(transactionApi);
        } catch (cause) {
          workerSettled = true;
          abortNative(mapOperationError(
            mode === 'readonly' ? 'read' : 'write',
            'IndexedDB transaction callback failed',
            { databaseName: DATABASE_NAME, storeNames: names, mode },
            cause
          ));
          return;
        }

        Promise.resolve(workerResult).then(
          (value) => {
            workerSettled = true;
            workerValue = value;
            if (completed && !settled) {
              settled = true;
              resolve(value);
            }
          },
          (cause) => {
            workerSettled = true;
            abortNative(mapOperationError(
              mode === 'readonly' ? 'read' : 'write',
              'IndexedDB transaction callback rejected',
              { databaseName: DATABASE_NAME, storeNames: names, mode },
              cause
            ));
          }
        );
        scheduleExternalWaitGuard();
      });
    }

    const api = {
      open,
      close,
      get: (storeName, key) => runTransaction(
        [storeName],
        'readonly',
        (transaction) => transaction.get(storeName, key)
      ),
      getAll: (storeName) => runTransaction(
        [storeName],
        'readonly',
        (transaction) => transaction.getAll(storeName)
      ),
      add: (storeName, value) => runTransaction(
        [storeName],
        'readwrite',
        (transaction) => transaction.add(storeName, value)
      ),
      put: (storeName, value) => runTransaction(
        [storeName],
        'readwrite',
        (transaction) => transaction.put(storeName, value)
      ),
      remove: (storeName, key) => runTransaction(
        [storeName],
        'readwrite',
        (transaction) => transaction.remove(storeName, key)
      ),
      queryIndex: (storeName, indexName, queryOptions) => runTransaction(
        [storeName],
        'readonly',
        (transaction) => transaction.queryIndex(storeName, indexName, queryOptions)
      ),
      runTransaction,
    };

    // Retain the injected constructor as part of the closure so callers can pass
    // IDBKeyRange instances to queryIndex without this module touching globals.
    void idbKeyRange;
    return Object.freeze(api);
  }

  function deletePeritaDatabaseForTests(options) {
    const settings = options || {};
    const indexedDbFactory = hasOwn(settings, 'indexedDB')
      ? settings.indexedDB
      : typeof globalThis !== 'undefined'
        ? globalThis.indexedDB
        : undefined;
    return new Promise((resolve, reject) => {
      if (!indexedDbFactory || typeof indexedDbFactory.deleteDatabase !== 'function') {
        reject(makeStorageError(
          ERROR_CODES.STORAGE_WRITE_FAILED,
          'IndexedDB test database could not be deleted',
          { databaseName: DATABASE_NAME, operation: 'deleteDatabaseForTests' },
          new TypeError('indexedDB.deleteDatabase is not available')
        ));
        return;
      }
      let request;
      let settled = false;
      try {
        request = indexedDbFactory.deleteDatabase(DATABASE_NAME);
      } catch (cause) {
        reject(makeStorageError(
          ERROR_CODES.STORAGE_WRITE_FAILED,
          'IndexedDB test database could not be deleted',
          { databaseName: DATABASE_NAME, operation: 'deleteDatabaseForTests' },
          cause
        ));
        return;
      }
      request.onsuccess = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(makeStorageError(
          ERROR_CODES.STORAGE_WRITE_FAILED,
          'IndexedDB test database could not be deleted',
          { databaseName: DATABASE_NAME, operation: 'deleteDatabaseForTests' },
          request.error
        ));
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(makeStorageError(
          ERROR_CODES.STORAGE_WRITE_FAILED,
          'IndexedDB test database deletion was blocked',
          { databaseName: DATABASE_NAME, operation: 'deleteDatabaseForTests', blocked: true },
          new Error('IndexedDB delete request was blocked')
        ));
      };
    });
  }

  return Object.freeze({
    DATABASE_NAME,
    DATABASE_VERSION,
    SCHEMA_VERSION,
    STORE_NAMES,
    INDEX_NAMES,
    createPeritaIndexedDb,
    deletePeritaDatabaseForTests,
  });
});

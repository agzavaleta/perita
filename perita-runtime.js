/* perita-runtime.js — isolated V1.1.0 write coordination and technical commits
 *
 * This module coordinates IndexedDB writes. It has no UI, localStorage,
 * migration, financial-domain, heartbeat timer, or automatic recovery logic.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./perita-contracts.js'),
      require('./perita-indexeddb.js')
    );
  } else {
    root.PeritaRuntime = factory(root.PeritaContracts, root.PeritaIndexedDb);
  }
})(typeof self !== 'undefined' ? self : this, function (Contracts, IndexedDb) {
  'use strict';

  if (!Contracts) throw new Error('PeritaContracts is required');
  if (!IndexedDb) throw new Error('PeritaIndexedDb is required');

  const {
    ERROR_CODES,
    PeritaError,
    StorageError,
    assertRevision,
    assertUuid,
    createUuidV4,
    nextRevision,
  } = Contracts;

  const WRITER_KEY = 'writer';
  const RUNTIME_KEY = 'runtime';
  const INTERNAL_COMMAND_STORES = Object.freeze([
    'system',
    'coordination',
    'commits',
  ]);
  const RESERVED_COMMAND_STORES = new Set([
    ...INTERNAL_COMMAND_STORES,
    'pendingIntents',
  ]);

  class RuntimeError extends PeritaError {}

  function runtimeError(code, message, context, cause) {
    return new RuntimeError(code, message, context, cause);
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function requireNonEmptyString(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw runtimeError(
        ERROR_CODES.COMMAND_FAILED,
        `${field} must be a non-empty string`,
        { field, value }
      );
    }
    return value;
  }

  function timestampFromNow(now) {
    let value;
    try {
      value = now();
    } catch (cause) {
      throw runtimeError(
        ERROR_CODES.COMMAND_FAILED,
        'the runtime clock failed',
        { field: 'now' },
        cause
      );
    }
    const parsed = typeof value === 'string' ? new Date(value) : null;
    if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
      throw runtimeError(
        ERROR_CODES.COMMAND_FAILED,
        'now() must return a canonical ISO UTC timestamp',
        { field: 'now', value }
      );
    }
    return { iso: value, milliseconds: parsed.getTime() };
  }

  function assertLeaseDuration(value) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw runtimeError(
        ERROR_CODES.INVALID_LEASE_DURATION,
        'leaseDurationMs must be a positive safe integer',
        { leaseDurationMs: value }
      );
    }
    return value;
  }

  function expiresAt(timestamp, leaseDurationMs) {
    const expiration = timestamp.milliseconds + leaseDurationMs;
    if (!Number.isSafeInteger(expiration)) {
      throw runtimeError(
        ERROR_CODES.INVALID_LEASE_DURATION,
        'lease expiration is outside the safe timestamp range',
        { leaseDurationMs, now: timestamp.iso }
      );
    }
    const value = new Date(expiration);
    if (!Number.isFinite(value.getTime())) {
      throw runtimeError(
        ERROR_CODES.INVALID_LEASE_DURATION,
        'lease expiration is not representable',
        { leaseDurationMs, now: timestamp.iso }
      );
    }
    return value.toISOString();
  }

  function unownedWriter() {
    return {
      key: WRITER_KEY,
      ownerTabId: null,
      epoch: 0,
      acquiredAt: null,
      heartbeatAt: null,
      expiresAt: null,
      status: 'unowned',
    };
  }

  function assertWriterRecord(value) {
    if (value === undefined) return unownedWriter();
    const validStatus = value && ['unowned', 'active'].includes(value.status);
    try {
      if (!validStatus || value.key !== WRITER_KEY) throw new Error('invalid writer shape');
      assertRevision(value.epoch, { field: 'writerEpoch', allowZero: true });
      if (value.status === 'unowned') {
        if (
          value.ownerTabId !== null || value.acquiredAt !== null ||
          value.heartbeatAt !== null || value.expiresAt !== null
        ) {
          throw new Error('unowned writer contains active lease data');
        }
      } else {
        requireNonEmptyString(value.ownerTabId, 'ownerTabId');
        if (value.epoch === 0) throw new Error('active writer epoch must be positive');
        for (const field of ['acquiredAt', 'heartbeatAt', 'expiresAt']) {
          const parsed = new Date(value[field]);
          if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value[field]) {
            throw new Error(`invalid ${field}`);
          }
        }
      }
      return value;
    } catch (cause) {
      if (cause instanceof RuntimeError) throw cause;
      throw runtimeError(
        ERROR_CODES.WRITER_EPOCH_LOST,
        'the persisted writer lease is invalid',
        { writerPresent: value !== undefined },
        cause
      );
    }
  }

  function assertRuntimeRecord(value) {
    try {
      if (!value || value.key !== RUNTIME_KEY || typeof value.writeEnabled !== 'boolean') {
        throw new Error('system/runtime is missing or invalid');
      }
      assertRevision(value.dataRevision, { field: 'dataRevision', allowZero: true });
      assertRevision(value.commitSequence, { field: 'commitSequence', allowZero: true });
      if (value.lastCommitId !== null) {
        assertUuid(value.lastCommitId, { field: 'lastCommitId', version: 4 });
      }
      return value;
    } catch (cause) {
      throw runtimeError(
        ERROR_CODES.COMMAND_FAILED,
        'system/runtime is missing or incompatible',
        { runtimePresent: value !== undefined },
        cause
      );
    }
  }

  function assertExpectedDataRevision(runtime, expectedDataRevision, commandType) {
    assertRevision(expectedDataRevision, { field: 'expectedDataRevision', allowZero: true });
    if (runtime.dataRevision !== expectedDataRevision) {
      throw runtimeError(
        ERROR_CODES.STALE_REVISION,
        `expected data revision ${expectedDataRevision}, found ${runtime.dataRevision}`,
        {
          expectedDataRevision,
          actualDataRevision: runtime.dataRevision,
          commandType,
        }
      );
    }
  }

  function assertWriterControl(writer, tabId, expectedEpoch, timestamp) {
    assertRevision(expectedEpoch, { field: 'expectedWriterEpoch' });
    if (
      writer.status !== 'active' ||
      writer.ownerTabId !== tabId ||
      writer.epoch !== expectedEpoch
    ) {
      throw runtimeError(
        ERROR_CODES.WRITER_EPOCH_LOST,
        'the current tab no longer owns the writer epoch',
        {
          tabId,
          expectedWriterEpoch: expectedEpoch,
          ownerTabId: writer.ownerTabId,
          actualWriterEpoch: writer.epoch,
          writerStatus: writer.status,
        }
      );
    }
    if (Date.parse(writer.expiresAt) <= timestamp.milliseconds) {
      throw runtimeError(
        ERROR_CODES.WRITER_LEASE_EXPIRED,
        'the writer lease has expired',
        {
          tabId,
          expectedWriterEpoch: expectedEpoch,
          expiresAt: writer.expiresAt,
          checkedAt: timestamp.iso,
        }
      );
    }
    return writer;
  }

  function normalizeAffectedStores(storeNames) {
    if (!Array.isArray(storeNames) || storeNames.length === 0) {
      throw runtimeError(
        ERROR_CODES.COMMAND_FAILED,
        'affectedStores must declare at least one store',
        { affectedStores: storeNames }
      );
    }
    const normalized = [...new Set(storeNames)];
    for (const storeName of normalized) {
      if (!IndexedDb.STORE_NAMES.includes(storeName) || RESERVED_COMMAND_STORES.has(storeName)) {
        throw runtimeError(
          ERROR_CODES.COMMAND_FAILED,
          'affectedStores contains an unknown or reserved store',
          { storeName, affectedStores: storeNames }
        );
      }
    }
    return normalized;
  }

  function cloneMetadata(value, field) {
    const source = value === undefined ? {} : value;
    try {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new TypeError(`${field} must be an object`);
      }
      const serialized = JSON.stringify(source);
      if (serialized === undefined) throw new TypeError(`${field} is not serializable`);
      return JSON.parse(serialized);
    } catch (cause) {
      throw runtimeError(
        ERROR_CODES.COMMAND_FAILED,
        `${field} must be a serializable object`,
        { field },
        cause
      );
    }
  }

  function unwrapRuntimeError(error) {
    let current = error;
    while (current) {
      if (current instanceof RuntimeError) return current;
      current = current.cause;
    }
    return null;
  }

  function commandFailure(error, commandType) {
    const typed = unwrapRuntimeError(error);
    if (typed) return typed;
    if (error instanceof StorageError && !/transaction callback (failed|rejected)/i.test(error.message)) {
      return error;
    }
    return runtimeError(
      ERROR_CODES.COMMAND_FAILED,
      `command ${commandType} failed`,
      { commandType },
      error
    );
  }

  function createPeritaRuntime(options) {
    const settings = options || {};
    const storage = settings.storage;
    const now = settings.now || (() => new Date().toISOString());
    const createUuid = settings.createUuid || (() => createUuidV4());
    const tabId = requireNonEmptyString(settings.tabId, 'tabId');
    if (!storage || typeof storage.open !== 'function' || typeof storage.runTransaction !== 'function') {
      throw runtimeError(
        ERROR_CODES.COMMAND_FAILED,
        'a Perita IndexedDB storage instance is required',
        { field: 'storage' }
      );
    }

    let heldWriterEpoch = null;

    function newUuid(field) {
      try {
        return assertUuid(createUuid(), { field, version: 4 });
      } catch (cause) {
        if (cause instanceof PeritaError) throw cause;
        throw runtimeError(
          ERROR_CODES.COMMAND_FAILED,
          `${field} generation failed`,
          { field },
          cause
        );
      }
    }

    async function open() {
      await storage.open();
    }

    async function getWriterState() {
      await open();
      return assertWriterRecord(await storage.get('coordination', WRITER_KEY));
    }

    async function acquireWriter(input) {
      const request = input || {};
      const expectedEpoch = request.expectedEpoch;
      const leaseDurationMs = assertLeaseDuration(request.leaseDurationMs);
      assertRevision(expectedEpoch, { field: 'expectedEpoch', allowZero: true });
      await open();
      try {
        const writer = await storage.runTransaction(
          ['coordination'],
          'readwrite',
          async (transaction) => {
            const current = assertWriterRecord(await transaction.get('coordination', WRITER_KEY));
            const timestamp = timestampFromNow(now);
            const leaseActive = current.status === 'active' &&
              Date.parse(current.expiresAt) > timestamp.milliseconds;

            if (current.epoch !== expectedEpoch) {
              throw runtimeError(
                ERROR_CODES.WRITER_EPOCH_LOST,
                'writer epoch changed before acquisition',
                { expectedEpoch, actualEpoch: current.epoch, tabId }
              );
            }
            if (leaseActive && current.ownerTabId !== tabId) {
              throw runtimeError(
                ERROR_CODES.WRITER_ALREADY_OWNED,
                'another tab currently owns the writer lease',
                {
                  tabId,
                  ownerTabId: current.ownerTabId,
                  epoch: current.epoch,
                  expiresAt: current.expiresAt,
                }
              );
            }

            const renew = leaseActive && current.ownerTabId === tabId;
            const epoch = renew ? current.epoch : nextRevision(current.epoch, { allowZero: true });
            const next = {
              key: WRITER_KEY,
              ownerTabId: tabId,
              epoch,
              acquiredAt: renew ? current.acquiredAt : timestamp.iso,
              heartbeatAt: timestamp.iso,
              expiresAt: expiresAt(timestamp, leaseDurationMs),
              status: 'active',
            };
            await transaction.put('coordination', next);
            return next;
          }
        );
        heldWriterEpoch = writer.epoch;
        return writer;
      } catch (error) {
        const typed = unwrapRuntimeError(error);
        throw typed || error;
      }
    }

    async function heartbeat(input) {
      const request = input || {};
      const expectedEpoch = request.expectedEpoch;
      const leaseDurationMs = assertLeaseDuration(request.leaseDurationMs);
      await open();
      try {
        const writer = await storage.runTransaction(
          ['coordination'],
          'readwrite',
          async (transaction) => {
            const current = assertWriterRecord(await transaction.get('coordination', WRITER_KEY));
            const timestamp = timestampFromNow(now);
            assertWriterControl(current, tabId, expectedEpoch, timestamp);
            const next = {
              ...current,
              heartbeatAt: timestamp.iso,
              expiresAt: expiresAt(timestamp, leaseDurationMs),
            };
            await transaction.put('coordination', next);
            return next;
          }
        );
        heldWriterEpoch = writer.epoch;
        return writer;
      } catch (error) {
        const typed = unwrapRuntimeError(error);
        throw typed || error;
      }
    }

    async function releaseWriter(input) {
      const request = input || {};
      const expectedEpoch = request.expectedEpoch;
      await open();
      try {
        const writer = await storage.runTransaction(
          ['coordination'],
          'readwrite',
          async (transaction) => {
            const current = assertWriterRecord(await transaction.get('coordination', WRITER_KEY));
            const timestamp = timestampFromNow(now);
            assertWriterControl(current, tabId, expectedEpoch, timestamp);
            const next = { ...unownedWriter(), epoch: current.epoch };
            await transaction.put('coordination', next);
            return next;
          }
        );
        heldWriterEpoch = null;
        return writer;
      } catch (error) {
        const typed = unwrapRuntimeError(error);
        throw typed || error;
      }
    }

    function normalizeIntentOption(intent, fallbackMetadata) {
      if (intent === undefined || intent === null || intent === false) return null;
      if (intent !== true && (typeof intent !== 'object' || Array.isArray(intent))) {
        throw runtimeError(
          ERROR_CODES.INTENT_STATE_INVALID,
          'intent must be true, false, or an options object',
          { intentType: typeof intent }
        );
      }
      const metadata = intent === true || !hasOwn(intent, 'metadata')
        ? fallbackMetadata
        : intent.metadata;
      return { metadata: cloneMetadata(metadata, 'intent.metadata') };
    }

    async function preflight(command) {
      await open();
      try {
        return await storage.runTransaction(
          ['system', 'coordination'],
          'readonly',
          async (transaction) => {
            const runtime = assertRuntimeRecord(await transaction.get('system', RUNTIME_KEY));
            const writer = assertWriterRecord(await transaction.get('coordination', WRITER_KEY));
            const timestamp = timestampFromNow(now);
            assertWriterControl(writer, tabId, command.expectedWriterEpoch, timestamp);
            assertExpectedDataRevision(runtime, command.expectedDataRevision, command.commandType);
            if (!runtime.writeEnabled && !command.allowWriteDisabled) {
              throw runtimeError(
                ERROR_CODES.WRITE_DISABLED,
                'runtime writes are disabled',
                { commandType: command.commandType, writeEnabled: false }
              );
            }
            return { runtime, writer };
          }
        );
      } catch (error) {
        const typed = unwrapRuntimeError(error);
        throw typed || error;
      }
    }

    async function persistPendingIntent(command, intentId, createdAt, metadata) {
      try {
        await storage.runTransaction(
          ['system', 'coordination', 'pendingIntents'],
          'readwrite',
          async (transaction) => {
            const runtime = assertRuntimeRecord(await transaction.get('system', RUNTIME_KEY));
            const writer = assertWriterRecord(await transaction.get('coordination', WRITER_KEY));
            assertWriterControl(writer, tabId, command.expectedWriterEpoch, timestampFromNow(now));
            assertExpectedDataRevision(runtime, command.expectedDataRevision, command.commandType);
            if (!runtime.writeEnabled && !command.allowWriteDisabled) {
              throw runtimeError(
                ERROR_CODES.WRITE_DISABLED,
                'runtime writes are disabled',
                { commandType: command.commandType, writeEnabled: false }
              );
            }
            await transaction.add('pendingIntents', {
              id: intentId,
              commandType: command.commandType,
              writerTabId: tabId,
              writerEpoch: command.expectedWriterEpoch,
              expectedDataRevision: command.expectedDataRevision,
              affectedStores: command.affectedStores.slice(),
              status: 'pending',
              createdAt,
              completedAt: null,
              commitId: null,
              failureCode: null,
              metadata,
            });
          }
        );
      } catch (error) {
        const typed = unwrapRuntimeError(error);
        throw typed || error;
      }
    }

    async function markIntentFailed(intentId, failureCode) {
      try {
        await storage.runTransaction(
          ['pendingIntents'],
          'readwrite',
          async (transaction) => {
            const current = await transaction.get('pendingIntents', intentId);
            if (!current || current.status !== 'pending') {
              throw runtimeError(
                ERROR_CODES.INTENT_STATE_INVALID,
                'pending intent cannot be marked failed from its current state',
                { intentId, status: current ? current.status : null }
              );
            }
            await transaction.put('pendingIntents', {
              ...current,
              status: 'failed',
              completedAt: timestampFromNow(now).iso,
              failureCode,
            });
          }
        );
      } catch (_) {
        // The command failure remains authoritative. A pending record is safer
        // than a fabricated terminal state and can be inspected explicitly.
      }
    }

    function commandTransactionApi(transaction, affectedStores) {
      const assertAffected = (storeName) => {
        if (!affectedStores.includes(storeName)) {
          throw runtimeError(
            ERROR_CODES.COMMAND_FAILED,
            'command attempted to access an undeclared affected store',
            { storeName, affectedStores }
          );
        }
      };
      return Object.freeze({
        get: (storeName, key) => {
          assertAffected(storeName);
          return transaction.get(storeName, key);
        },
        getAll: (storeName) => {
          assertAffected(storeName);
          return transaction.getAll(storeName);
        },
        add: (storeName, value) => {
          assertAffected(storeName);
          return transaction.add(storeName, value);
        },
        put: (storeName, value) => {
          assertAffected(storeName);
          return transaction.put(storeName, value);
        },
        remove: (storeName, key) => {
          assertAffected(storeName);
          return transaction.remove(storeName, key);
        },
        queryIndex: (storeName, indexName, options) => {
          assertAffected(storeName);
          return transaction.queryIndex(storeName, indexName, options);
        },
        abort: (reason) => transaction.abort(reason),
      });
    }

    async function executePreparedCommand(command) {
      const internalStores = command.intentId
        ? [...INTERNAL_COMMAND_STORES, 'pendingIntents']
        : INTERNAL_COMMAND_STORES;
      const transactionStores = [...new Set([...command.affectedStores, ...internalStores])];
      try {
        return await storage.runTransaction(
          transactionStores,
          'readwrite',
          async (transaction) => {
            const initialRuntime = assertRuntimeRecord(await transaction.get('system', RUNTIME_KEY));
            const initialWriter = assertWriterRecord(
              await transaction.get('coordination', WRITER_KEY)
            );
            assertWriterControl(
              initialWriter,
              tabId,
              command.expectedWriterEpoch,
              timestampFromNow(now)
            );
            assertExpectedDataRevision(
              initialRuntime,
              command.expectedDataRevision,
              command.commandType
            );
            if (!initialRuntime.writeEnabled && !command.allowWriteDisabled) {
              throw runtimeError(
                ERROR_CODES.WRITE_DISABLED,
                'runtime writes are disabled',
                { commandType: command.commandType, writeEnabled: false }
              );
            }

            let intentRecord = null;
            if (command.intentId) {
              intentRecord = await transaction.get('pendingIntents', command.intentId);
              if (
                !intentRecord || intentRecord.status !== 'pending' ||
                intentRecord.writerTabId !== tabId ||
                intentRecord.writerEpoch !== command.expectedWriterEpoch ||
                intentRecord.expectedDataRevision !== command.expectedDataRevision
              ) {
                throw runtimeError(
                  ERROR_CODES.INTENT_STATE_INVALID,
                  'pending intent does not match the command',
                  { intentId: command.intentId, status: intentRecord && intentRecord.status }
                );
              }
            }

            const result = await command.execute(
              commandTransactionApi(transaction, command.affectedStores)
            );

            const finalWriter = assertWriterRecord(
              await transaction.get('coordination', WRITER_KEY)
            );
            const finalRuntime = assertRuntimeRecord(await transaction.get('system', RUNTIME_KEY));
            const committedAt = timestampFromNow(now);
            assertWriterControl(
              finalWriter,
              tabId,
              command.expectedWriterEpoch,
              committedAt
            );
            assertExpectedDataRevision(
              finalRuntime,
              command.expectedDataRevision,
              command.commandType
            );
            if (!finalRuntime.writeEnabled && !command.allowWriteDisabled) {
              throw runtimeError(
                ERROR_CODES.WRITE_DISABLED,
                'runtime writes were disabled before commit',
                { commandType: command.commandType, writeEnabled: false }
              );
            }

            const sequence = nextRevision(finalRuntime.commitSequence, { allowZero: true });
            const dataRevision = nextRevision(finalRuntime.dataRevision, { allowZero: true });
            const commitId = newUuid('commitId');
            const commit = {
              sequence,
              commitId,
              commandType: command.commandType,
              writerTabId: tabId,
              writerEpoch: command.expectedWriterEpoch,
              previousDataRevision: finalRuntime.dataRevision,
              dataRevision,
              affectedStores: command.affectedStores.slice(),
              intentId: command.intentId,
              committedAt: committedAt.iso,
              metadata: command.metadata,
            };
            await transaction.add('commits', commit);
            await transaction.put('system', {
              ...finalRuntime,
              ...(command.runtimePatch || {}),
              dataRevision,
              lastCommitId: commitId,
              commitSequence: sequence,
            });
            if (intentRecord) {
              await transaction.put('pendingIntents', {
                ...intentRecord,
                status: 'completed',
                completedAt: committedAt.iso,
                commitId,
                failureCode: null,
              });
            }
            return { result, commit };
          }
        );
      } catch (error) {
        throw commandFailure(error, command.commandType);
      }
    }

    async function runCommand(input, internalOptions) {
      const request = input || {};
      const commandType = requireNonEmptyString(request.commandType, 'commandType');
      const expectedDataRevision = request.expectedDataRevision;
      const expectedWriterEpoch = request.expectedWriterEpoch;
      assertRevision(expectedDataRevision, { field: 'expectedDataRevision', allowZero: true });
      assertRevision(expectedWriterEpoch, { field: 'expectedWriterEpoch' });
      if (typeof request.execute !== 'function') {
        throw runtimeError(
          ERROR_CODES.COMMAND_FAILED,
          'execute must be a function',
          { commandType }
        );
      }
      const affectedStores = internalOptions && internalOptions.affectedStores
        ? internalOptions.affectedStores
        : normalizeAffectedStores(request.affectedStores);
      const metadata = cloneMetadata(request.metadata, 'metadata');
      const intentOption = normalizeIntentOption(request.intent, metadata);
      const command = {
        commandType,
        expectedDataRevision,
        expectedWriterEpoch,
        affectedStores,
        execute: request.execute,
        metadata,
        intentId: null,
        allowWriteDisabled: Boolean(internalOptions && internalOptions.allowWriteDisabled),
        runtimePatch: internalOptions && internalOptions.runtimePatch,
      };

      await preflight(command);
      if (intentOption) {
        command.intentId = newUuid('intentId');
        const createdAt = timestampFromNow(now).iso;
        await persistPendingIntent(
          command,
          command.intentId,
          createdAt,
          intentOption.metadata
        );
      }

      try {
        return await executePreparedCommand(command);
      } catch (error) {
        if (
          command.intentId &&
          ![
            ERROR_CODES.WRITER_EPOCH_LOST,
            ERROR_CODES.WRITER_LEASE_EXPIRED,
          ].includes(error.code)
        ) {
          await markIntentFailed(command.intentId, error.code || ERROR_CODES.COMMAND_FAILED);
        }
        throw error;
      }
    }

    async function executeCommand(input) {
      return runCommand(input);
    }

    async function setWriteEnabled(input) {
      const request = input || {};
      if (typeof request.enabled !== 'boolean') {
        throw runtimeError(
          ERROR_CODES.COMMAND_FAILED,
          'enabled must be boolean',
          { enabled: request.enabled }
        );
      }
      const reason = requireNonEmptyString(request.reason, 'reason');
      if (heldWriterEpoch === null) {
        throw runtimeError(
          ERROR_CODES.WRITER_NOT_OWNED,
          'the runtime instance has not acquired the writer lease',
          { tabId }
        );
      }
      await open();
      const runtime = assertRuntimeRecord(await storage.get('system', RUNTIME_KEY));
      return runCommand(
        {
          commandType: 'runtime.set-write-enabled',
          expectedDataRevision: runtime.dataRevision,
          expectedWriterEpoch: heldWriterEpoch,
          affectedStores: ['system'],
          metadata: { enabled: request.enabled, reason },
          execute: async () => undefined,
        },
        {
          allowWriteDisabled: true,
          affectedStores: ['system'],
          runtimePatch: { writeEnabled: request.enabled },
        }
      );
    }

    async function getPendingIntents() {
      await open();
      const [intents, writer] = await Promise.all([
        storage.getAll('pendingIntents'),
        getWriterState(),
      ]);
      return intents
        .filter((intent) => intent.status === 'pending')
        .map((intent) => ({
          ...intent,
          isStale: (
            writer.status !== 'active' ||
            intent.writerTabId !== writer.ownerTabId ||
            intent.writerEpoch !== writer.epoch
          ),
        }));
    }

    return Object.freeze({
      open,
      acquireWriter,
      heartbeat,
      releaseWriter,
      getWriterState,
      executeCommand,
      setWriteEnabled,
      getPendingIntents,
    });
  }

  return Object.freeze({
    WRITER_KEY,
    RuntimeError,
    createPeritaRuntime,
  });
});

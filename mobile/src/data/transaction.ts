import {
  type StoreKey,
  type StoreName,
  type StoreValue,
} from "@/data/schema"
import { toPersistenceError } from "@/data/errors"

export interface TransactionStore<Name extends StoreName> {
  get(key: StoreKey<Name>): Promise<StoreValue<Name> | undefined>
  getAll(): Promise<StoreValue<Name>[]>
  getAllFromIndex(
    indexName: string,
    query?: IDBValidKey | IDBKeyRange,
  ): Promise<StoreValue<Name>[]>
  count(): Promise<number>
  add(value: StoreValue<Name>): Promise<StoreKey<Name>>
  put(value: StoreValue<Name>): Promise<StoreKey<Name>>
  delete(key: StoreKey<Name>): Promise<void>
  clear(): Promise<void>
}

export interface TransactionContext {
  store<Name extends StoreName>(name: Name): TransactionStore<Name>
}

function requestToPromise<Result>(
  request: IDBRequest<Result>,
  operation: string,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(
        toPersistenceError(
          request.error,
          "request_failed",
          `IndexedDB request failed: ${operation}`,
        ),
      )
  })
}

function transactionCompletion(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(
        toPersistenceError(
          transaction.error,
          "transaction_failed",
          "IndexedDB transaction failed",
        ),
      )
    transaction.onabort = () =>
      reject(
        toPersistenceError(
          transaction.error,
          "aborted",
          "IndexedDB transaction was aborted",
        ),
      )
  })
}

function storeAdapter<Name extends StoreName>(
  objectStore: IDBObjectStore,
): TransactionStore<Name> {
  return {
    get: async (key) =>
      requestToPromise(
        objectStore.get(key),
        `get from ${objectStore.name}`,
      ) as Promise<StoreValue<Name> | undefined>,
    getAll: async () =>
      requestToPromise(
        objectStore.getAll(),
        `getAll from ${objectStore.name}`,
      ) as Promise<StoreValue<Name>[]>,
    getAllFromIndex: async (indexName, query) =>
      requestToPromise(
        objectStore.index(indexName).getAll(query),
        `getAll from ${objectStore.name}.${indexName}`,
      ) as Promise<StoreValue<Name>[]>,
    count: () =>
      requestToPromise(objectStore.count(), `count ${objectStore.name}`),
    add: async (value) =>
      requestToPromise(
        objectStore.add(value),
        `add to ${objectStore.name}`,
      ) as Promise<StoreKey<Name>>,
    put: async (value) =>
      requestToPromise(
        objectStore.put(value),
        `put in ${objectStore.name}`,
      ) as Promise<StoreKey<Name>>,
    delete: (key) =>
      requestToPromise(
        objectStore.delete(key),
        `delete from ${objectStore.name}`,
      ),
    clear: () =>
      requestToPromise(objectStore.clear(), `clear ${objectStore.name}`),
  }
}

export async function runTransaction<Result>(
  database: IDBDatabase,
  storeNames: readonly StoreName[],
  mode: IDBTransactionMode,
  worker: (context: TransactionContext) => Promise<Result>,
): Promise<Result> {
  let transaction: IDBTransaction
  try {
    transaction = database.transaction([...storeNames], mode)
  } catch (error) {
    throw toPersistenceError(
      error,
      "transaction_failed",
      "Could not start IndexedDB transaction",
    )
  }

  const completion = transactionCompletion(transaction)
  const context: TransactionContext = {
    store: <Name extends StoreName>(name: Name) =>
      storeAdapter<Name>(transaction.objectStore(name)),
  }

  try {
    const result = await worker(context)
    await completion
    return result
  } catch (error) {
    try {
      transaction.abort()
    } catch {
      // The browser may already have aborted or committed the transaction.
    }
    try {
      await completion
    } catch {
      // Preserve the more specific request/worker failure below.
    }
    throw toPersistenceError(
      error,
      "transaction_failed",
      "IndexedDB transaction could not be completed",
    )
  }
}

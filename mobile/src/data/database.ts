import { PersistenceError, toPersistenceError } from "@/data/errors"
import { applySchemaMigrations } from "@/data/migrations"
import {
  DATABASE_NAME,
  DATABASE_VERSION,
  type StoreName,
} from "@/data/schema"
import {
  runTransaction,
  type TransactionContext,
} from "@/data/transaction"

export interface OpenDatabaseOptions {
  readonly name?: string
  readonly indexedDB?: IDBFactory
}

export interface PeritaDatabase {
  readonly name: string
  readonly version: number
  readonly storeNames: readonly string[]
  transaction<Result>(
    storeNames: readonly StoreName[],
    mode: IDBTransactionMode,
    worker: (context: TransactionContext) => Promise<Result>,
  ): Promise<Result>
  close(): void
}

class IndexedDbPeritaDatabase implements PeritaDatabase {
  private readonly connection: IDBDatabase

  constructor(connection: IDBDatabase) {
    this.connection = connection
  }

  get name() {
    return this.connection.name
  }

  get version() {
    return this.connection.version
  }

  get storeNames() {
    return Array.from(this.connection.objectStoreNames)
  }

  transaction<Result>(
    storeNames: readonly StoreName[],
    mode: IDBTransactionMode,
    worker: (context: TransactionContext) => Promise<Result>,
  ) {
    return runTransaction(this.connection, storeNames, mode, worker)
  }

  close() {
    this.connection.close()
  }
}

export function openPeritaDatabase(
  options: OpenDatabaseOptions = {},
): Promise<PeritaDatabase> {
  const factory = options.indexedDB ?? globalThis.indexedDB
  if (!factory) {
    return Promise.reject(
      new PersistenceError(
        "open_failed",
        "IndexedDB is not available in this environment",
      ),
    )
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let request: IDBOpenDBRequest
    try {
      request = factory.open(options.name ?? DATABASE_NAME, DATABASE_VERSION)
    } catch (error) {
      reject(
        toPersistenceError(
          error,
          "open_failed",
          "Could not request the Perita mobile database",
        ),
      )
      return
    }

    request.onupgradeneeded = (event) => {
      const transaction = request.transaction
      if (!transaction) {
        throw new PersistenceError(
          "open_failed",
          "Schema upgrade started without a versionchange transaction",
        )
      }
      applySchemaMigrations(
        request.result,
        transaction,
        event.oldVersion,
        event.newVersion ?? DATABASE_VERSION,
      )
    }

    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(new IndexedDbPeritaDatabase(database))
    }

    request.onerror = () => {
      if (settled) return
      settled = true
      reject(
        toPersistenceError(
          request.error,
          "open_failed",
          "Could not open the Perita mobile database",
        ),
      )
    }

    request.onblocked = () => {
      if (settled) return
      settled = true
      reject(
        new PersistenceError(
          "blocked",
          "The Perita mobile database upgrade is blocked by another tab",
        ),
      )
    }
  })
}

export function closePeritaDatabase(database: PeritaDatabase) {
  database.close()
}

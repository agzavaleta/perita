export const SETUP_DRAFT_DATABASE_NAME = "perita_mobile_setup_draft" as const
export const SETUP_DRAFT_DATABASE_VERSION = 1 as const

const STORE_NAME = "draft" as const
const DRAFT_KEY = "current" as const

export interface SetupDraftAccount {
  readonly id: string
  readonly name: string
  readonly bank: string | null
  readonly openingBalance: number
  readonly emoji: string
}

export interface SetupDraft {
  readonly periodKey: string
  readonly salaryReferenceAmount: number
  readonly account: SetupDraftAccount
}

interface StoredSetupDraft {
  readonly key: typeof DRAFT_KEY
  readonly value: unknown
}

export interface SetupDraftStore {
  read(): Promise<SetupDraft | null>
  save(draft: SetupDraft): Promise<void>
  clear(): Promise<void>
  close(): void
}

export interface OpenSetupDraftStoreOptions {
  readonly name?: string
  readonly indexedDB?: IDBFactory
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function normalizeDraft(value: unknown): SetupDraft | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const legacyAccounts = Array.isArray(record.accounts) ? record.accounts : []
  const account = record.account ?? legacyAccounts[0]
  if (!account || typeof account !== "object") return null
  const accountRecord = account as Record<string, unknown>
  if (
    typeof record.periodKey !== "string" ||
    typeof record.salaryReferenceAmount !== "number" ||
    typeof accountRecord.id !== "string" ||
    typeof accountRecord.name !== "string" ||
    typeof accountRecord.openingBalance !== "number"
  ) {
    return null
  }
  return {
    periodKey: record.periodKey,
    salaryReferenceAmount: record.salaryReferenceAmount,
    account: {
      id: accountRecord.id,
      name: accountRecord.name,
      bank: typeof accountRecord.bank === "string" ? accountRecord.bank : null,
      openingBalance: accountRecord.openingBalance,
      emoji: typeof accountRecord.emoji === "string" ? accountRecord.emoji : "💳",
    },
  }
}

export function openSetupDraftStore(
  options: OpenSetupDraftStoreOptions = {},
): Promise<SetupDraftStore> {
  const factory = options.indexedDB ?? globalThis.indexedDB
  if (!factory) return Promise.reject(new Error("IndexedDB is not available"))

  return new Promise((resolve, reject) => {
    const request = factory.open(
      options.name ?? SETUP_DRAFT_DATABASE_NAME,
      SETUP_DRAFT_DATABASE_VERSION,
    )
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" })
      }
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      resolve({
        async read() {
          const transaction = database.transaction(STORE_NAME, "readonly")
          const stored = await requestResult<StoredSetupDraft | undefined>(
            transaction.objectStore(STORE_NAME).get(DRAFT_KEY),
          )
          await transactionDone(transaction)
          return normalizeDraft(stored?.value)
        },
        async save(draft) {
          const transaction = database.transaction(STORE_NAME, "readwrite")
          transaction.objectStore(STORE_NAME).put({
            key: DRAFT_KEY,
            value: draft,
          } satisfies StoredSetupDraft)
          await transactionDone(transaction)
        },
        async clear() {
          const transaction = database.transaction(STORE_NAME, "readwrite")
          transaction.objectStore(STORE_NAME).delete(DRAFT_KEY)
          await transactionDone(transaction)
        },
        close() {
          database.close()
        },
      })
    }
  })
}

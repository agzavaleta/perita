import {
  DATABASE_VERSION,
  INDEX_NAMES,
  STORE_NAMES,
} from "@/data/schema"

export interface SchemaMigration {
  readonly version: number
  readonly description: string
  upgrade(database: IDBDatabase, transaction: IDBTransaction): void
}

function createInitialSchema(database: IDBDatabase) {
  database.createObjectStore(STORE_NAMES.financialSettings, {
    keyPath: "key",
  })

  const periods = database.createObjectStore(STORE_NAMES.periods, {
    keyPath: "id",
  })
  periods.createIndex(INDEX_NAMES.byPeriodKey, "periodKey", { unique: true })
  periods.createIndex(INDEX_NAMES.byStatus, "status")

  const periodOpenings = database.createObjectStore(
    STORE_NAMES.periodOpenings,
    { keyPath: "id" },
  )
  periodOpenings.createIndex(INDEX_NAMES.byPeriod, "periodId")
  periodOpenings.createIndex(
    INDEX_NAMES.byPeriodTarget,
    ["periodId", "targetType", "targetId"],
    { unique: true },
  )

  database.createObjectStore(STORE_NAMES.accounts, { keyPath: "id" })
  database.createObjectStore(STORE_NAMES.savingsGoals, { keyPath: "id" })
  database.createObjectStore(STORE_NAMES.debts, { keyPath: "id" })
  database.createObjectStore(STORE_NAMES.categories, { keyPath: "id" })
  database.createObjectStore(STORE_NAMES.fixedExpenseTemplates, {
    keyPath: "id",
  })

  const fixedExpenseInstances = database.createObjectStore(
    STORE_NAMES.fixedExpenseInstances,
    { keyPath: "id" },
  )
  fixedExpenseInstances.createIndex(INDEX_NAMES.byPeriod, "periodId")
  fixedExpenseInstances.createIndex(
    INDEX_NAMES.byPeriodTemplate,
    ["periodId", "templateId"],
    { unique: true },
  )

  const operations = database.createObjectStore(STORE_NAMES.operations, {
    keyPath: "id",
  })
  operations.createIndex(INDEX_NAMES.byPeriod, "periodId")
  operations.createIndex(
    INDEX_NAMES.byPeriodType,
    ["periodId", "type"],
  )

  const movements = database.createObjectStore(STORE_NAMES.movements, {
    keyPath: "id",
  })
  movements.createIndex(INDEX_NAMES.byOperation, "operationId")
  movements.createIndex(INDEX_NAMES.byPeriod, "periodId")
  movements.createIndex(
    INDEX_NAMES.byTarget,
    ["targetType", "targetId"],
  )

  const revisions = database.createObjectStore(
    STORE_NAMES.operationRevisions,
    { keyPath: "id" },
  )
  revisions.createIndex(INDEX_NAMES.byOperation, "operationId")
  revisions.createIndex(
    INDEX_NAMES.byOperationRevision,
    ["operationId", "revisionNumber"],
    { unique: true },
  )

  const auditEvents = database.createObjectStore(STORE_NAMES.auditEvents, {
    keyPath: "id",
  })
  auditEvents.createIndex(INDEX_NAMES.byPeriod, "periodId")
  auditEvents.createIndex(
    INDEX_NAMES.bySubject,
    ["subjectType", "subjectId"],
  )

  const snapshots = database.createObjectStore(STORE_NAMES.periodSnapshots, {
    keyPath: "id",
  })
  snapshots.createIndex(INDEX_NAMES.byPeriod, "periodId", { unique: true })
  snapshots.createIndex(INDEX_NAMES.byPeriodKey, "periodKey", { unique: true })
}

function backfillMissingField(
  transaction: IDBTransaction,
  storeName: typeof STORE_NAMES.periods | typeof STORE_NAMES.accounts | typeof STORE_NAMES.savingsGoals,
  field: string,
  defaultValue: unknown,
) {
  const request = transaction.objectStore(storeName).openCursor()
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor) return

    const record = cursor.value as Record<string, unknown>
    if (!Object.hasOwn(record, field)) {
      cursor.update({ ...record, [field]: defaultValue })
    }
    cursor.continue()
  }
}

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    description: "Create the isolated mobile domain schema",
    upgrade(database) {
      createInitialSchema(database)
    },
  },
  {
    version: 2,
    description: "Backfill planning budget and financial target emojis",
    upgrade(_database, transaction) {
      backfillMissingField(
        transaction,
        STORE_NAMES.periods,
        "variableExpenseBudgetAmount",
        0,
      )
      backfillMissingField(transaction, STORE_NAMES.accounts, "emoji", "💳")
      backfillMissingField(
        transaction,
        STORE_NAMES.savingsGoals,
        "emoji",
        "💰",
      )
    },
  },
]

export function applySchemaMigrations(
  database: IDBDatabase,
  transaction: IDBTransaction,
  oldVersion: number,
  newVersion: number,
) {
  for (const migration of SCHEMA_MIGRATIONS) {
    if (migration.version > oldVersion && migration.version <= newVersion) {
      migration.upgrade(database, transaction)
    }
  }
}

const latestMigration = SCHEMA_MIGRATIONS.at(-1)?.version
if (latestMigration !== DATABASE_VERSION) {
  throw new Error("DATABASE_VERSION must match the latest schema migration")
}

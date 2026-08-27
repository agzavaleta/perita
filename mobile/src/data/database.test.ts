import { IDBFactory } from "fake-indexeddb"
import { describe, expect, it } from "vitest"

import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asNonZeroClpDelta,
  asPeriodKey,
  asPositiveClpAmount,
  asRevision,
  asUtcTimestamp,
  type Account,
  type Category,
  type Movement,
  type Operation,
  type Period,
  type SavingsGoal,
} from "@/domain"
import {
  createRepositories,
  DATABASE_VERSION,
  INDEX_NAMES,
  openPeritaDatabase,
  STORE_NAMES,
} from "@/data"
import {
  applySchemaMigrations,
  SCHEMA_MIGRATIONS,
} from "@/data/migrations"

const ACCOUNT_ID = asEntityId("00000000-0000-4000-8000-000000000001")
const PERIOD_ID = asEntityId("00000000-0000-4000-8000-000000000002")
const OPERATION_ID = asEntityId("00000000-0000-4000-8000-000000000003")
const MOVEMENT_ID = asEntityId("00000000-0000-4000-8000-000000000004")
const CATEGORY_ID = asEntityId("00000000-0000-4000-8000-000000000005")
const GOAL_ID = asEntityId("00000000-0000-4000-8000-000000000006")
const SNAPSHOT_ID = asEntityId("00000000-0000-4000-8000-000000000007")
const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: ACCOUNT_ID,
    emoji: "💳",
    name: "Cuenta principal",
    bank: "Banco",
    openingBalance: asPositiveClpAmount(100_000),
    currentBalance: asPositiveClpAmount(100_000),
    status: "active",
    deletedAt: null,
    balanceAtDeletion: null,
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function operation(): Operation {
  return {
    id: OPERATION_ID,
    periodId: PERIOD_ID,
    type: "additional_income",
    operationDate: asCivilDate("2026-08-21"),
    amount: asPositiveClpAmount(15_000),
    details: {
      accountId: ACCOUNT_ID,
      concept: "Ingreso de prueba",
      observation: null,
    },
    status: "posted",
    voidedAt: null,
    voidReason: null,
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function movement(): Movement {
  return {
    id: MOVEMENT_ID,
    operationId: OPERATION_ID,
    periodId: PERIOD_ID,
    targetType: "account",
    targetId: ACCOUNT_ID,
    effectType: "asset_balance",
    delta: asNonZeroClpDelta(15_000),
    status: "posted",
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function category(): Category {
  return {
    id: CATEGORY_ID,
    name: "Alimentación",
    status: "active",
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function openNative(factory: IDBFactory, name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function openVersionOne(factory: IDBFactory, name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1)
    request.onupgradeneeded = (event) => {
      const transaction = request.transaction
      if (!transaction) throw new Error("Missing V1 upgrade transaction")
      applySchemaMigrations(
        request.result,
        transaction,
        event.oldVersion,
        event.newVersion ?? 1,
      )
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionCompletion(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

describe("Perita IndexedDB persistence", () => {
  it("applies the explicit initial migration with the expected stores and indexes", async () => {
    const factory = new IDBFactory()
    const name = "perita-mobile-initial-upgrade"
    const database = await openPeritaDatabase({ name, indexedDB: factory })

    expect(database.version).toBe(DATABASE_VERSION)
    expect(SCHEMA_MIGRATIONS.map(({ version }) => version)).toEqual([1, 2, 3])
    expect([...database.storeNames].sort()).toEqual(
      Object.values(STORE_NAMES).sort(),
    )
    database.close()

    const nativeDatabase = await openNative(factory, name)
    const transaction = nativeDatabase.transaction(
      [STORE_NAMES.periods, STORE_NAMES.operations, STORE_NAMES.movements],
      "readonly",
    )
    expect(
      Array.from(
        transaction.objectStore(STORE_NAMES.periods).indexNames,
      ).sort(),
    ).toEqual([INDEX_NAMES.byPeriodKey, INDEX_NAMES.byStatus].sort())
    expect(
      Array.from(
        transaction.objectStore(STORE_NAMES.operations).indexNames,
      ).sort(),
    ).toEqual([INDEX_NAMES.byPeriod, INDEX_NAMES.byPeriodType].sort())
    expect(
      Array.from(
        transaction.objectStore(STORE_NAMES.movements).indexNames,
      ).sort(),
    ).toEqual(
      [
        INDEX_NAMES.byOperation,
        INDEX_NAMES.byPeriod,
        INDEX_NAMES.byTarget,
      ].sort(),
    )
    nativeDatabase.close()
  })

  it("backfills V1 records through the latest upgrade without changing financial data", async () => {
    const factory = new IDBFactory()
    const name = "perita-mobile-v1-to-v2"
    const periodV1: Omit<Period, "variableExpenseBudgetAmount"> = {
      id: PERIOD_ID,
      periodKey: asPeriodKey("2026-08"),
      plannedSalaryAmount: asClpAmount(900_000),
      status: "open",
      openedAt: NOW,
      closedAt: null,
      snapshotId: null,
      revision: asRevision(3),
    }
    const {
      emoji: _accountEmoji,
      deletedAt: _deletedAt,
      balanceAtDeletion: _balanceAtDeletion,
      ...accountV1Base
    } = account({
      openingBalance: asClpAmount(125_000),
      currentBalance: asClpAmount(140_000),
      revision: asRevision(4),
    })
    const accountV1: Omit<
      Account,
      "emoji" | "deletedAt" | "balanceAtDeletion"
    > = accountV1Base
    const goalV1: Omit<SavingsGoal, "emoji"> = {
      id: GOAL_ID,
      name: "Vacaciones",
      bank: null,
      targetAmount: asPositiveClpAmount(1_500_000),
      openingBalance: asClpAmount(40_000),
      currentBalance: asClpAmount(75_000),
      plannedMonthlyAmount: asClpAmount(50_000),
      lifecycleStatus: "active",
      progressStatus: "in_progress",
      closedAt: null,
      revision: asRevision(2),
      createdAt: NOW,
      updatedAt: NOW,
    }
    const snapshotV1 = {
      id: SNAPSHOT_ID,
      periodId: asEntityId("00000000-0000-4000-8000-000000000008"),
      periodKey: asPeriodKey("2026-07"),
      schemaVersion: "1.1.0",
      snapshotKind: "canonical",
      closedAt: NOW,
      data: { preservedMarker: "unchanged" },
      integrity: {
        algorithm: "SHA-256",
        payloadHash: "original-hash-must-not-change",
      },
    }

    const versionOne = await openVersionOne(factory, name)
    const seedTransaction = versionOne.transaction(
      [
        STORE_NAMES.periods,
        STORE_NAMES.accounts,
        STORE_NAMES.savingsGoals,
        STORE_NAMES.periodSnapshots,
      ],
      "readwrite",
    )
    seedTransaction.objectStore(STORE_NAMES.periods).add(periodV1)
    seedTransaction.objectStore(STORE_NAMES.accounts).add(accountV1)
    seedTransaction.objectStore(STORE_NAMES.savingsGoals).add(goalV1)
    seedTransaction.objectStore(STORE_NAMES.periodSnapshots).add(snapshotV1)
    await transactionCompletion(seedTransaction)
    versionOne.close()

    const upgraded = await openPeritaDatabase({ name, indexedDB: factory })
    const repositories = createRepositories(upgraded)

    expect(upgraded.version).toBe(3)
    expect(await repositories.periods.get(PERIOD_ID)).toEqual({
      ...periodV1,
      variableExpenseBudgetAmount: 0,
    })
    expect(await repositories.accounts.get(ACCOUNT_ID)).toEqual({
      ...accountV1,
      emoji: "💳",
      deletedAt: null,
      balanceAtDeletion: null,
    })
    expect(await repositories.savingsGoals.get(GOAL_ID)).toEqual({
      ...goalV1,
      emoji: "💰",
    })
    expect(await repositories.periodSnapshots.get(SNAPSHOT_ID)).toEqual(snapshotV1)
    upgraded.close()
  })

  it("supports basic CRUD through a domain repository", async () => {
    const database = await openPeritaDatabase({
      name: "perita-mobile-crud",
      indexedDB: new IDBFactory(),
    })
    const repositories = createRepositories(database)

    await repositories.accounts.add(account())
    expect(await repositories.accounts.get(ACCOUNT_ID)).toEqual(account())

    const renamed = account({
      name: "Cuenta actualizada",
      revision: asRevision(2),
    })
    await repositories.accounts.put(renamed)
    expect(await repositories.accounts.getAll()).toEqual([renamed])
    expect(await repositories.accounts.count()).toBe(1)

    await repositories.accounts.delete(ACCOUNT_ID)
    expect(await repositories.accounts.get(ACCOUNT_ID)).toBeUndefined()
    database.close()
  })

  it("preserves records after closing and reopening the same database", async () => {
    const factory = new IDBFactory()
    const options = { name: "perita-mobile-reopen", indexedDB: factory }
    const firstConnection = await openPeritaDatabase(options)
    await createRepositories(firstConnection).categories.add(category())
    firstConnection.close()

    const reopened = await openPeritaDatabase(options)
    expect(await createRepositories(reopened).categories.get(CATEGORY_ID)).toEqual(
      category(),
    )
    reopened.close()
  })

  it("commits a financial operation and its movement atomically", async () => {
    const database = await openPeritaDatabase({
      name: "perita-mobile-transaction-commit",
      indexedDB: new IDBFactory(),
    })

    await database.transaction(
      [STORE_NAMES.accounts, STORE_NAMES.operations, STORE_NAMES.movements],
      "readwrite",
      async ({ store }) => {
        await store(STORE_NAMES.accounts).add(account())
        await store(STORE_NAMES.operations).add(operation())
        await store(STORE_NAMES.movements).add(movement())
      },
    )

    const repositories = createRepositories(database)
    expect(await repositories.accounts.count()).toBe(1)
    expect(await repositories.operations.get(OPERATION_ID)).toEqual(operation())
    expect(await repositories.movements.listByOperation(OPERATION_ID)).toEqual([
      movement(),
    ])
    database.close()
  })

  it("rolls back every store when a multi-entity transaction fails", async () => {
    const database = await openPeritaDatabase({
      name: "perita-mobile-transaction-rollback",
      indexedDB: new IDBFactory(),
    })

    await expect(
      database.transaction(
        [STORE_NAMES.accounts, STORE_NAMES.operations],
        "readwrite",
        async ({ store }) => {
          await store(STORE_NAMES.accounts).add(account())
          await store(STORE_NAMES.operations).add(operation())
          throw new Error("simulated use-case failure")
        },
      ),
    ).rejects.toMatchObject({
      name: "PersistenceError",
      code: "transaction_failed",
    })

    const repositories = createRepositories(database)
    expect(await repositories.accounts.count()).toBe(0)
    expect(await repositories.operations.count()).toBe(0)
    database.close()
  })
})

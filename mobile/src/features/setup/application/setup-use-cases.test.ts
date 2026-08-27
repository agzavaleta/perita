import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  asCivilDate,
  asEntityId,
  asUtcTimestamp,
  type EntityId,
} from "@/domain/primitives"
import { openPeritaDatabase, type PeritaDatabase } from "@/data/database"
import { createRepositories, type PeritaRepositories } from "@/data/repositories"
import { HomeUseCases } from "@/features/home/application/home-use-cases"
import { SetupUseCases } from "@/features/setup/application/setup-use-cases"
import {
  openSetupDraftStore,
  type SetupDraftStore,
} from "@/features/setup/data/setup-draft-store"

const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")
const TODAY = asCivilDate("2026-08-21")

function idSequence(prefix = "51000000") {
  let value = 1
  return () =>
    asEntityId(`${prefix}-0000-4000-8000-${String(value++).padStart(12, "0")}`)
}

describe("SetupUseCases", () => {
  let database: PeritaDatabase
  let repositories: PeritaRepositories
  let setup: SetupUseCases
  let draftStore: SetupDraftStore

  beforeEach(async () => {
    const indexedDB = new IDBFactory()
    database = await openPeritaDatabase({
      name: `setup-${crypto.randomUUID()}`,
      indexedDB,
    })
    draftStore = await openSetupDraftStore({
      name: `setup-draft-${crypto.randomUUID()}`,
      indexedDB,
    })
    repositories = createRepositories(database)
    setup = new SetupUseCases(repositories, {
      now: () => NOW,
      today: () => TODAY,
      createId: idSequence(),
      draftStore,
    })
  })

  afterEach(() => {
    database.close()
    draftStore.close()
  })

  it("creates settings, period, account and opening atomically without financial operations", async () => {
    expect(await setup.getState()).toMatchObject({
      status: "not_started",
      allowedPeriodKeys: ["2026-08", "2026-07"],
      draft: null,
    })

    await setup.saveDraft({
      periodKey: "2026-08",
      salaryReferenceAmount: 900_000,
      variableExpenseBudgetAmount: 250_000,
      accounts: [{
        id: "draft-account-1",
        name: "Principal",
        bank: "Banco",
        openingBalance: 100_000,
      }],
    })
    const reopenedSetup = new SetupUseCases(repositories, {
      now: () => NOW,
      today: () => TODAY,
      createId: idSequence("51500000"),
      draftStore,
    })
    expect(await reopenedSetup.getState()).toMatchObject({
      status: "resumable",
      draft: {
        accounts: [{ id: "draft-account-1", emoji: "💳" }],
      },
    })
    expect(await repositories.accounts.count()).toBe(0)

    const result = await setup.completeSetup({
      periodKey: "2026-08",
      salaryReferenceAmount: 900_000,
      variableExpenseBudgetAmount: 250_000,
      accounts: [{ name: "Principal", bank: "Banco", openingBalance: 100_000 }],
    })

    expect(result.accounts[0]).toMatchObject({
      emoji: "💳",
      openingBalance: 100_000,
      currentBalance: 100_000,
      status: "active",
      deletedAt: null,
      balanceAtDeletion: null,
    })
    expect(result.periodOpenings[0]).toMatchObject({
      targetId: result.accounts[0]?.id,
      openingAmount: 100_000,
    })
    expect(result.period).toMatchObject({
      plannedSalaryAmount: 900_000,
      variableExpenseBudgetAmount: 250_000,
    })
    expect(await repositories.operations.count()).toBe(0)
    expect(await repositories.movements.count()).toBe(0)
    expect(await repositories.auditEvents.count()).toBe(3)
    expect((await setup.getState()).status).toBe("completed")
    expect(await draftStore.read()).toBeNull()

    const dashboard = await new HomeUseCases(repositories, {
      today: () => TODAY,
    }).getDashboard()
    expect(dashboard.summary).toMatchObject({
      plannedSalaryAmount: 900_000,
      receivedSalaryAmount: 0,
    })
  })

  it("accepts zero planning and a negative opening only during setup with a warning", async () => {
    const result = await setup.completeSetup({
      periodKey: "2026-07",
      salaryReferenceAmount: 0,
      variableExpenseBudgetAmount: 0,
      accounts: [{ name: "Cuenta utilizada", openingBalance: -25_000 }],
    })

    expect(result.accounts[0]).toMatchObject({
      openingBalance: -25_000,
      currentBalance: -25_000,
    })
    expect(result.warnings).toEqual([{
      code: "negative_opening_balance",
      accountId: result.accounts[0]?.id,
      openingBalance: -25_000,
    }])
    expect(await repositories.operations.count()).toBe(0)
  })

  it("accepts an initial period older than the previous month", async () => {
    const result = await setup.completeSetup({
      periodKey: "2024-01",
      salaryReferenceAmount: 0,
      variableExpenseBudgetAmount: 0,
      accounts: [{ name: "Histórica", openingBalance: 0 }],
    })

    expect(result.period.periodKey).toBe("2024-01")
  })

  it("confirms multiple accounts in the same atomic setup transaction", async () => {
    const result = await setup.completeSetup({
      periodKey: "2026-08",
      salaryReferenceAmount: 1_000_000,
      variableExpenseBudgetAmount: 300_000,
      accounts: [
        { name: "Principal", bank: "BancoEstado", openingBalance: 200_000 },
        { name: "Efectivo", bank: "Efectivo", openingBalance: 25_000, emoji: "💵" },
      ],
    })

    expect(result.accounts).toHaveLength(2)
    expect(result.accounts.map(({ emoji }) => emoji)).toEqual(["💳", "💵"])
    expect(result.periodOpenings).toHaveLength(2)
    expect(await repositories.auditEvents.count()).toBe(4)
  })

  it("rejects confirmation without accounts and creates no financial records", async () => {
    await setup.saveDraft({
      periodKey: "2026-08",
      salaryReferenceAmount: 0,
      variableExpenseBudgetAmount: 0,
      accounts: [],
    })
    await expect(setup.completeSetup({
      periodKey: "2026-08",
      salaryReferenceAmount: 0,
      variableExpenseBudgetAmount: 0,
      accounts: [],
    })).rejects.toMatchObject({ code: "invalid_account" })

    expect(await repositories.administration.readSnapshot()).toMatchObject({
      financialSettings: [],
      periods: [],
      accounts: [],
      periodOpenings: [],
    })
    expect(await draftStore.read()).toMatchObject({ accounts: [] })
  })

  it("rejects a future period without writes", async () => {
    await expect(setup.completeSetup({
      periodKey: "2026-09",
      salaryReferenceAmount: 0,
      variableExpenseBudgetAmount: 0,
      accounts: [{ name: "Principal", openingBalance: 0 }],
    })).rejects.toMatchObject({ code: "invalid_period" })
    expect(await repositories.administration.readSnapshot()).toMatchObject({
      financialSettings: [],
      periods: [],
      accounts: [],
      periodOpenings: [],
    })
  })

  it("rolls back every setup record when one account write violates uniqueness", async () => {
    const periodId = asEntityId("52000000-0000-4000-8000-000000000001")
    const duplicateAccountId = asEntityId("52000000-0000-4000-8000-000000000002")
    const remainingIds = idSequence("53000000")
    const queuedIds: EntityId[] = [periodId, duplicateAccountId, duplicateAccountId]
    const failingSetup = new SetupUseCases(repositories, {
      now: () => NOW,
      today: () => TODAY,
      createId: () => queuedIds.shift() ?? remainingIds(),
      draftStore,
    })

    await failingSetup.saveDraft({
      periodKey: "2026-08",
      salaryReferenceAmount: 0,
      variableExpenseBudgetAmount: 0,
      accounts: [{
        id: "draft-duplicate",
        name: "Duplicada",
        openingBalance: 0,
      }],
    })

    await expect(failingSetup.completeSetup({
      periodKey: "2026-08",
      salaryReferenceAmount: 0,
      variableExpenseBudgetAmount: 0,
      accounts: [
        { name: "Principal", openingBalance: 0 },
        { name: "Duplicada", openingBalance: 0 },
      ],
    })).rejects.toMatchObject({ code: "persistence_conflict" })
    const snapshot = await repositories.administration.readSnapshot()
    expect(snapshot.financialSettings).toEqual([])
    expect(snapshot.periods).toEqual([])
    expect(snapshot.accounts).toEqual([])
    expect(snapshot.periodOpenings).toEqual([])
    expect(snapshot.auditEvents).toEqual([])
    expect(await draftStore.read()).toMatchObject({
      accounts: [{ id: "draft-duplicate" }],
    })
  })
})

import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  asCivilDate,
  asEntityId,
  asUtcTimestamp,
} from "@/domain/primitives"
import { openPeritaDatabase, type PeritaDatabase } from "@/data/database"
import { createRepositories, type PeritaRepositories } from "@/data/repositories"
import { HomeUseCases } from "@/features/home/application/home-use-cases"
import { SetupUseCases } from "@/features/setup/application/setup-use-cases"
import {
  openSetupDraftStore,
  type SetupDraftStore,
} from "@/features/setup/data/setup-draft-store"

const NOW = asUtcTimestamp("2026-08-31T12:00:00.000Z")
const TODAY = asCivilDate("2026-08-31")

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

  it("creates settings, one account and its opening atomically", async () => {
    expect(await setup.getState()).toMatchObject({
      status: "not_started",
      allowedPeriodKeys: ["2026-09", "2026-08", "2026-07"],
      draft: null,
    })

    await setup.saveDraft({
      periodKey: "2026-08",
      salaryReferenceAmount: 900_000,
      account: {
        id: "draft-account-1",
        name: "Principal",
        openingBalance: 100_000,
      },
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
        account: {
          id: "draft-account-1",
          bank: null,
          emoji: "💳",
        },
      },
    })
    expect(await repositories.accounts.count()).toBe(0)

    const result = await setup.completeSetup({
      periodKey: "2026-08",
      salaryReferenceAmount: 900_000,
      account: {
        name: "Principal",
        bank: undefined,
        openingBalance: 100_000,
      },
    })

    expect(result.financialSettings.salaryReferenceAmount).toBe(900_000)
    expect(result.period).toMatchObject({
      plannedSalaryAmount: 900_000,
      variableExpenseBudgetAmount: 0,
      status: "open",
    })
    expect(result.accounts).toEqual([
      expect.objectContaining({
        name: "Principal",
        bank: null,
        openingBalance: 100_000,
        currentBalance: 100_000,
        status: "active",
      }),
    ])
    expect(result.periodOpenings).toEqual([
      expect.objectContaining({
        targetId: result.accounts[0]?.id,
        openingAmount: 100_000,
      }),
    ])
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

  it("keeps a negative current balance as an opening with a warning", async () => {
    const result = await setup.completeSetup({
      periodKey: "2026-07",
      salaryReferenceAmount: 0,
      account: { name: "Cuenta utilizada", openingBalance: -25_000 },
    })

    expect(result.accounts[0]).toMatchObject({
      openingBalance: -25_000,
      currentBalance: -25_000,
    })
    expect(result.periodOpenings[0]).toMatchObject({ openingAmount: -25_000 })
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
      account: { name: "Histórica", openingBalance: 0 },
    })

    expect(result.period.periodKey).toBe("2024-01")
    expect(result.period.variableExpenseBudgetAmount).toBe(0)
  })

  it("rejects an invalid account without creating financial records", async () => {
    await expect(setup.completeSetup({
      periodKey: "2026-08",
      salaryReferenceAmount: 0,
      account: { name: "  ", openingBalance: 0 },
    })).rejects.toMatchObject({ code: "invalid_account" })

    expect(await repositories.administration.readSnapshot()).toMatchObject({
      financialSettings: [],
      periods: [],
      accounts: [],
      periodOpenings: [],
    })
  })

  it("accepts only the next anticipated month and rejects later future periods", async () => {
    await expect(setup.completeSetup({
      periodKey: "2026-10",
      salaryReferenceAmount: 0,
      account: { name: "Principal", openingBalance: 0 },
    })).rejects.toMatchObject({ code: "invalid_period" })
    expect(await repositories.administration.readSnapshot()).toMatchObject({
      financialSettings: [],
      periods: [],
      accounts: [],
      periodOpenings: [],
    })

    const result = await setup.completeSetup({
      periodKey: "2026-09",
      salaryReferenceAmount: 0,
      account: { name: "Principal", openingBalance: 0 },
    })
    expect(result.period.periodKey).toBe("2026-09")
  })

  it("rolls back the single-account setup when an atomic write fails", async () => {
    const ids = [
      "52000000-0000-4000-8000-000000000001",
      "52000000-0000-4000-8000-000000000002",
      "52000000-0000-4000-8000-000000000003",
      "52000000-0000-4000-8000-000000000004",
      "52000000-0000-4000-8000-000000000004",
    ].map(asEntityId)
    const remainingIds = idSequence("53000000")
    const failingSetup = new SetupUseCases(repositories, {
      now: () => NOW,
      today: () => TODAY,
      createId: () => ids.shift() ?? remainingIds(),
      draftStore,
    })

    await expect(failingSetup.completeSetup({
      periodKey: "2026-08",
      salaryReferenceAmount: 0,
      account: { name: "Principal", openingBalance: 0 },
    })).rejects.toMatchObject({ code: "persistence_conflict" })
    const snapshot = await repositories.administration.readSnapshot()
    expect(snapshot.financialSettings).toEqual([])
    expect(snapshot.periods).toEqual([])
    expect(snapshot.accounts).toEqual([])
    expect(snapshot.periodOpenings).toEqual([])
    expect(snapshot.auditEvents).toEqual([])
  })
})

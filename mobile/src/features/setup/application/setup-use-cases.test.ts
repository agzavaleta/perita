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

  beforeEach(async () => {
    database = await openPeritaDatabase({
      name: `setup-${crypto.randomUUID()}`,
      indexedDB: new IDBFactory(),
    })
    repositories = createRepositories(database)
    setup = new SetupUseCases(repositories, {
      now: () => NOW,
      today: () => TODAY,
      createId: idSequence(),
    })
  })

  afterEach(() => database.close())

  it("creates settings, period, account and opening atomically without financial operations", async () => {
    expect(await setup.getState()).toMatchObject({
      status: "not_started",
      allowedPeriodKeys: ["2026-08", "2026-07"],
    })

    const result = await setup.completeSetup({
      periodKey: "2026-08",
      salaryReferenceAmount: 900_000,
      plannedSalaryAmount: 900_000,
      accounts: [{ name: "Principal", bank: "Banco", openingBalance: 100_000 }],
    })

    expect(result.accounts[0]).toMatchObject({
      openingBalance: 100_000,
      currentBalance: 100_000,
      status: "active",
    })
    expect(result.periodOpenings[0]).toMatchObject({
      targetId: result.accounts[0]?.id,
      openingAmount: 100_000,
    })
    expect(await repositories.operations.count()).toBe(0)
    expect(await repositories.movements.count()).toBe(0)
    expect(await repositories.auditEvents.count()).toBe(3)
    expect((await setup.getState()).status).toBe("completed")

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
      plannedSalaryAmount: 0,
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

  it("rejects a future period without writes", async () => {
    await expect(setup.completeSetup({
      periodKey: "2026-09",
      salaryReferenceAmount: 0,
      plannedSalaryAmount: 0,
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
    })

    await expect(failingSetup.completeSetup({
      periodKey: "2026-08",
      salaryReferenceAmount: 0,
      plannedSalaryAmount: 0,
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
  })
})

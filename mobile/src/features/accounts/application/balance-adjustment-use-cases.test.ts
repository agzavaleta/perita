import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Account } from "@/domain/entities"
import type { Period, PeriodOpening } from "@/domain/periods"
import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asPeriodKey,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import { openPeritaDatabase, type PeritaDatabase } from "@/data/database"
import { createRepositories, type PeritaRepositories } from "@/data/repositories"
import { BalanceAdjustmentUseCases } from "@/features/accounts/application/balance-adjustment-use-cases"

const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")
const TODAY = asCivilDate("2026-08-21")
const PERIOD_ID = asEntityId("54000000-0000-4000-8000-000000000001")
const ACCOUNT_ID = asEntityId("54000000-0000-4000-8000-000000000002")

const period: Period = {
  id: PERIOD_ID,
  periodKey: asPeriodKey("2026-08"),
  plannedSalaryAmount: asClpAmount(0),
  variableExpenseBudgetAmount: asClpAmount(0),
  openedAt: NOW,
  status: "open",
  closedAt: null,
  snapshotId: null,
  revision: asRevision(1),
}
const account: Account = {
  id: ACCOUNT_ID,
  emoji: "💳",
  name: "Principal",
  bank: null,
  openingBalance: asClpAmount(100_000),
  currentBalance: asClpAmount(100_000),
  status: "active",
  deletedAt: null,
  balanceAtDeletion: null,
  revision: asRevision(1),
  createdAt: NOW,
  updatedAt: NOW,
}
const opening: PeriodOpening = {
  id: asEntityId("54000000-0000-4000-8000-000000000003"),
  periodId: PERIOD_ID,
  targetType: "account",
  targetId: ACCOUNT_ID,
  openingAmount: asClpAmount(100_000),
}

describe("BalanceAdjustmentUseCases", () => {
  let database: PeritaDatabase
  let repositories: PeritaRepositories
  let adjustments: BalanceAdjustmentUseCases

  beforeEach(async () => {
    database = await openPeritaDatabase({
      name: `adjustment-${crypto.randomUUID()}`,
      indexedDB: new IDBFactory(),
    })
    repositories = createRepositories(database)
    await repositories.periods.add(period)
    await repositories.accounts.add(account)
    await repositories.periodOpenings.add(opening)
    let id = 100
    adjustments = new BalanceAdjustmentUseCases(repositories, {
      now: () => NOW,
      today: () => TODAY,
      createId: () => asEntityId(
        `54000000-0000-4000-8000-${String(id++).padStart(12, "0")}`,
      ),
    })
  })

  afterEach(() => database.close())

  it("records a post-setup correction as a traceable operation and preserves opening", async () => {
    const result = await adjustments.createAdjustment({
      accountId: ACCOUNT_ID,
      expectedAccountRevision: account.revision,
      operationDate: TODAY,
      targetBalance: 135_000,
      reason: "Conciliar con banco",
    })

    expect(result.account).toMatchObject({
      openingBalance: 100_000,
      currentBalance: 135_000,
      revision: 2,
    })
    expect(result.operation).toMatchObject({
      type: "balance_adjustment",
      amount: 35_000,
      details: { accountId: ACCOUNT_ID, reason: "Conciliar con banco" },
    })
    expect(result.movement).toMatchObject({
      targetType: "account",
      targetId: ACCOUNT_ID,
      delta: 35_000,
    })
    expect((await repositories.periodOpenings.get(opening.id))?.openingAmount).toBe(100_000)
    expect(await repositories.auditEvents.count()).toBe(0)
  })

  it("rejects a direct negative correction after setup without partial writes", async () => {
    await expect(adjustments.createAdjustment({
      accountId: ACCOUNT_ID,
      expectedAccountRevision: account.revision,
      operationDate: TODAY,
      targetBalance: -1,
      reason: "No permitido",
    })).rejects.toMatchObject({ code: "invalid_amount" })
    expect(await repositories.operations.count()).toBe(0)
    expect((await repositories.accounts.get(ACCOUNT_ID))?.currentBalance).toBe(100_000)
  })
})

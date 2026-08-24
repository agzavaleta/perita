import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type {
  Account,
  FinancialSettings,
  FixedExpenseInstance,
  FixedExpenseTemplate,
} from "@/domain/entities"
import type { Period, PeriodOpening } from "@/domain/periods"
import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asPeriodKey,
  asPositiveClpAmount,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import { openPeritaDatabase, type PeritaDatabase } from "@/data/database"
import { createRepositories, type PeritaRepositories } from "@/data/repositories"
import {
  MonthlyCloseUseCases,
} from "@/features/planning/application/monthly-close-use-cases"
import { MovementUseCases } from "@/features/movements/application/movement-use-cases"
import { sha256 } from "@/lib/integrity"

const NOW = asUtcTimestamp("2026-08-31T22:00:00.000Z")
const TODAY = asCivilDate("2026-08-31")
const PERIOD_ID = asEntityId("80000000-0000-4000-8000-000000000001")
const ACCOUNT_ID = asEntityId("80000000-0000-4000-8000-000000000002")
const TEMPLATE_ID = asEntityId("80000000-0000-4000-8000-000000000003")
const INSTANCE_ID = asEntityId("80000000-0000-4000-8000-000000000004")
const OPENING_ID = asEntityId("80000000-0000-4000-8000-000000000005")

function settings(): FinancialSettings {
  return {
    key: "current",
    salaryReferenceAmount: asClpAmount(900_000),
    currency: "CLP",
    timezone: "America/Santiago",
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function period(
  plannedSalaryAmount = 0,
  variableExpenseBudgetAmount = 0,
): Period {
  return {
    id: PERIOD_ID,
    periodKey: asPeriodKey("2026-08"),
    plannedSalaryAmount: asClpAmount(plannedSalaryAmount),
    variableExpenseBudgetAmount: asClpAmount(variableExpenseBudgetAmount),
    openedAt: NOW,
    status: "open",
    closedAt: null,
    snapshotId: null,
    revision: asRevision(1),
  }
}

function account(): Account {
  return {
    id: ACCOUNT_ID,
    emoji: "💳",
    name: "Principal",
    bank: null,
    openingBalance: asClpAmount(100_000),
    currentBalance: asClpAmount(100_000),
    status: "active",
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function template(): FixedExpenseTemplate {
  return {
    id: TEMPLATE_ID,
    name: "Internet",
    referenceAmount: asPositiveClpAmount(25_000),
    status: "active",
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function instance(): FixedExpenseInstance {
  return {
    id: INSTANCE_ID,
    periodId: PERIOD_ID,
    templateId: TEMPLATE_ID,
    nameSnapshot: "Internet",
    plannedAmount: asPositiveClpAmount(25_000),
    status: "pending",
    activePaymentOperationId: null,
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function opening(): PeriodOpening {
  return {
    id: OPENING_ID,
    periodId: PERIOD_ID,
    targetType: "account",
    targetId: ACCOUNT_ID,
    openingAmount: asClpAmount(100_000),
  }
}

function idSequence() {
  let value = 100
  return () => asEntityId(
    `80000000-0000-4000-8000-${String(value++).padStart(12, "0")}`,
  )
}

describe("MonthlyCloseUseCases", () => {
  let database: PeritaDatabase
  let repositories: PeritaRepositories

  beforeEach(async () => {
    database = await openPeritaDatabase({
      name: `monthly-close-${crypto.randomUUID()}`,
      indexedDB: new IDBFactory(),
    })
    repositories = createRepositories(database)
    await repositories.financialSettings.add(settings())
    await repositories.periods.add(period())
    await repositories.accounts.add(account())
    await repositories.periodOpenings.add(opening())
    await repositories.fixedExpenseTemplates.add(template())
    await repositories.fixedExpenseInstances.add(instance())
  })

  afterEach(() => database.close())

  function useCases(hash = sha256) {
    return new MonthlyCloseUseCases(repositories, {
      now: () => NOW,
      createId: idSequence(),
      hash,
    })
  }

  it("closes atomically, snapshots the month and opens the exact continuation", async () => {
    await repositories.periods.put(period(0, 250_000))
    const result = await useCases().closeCurrentPeriod()
    expect(result.closedPeriod).toMatchObject({
      periodKey: "2026-08",
      status: "closed",
      revision: 2,
    })
    expect(result.nextPeriod).toMatchObject({
      periodKey: "2026-09",
      plannedSalaryAmount: 900_000,
      variableExpenseBudgetAmount: 0,
      status: "open",
      revision: 1,
    })
    expect(result.snapshot.data.periodPlan).toEqual({
      plannedSalaryAmount: 0,
      variableExpenseBudgetAmount: 250_000,
    })
    expect(result.snapshot.integrity.payloadHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.snapshot.data.fixedExpenses[0]).toMatchObject({
      status: "unpaid",
      revision: 2,
    })
    expect(await repositories.periods.listByStatus("open")).toHaveLength(1)
    expect(await repositories.periodOpenings.listByPeriod(result.nextPeriod.id)).toEqual([
      expect.objectContaining({
        targetType: "account",
        targetId: ACCOUNT_ID,
        openingAmount: 100_000,
      }),
    ])
    const nextInstances = await repositories.fixedExpenseInstances.listByPeriod(
      result.nextPeriod.id,
    )
    expect(nextInstances).toEqual([
      expect.objectContaining({
        templateId: TEMPLATE_ID,
        plannedAmount: 25_000,
        status: "pending",
      }),
    ])
  })

  it("blocks planned salary without receipt and leaves every close store unchanged", async () => {
    await repositories.periods.put(period(900_000))
    await expect(useCases().closeCurrentPeriod()).rejects.toMatchObject({
      code: "salary_not_received",
    })
    expect(await repositories.periods.getAll()).toEqual([period(900_000)])
    expect(await repositories.periodSnapshots.count()).toBe(0)
    expect(await repositories.fixedExpenseInstances.get(INSTANCE_ID)).toMatchObject({
      status: "pending",
      revision: 1,
    })
  })

  it("blocks a duplicate following Period before any close write", async () => {
    await repositories.periods.add({
      id: asEntityId("80000000-0000-4000-8000-000000000099"),
      periodKey: asPeriodKey("2026-09"),
      plannedSalaryAmount: asClpAmount(0),
      variableExpenseBudgetAmount: asClpAmount(0),
      openedAt: NOW,
      status: "closed",
      closedAt: NOW,
      snapshotId: asEntityId("80000000-0000-4000-8000-000000000098"),
      revision: asRevision(2),
    })
    const close = useCases()
    expect((await close.getClosePreview()).blockers).toContain(
      "El período siguiente ya existe.",
    )
    await expect(close.closeCurrentPeriod()).rejects.toMatchObject({
      code: "next_period_exists",
    })
    expect(await repositories.periodSnapshots.count()).toBe(0)
    expect(await repositories.periods.listByStatus("open")).toEqual([period()])
  })

  it("detects concurrent changes before commit and never leaves a partial close", async () => {
    const concurrentHash = async (value: string) => {
      const current = await repositories.financialSettings.get("current")
      if (!current) throw new Error("fixture settings missing")
      await repositories.financialSettings.put({
        ...current,
        salaryReferenceAmount: asClpAmount(950_000),
        revision: asRevision(2),
      })
      return sha256(value)
    }
    await expect(useCases(concurrentHash).closeCurrentPeriod()).rejects.toMatchObject({
      code: "revision_conflict",
    })
    expect(await repositories.periods.listByStatus("open")).toEqual([period()])
    expect(await repositories.periodSnapshots.count()).toBe(0)
    expect(await repositories.fixedExpenseInstances.get(INSTANCE_ID)).toMatchObject({
      status: "pending",
    })
  })

  it("serves immutable historical snapshots and rejects corrupted archives", async () => {
    const close = useCases()
    const result = await close.closeCurrentPeriod()
    const live = await repositories.accounts.get(ACCOUNT_ID)
    if (!live) throw new Error("fixture account missing")
    await repositories.accounts.put({
      ...live,
      name: "Nombre actual",
      revision: asRevision(2),
    })
    const history = await close.getMonthlyHistoryDetail(asPeriodKey("2026-08"))
    expect(history.data.entitySnapshots.accounts[0]?.name).toBe("Principal")
    expect((await close.listMonthlyHistory())[0]).toMatchObject({
      periodKey: "2026-08",
      totals: { fixedExpenseUnpaidAmount: 25_000 },
    })

    await repositories.periodSnapshots.put({
      ...result.snapshot,
      data: {
        ...result.snapshot.data,
        totals: {
          ...result.snapshot.data.totals,
          availableAmount: asClpAmount(1),
        },
      },
    })
    await expect(
      close.getMonthlyHistoryDetail(asPeriodKey("2026-08")),
    ).rejects.toMatchObject({ code: "snapshot_integrity" })
  })

  it("prevents editing an operation archived in a closed Period", async () => {
    const movements = new MovementUseCases(repositories, {
      now: () => NOW,
      today: () => TODAY,
      createId: idSequence(),
    })
    const created = await movements.registerIncome({
      incomeType: "additional",
      accountId: ACCOUNT_ID,
      operationDate: TODAY,
      amount: 10_000,
      concept: "Extra",
    })
    const archived = await useCases().closeCurrentPeriod()
    expect(archived.snapshot.data.totals).toMatchObject({
      additionalIncomeAmount: 10_000,
      totalIncomeAmount: 10_000,
      availableAmount: 10_000,
    })
    await expect(
      movements.editMovement({
        operationId: created.operation.id,
        expectedRevision: created.operation.revision,
        accountId: ACCOUNT_ID,
        operationDate: TODAY,
        amount: 20_000,
        concept: "Editado",
      }),
    ).rejects.toThrow(/active open Period/)
  })
})

import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Account } from "@/domain/entities"
import type { Period } from "@/domain/periods"
import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asPeriodKey,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import { openPeritaDatabase, type PeritaDatabase } from "@/data/database"
import {
  createRepositories,
  type PeritaRepositories,
} from "@/data/repositories"
import { MovementUseCases } from "@/features/movements/application/movement-use-cases"
import {
  PlanningUseCases,
  savingsGoalProgressPercent,
} from "@/features/planning/application/planning-use-cases"

const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")
const TODAY = asCivilDate("2026-08-21")
const PERIOD_ID = asEntityId("50000000-0000-4000-8000-000000000001")
const ACCOUNT_ID = asEntityId("50000000-0000-4000-8000-000000000002")

function period(): Period {
  return {
    id: PERIOD_ID,
    periodKey: asPeriodKey("2026-08"),
    plannedSalaryAmount: asClpAmount(900_000),
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
    name: "Cuenta principal",
    bank: null,
    openingBalance: asClpAmount(200_000),
    currentBalance: asClpAmount(200_000),
    status: "active",
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function idSequence() {
  let value = 100
  return () =>
    asEntityId(
      `50000000-0000-4000-8000-${String(value++).padStart(12, "0")}`,
    )
}

describe("PlanningUseCases", () => {
  let database: PeritaDatabase
  let repositories: PeritaRepositories
  let planning: PlanningUseCases
  let movements: MovementUseCases

  beforeEach(async () => {
    database = await openPeritaDatabase({
      name: `planning-${crypto.randomUUID()}`,
      indexedDB: new IDBFactory(),
    })
    repositories = createRepositories(database)
    await repositories.periods.add(period())
    await repositories.accounts.add(account())
    const createId = idSequence()
    planning = new PlanningUseCases(repositories, {
      now: () => NOW,
      createId,
    })
    movements = new MovementUseCases(repositories, {
      now: () => NOW,
      today: () => TODAY,
      createId,
    })
  })

  afterEach(() => database.close())

  it("creates a zero-balance goal with opening and audit, then derives progress from transfers", async () => {
    const goal = await planning.createSavingsGoal({
      name: "Viaje",
      bank: "BancoEstado",
      targetAmount: 100_000,
      plannedMonthlyAmount: 20_000,
    })
    expect(goal).toMatchObject({
      openingBalance: 0,
      currentBalance: 0,
      lifecycleStatus: "active",
      progressStatus: "in_progress",
      revision: 1,
    })
    expect(await repositories.periodOpenings.listByPeriod(PERIOD_ID)).toEqual([
      expect.objectContaining({
        targetType: "savings_goal",
        targetId: goal.id,
        openingAmount: 0,
      }),
    ])

    await movements.registerTransfer({
      sourceType: "account",
      sourceId: ACCOUNT_ID,
      destinationType: "savings_goal",
      destinationId: goal.id,
      operationDate: TODAY,
      amount: 100_000,
      concept: "Aporte",
    })
    const detail = await planning.getSavingsGoalDetail(goal.id)
    expect(detail.goal.progressStatus).toBe("completed")
    expect(savingsGoalProgressPercent(detail.goal)).toBe(100)
    expect(detail.relatedMovements).toHaveLength(1)

    const edited = await planning.editSavingsGoal({
      goalId: detail.goal.id,
      expectedRevision: detail.goal.revision,
      name: "Gran viaje",
      bank: null,
      targetAmount: 200_000,
      plannedMonthlyAmount: 25_000,
    })
    expect(edited).toMatchObject({
      name: "Gran viaje",
      currentBalance: 100_000,
      progressStatus: "in_progress",
    })
    expect(savingsGoalProgressPercent(edited)).toBe(50)
  })

  it("closes only active goals with zero balance and never reopens them", async () => {
    const empty = await planning.createSavingsGoal({
      name: "Reserva",
      targetAmount: 50_000,
      plannedMonthlyAmount: 0,
    })
    const closed = await planning.closeSavingsGoal(empty.id, empty.revision)
    expect(closed).toMatchObject({ lifecycleStatus: "closed", closedAt: NOW })
    await expect(
      planning.editSavingsGoal({
        goalId: closed.id,
        expectedRevision: closed.revision,
        name: "Otra",
        targetAmount: 50_000,
        plannedMonthlyAmount: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_state" })

    const funded = await planning.createSavingsGoal({
      name: "Casa",
      targetAmount: 100_000,
      plannedMonthlyAmount: 10_000,
    })
    await movements.registerTransfer({
      sourceType: "account",
      sourceId: ACCOUNT_ID,
      destinationType: "savings_goal",
      destinationId: funded.id,
      operationDate: TODAY,
      amount: 1,
    })
    const current = await repositories.savingsGoals.get(funded.id)
    if (!current) throw new Error("fixture goal missing")
    await expect(
      planning.closeSavingsGoal(current.id, current.revision),
    ).rejects.toMatchObject({ code: "nonzero_balance" })
  })

  it("creates fixed information with one pending instance and no financial operation", async () => {
    const item = await planning.createFixedExpense({
      name: "Arriendo",
      referenceAmount: 450_000,
    })
    expect(item.template).toMatchObject({ status: "active", revision: 1 })
    expect(item.currentInstance).toMatchObject({
      periodId: PERIOD_ID,
      templateId: item.template.id,
      nameSnapshot: "Arriendo",
      plannedAmount: 450_000,
      status: "pending",
      activePaymentOperationId: null,
      revision: 1,
    })
    expect(await repositories.fixedExpenseInstances.count()).toBe(1)
    expect(await repositories.operations.count()).toBe(0)
    expect(await repositories.movements.count()).toBe(0)
    expect(await repositories.auditEvents.count()).toBe(2)
  })

  it("edits template reference and current planning independently", async () => {
    const created = await planning.createFixedExpense({
      name: "Internet",
      referenceAmount: 30_000,
    })
    const instanceBefore = created.currentInstance
    if (!instanceBefore) throw new Error("fixture instance missing")
    const edited = await planning.editFixedExpense({
      templateId: created.template.id,
      expectedRevision: created.template.revision,
      name: "Fibra",
      referenceAmount: 35_000,
    })
    expect(edited.template).toMatchObject({
      name: "Fibra",
      referenceAmount: 35_000,
      revision: 2,
    })
    expect(edited.currentInstance).toEqual(instanceBefore)

    const instance = await planning.updateCurrentPlannedAmount(
      instanceBefore.id,
      instanceBefore.revision,
      32_000,
    )
    expect(instance).toMatchObject({ plannedAmount: 32_000, revision: 2 })
    expect(
      (await repositories.fixedExpenseTemplates.get(created.template.id))
        ?.referenceAmount,
    ).toBe(35_000)
    expect(await repositories.operations.count()).toBe(0)
  })

  it("deactivates a template without changing its current instance", async () => {
    const created = await planning.createFixedExpense({
      name: "Seguro",
      referenceAmount: 25_000,
    })
    const instanceBefore = created.currentInstance
    const deactivated = await planning.deactivateFixedExpense(
      created.template.id,
      created.template.revision,
    )
    expect(deactivated.template.status).toBe("inactive")
    expect(deactivated.currentInstance).toEqual(instanceBefore)
    await expect(
      planning.editFixedExpense({
        templateId: deactivated.template.id,
        expectedRevision: deactivated.template.revision,
        name: "Seguro editado",
        referenceAmount: 25_000,
      }),
    ).rejects.toMatchObject({ code: "invalid_state" })
    await expect(
      planning.deactivateFixedExpense(
        deactivated.template.id,
        deactivated.template.revision,
      ),
    ).rejects.toMatchObject({ code: "invalid_state" })
  })
})

import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Account } from "@/domain/entities"
import type { Period } from "@/domain/periods"
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
    variableExpenseBudgetAmount: asClpAmount(0),
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
    name: "Cuenta principal",
    bank: null,
    openingBalance: asClpAmount(200_000),
    currentBalance: asClpAmount(200_000),
    status: "active",
    deletedAt: null,
    balanceAtDeletion: null,
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
      today: () => TODAY,
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
      emoji: "✈️",
      name: "Viaje",
      bank: "BancoEstado",
      targetAmount: 100_000,
      currentBalance: 0,
      plannedMonthlyAmount: 20_000,
    })
    expect(goal).toMatchObject({
      emoji: "✈️",
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
    expect(await repositories.operations.count()).toBe(0)
    expect(await repositories.movements.count()).toBe(0)

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
      emoji: "🌍",
      name: "Gran viaje",
      bank: null,
      targetAmount: 200_000,
      plannedMonthlyAmount: 25_000,
    })
    expect(edited).toMatchObject({
      emoji: "🌍",
      name: "Gran viaje",
      currentBalance: 100_000,
      progressStatus: "in_progress",
    })
    expect(savingsGoalProgressPercent(edited)).toBe(50)
  })

  it("creates a goal with prior savings as an atomic adjustment and zero opening", async () => {
    const accountBefore = await repositories.accounts.get(ACCOUNT_ID)
    const goal = await planning.createSavingsGoal({
      name: "Pie vivienda",
      targetAmount: 1_000_000,
      currentBalance: 400_000,
      plannedMonthlyAmount: 50_000,
    })

    expect(goal).toMatchObject({
      openingBalance: 0,
      currentBalance: 400_000,
      plannedMonthlyAmount: 50_000,
      progressStatus: "in_progress",
    })
    expect(await repositories.periodOpenings.listByPeriod(PERIOD_ID)).toEqual([
      expect.objectContaining({
        targetType: "savings_goal",
        targetId: goal.id,
        openingAmount: 0,
      }),
    ])
    expect(await repositories.operations.getAll()).toEqual([
      expect.objectContaining({
        type: "balance_adjustment",
        amount: 400_000,
        details: {
          goalId: goal.id,
          reason: "Saldo inicial informado al crear meta",
        },
      }),
    ])
    expect(await repositories.movements.getAll()).toEqual([
      expect.objectContaining({
        targetType: "savings_goal",
        targetId: goal.id,
        delta: 400_000,
      }),
    ])
    expect(await repositories.operations.listByType(PERIOD_ID, "savings_deposit"))
      .toHaveLength(0)
    expect(await repositories.accounts.get(ACCOUNT_ID)).toEqual(accountBefore)
  })

  it("marks a newly informed balance above its target as completed", async () => {
    const goal = await planning.createSavingsGoal({
      name: "Notebook",
      targetAmount: 300_000,
      currentBalance: 400_000,
      plannedMonthlyAmount: 0,
    })

    expect(goal).toMatchObject({
      currentBalance: 400_000,
      progressStatus: "completed",
    })
  })

  it("records signed adjustments when editing a goal balance", async () => {
    const increaseGoal = await planning.createSavingsGoal({
      name: "Aumento",
      targetAmount: 1_000_000,
      currentBalance: 400_000,
      plannedMonthlyAmount: 0,
    })
    const increased = await planning.editSavingsGoal({
      goalId: increaseGoal.id,
      expectedRevision: increaseGoal.revision,
      name: increaseGoal.name,
      bank: increaseGoal.bank,
      emoji: increaseGoal.emoji,
      targetAmount: increaseGoal.targetAmount,
      currentBalance: 500_000,
      plannedMonthlyAmount: increaseGoal.plannedMonthlyAmount,
      balanceAdjustmentReason: "Conciliación al alza",
    })
    expect(increased.currentBalance).toBe(500_000)

    const decreaseGoal = await planning.createSavingsGoal({
      name: "Disminución",
      targetAmount: 1_000_000,
      currentBalance: 400_000,
      plannedMonthlyAmount: 0,
    })
    const decreased = await planning.editSavingsGoal({
      goalId: decreaseGoal.id,
      expectedRevision: decreaseGoal.revision,
      name: decreaseGoal.name,
      bank: decreaseGoal.bank,
      emoji: decreaseGoal.emoji,
      targetAmount: decreaseGoal.targetAmount,
      currentBalance: 300_000,
      plannedMonthlyAmount: decreaseGoal.plannedMonthlyAmount,
      balanceAdjustmentReason: "Conciliación a la baja",
    })
    expect(decreased.currentBalance).toBe(300_000)

    const movements = await repositories.movements.getAll()
    expect(movements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetId: increaseGoal.id, delta: 100_000 }),
        expect.objectContaining({ targetId: decreaseGoal.id, delta: -100_000 }),
      ]),
    )
  })

  it("does not create an adjustment for metadata-only edits and requires a reason for balance changes", async () => {
    const goal = await planning.createSavingsGoal({
      name: "Reserva",
      targetAmount: 1_000_000,
      currentBalance: 400_000,
      plannedMonthlyAmount: 25_000,
    })
    const operationCount = await repositories.operations.count()
    const edited = await planning.editSavingsGoal({
      goalId: goal.id,
      expectedRevision: goal.revision,
      name: "Reserva familiar",
      bank: goal.bank,
      emoji: goal.emoji,
      targetAmount: goal.targetAmount,
      currentBalance: goal.currentBalance,
      plannedMonthlyAmount: goal.plannedMonthlyAmount,
    })
    expect(edited.name).toBe("Reserva familiar")
    expect(await repositories.operations.count()).toBe(operationCount)

    await expect(
      planning.editSavingsGoal({
        goalId: edited.id,
        expectedRevision: edited.revision,
        name: edited.name,
        bank: edited.bank,
        emoji: edited.emoji,
        targetAmount: edited.targetAmount,
        currentBalance: 500_000,
        plannedMonthlyAmount: edited.plannedMonthlyAmount,
      }),
    ).rejects.toMatchObject({ code: "invalid_reason" })
    expect((await repositories.savingsGoals.get(goal.id))?.currentBalance).toBe(
      400_000,
    )
    expect(await repositories.operations.count()).toBe(operationCount)
  })

  it("rolls back the entire goal creation when its adjustment cannot be persisted", async () => {
    const collidingOperationId = asEntityId(
      "50000000-0000-4000-8000-000000000101",
    )
    await repositories.operations.add({
      id: collidingOperationId,
      periodId: PERIOD_ID,
      type: "balance_adjustment",
      operationDate: TODAY,
      amount: asPositiveClpAmount(1),
      details: { accountId: ACCOUNT_ID, reason: "Colisión controlada" },
      status: "posted",
      voidedAt: null,
      voidReason: null,
      revision: asRevision(1),
      createdAt: NOW,
      updatedAt: NOW,
    })

    await expect(
      planning.createSavingsGoal({
        name: "No debe persistir",
        targetAmount: 1_000_000,
        currentBalance: 400_000,
        plannedMonthlyAmount: 0,
      }),
    ).rejects.toThrow()

    expect(await repositories.savingsGoals.count()).toBe(0)
    expect(await repositories.periodOpenings.count()).toBe(0)
    expect(await repositories.movements.count()).toBe(0)
    expect(await repositories.auditEvents.count()).toBe(0)
    expect(await repositories.operations.count()).toBe(1)
    expect((await repositories.accounts.get(ACCOUNT_ID))?.currentBalance).toBe(
      200_000,
    )
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

  it("keeps active goals and fixed expenses before their closed or inactive peers", async () => {
    const closedGoal = await planning.createSavingsGoal({
      name: "Abeja cerrada",
      targetAmount: 10_000,
      plannedMonthlyAmount: 0,
    })
    await planning.createSavingsGoal({
      name: "Zeta vigente",
      targetAmount: 10_000,
      plannedMonthlyAmount: 0,
    })
    await planning.createSavingsGoal({
      name: "Alfa vigente",
      targetAmount: 10_000,
      plannedMonthlyAmount: 0,
    })
    await planning.closeSavingsGoal(closedGoal.id, closedGoal.revision)

    const inactiveFixed = await planning.createFixedExpense({
      name: "Abeja inactiva",
      referenceAmount: 1_000,
    })
    await planning.createFixedExpense({ name: "Zeta vigente", referenceAmount: 1_000 })
    await planning.createFixedExpense({ name: "Alfa vigente", referenceAmount: 1_000 })
    await planning.deactivateFixedExpense(
      inactiveFixed.template.id,
      inactiveFixed.template.revision,
    )

    expect((await planning.listSavingsGoals()).map(({ name }) => name)).toEqual([
      "Alfa vigente",
      "Zeta vigente",
      "Abeja cerrada",
    ])
    expect((await planning.listFixedExpenses()).map(({ template }) => template.name))
      .toEqual(["Alfa vigente", "Zeta vigente", "Abeja inactiva"])
  })

  it("deletes a never-used zero-balance goal with its current opening and audits", async () => {
    const goal = await planning.createSavingsGoal({
      name: "Temporal",
      targetAmount: 100_000,
      plannedMonthlyAmount: 0,
    })

    expect((await planning.getSavingsGoalDetail(goal.id)).canDelete).toBe(true)
    await planning.deleteSavingsGoal(goal.id, goal.revision)

    expect(await repositories.savingsGoals.get(goal.id)).toBeUndefined()
    expect((await repositories.periodOpenings.getAll()).some(({ targetId }) => targetId === goal.id)).toBe(false)
    expect(await repositories.auditEvents.listBySubject("savings_goal", goal.id)).toEqual([])
  })

  it("keeps a goal that returned to zero after activity and blocks historical openings", async () => {
    const used = await planning.createSavingsGoal({
      name: "Usada",
      targetAmount: 100_000,
      plannedMonthlyAmount: 0,
    })
    await movements.registerSavingsDeposit({ goalId: used.id, operationDate: TODAY, amount: 10_000 })
    const afterDeposit = await repositories.savingsGoals.get(used.id)
    if (!afterDeposit) throw new Error("fixture goal missing")
    await movements.registerSavingsWithdrawal({ goalId: used.id, operationDate: TODAY, amount: 10_000 })
    const atZero = await repositories.savingsGoals.get(used.id)
    if (!atZero) throw new Error("fixture goal missing")
    await expect(planning.deleteSavingsGoal(atZero.id, atZero.revision)).rejects.toMatchObject({ code: "cannot_delete" })

    const historical = await planning.createSavingsGoal({ name: "Histórica", targetAmount: 100_000, plannedMonthlyAmount: 0 })
    await repositories.periodOpenings.add({
      id: asEntityId("50000000-0000-4000-8000-000000009001"),
      periodId: asEntityId("50000000-0000-4000-8000-000000009002"),
      targetType: "savings_goal",
      targetId: historical.id,
      openingAmount: asClpAmount(0),
    })
    await expect(planning.deleteSavingsGoal(historical.id, historical.revision)).rejects.toMatchObject({ code: "cannot_delete" })
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

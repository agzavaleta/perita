import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type {
  Account,
  Category,
  FixedExpenseInstance,
  FixedExpenseTemplate,
  SavingsGoal,
} from "@/domain/entities"
import type { Period } from "@/domain/periods"
import { deriveMonthlySummary } from "@/domain/monthly-close"
import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asNonZeroClpDelta,
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
import { BalanceAdjustmentUseCases } from "@/features/accounts/application/balance-adjustment-use-cases"
import { MovementUseCases } from "@/features/movements/application/movement-use-cases"

const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")
const TODAY = asCivilDate("2026-08-21")
const PERIOD_ID = asEntityId("30000000-0000-4000-8000-000000000001")
const ACCOUNT_A = asEntityId("30000000-0000-4000-8000-000000000002")
const ACCOUNT_B = asEntityId("30000000-0000-4000-8000-000000000003")
const CATEGORY_A = asEntityId("30000000-0000-4000-8000-000000000004")
const CATEGORY_B = asEntityId("30000000-0000-4000-8000-000000000005")
const GOAL_A = asEntityId("30000000-0000-4000-8000-000000000006")
const GOAL_B = asEntityId("30000000-0000-4000-8000-000000000007")
const FIXED_TEMPLATE = asEntityId("30000000-0000-4000-8000-000000000008")
const FIXED_INSTANCE = asEntityId("30000000-0000-4000-8000-000000000009")

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

function account(id: typeof ACCOUNT_A, name: string, balance: number): Account {
  return {
    id,
    emoji: "💳",
    name,
    bank: null,
    openingBalance: asClpAmount(balance),
    currentBalance: asClpAmount(balance),
    status: "active",
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function category(id: typeof CATEGORY_A, name: string): Category {
  return {
    id,
    name,
    status: "active",
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function goal(id: typeof GOAL_A, name: string, balance = 50_000): SavingsGoal {
  return {
    id,
    emoji: "💰",
    name,
    bank: null,
    targetAmount: asPositiveClpAmount(100_000),
    openingBalance: asClpAmount(balance),
    currentBalance: asClpAmount(balance),
    plannedMonthlyAmount: asClpAmount(10_000),
    lifecycleStatus: "active",
    progressStatus: balance >= 100_000 ? "completed" : "in_progress",
    closedAt: null,
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function fixedTemplate(): FixedExpenseTemplate {
  return {
    id: FIXED_TEMPLATE,
    name: "Internet",
    referenceAmount: asPositiveClpAmount(30_000),
    status: "active",
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function fixedInstance(): FixedExpenseInstance {
  return {
    id: FIXED_INSTANCE,
    periodId: PERIOD_ID,
    templateId: FIXED_TEMPLATE,
    nameSnapshot: "Internet",
    plannedAmount: asPositiveClpAmount(30_000),
    status: "pending",
    activePaymentOperationId: null,
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function idSequence() {
  let value = 100
  return () =>
    asEntityId(
      `30000000-0000-4000-8000-${String(value++).padStart(12, "0")}`,
    )
}

describe("MovementUseCases", () => {
  let database: PeritaDatabase
  let repositories: PeritaRepositories
  let useCases: MovementUseCases

  beforeEach(async () => {
    database = await openPeritaDatabase({
      name: `movements-${crypto.randomUUID()}`,
      indexedDB: new IDBFactory(),
    })
    repositories = createRepositories(database)
    await repositories.periods.add(period())
    await repositories.accounts.add(account(ACCOUNT_A, "Cuenta A", 100_000))
    await repositories.accounts.add(account(ACCOUNT_B, "Cuenta B", 50_000))
    await repositories.categories.add(category(CATEGORY_A, "Comida"))
    await repositories.categories.add(category(CATEGORY_B, "Transporte"))
    await repositories.savingsGoals.add(goal(GOAL_A, "Casa"))
    await repositories.savingsGoals.add(goal(GOAL_B, "Viaje"))
    await repositories.fixedExpenseTemplates.add(fixedTemplate())
    await repositories.fixedExpenseInstances.add(fixedInstance())
    useCases = new MovementUseCases(repositories, {
      now: () => NOW,
      today: () => TODAY,
      createId: idSequence(),
    })
  })

  afterEach(() => database.close())

  it("registers income and expense with exact signed movements and account balances", async () => {
    const income = await useCases.registerIncome({
      incomeType: "additional",
      accountId: ACCOUNT_A,
      operationDate: asCivilDate("2026-08-20"),
      amount: 30_000,
      concept: "Venta",
    })
    expect(income.movement.delta).toBe(30_000)
    expect((await repositories.accounts.get(ACCOUNT_A))?.currentBalance).toBe(
      130_000,
    )

    const expense = await useCases.registerExpense({
      accountId: ACCOUNT_A,
      categoryId: CATEGORY_A,
      operationDate: TODAY,
      amount: 20_000,
      concept: "Almuerzo",
    })
    expect(expense.movement.delta).toBe(-20_000)
    expect(expense.operation.details).toMatchObject({
      categoryId: CATEGORY_A,
      categoryName: "Comida",
    })
    expect((await repositories.accounts.get(ACCOUNT_A))?.currentBalance).toBe(
      110_000,
    )
    expect(await repositories.auditEvents.count()).toBe(0)
  })

  it("registers independent deposits and withdrawals without changing accounts", async () => {
    const accountsBefore = await repositories.accounts.getAll()
    const deposit = await useCases.registerSavingsDeposit({
      goalId: GOAL_A,
      operationDate: TODAY,
      amount: 100_000,
      concept: "Ahorro extraordinario",
      observation: "Transferencia externa",
    })
    expect(deposit.operation).toMatchObject({
      type: "savings_deposit",
      amount: 100_000,
      details: {
        goalId: GOAL_A,
        concept: "Ahorro extraordinario",
        observation: "Transferencia externa",
      },
    })
    expect(deposit.movement).toMatchObject({
      targetType: "savings_goal",
      targetId: GOAL_A,
      delta: 100_000,
    })
    expect(deposit.goal).toMatchObject({
      currentBalance: 150_000,
      progressStatus: "completed",
    })

    const withdrawal = await useCases.registerSavingsWithdrawal({
      goalId: GOAL_A,
      operationDate: TODAY,
      amount: 40_000,
      concept: "Uso parcial",
    })
    expect(withdrawal.operation.type).toBe("savings_withdrawal")
    expect(withdrawal.movement.delta).toBe(-40_000)
    expect(withdrawal.goal.currentBalance).toBe(110_000)
    expect(await repositories.accounts.getAll()).toEqual(accountsBefore)
    const listed = await useCases.listMovements()
    expect(listed).toEqual([
      expect.objectContaining({
        operation: expect.objectContaining({ type: "savings_deposit" }),
        kind: "savings",
        title: "Depósito",
        accountName: "Casa",
        signedAmount: 100_000,
        description: "Ahorro extraordinario · Transferencia externa",
      }),
      expect.objectContaining({
        operation: expect.objectContaining({ type: "savings_withdrawal" }),
        kind: "savings",
        title: "Retiro",
        accountName: "Casa",
        signedAmount: -40_000,
      }),
    ])
    expect(await useCases.listMovements({ kind: "savings" })).toHaveLength(2)
    expect(await useCases.listMovements({ kind: "income" })).toEqual([])
    expect(await useCases.listMovements({ kind: "expense" })).toEqual([])
    expect(await useCases.listMovements({ query: "casa" })).toHaveLength(2)
    expect(await useCases.listMovements({ query: "transferencia externa" }))
      .toHaveLength(1)
    expect(await useCases.listMovements({ accountId: ACCOUNT_A })).toEqual([])
    expect(await useCases.getMovementDetail(deposit.operation.id)).toMatchObject({
      kind: "savings",
      title: "Depósito",
      accountName: "Casa",
      signedAmount: 100_000,
      revisions: [],
    })

    const edited = await useCases.editSavingsMovement({
      operationId: deposit.operation.id,
      expectedRevision: deposit.operation.revision,
      operationDate: TODAY,
      amount: 120_000,
      concept: "Ahorro editado",
    })
    expect(
      (await useCases.listMovements({ query: "ahorro editado" }))[0],
    ).toMatchObject({ signedAmount: 120_000 })
    await useCases.voidSavingsMovement({
      operationId: withdrawal.operation.id,
      expectedRevision: withdrawal.operation.revision,
    })
    expect(await useCases.listMovements({ status: "voided" })).toEqual([
      expect.objectContaining({
        operation: expect.objectContaining({
          id: withdrawal.operation.id,
          status: "voided",
        }),
        signedAmount: -40_000,
      }),
    ])
    expect(edited.goal.currentBalance).toBe(130_000)
  })

  it("moves goal progress between completed and in progress", async () => {
    const completed = await useCases.registerSavingsDeposit({
      goalId: GOAL_B,
      operationDate: TODAY,
      amount: 50_000,
    })
    expect(completed.goal.progressStatus).toBe("completed")

    const inProgress = await useCases.registerSavingsWithdrawal({
      goalId: GOAL_B,
      operationDate: TODAY,
      amount: 1,
    })
    expect(inProgress.goal).toMatchObject({
      currentBalance: 99_999,
      progressStatus: "in_progress",
    })
  })

  it("blocks unfunded withdrawals without partial writes", async () => {
    const accountBefore = await repositories.accounts.get(ACCOUNT_A)
    await expect(
      useCases.registerSavingsWithdrawal({
        goalId: GOAL_A,
        operationDate: TODAY,
        amount: 50_001,
      }),
    ).rejects.toMatchObject({
      code: "insufficient_balance",
      message: "El retiro no puede superar el saldo disponible de la meta.",
    })
    expect(await repositories.operations.count()).toBe(0)
    expect(await repositories.movements.count()).toBe(0)
    expect((await repositories.savingsGoals.get(GOAL_A))?.currentBalance).toBe(
      50_000,
    )
    expect(await repositories.accounts.get(ACCOUNT_A)).toEqual(accountBefore)
  })

  it("rejects closed goals and invalid or future dates", async () => {
    const closed = await repositories.savingsGoals.get(GOAL_B)
    if (!closed) throw new Error("fixture goal missing")
    await repositories.savingsGoals.put({
      ...closed,
      lifecycleStatus: "closed",
      currentBalance: asClpAmount(0),
      progressStatus: "in_progress",
      closedAt: NOW,
    })
    await expect(
      useCases.registerSavingsDeposit({
        goalId: GOAL_B,
        operationDate: TODAY,
        amount: 1,
      }),
    ).rejects.toMatchObject({ code: "inactive_savings_goal" })
    for (const operationDate of [
      asCivilDate("2026-07-31"),
      asCivilDate("2026-08-22"),
    ]) {
      await expect(
        useCases.registerSavingsDeposit({
          goalId: GOAL_A,
          operationDate,
          amount: 1,
        }),
      ).rejects.toMatchObject({ code: "invalid_date" })
    }
    expect(await repositories.operations.count()).toBe(0)
    expect(await repositories.movements.count()).toBe(0)
  })

  it("derives monthly savings from deposits and withdrawals while ignoring adjustments", async () => {
    await useCases.registerSavingsDeposit({
      goalId: GOAL_A,
      operationDate: TODAY,
      amount: 100_000,
    })
    await useCases.registerSavingsWithdrawal({
      goalId: GOAL_A,
      operationDate: TODAY,
      amount: 40_000,
    })
    const operations = await repositories.operations.getAll()
    const movements = await repositories.movements.getAll()
    const adjustmentOperation = {
      id: asEntityId("30000000-0000-4000-8000-000000000900"),
      periodId: PERIOD_ID,
      type: "balance_adjustment" as const,
      operationDate: TODAY,
      amount: asPositiveClpAmount(200_000),
      details: { goalId: GOAL_A, reason: "Saldo informado" },
      status: "posted" as const,
      voidedAt: null,
      voidReason: null,
      revision: asRevision(1),
      createdAt: NOW,
      updatedAt: NOW,
    }
    const adjustmentMovement = {
      id: asEntityId("30000000-0000-4000-8000-000000000901"),
      operationId: adjustmentOperation.id,
      periodId: PERIOD_ID,
      targetType: "savings_goal" as const,
      targetId: GOAL_A,
      effectType: "asset_balance" as const,
      delta: asNonZeroClpDelta(200_000),
      status: "posted" as const,
      createdAt: NOW,
      updatedAt: NOW,
    }
    const summary = deriveMonthlySummary({
      period: period(),
      operations: [...operations, adjustmentOperation],
      movements: [...movements, adjustmentMovement],
      fixedExpenseInstances: [],
    })
    expect(summary.netSavingsAmount).toBe(60_000)
    expect(summary.additionalIncomeAmount).toBe(0)
    expect(summary.variableExpenseAmount).toBe(0)
  })

  it("rolls back goal and movement when the savings operation conflicts", async () => {
    const collidingId = asEntityId(
      "30000000-0000-4000-8000-000000000100",
    )
    await repositories.operations.add({
      id: collidingId,
      periodId: PERIOD_ID,
      type: "balance_adjustment",
      operationDate: TODAY,
      amount: asPositiveClpAmount(1),
      details: { accountId: ACCOUNT_A, reason: "Colisión controlada" },
      status: "posted",
      voidedAt: null,
      voidReason: null,
      revision: asRevision(1),
      createdAt: NOW,
      updatedAt: NOW,
    })

    await expect(
      useCases.registerSavingsDeposit({
        goalId: GOAL_A,
        operationDate: TODAY,
        amount: 100_000,
      }),
    ).rejects.toThrow()
    expect((await repositories.savingsGoals.get(GOAL_A))?.currentBalance).toBe(
      50_000,
    )
    expect(await repositories.movements.count()).toBe(0)
    expect(await repositories.operations.count()).toBe(1)
  })

  it("edits a savings deposit by replacing its prior impact and records the revision", async () => {
    const accountsBefore = await repositories.accounts.getAll()
    const created = await useCases.registerSavingsDeposit({
      goalId: GOAL_A,
      operationDate: TODAY,
      amount: 100_000,
      concept: "Ahorro inicial",
    })
    const edited = await useCases.editSavingsMovement({
      operationId: created.operation.id,
      expectedRevision: created.operation.revision,
      operationDate: asCivilDate("2026-08-20"),
      amount: 150_000,
      concept: "Ahorro corregido",
      observation: "Edición",
    })

    expect(edited.operation).toMatchObject({
      type: "savings_deposit",
      revision: 2,
      amount: 150_000,
      operationDate: "2026-08-20",
      details: {
        goalId: GOAL_A,
        concept: "Ahorro corregido",
        observation: "Edición",
      },
      createdAt: created.operation.createdAt,
    })
    expect(edited.movement.delta).toBe(150_000)
    expect(edited.goal.currentBalance).toBe(200_000)
    expect(await repositories.accounts.getAll()).toEqual(accountsBefore)
    expect(
      await repositories.operationRevisions.listByOperation(created.operation.id),
    ).toEqual([
      expect.objectContaining({
        changeType: "edit",
        revisionNumber: 1,
        previousOperation: created.operation,
        previousMovements: [created.movement],
      }),
    ])

    const lowered = await useCases.editSavingsMovement({
      operationId: edited.operation.id,
      expectedRevision: edited.operation.revision,
      operationDate: edited.operation.operationDate,
      amount: 80_000,
      concept: edited.operation.details.concept,
      observation: edited.operation.details.observation,
    })
    expect(lowered.goal.currentBalance).toBe(130_000)
    expect(lowered.movement.delta).toBe(80_000)

    await expect(
      useCases.editSavingsMovement({
        operationId: lowered.operation.id,
        expectedRevision: lowered.operation.revision,
        operationDate: lowered.operation.operationDate,
        amount: lowered.operation.amount,
        concept: lowered.operation.details.concept,
        observation: lowered.operation.details.observation,
      }),
    ).rejects.toMatchObject({ code: "no_changes" })
  })

  it("edits a withdrawal using the final projected balance for larger and smaller amounts", async () => {
    await useCases.registerSavingsDeposit({
      goalId: GOAL_A,
      operationDate: TODAY,
      amount: 100_000,
    })
    const withdrawal = await useCases.registerSavingsWithdrawal({
      goalId: GOAL_A,
      operationDate: TODAY,
      amount: 40_000,
    })
    const larger = await useCases.editSavingsMovement({
      operationId: withdrawal.operation.id,
      expectedRevision: withdrawal.operation.revision,
      operationDate: TODAY,
      amount: 70_000,
    })
    expect(larger.goal.currentBalance).toBe(80_000)
    expect(larger.movement.delta).toBe(-70_000)

    const smaller = await useCases.editSavingsMovement({
      operationId: larger.operation.id,
      expectedRevision: larger.operation.revision,
      operationDate: TODAY,
      amount: 20_000,
    })
    expect(smaller.goal.currentBalance).toBe(130_000)
    expect(smaller.movement.delta).toBe(-20_000)
    await expect(
      useCases.editSavingsMovement({
        operationId: smaller.operation.id,
        expectedRevision: smaller.operation.revision,
        operationDate: TODAY,
        amount: 160_000,
      }),
    ).rejects.toMatchObject({
      code: "insufficient_balance",
      message: expect.stringContaining("$10.000"),
    })
    expect((await repositories.savingsGoals.get(GOAL_A))?.currentBalance).toBe(
      130_000,
    )
  })

  it("voids savings operations atomically and blocks a deposit reversal with an exact shortage", async () => {
    const deposit = await useCases.registerSavingsDeposit({
      goalId: GOAL_A,
      operationDate: TODAY,
      amount: 100_000,
    })
    const withdrawal = await useCases.registerSavingsWithdrawal({
      goalId: GOAL_A,
      operationDate: TODAY,
      amount: 120_000,
    })
    expect(withdrawal.goal.currentBalance).toBe(30_000)

    await expect(
      useCases.voidSavingsMovement({
        operationId: deposit.operation.id,
        expectedRevision: deposit.operation.revision,
      }),
    ).rejects.toMatchObject({
      code: "insufficient_balance",
      message: expect.stringContaining("$70"),
    })
    expect((await repositories.savingsGoals.get(GOAL_A))?.currentBalance).toBe(30_000)
    expect((await repositories.operations.get(deposit.operation.id))?.status).toBe(
      "posted",
    )

    const voided = await useCases.voidSavingsMovement({
      operationId: withdrawal.operation.id,
      expectedRevision: withdrawal.operation.revision,
      reason: "Ya no corresponde",
    })
    expect(voided.goal.currentBalance).toBe(150_000)
    expect(voided.operation).toMatchObject({
      status: "voided",
      revision: 2,
      voidReason: "Ya no corresponde",
    })
    expect(voided.movement).toMatchObject({ status: "voided", delta: -120_000 })
    expect(
      await repositories.operationRevisions.listByOperation(withdrawal.operation.id),
    ).toEqual([expect.objectContaining({ changeType: "void", revisionNumber: 1 })])
    const voidedDeposit = await useCases.voidSavingsMovement({
      operationId: deposit.operation.id,
      expectedRevision: deposit.operation.revision,
    })
    expect(voidedDeposit.goal.currentBalance).toBe(50_000)
    expect(voidedDeposit.movement.status).toBe("voided")
    await expect(
      useCases.voidSavingsMovement({
        operationId: voided.operation.id,
        expectedRevision: voided.operation.revision,
      }),
    ).rejects.toMatchObject({ code: "invalid_operation_state" })
    await expect(
      useCases.editSavingsMovement({
        operationId: voided.operation.id,
        expectedRevision: voided.operation.revision,
        operationDate: TODAY,
        amount: 10_000,
      }),
    ).rejects.toMatchObject({ code: "invalid_operation_state" })
  })

  it("derives monthly savings from the edited posted state and excludes voided savings", async () => {
    const deposit = await useCases.registerSavingsDeposit({
      goalId: GOAL_A,
      operationDate: TODAY,
      amount: 100_000,
    })
    await useCases.editSavingsMovement({
      operationId: deposit.operation.id,
      expectedRevision: deposit.operation.revision,
      operationDate: TODAY,
      amount: 140_000,
    })
    const withdrawal = await useCases.registerSavingsWithdrawal({
      goalId: GOAL_A,
      operationDate: TODAY,
      amount: 40_000,
    })
    await useCases.voidSavingsMovement({
      operationId: withdrawal.operation.id,
      expectedRevision: withdrawal.operation.revision,
    })

    const summary = deriveMonthlySummary({
      period: period(),
      operations: await repositories.operations.getAll(),
      movements: await repositories.movements.getAll(),
      fixedExpenseInstances: [],
    })
    expect(summary.netSavingsAmount).toBe(140_000)
    expect(summary.additionalIncomeAmount).toBe(0)
    expect(summary.variableExpenseAmount).toBe(0)
  })

  it("rejects stale or closed-period savings changes without partial writes", async () => {
    const created = await useCases.registerSavingsDeposit({
      goalId: GOAL_A,
      operationDate: TODAY,
      amount: 10_000,
    })
    await expect(
      useCases.editSavingsMovement({
        operationId: created.operation.id,
        expectedRevision: asRevision(99),
        operationDate: TODAY,
        amount: 20_000,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" })
    expect((await repositories.savingsGoals.get(GOAL_A))?.currentBalance).toBe(60_000)
    await expect(
      useCases.editSavingsMovement({
        operationId: created.operation.id,
        expectedRevision: created.operation.revision,
        operationDate: asCivilDate("2026-08-22"),
        amount: 20_000,
      }),
    ).rejects.toMatchObject({ code: "invalid_date" })

    await repositories.periods.put({
      ...period(),
      status: "closed",
      closedAt: NOW,
      snapshotId: asEntityId("30000000-0000-4000-8000-000000000999"),
    })
    await expect(
      useCases.voidSavingsMovement({
        operationId: created.operation.id,
        expectedRevision: created.operation.revision,
      }),
    ).rejects.toMatchObject({ code: "no_open_period" })
    expect((await repositories.operations.get(created.operation.id))?.status).toBe(
      "posted",
    )
  })

  it("rolls back every B2 record when the atomic savings change conflicts", async () => {
    const created = await useCases.registerSavingsDeposit({
      goalId: GOAL_A,
      operationDate: TODAY,
      amount: 10_000,
    })
    await repositories.savingsGoals.put({
      ...created.goal,
      name: "Cambio concurrente",
      revision: asRevision(3),
    })
    const changedOperation = {
      ...created.operation,
      amount: asPositiveClpAmount(20_000),
      revision: asRevision(2),
    }
    const changedMovement = {
      ...created.movement,
      delta: asNonZeroClpDelta(20_000),
    }

    await expect(
      repositories.operations.commitSavingsGoalMovement({
        kind: "change",
        period: { id: PERIOD_ID, revision: asRevision(1) },
        expectedSavingsGoal: {
          id: GOAL_A,
          revision: created.goal.revision,
        },
        expectedOperation: {
          id: created.operation.id,
          revision: created.operation.revision,
        },
        savingsGoal: {
          ...created.goal,
          currentBalance: asClpAmount(70_000),
          revision: asRevision(3),
        },
        operation: changedOperation,
        movement: changedMovement,
        operationRevision: {
          id: asEntityId("30000000-0000-4000-8000-000000000998"),
          operationId: created.operation.id,
          periodId: PERIOD_ID,
          revisionNumber: created.operation.revision,
          changeType: "edit",
          previousOperation: created.operation,
          previousMovements: [created.movement],
          reason: null,
          createdAt: NOW,
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" })
    expect(await repositories.savingsGoals.get(GOAL_A)).toMatchObject({
      name: "Cambio concurrente",
      currentBalance: 60_000,
      revision: 3,
    })
    expect(await repositories.operations.get(created.operation.id)).toEqual(
      created.operation,
    )
    expect(await repositories.movements.get(created.movement.id)).toEqual(
      created.movement,
    )
    expect(
      await repositories.operationRevisions.listByOperation(created.operation.id),
    ).toEqual([])
  })

  it("rejects a stale savings-goal revision without partial persistence", async () => {
    const storedGoal = await repositories.savingsGoals.get(GOAL_A)
    if (!storedGoal) throw new Error("fixture goal missing")
    await repositories.savingsGoals.put({
      ...storedGoal,
      name: "Cambio concurrente",
      revision: asRevision(2),
    })
    const operationId = asEntityId(
      "30000000-0000-4000-8000-000000000902",
    )
    const movementId = asEntityId(
      "30000000-0000-4000-8000-000000000903",
    )
    await expect(
      repositories.operations.commitSavingsGoalMovement({
        kind: "create",
        period: { id: PERIOD_ID, revision: asRevision(1) },
        expectedSavingsGoal: { id: GOAL_A, revision: asRevision(1) },
        savingsGoal: {
          ...storedGoal,
          currentBalance: asClpAmount(60_000),
          revision: asRevision(2),
        },
        operation: {
          id: operationId,
          periodId: PERIOD_ID,
          type: "savings_deposit",
          operationDate: TODAY,
          amount: asPositiveClpAmount(10_000),
          details: { goalId: GOAL_A, concept: null, observation: null },
          status: "posted",
          voidedAt: null,
          voidReason: null,
          revision: asRevision(1),
          createdAt: NOW,
          updatedAt: NOW,
        },
        movement: {
          id: movementId,
          operationId,
          periodId: PERIOD_ID,
          targetType: "savings_goal",
          targetId: GOAL_A,
          effectType: "asset_balance",
          delta: asNonZeroClpDelta(10_000),
          status: "posted",
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" })
    expect(await repositories.savingsGoals.get(GOAL_A)).toMatchObject({
      name: "Cambio concurrente",
      currentBalance: 50_000,
      revision: 2,
    })
    expect(await repositories.operations.get(operationId)).toBeUndefined()
    expect(await repositories.movements.get(movementId)).toBeUndefined()
  })

  it("allows only one posted salary receipt in the open period", async () => {
    await useCases.registerIncome({
      incomeType: "salary",
      accountId: ACCOUNT_A,
      operationDate: TODAY,
      amount: 900_000,
    })
    await expect(
      useCases.registerIncome({
        incomeType: "salary",
        accountId: ACCOUNT_B,
        operationDate: TODAY,
        amount: 900_000,
      }),
    ).rejects.toMatchObject({ code: "salary_already_posted" })
    expect(
      (await repositories.operations.listByType(PERIOD_ID, "salary_receipt")).filter(
        ({ status }) => status === "posted",
      ),
    ).toHaveLength(1)
  })

  it("edits an income across accounts and preserves its complete prior revision", async () => {
    const created = await useCases.registerIncome({
      incomeType: "additional",
      accountId: ACCOUNT_A,
      operationDate: TODAY,
      amount: 30_000,
      concept: "Venta",
      observation: "Pago presencial",
    })
    const edited = await useCases.editMovement({
      operationId: created.operation.id,
      expectedRevision: created.operation.revision,
      accountId: ACCOUNT_B,
      operationDate: asCivilDate("2026-08-20"),
      amount: 40_000,
    })

    expect(edited.operation).toMatchObject({
      revision: 2,
      amount: 40_000,
      details: { concept: "Venta", observation: "Pago presencial" },
    })
    expect(edited.movement).toMatchObject({ targetId: ACCOUNT_B, delta: 40_000 })
    expect((await repositories.accounts.get(ACCOUNT_A))?.currentBalance).toBe(
      100_000,
    )
    expect((await repositories.accounts.get(ACCOUNT_B))?.currentBalance).toBe(
      90_000,
    )
    expect(
      await repositories.operationRevisions.listByOperation(created.operation.id),
    ).toEqual([
      expect.objectContaining({
        changeType: "edit",
        revisionNumber: 1,
        previousOperation: created.operation,
        previousMovements: [created.movement],
      }),
    ])
  })

  it("voids an expense, restores its balance and retains canonical history", async () => {
    const created = await useCases.registerExpense({
      accountId: ACCOUNT_A,
      categoryId: CATEGORY_A,
      operationDate: TODAY,
      amount: 20_000,
      concept: "Almuerzo",
    })
    const voided = await useCases.voidMovement({
      operationId: created.operation.id,
      expectedRevision: created.operation.revision,
      reason: "Registro duplicado",
    })

    expect(voided.operation).toMatchObject({
      status: "voided",
      revision: 2,
      voidReason: "Registro duplicado",
    })
    expect(voided.movement).toMatchObject({ status: "voided", delta: -20_000 })
    expect((await repositories.accounts.get(ACCOUNT_A))?.currentBalance).toBe(
      100_000,
    )
    expect(
      await repositories.operationRevisions.listByOperation(created.operation.id),
    ).toEqual([expect.objectContaining({ changeType: "void", revisionNumber: 1 })])
  })

  it("pays, edits and voids a fixed expense while keeping its instance linked atomically", async () => {
    const created = await useCases.registerFixedExpensePayment({
      accountId: ACCOUNT_A,
      fixedExpenseInstanceId: FIXED_INSTANCE,
      operationDate: TODAY,
      amount: 30_000,
    })
    expect(created.operation).toMatchObject({
      type: "fixed_expense_payment",
      amount: 30_000,
      status: "posted",
    })
    expect(await repositories.fixedExpenseInstances.get(FIXED_INSTANCE)).toMatchObject({
      status: "paid",
      activePaymentOperationId: created.operation.id,
      revision: 2,
    })
    expect((await repositories.accounts.get(ACCOUNT_A))?.currentBalance).toBe(70_000)

    await expect(
      useCases.registerFixedExpensePayment({
        accountId: ACCOUNT_A,
        fixedExpenseInstanceId: FIXED_INSTANCE,
        operationDate: TODAY,
        amount: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_operation_state" })

    const edited = await useCases.editMovement({
      operationId: created.operation.id,
      expectedRevision: created.operation.revision,
      accountId: ACCOUNT_B,
      operationDate: TODAY,
      amount: 25_000,
    })
    expect((await repositories.accounts.get(ACCOUNT_A))?.currentBalance).toBe(100_000)
    expect((await repositories.accounts.get(ACCOUNT_B))?.currentBalance).toBe(25_000)
    expect(await repositories.fixedExpenseInstances.get(FIXED_INSTANCE)).toMatchObject({
      status: "paid",
      activePaymentOperationId: created.operation.id,
      revision: 2,
    })

    await useCases.voidMovement({
      operationId: edited.operation.id,
      expectedRevision: edited.operation.revision,
      reason: "Pago duplicado",
    })
    expect((await repositories.accounts.get(ACCOUNT_B))?.currentBalance).toBe(50_000)
    expect(await repositories.fixedExpenseInstances.get(FIXED_INSTANCE)).toMatchObject({
      status: "pending",
      activePaymentOperationId: null,
      revision: 3,
    })
    expect(await repositories.operationRevisions.listByOperation(created.operation.id)).toHaveLength(2)
  })

  it("rejects insufficient expenses and reversals without partial writes", async () => {
    await expect(
      useCases.registerExpense({
        accountId: ACCOUNT_A,
        categoryId: CATEGORY_A,
        operationDate: TODAY,
        amount: 100_001,
        concept: "Sin fondos",
      }),
    ).rejects.toMatchObject({ code: "insufficient_balance" })
    expect(await repositories.operations.count()).toBe(0)
    expect((await repositories.accounts.get(ACCOUNT_A))?.currentBalance).toBe(
      100_000,
    )

    const income = await useCases.registerIncome({
      incomeType: "additional",
      accountId: ACCOUNT_A,
      operationDate: TODAY,
      amount: 30_000,
      concept: "Venta",
    })
    const stored = await repositories.accounts.get(ACCOUNT_A)
    if (!stored) throw new Error("fixture account missing")
    await repositories.accounts.put({ ...stored, currentBalance: asClpAmount(10_000) })

    await expect(
      useCases.voidMovement({
        operationId: income.operation.id,
        expectedRevision: income.operation.revision,
      }),
    ).rejects.toMatchObject({ code: "insufficient_balance" })
    expect((await repositories.operations.get(income.operation.id))?.status).toBe(
      "posted",
    )
  })

  it("returns chronological filtered lists by search, kind, account and status", async () => {
    await useCases.registerIncome({
      incomeType: "additional",
      accountId: ACCOUNT_B,
      operationDate: asCivilDate("2026-08-19"),
      amount: 10_000,
      concept: "Reembolso",
    })
    const expense = await useCases.registerExpense({
      accountId: ACCOUNT_A,
      categoryId: CATEGORY_B,
      operationDate: TODAY,
      amount: 5_000,
      concept: "Bus",
    })
    await useCases.registerIncome({
      incomeType: "additional",
      accountId: ACCOUNT_A,
      operationDate: asCivilDate("2026-08-20"),
      amount: 8_000,
      concept: "Venta",
    })
    await useCases.voidMovement({
      operationId: expense.operation.id,
      expectedRevision: expense.operation.revision,
    })

    expect(
      (await useCases.listMovements()).map(({ operation }) =>
        operation.operationDate,
      ),
    ).toEqual(["2026-08-21", "2026-08-20", "2026-08-19"])
    expect((await useCases.listMovements({ query: "transporte" }))).toHaveLength(1)
    expect(
      await useCases.listMovements({ kind: "income", accountId: ACCOUNT_A }),
    ).toHaveLength(1)
    expect(await useCases.listMovements({ status: "voided" })).toEqual([
      expect.objectContaining({ operation: expect.objectContaining({ id: expense.operation.id }) }),
    ])
  })

  it("lists account balance adjustments with their real sign, reason and filters", async () => {
    const adjustmentIds = (() => {
      let value = 900
      return () => asEntityId(
        `30000000-0000-4000-8000-${String(value++).padStart(12, "0")}`,
      )
    })()
    const adjustments = new BalanceAdjustmentUseCases(repositories, {
      now: () => NOW,
      today: () => TODAY,
      createId: adjustmentIds,
    })
    const initial = await repositories.accounts.get(ACCOUNT_A)
    if (!initial) throw new Error("fixture account missing")
    const positive = await adjustments.createAdjustment({
      accountId: ACCOUNT_A,
      expectedAccountRevision: initial.revision,
      operationDate: asCivilDate("2026-08-20"),
      targetBalance: 125_000,
      reason: "Conciliación bancaria",
    })
    const negative = await adjustments.createAdjustment({
      accountId: ACCOUNT_A,
      expectedAccountRevision: positive.account.revision,
      operationDate: TODAY,
      targetBalance: 115_000,
      reason: "Comisión no registrada",
    })

    const listed = await useCases.listMovements()
    expect(listed).toEqual([
      expect.objectContaining({
        operation: expect.objectContaining({ id: negative.operation.id }),
        kind: "adjustment",
        title: "Ajuste de saldo",
        description: "Comisión no registrada",
        accountName: "Cuenta A",
        signedAmount: -10_000,
      }),
      expect.objectContaining({
        operation: expect.objectContaining({ id: positive.operation.id }),
        signedAmount: 25_000,
      }),
    ])
    expect(await useCases.listMovements({ kind: "adjustment" })).toHaveLength(2)
    expect(await useCases.listMovements({ query: "conciliación" })).toHaveLength(1)
    expect(await useCases.listMovements({ query: "cuenta a" })).toHaveLength(2)
    expect(await useCases.listMovements({ query: "ajuste de saldo" })).toHaveLength(2)
    expect(await useCases.listMovements({ accountId: ACCOUNT_B })).toEqual([])
    expect(await useCases.listMovements({ status: "posted" })).toHaveLength(2)
    expect(await useCases.listMovements({ status: "voided" })).toEqual([])
  })

  it("lists and resolves a savings-goal balance adjustment without treating it as an account", async () => {
    const operationId = asEntityId(
      "30000000-0000-4000-8000-000000000950",
    )
    const movementId = asEntityId(
      "30000000-0000-4000-8000-000000000951",
    )
    await repositories.operations.add({
      id: operationId,
      periodId: PERIOD_ID,
      type: "balance_adjustment",
      operationDate: TODAY,
      amount: asPositiveClpAmount(25_000),
      details: { goalId: GOAL_A, reason: "Saldo informado en la meta" },
      status: "posted",
      voidedAt: null,
      voidReason: null,
      revision: asRevision(1),
      createdAt: NOW,
      updatedAt: NOW,
    })
    await repositories.movements.add({
      id: movementId,
      operationId,
      periodId: PERIOD_ID,
      targetType: "savings_goal",
      targetId: GOAL_A,
      effectType: "asset_balance",
      delta: asNonZeroClpDelta(25_000),
      status: "posted",
      createdAt: NOW,
      updatedAt: NOW,
    })

    expect(await useCases.listMovements({ kind: "adjustment" })).toEqual([
      expect.objectContaining({
        kind: "adjustment",
        title: "Ajuste de saldo",
        accountName: "Casa",
        description: "Saldo informado en la meta",
        signedAmount: 25_000,
      }),
    ])
    expect(await useCases.listMovements({ query: "casa" })).toHaveLength(1)
    expect(await useCases.listMovements({ accountId: ACCOUNT_A })).toEqual([])
    expect(await useCases.getMovementDetail(operationId)).toMatchObject({
      kind: "adjustment",
      accountName: "Casa",
      description: "Saldo informado en la meta",
      signedAmount: 25_000,
      revisions: [],
    })
  })

  it("moves money through all four approved endpoint combinations without changing assets", async () => {
    const initialTotal = 250_000
    for (const draft of [
      {
        sourceType: "account" as const,
        sourceId: ACCOUNT_A,
        destinationType: "account" as const,
        destinationId: ACCOUNT_B,
      },
      {
        sourceType: "account" as const,
        sourceId: ACCOUNT_A,
        destinationType: "savings_goal" as const,
        destinationId: GOAL_A,
      },
      {
        sourceType: "savings_goal" as const,
        sourceId: GOAL_A,
        destinationType: "account" as const,
        destinationId: ACCOUNT_A,
      },
      {
        sourceType: "savings_goal" as const,
        sourceId: GOAL_A,
        destinationType: "savings_goal" as const,
        destinationId: GOAL_B,
      },
    ]) {
      const result = await useCases.registerTransfer({
        ...draft,
        operationDate: TODAY,
        amount: 10_000,
      })
      expect(result.kind).toBe("transfer")
      expect(result.movements.map(({ delta }) => delta)).toEqual([
        -10_000,
        10_000,
      ])
      const targets = [
        ...(await repositories.accounts.getAll()),
        ...(await repositories.savingsGoals.getAll()),
      ]
      expect(
        targets.reduce((total, target) => total + target.currentBalance, 0),
      ).toBe(initialTotal)
    }
    expect(await useCases.listMovements({ kind: "transfer" })).toHaveLength(4)
    expect(
      await useCases.listMovements({ kind: "transfer", accountId: ACCOUNT_A }),
    ).toHaveLength(3)
    expect(
      await useCases.listMovements({ kind: "transfer", query: "viaje" }),
    ).toHaveLength(1)
  })

  it("rejects identical, inactive and insufficient endpoints without partial writes", async () => {
    await expect(
      useCases.registerTransfer({
        sourceType: "account",
        sourceId: ACCOUNT_A,
        destinationType: "account",
        destinationId: ACCOUNT_A,
        operationDate: TODAY,
        amount: 1,
      }),
    ).rejects.toMatchObject({ code: "same_transfer_endpoint" })

    const inactive = account(ACCOUNT_B, "Cuenta B", 0)
    await repositories.accounts.put({ ...inactive, status: "inactive" })
    await expect(
      useCases.registerTransfer({
        sourceType: "account",
        sourceId: ACCOUNT_A,
        destinationType: "account",
        destinationId: ACCOUNT_B,
        operationDate: TODAY,
        amount: 1,
      }),
    ).rejects.toMatchObject({ code: "inactive_account" })
    const closedGoal = goal(GOAL_B, "Viaje", 0)
    await repositories.savingsGoals.put({
      ...closedGoal,
      lifecycleStatus: "closed",
      closedAt: NOW,
    })
    await expect(
      useCases.registerTransfer({
        sourceType: "account",
        sourceId: ACCOUNT_A,
        destinationType: "savings_goal",
        destinationId: GOAL_B,
        operationDate: TODAY,
        amount: 1,
      }),
    ).rejects.toMatchObject({ code: "inactive_savings_goal" })
    await expect(
      useCases.registerTransfer({
        sourceType: "savings_goal",
        sourceId: GOAL_A,
        destinationType: "account",
        destinationId: ACCOUNT_A,
        operationDate: TODAY,
        amount: 50_001,
      }),
    ).rejects.toMatchObject({ code: "insufficient_balance" })
    expect(await repositories.operations.count()).toBe(0)
    expect((await repositories.savingsGoals.get(GOAL_A))?.currentBalance).toBe(
      50_000,
    )
    expect((await repositories.accounts.get(ACCOUNT_A))?.currentBalance).toBe(
      100_000,
    )
  })

  it("edits both endpoints atomically and keeps the complete transfer revision", async () => {
    const created = await useCases.registerTransfer({
      sourceType: "account",
      sourceId: ACCOUNT_A,
      destinationType: "savings_goal",
      destinationId: GOAL_B,
      operationDate: TODAY,
      amount: 20_000,
      concept: "Aporte",
    })
    const edited = await useCases.editTransfer({
      operationId: created.operation.id,
      expectedRevision: created.operation.revision,
      sourceType: "savings_goal",
      sourceId: GOAL_A,
      destinationType: "account",
      destinationId: ACCOUNT_B,
      operationDate: asCivilDate("2026-08-20"),
      amount: 30_000,
    })

    expect(edited.operation).toMatchObject({ revision: 2, amount: 30_000 })
    expect((await repositories.accounts.get(ACCOUNT_A))?.currentBalance).toBe(
      100_000,
    )
    expect((await repositories.savingsGoals.get(GOAL_B))?.currentBalance).toBe(
      50_000,
    )
    expect((await repositories.savingsGoals.get(GOAL_A))?.currentBalance).toBe(
      20_000,
    )
    expect((await repositories.accounts.get(ACCOUNT_B))?.currentBalance).toBe(
      80_000,
    )
    expect(
      await repositories.operationRevisions.listByOperation(created.operation.id),
    ).toEqual([
      expect.objectContaining({
        changeType: "edit",
        previousOperation: created.operation,
        previousMovements: created.movements,
      }),
    ])
  })

  it("previews create and edit transfers without persisting and reverses the edited impact", async () => {
    const draft = {
      sourceType: "account" as const,
      sourceId: ACCOUNT_A,
      destinationType: "account" as const,
      destinationId: ACCOUNT_B,
      operationDate: TODAY,
      amount: 20_000,
    }
    const preview = await useCases.previewTransfer(draft)
    expect(preview).toMatchObject({
      source: { name: "Cuenta A", currentBalance: 100_000, resultingBalance: 80_000 },
      destination: { name: "Cuenta B", currentBalance: 50_000, resultingBalance: 70_000 },
      amount: 20_000,
      operationDate: TODAY,
    })
    expect(await repositories.operations.count()).toBe(0)
    expect((await repositories.accounts.get(ACCOUNT_A))?.currentBalance).toBe(100_000)

    const created = await useCases.registerTransfer(draft)
    const editPreview = await useCases.previewTransfer({
      operationId: created.operation.id,
      expectedRevision: created.operation.revision,
      sourceType: "account",
      sourceId: ACCOUNT_B,
      destinationType: "savings_goal",
      destinationId: GOAL_A,
      operationDate: TODAY,
      amount: 30_000,
    })
    expect(editPreview).toMatchObject({
      source: { currentBalance: 70_000, resultingBalance: 20_000 },
      destination: { currentBalance: 50_000, resultingBalance: 80_000 },
    })
    expect((await repositories.accounts.get(ACCOUNT_A))?.currentBalance).toBe(80_000)
    expect((await repositories.accounts.get(ACCOUNT_B))?.currentBalance).toBe(70_000)
    expect(await repositories.operations.count()).toBe(1)
  })

  it("voids both impacts and rejects an unfunded reversal atomically", async () => {
    const created = await useCases.registerTransfer({
      sourceType: "account",
      sourceId: ACCOUNT_A,
      destinationType: "account",
      destinationId: ACCOUNT_B,
      operationDate: TODAY,
      amount: 20_000,
    })
    const voided = await useCases.voidMovement({
      operationId: created.operation.id,
      expectedRevision: created.operation.revision,
    })
    expect(voided.movements.every(({ status }) => status === "voided")).toBe(true)
    expect((await repositories.accounts.get(ACCOUNT_A))?.currentBalance).toBe(
      100_000,
    )
    expect((await repositories.accounts.get(ACCOUNT_B))?.currentBalance).toBe(
      50_000,
    )

    const blocked = await useCases.registerTransfer({
      sourceType: "account",
      sourceId: ACCOUNT_A,
      destinationType: "account",
      destinationId: ACCOUNT_B,
      operationDate: TODAY,
      amount: 30_000,
    })
    await useCases.registerExpense({
      accountId: ACCOUNT_B,
      categoryId: CATEGORY_A,
      operationDate: TODAY,
      amount: 60_000,
      concept: "Consumo posterior",
    })
    await expect(
      useCases.voidMovement({
        operationId: blocked.operation.id,
        expectedRevision: blocked.operation.revision,
      }),
    ).rejects.toMatchObject({ code: "insufficient_balance" })
    expect((await repositories.operations.get(blocked.operation.id))?.status).toBe(
      "posted",
    )
    expect((await repositories.accounts.get(ACCOUNT_A))?.currentBalance).toBe(
      70_000,
    )
    expect((await repositories.accounts.get(ACCOUNT_B))?.currentBalance).toBe(
      20_000,
    )
  })

  it("rolls back target and operation writes when a transfer movement cannot persist", async () => {
    const created = await useCases.registerTransfer({
      sourceType: "account",
      sourceId: ACCOUNT_A,
      destinationType: "savings_goal",
      destinationId: GOAL_A,
      operationDate: TODAY,
      amount: 10_000,
    })
    if (created.operation.type !== "transfer") {
      throw new Error("fixture transfer missing")
    }
    const storedAccount = await repositories.accounts.get(ACCOUNT_A)
    const storedGoal = await repositories.savingsGoals.get(GOAL_A)
    if (!storedAccount || !storedGoal) throw new Error("fixture targets missing")
    const operationId = asEntityId("30000000-0000-4000-8000-000000000008")
    const operation = {
      ...created.operation,
      id: operationId,
      amount: asPositiveClpAmount(5_000),
      revision: asRevision(1),
    }
    const movements = [
      {
        ...created.movements[0],
        operationId,
        delta: asNonZeroClpDelta(-5_000),
      },
      {
        ...created.movements[1],
        id: asEntityId("30000000-0000-4000-8000-000000000009"),
        operationId,
        delta: asNonZeroClpDelta(5_000),
      },
    ]

    await expect(
      repositories.operations.commitTransfer({
        kind: "create",
        period: { id: PERIOD_ID, revision: asRevision(1) },
        expectedAccounts: [
          { id: storedAccount.id, revision: storedAccount.revision },
        ],
        expectedSavingsGoals: [
          { id: storedGoal.id, revision: storedGoal.revision },
        ],
        accounts: [
          {
            ...storedAccount,
            currentBalance: asClpAmount(85_000),
            revision: asRevision(Number(storedAccount.revision) + 1),
          },
        ],
        savingsGoals: [
          {
            ...storedGoal,
            currentBalance: asClpAmount(65_000),
            revision: asRevision(Number(storedGoal.revision) + 1),
          },
        ],
        operation,
        movements,
      }),
    ).rejects.toBeDefined()
    expect((await repositories.accounts.get(ACCOUNT_A))?.currentBalance).toBe(
      90_000,
    )
    expect((await repositories.savingsGoals.get(GOAL_A))?.currentBalance).toBe(
      60_000,
    )
    expect(await repositories.operations.get(operationId)).toBeUndefined()
    expect(await repositories.operations.count()).toBe(1)
  })
})

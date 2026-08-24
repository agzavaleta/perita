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

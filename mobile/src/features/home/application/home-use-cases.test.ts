import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Account, Category, Debt, SavingsGoal } from "@/domain/entities"
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
import { createRepositories, type PeritaRepositories } from "@/data/repositories"
import { deriveDebtProgress } from "@/domain/invariants"
import { HomeUseCases } from "@/features/home/application/home-use-cases"
import { MovementUseCases } from "@/features/movements/application/movement-use-cases"
import { DebtUseCases } from "@/features/planning/application/debt-use-cases"

const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")
const TODAY = asCivilDate("2026-08-21")
const PERIOD_ID = asEntityId("a0000000-0000-4000-8000-000000000001")
const ACCOUNT_ID = asEntityId("a0000000-0000-4000-8000-000000000002")
const GOAL_ID = asEntityId("a0000000-0000-4000-8000-000000000003")
const DEBT_ID = asEntityId("a0000000-0000-4000-8000-000000000004")
const CATEGORY_ID = asEntityId("a0000000-0000-4000-8000-000000000005")

function period(): Period {
  return {
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
}

function account(): Account {
  return {
    id: ACCOUNT_ID,
    emoji: "💳",
    name: "Principal",
    bank: "Banco",
    openingBalance: asClpAmount(100_000),
    currentBalance: asClpAmount(100_000),
    status: "active",
    deletedAt: null,
    balanceAtDeletion: null,
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function goal(overrides: Partial<SavingsGoal> = {}): SavingsGoal {
  return {
    id: GOAL_ID,
    emoji: "💰",
    name: "Viaje",
    bank: null,
    targetAmount: asPositiveClpAmount(100_000),
    openingBalance: asClpAmount(0),
    currentBalance: asClpAmount(0),
    plannedMonthlyAmount: asClpAmount(10_000),
    lifecycleStatus: "active",
    progressStatus: "in_progress",
    closedAt: null,
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function debt(overrides: Partial<Debt> = {}): Debt {
  return {
    id: DEBT_ID,
    name: "Crédito",
    totalAmount: asPositiveClpAmount(100_000),
    openingOutstanding: asClpAmount(100_000),
    outstandingAmount: asClpAmount(100_000),
    dueDate: null,
    monthlyPaymentAmount: asPositiveClpAmount(25_000),
    paymentDay: 31,
    lifecycleStatus: "active",
    paymentStatus: "active",
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function category(): Category {
  return {
    id: CATEGORY_ID,
    name: "Comida",
    status: "active",
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function idSequence() {
  let value = 100
  return () => asEntityId(
    `a0000000-0000-4000-8000-${String(value++).padStart(12, "0")}`,
  )
}

describe("HomeUseCases", () => {
  let database: PeritaDatabase
  let repositories: PeritaRepositories

  beforeEach(async () => {
    database = await openPeritaDatabase({
      name: `home-${crypto.randomUUID()}`,
      indexedDB: new IDBFactory(),
    })
    repositories = createRepositories(database)
    await repositories.periods.add(period())
  })

  afterEach(() => database.close())

  it("returns a canonical zero dashboard for an empty Period", async () => {
    const dashboard = await new HomeUseCases(repositories, {
      today: () => TODAY,
    }).getDashboard()
    expect(dashboard).toMatchObject({
      netWorth: 0,
      totalAccountBalance: 0,
      totalSavingsBalance: 0,
      periodExpenseAmount: 0,
      expenseToIncomePercent: null,
      savingsToIncomePercent: null,
      isEmpty: true,
      accounts: [],
      relevantGoals: [],
      activeDebts: [],
      summary: {
        totalIncomeAmount: 0,
        availableAmount: 0,
      },
    })
  })

  it("excludes deleted accounts from current balances and availability", async () => {
    await repositories.accounts.add({
      ...account(),
      status: "deleted",
      deletedAt: NOW,
      balanceAtDeletion: asClpAmount(100_000),
      revision: asRevision(2),
    })

    const dashboard = await new HomeUseCases(repositories, {
      today: () => TODAY,
    }).getDashboard()

    expect(dashboard).toMatchObject({
      totalAccountBalance: 0,
      netWorth: 0,
      accounts: [],
      isEmpty: true,
      summary: { availableAmount: -100_000 },
    })
  })

  it("adds accounts and savings when there are no pending debts", async () => {
    await repositories.accounts.add(account())
    await repositories.savingsGoals.add(goal({
      openingBalance: asClpAmount(50_000),
      currentBalance: asClpAmount(50_000),
    }))

    const dashboard = await new HomeUseCases(repositories, {
      today: () => TODAY,
    }).getDashboard()

    expect(dashboard.netWorth).toBe(150_000)
  })

  it("subtracts one active pending debt from net worth", async () => {
    await repositories.accounts.add(account())
    await repositories.savingsGoals.add(goal({
      openingBalance: asClpAmount(50_000),
      currentBalance: asClpAmount(50_000),
    }))
    await repositories.debts.add(debt({ outstandingAmount: asClpAmount(40_000) }))

    const dashboard = await new HomeUseCases(repositories, {
      today: () => TODAY,
    }).getDashboard()

    expect(dashboard.netWorth).toBe(110_000)
  })

  it("returns every active pending debt with overdue items first, then highest balance", async () => {
    await repositories.accounts.add(account())
    await repositories.debts.add(debt({
      outstandingAmount: asClpAmount(50_000),
      name: "Deuda uno",
      paymentStatus: "overdue",
    }))
    await repositories.debts.add(debt({
      id: asEntityId("a0000000-0000-4000-8000-000000000010"),
      outstandingAmount: asClpAmount(60_000),
      name: "Deuda dos",
    }))
    await repositories.debts.add(debt({
      id: asEntityId("a0000000-0000-4000-8000-000000000011"),
      outstandingAmount: asClpAmount(70_000),
      name: "Deuda tres",
    }))

    const dashboard = await new HomeUseCases(repositories, {
      today: () => TODAY,
    }).getDashboard()

    expect(dashboard.netWorth).toBe(-80_000)
    expect(dashboard.activeDebts).toHaveLength(3)
    expect(dashboard.activeDebts.map(({ debt: item }) => item.name)).toEqual([
      "Deuda uno",
      "Deuda tres",
      "Deuda dos",
    ])
  })

  it("does not subtract inactive or fully paid debts", async () => {
    await repositories.accounts.add(account())
    await repositories.debts.add(debt({
      lifecycleStatus: "inactive",
      outstandingAmount: asClpAmount(70_000),
    }))
    await repositories.debts.add(debt({
      id: asEntityId("a0000000-0000-4000-8000-000000000012"),
      outstandingAmount: asClpAmount(0),
      paymentStatus: "paid",
    }))

    const dashboard = await new HomeUseCases(repositories, {
      today: () => TODAY,
    }).getDashboard()

    expect(dashboard.netWorth).toBe(100_000)
    expect(dashboard.activeDebts).toEqual([])
  })

  it("aggregates balances and reuses the canonical monthly summary", async () => {
    await repositories.accounts.add(account())
    await repositories.savingsGoals.add(goal())
    await repositories.debts.add(debt())
    await repositories.categories.add(category())
    const createId = idSequence()
    const movements = new MovementUseCases(repositories, {
      now: () => NOW,
      today: () => TODAY,
      createId,
    })
    const debts = new DebtUseCases(repositories, {
      now: () => NOW,
      today: () => TODAY,
      createId,
    })
    await movements.registerIncome({
      incomeType: "additional",
      accountId: ACCOUNT_ID,
      operationDate: TODAY,
      amount: 100_000,
      concept: "Extra",
    })
    await movements.registerExpense({
      accountId: ACCOUNT_ID,
      categoryId: CATEGORY_ID,
      operationDate: TODAY,
      amount: 20_000,
      concept: "Almuerzo",
    })
    await debts.registerPayment({
      debtId: DEBT_ID,
      accountId: ACCOUNT_ID,
      operationDate: TODAY,
      amount: 30_000,
    })
    await movements.registerTransfer({
      sourceType: "account",
      sourceId: ACCOUNT_ID,
      destinationType: "savings_goal",
      destinationId: GOAL_ID,
      operationDate: TODAY,
      amount: 10_000,
    })

    const dashboard = await new HomeUseCases(repositories, {
      today: () => TODAY,
    }).getDashboard()
    expect(dashboard).toMatchObject({
      totalAccountBalance: 140_000,
      totalSavingsBalance: 10_000,
      netWorth: 80_000,
      periodExpenseAmount: 50_000,
      expenseToIncomePercent: 50,
      savingsToIncomePercent: 10,
      isEmpty: false,
      summary: {
        totalIncomeAmount: 100_000,
        variableExpenseAmount: 20_000,
        debtPaymentAmount: 30_000,
        netSavingsAmount: 10_000,
        availableAmount: 40_000,
      },
    })
    expect(dashboard.accounts[0]).toMatchObject({ name: "Principal", currentBalance: 140_000 })
    expect(dashboard.relevantGoals[0]).toMatchObject({
      goal: { name: "Viaje", currentBalance: 10_000 },
      progressPercent: 10,
    })
    expect(dashboard.activeDebts[0]).toMatchObject({
      debt: { name: "Crédito", outstandingAmount: 70_000 },
      schedule: { remainingInstallments: 3 },
      progressPercent: 30,
    })
  })

  it("does not derive a negative savings percentage for withdrawals", async () => {
    await repositories.accounts.add(account())
    await repositories.savingsGoals.add(goal({
      openingBalance: asClpAmount(50_000),
      currentBalance: asClpAmount(50_000),
    }))
    const movements = new MovementUseCases(repositories, {
      now: () => NOW,
      today: () => TODAY,
      createId: idSequence(),
    })
    await movements.registerIncome({
      incomeType: "additional",
      accountId: ACCOUNT_ID,
      operationDate: TODAY,
      amount: 100_000,
      concept: "Extra",
    })
    await movements.registerTransfer({
      sourceType: "savings_goal",
      sourceId: GOAL_ID,
      destinationType: "account",
      destinationId: ACCOUNT_ID,
      operationDate: TODAY,
      amount: 10_000,
    })

    const dashboard = await new HomeUseCases(repositories, {
      today: () => TODAY,
    }).getDashboard()

    expect(dashboard.summary.netSavingsAmount).toBe(-10_000)
    expect(dashboard.savingsToIncomePercent).toBeNull()
  })

  it("returns every active savings goal without truncating the Home list", async () => {
    await repositories.savingsGoals.add(goal())
    await repositories.savingsGoals.add(goal({
      id: asEntityId("a0000000-0000-4000-8000-000000000006"),
      name: "Emergencias",
      currentBalance: asClpAmount(50_000),
    }))
    await repositories.savingsGoals.add(goal({
      id: asEntityId("a0000000-0000-4000-8000-000000000007"),
      name: "Vivienda",
      currentBalance: asClpAmount(25_000),
    }))
    await repositories.savingsGoals.add(goal({
      id: asEntityId("a0000000-0000-4000-8000-000000000008"),
      name: "Cerrada",
      lifecycleStatus: "closed",
      closedAt: NOW,
    }))

    const dashboard = await new HomeUseCases(repositories, {
      today: () => TODAY,
    }).getDashboard()

    expect(dashboard.relevantGoals.map(({ goal }) => goal.name)).toEqual([
      "Emergencias",
      "Vivienda",
      "Viaje",
    ])
  })
})

describe("deriveDebtProgress", () => {
  it("derives empty, partial and paid debt progress", () => {
    expect(deriveDebtProgress({ totalAmount: asPositiveClpAmount(100_000), outstandingAmount: asClpAmount(100_000) }))
      .toEqual({ paidAmount: 0, progressPercent: 0 })
    expect(deriveDebtProgress({ totalAmount: asPositiveClpAmount(100_000), outstandingAmount: asClpAmount(70_000) }))
      .toEqual({ paidAmount: 30_000, progressPercent: 30 })
    expect(deriveDebtProgress({ totalAmount: asPositiveClpAmount(100_000), outstandingAmount: asClpAmount(0) }))
      .toEqual({ paidAmount: 100_000, progressPercent: 100 })
  })

  it("clamps inconsistent amounts to the visual range", () => {
    expect(
      deriveDebtProgress({ totalAmount: asPositiveClpAmount(100_000), outstandingAmount: asClpAmount(120_000) })
        .progressPercent,
    ).toBe(0)
    expect(
      deriveDebtProgress({ totalAmount: asPositiveClpAmount(100_000), outstandingAmount: asClpAmount(-20_000, { allowNegative: true }) })
        .progressPercent,
    ).toBe(100)
  })
})

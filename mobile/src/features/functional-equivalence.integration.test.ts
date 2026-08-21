import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Account, Category } from "@/domain/entities"
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
import { AccountUseCases } from "@/features/accounts/application/account-use-cases"
import { HomeUseCases } from "@/features/home/application/home-use-cases"
import { MovementUseCases } from "@/features/movements/application/movement-use-cases"
import { DebtUseCases } from "@/features/planning/application/debt-use-cases"
import { MonthlyCloseUseCases } from "@/features/planning/application/monthly-close-use-cases"
import { PlanningUseCases } from "@/features/planning/application/planning-use-cases"
import { SettingsUseCases } from "@/features/settings/application/settings-use-cases"
import { canonicalJson, sha256 } from "@/lib/integrity"

const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")
const TODAY = asCivilDate("2026-08-21")
const PERIOD_ID = asEntityId("f1500000-0000-4000-8000-000000000001")
const ACCOUNT_ID = asEntityId("f1500000-0000-4000-8000-000000000002")
const OPENING_ID = asEntityId("f1500000-0000-4000-8000-000000000003")
const CATEGORY_ID = asEntityId("f1500000-0000-4000-8000-000000000004")

function initialPeriod(): Period {
  return {
    id: PERIOD_ID,
    periodKey: asPeriodKey("2026-08"),
    plannedSalaryAmount: asClpAmount(500_000),
    openedAt: NOW,
    status: "open",
    closedAt: null,
    snapshotId: null,
    revision: asRevision(1),
  }
}

function initialAccount(): Account {
  return {
    id: ACCOUNT_ID,
    name: "Principal",
    bank: "Banco",
    openingBalance: asClpAmount(0),
    currentBalance: asClpAmount(0),
    status: "active",
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function initialOpening(): PeriodOpening {
  return {
    id: OPENING_ID,
    periodId: PERIOD_ID,
    targetType: "account",
    targetId: ACCOUNT_ID,
    openingAmount: asClpAmount(0),
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

describe("V1.1.0 functional equivalence through application and IndexedDB", () => {
  let database: PeritaDatabase
  let repositories: PeritaRepositories

  beforeEach(async () => {
    database = await openPeritaDatabase({
      name: `phase-15-${crypto.randomUUID()}`,
      indexedDB: new IDBFactory(),
    })
    repositories = createRepositories(database)
    await repositories.periods.add(initialPeriod())
    await repositories.accounts.add(initialAccount())
    await repositories.periodOpenings.add(initialOpening())
    await repositories.categories.add(category())
  })

  afterEach(() => database.close())

  it("preserves rules and balances across movements, planning, close, history and restore", async () => {
    const options = { now: () => NOW, today: () => TODAY }
    const accounts = new AccountUseCases(repositories, { now: () => NOW })
    const movements = new MovementUseCases(repositories, options)
    const planning = new PlanningUseCases(repositories, { now: () => NOW })
    const debts = new DebtUseCases(repositories, options)
    const monthlyClose = new MonthlyCloseUseCases(repositories, { now: () => NOW })
    const settings = new SettingsUseCases(repositories, { now: () => NOW })

    await settings.updateReferenceSalary(500_000)
    const reserve = await accounts.createAccount({ name: "Reserva", bank: null })
    const salary = await movements.registerIncome({
      incomeType: "salary",
      accountId: ACCOUNT_ID,
      operationDate: TODAY,
      amount: 500_000,
    })
    const expense = await movements.registerExpense({
      accountId: ACCOUNT_ID,
      categoryId: CATEGORY_ID,
      operationDate: TODAY,
      amount: 20_000,
      concept: "Almuerzo",
    })
    await movements.editMovement({
      operationId: expense.operation.id,
      expectedRevision: expense.operation.revision,
      accountId: ACCOUNT_ID,
      categoryId: CATEGORY_ID,
      operationDate: TODAY,
      amount: 25_000,
      concept: "Almuerzo",
    })

    const goal = await planning.createSavingsGoal({
      name: "Viaje",
      targetAmount: 100_000,
      plannedMonthlyAmount: 10_000,
    })
    const transfer = await movements.registerTransfer({
      sourceType: "account",
      sourceId: ACCOUNT_ID,
      destinationType: "savings_goal",
      destinationId: goal.id,
      operationDate: TODAY,
      amount: 50_000,
    })
    const fixed = await planning.createFixedExpense({
      name: "Internet",
      referenceAmount: 30_000,
    })
    if (!fixed.currentInstance) throw new Error("fixture fixed instance missing")
    const fixedPayment = await movements.registerFixedExpensePayment({
      accountId: ACCOUNT_ID,
      fixedExpenseInstanceId: fixed.currentInstance.id,
      operationDate: TODAY,
      amount: 30_000,
    })
    const debt = await debts.createDebt({
      name: "Crédito",
      totalAmount: 100_000,
      monthlyPaymentAmount: 20_000,
      paymentDay: 15,
    })
    const debtPayment = await debts.registerPayment({
      debtId: debt.id,
      accountId: ACCOUNT_ID,
      operationDate: TODAY,
      amount: 20_000,
    })

    const dashboard = await new HomeUseCases(repositories, {
      today: () => TODAY,
    }).getDashboard()
    expect(dashboard.summary).toMatchObject({
      receivedSalaryAmount: 500_000,
      variableExpenseAmount: 25_000,
      fixedExpensePaidAmount: 30_000,
      debtPaymentAmount: 20_000,
      netSavingsAmount: 50_000,
      availableAmount: 375_000,
    })
    expect(dashboard).toMatchObject({
      totalAccountBalance: 375_000,
      totalSavingsBalance: 50_000,
      totalBalance: 425_000,
    })
    expect((await repositories.debts.get(debt.id))?.outstandingAmount).toBe(80_000)
    expect((await repositories.accounts.get(reserve.id))?.currentBalance).toBe(0)

    const closed = await monthlyClose.closeCurrentPeriod()
    expect(closed.snapshot.data.totals.availableAmount).toBe(375_000)
    expect(await monthlyClose.getMonthlyHistoryDetail(asPeriodKey("2026-08"))).toMatchObject({
      id: closed.snapshot.id,
      data: { totals: { totalIncomeAmount: 500_000 } },
    })
    expect((await repositories.periods.listByStatus("open"))[0]?.periodKey).toBe("2026-09")

    for (const mutation of [
      () => movements.voidMovement({
        operationId: fixedPayment.operation.id,
        expectedRevision: fixedPayment.operation.revision,
      }),
      () => movements.editTransfer({
        operationId: transfer.operation.id,
        expectedRevision: transfer.operation.revision,
        sourceType: "account",
        sourceId: ACCOUNT_ID,
        destinationType: "account",
        destinationId: reserve.id,
        operationDate: TODAY,
        amount: 1,
      }),
      () => debts.voidPayment(
        debtPayment.operation.id,
        debtPayment.operation.revision,
      ),
      () => movements.editMovement({
        operationId: salary.operation.id,
        expectedRevision: salary.operation.revision,
        accountId: ACCOUNT_ID,
        operationDate: TODAY,
        amount: 400_000,
      }),
    ]) {
      await expect(mutation()).rejects.toBeDefined()
    }

    const backup = await settings.exportBackup()
    const inconsistentHistory = JSON.parse(JSON.stringify(backup)) as {
      data: {
        periodSnapshots: Array<{
          data: { totals: { totalIncomeAmount: number } }
          integrity: { payloadHash: string }
        }>
      }
      integrity: { payloadHash: string }
    }
    const historicalSnapshot = inconsistentHistory.data.periodSnapshots[0]
    if (!historicalSnapshot) throw new Error("fixture historical snapshot missing")
    historicalSnapshot.data.totals.totalIncomeAmount += 1
    const { integrity: _snapshotIntegrity, ...snapshotPayload } = historicalSnapshot
    historicalSnapshot.integrity.payloadHash = await sha256(canonicalJson(snapshotPayload))
    const { integrity: _backupIntegrity, ...backupPayload } = inconsistentHistory
    inconsistentHistory.integrity.payloadHash = await sha256(canonicalJson(backupPayload))
    expect(await settings.validateBackup(inconsistentHistory)).toMatchObject({
      status: "invalid",
      errors: ["Los totales de un mes histórico no son reproducibles."],
    })

    await settings.updateReferenceSalary(900_000)
    await settings.restoreBackup(backup)
    expect((await settings.getSettings())?.salaryReferenceAmount).toBe(500_000)
    expect(await settings.validateBackup(await settings.exportBackup())).toMatchObject({
      status: "valid",
    })
  })
})

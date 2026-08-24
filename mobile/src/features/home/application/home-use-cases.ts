import type { Account, Debt, SavingsGoal } from "@/domain/entities"
import { deriveDebtSchedule } from "@/domain/invariants"
import { deriveMonthlySummary } from "@/domain/monthly-close"
import type { DebtSchedule, MonthlySummary, Period } from "@/domain"
import {
  asClpAmount,
  asCivilDate,
  type CivilDate,
  type ClpAmount,
} from "@/domain/primitives"
import type { PeritaRepositories } from "@/data/repositories"

export interface HomeGoalItem {
  readonly goal: SavingsGoal
  readonly progressPercent: number
}

export interface HomeDebtItem {
  readonly debt: Debt
  readonly schedule: DebtSchedule
  readonly progressPercent: number
}

export interface HomeDashboard {
  readonly period: Period
  readonly summary: MonthlySummary
  readonly totalBalance: ClpAmount
  readonly totalAccountBalance: ClpAmount
  readonly totalSavingsBalance: ClpAmount
  readonly periodExpenseAmount: ClpAmount
  readonly accounts: readonly Account[]
  readonly relevantGoals: readonly HomeGoalItem[]
  readonly relevantDebts: readonly HomeDebtItem[]
  readonly isEmpty: boolean
}

export interface HomeUseCasesPort {
  getDashboard(): Promise<HomeDashboard>
}

export class HomeUseCaseError extends Error {
  readonly code: "no_open_period" | "invalid_state"

  constructor(code: "no_open_period" | "invalid_state", message: string) {
    super(message)
    this.name = "HomeUseCaseError"
    this.code = code
  }
}

interface Options {
  readonly today?: () => CivilDate
}

function defaultToday() {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Santiago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  )
  return asCivilDate(`${values.year}-${values.month}-${values.day}`)
}

function checkedSum(values: readonly number[], allowNegative = false) {
  let total = 0
  for (const value of values) {
    total += value
    if (!Number.isSafeInteger(total)) {
      throw new HomeUseCaseError(
        "invalid_state",
        "Los totales financieros exceden el rango CLP permitido.",
      )
    }
  }
  return asClpAmount(total, { allowNegative })
}

export function deriveDebtProgressPercent(
  totalAmount: number,
  outstandingAmount: number,
) {
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) return 0
  const paidAmount = totalAmount - outstandingAmount
  return Math.min(100, Math.max(0, (paidAmount / totalAmount) * 100))
}

export class HomeUseCases implements HomeUseCasesPort {
  private readonly repositories: PeritaRepositories
  private readonly today: () => CivilDate

  constructor(
    repositories: PeritaRepositories,
    options: Options = {},
  ) {
    this.repositories = repositories
    this.today = options.today ?? defaultToday
  }

  async getDashboard() {
    const [periods, accounts, goals, debts, operations, movements, instances] =
      await Promise.all([
        this.repositories.periods.listByStatus("open"),
        this.repositories.accounts.getAll(),
        this.repositories.savingsGoals.getAll(),
        this.repositories.debts.getAll(),
        this.repositories.operations.getAll(),
        this.repositories.movements.getAll(),
        this.repositories.fixedExpenseInstances.getAll(),
      ])
    if (periods.length !== 1 || !periods[0]) {
      throw new HomeUseCaseError(
        "no_open_period",
        "Debe existir un único período abierto para mostrar Inicio.",
      )
    }
    const period = periods[0]
    const summary = deriveMonthlySummary({
      period,
      operations,
      movements,
      fixedExpenseInstances: instances,
    })
    const totalAccountBalance = checkedSum(
      accounts.map(({ currentBalance }) => currentBalance),
      true,
    )
    const totalSavingsBalance = checkedSum(
      goals.map(({ currentBalance }) => currentBalance),
    )
    const totalBalance = checkedSum(
      [totalAccountBalance, totalSavingsBalance],
      true,
    )
    const periodExpenseAmount = checkedSum([
      summary.fixedExpensePaidAmount,
      summary.variableExpenseAmount,
      summary.debtPaymentAmount,
    ])
    const currentDate = this.today()
    const relevantGoals = goals
      .filter(({ lifecycleStatus }) => lifecycleStatus === "active")
      .map((goal) => ({
        goal,
        progressPercent: Math.min(
          100,
          Math.floor((goal.currentBalance / goal.targetAmount) * 100),
        ),
      }))
      .toSorted(
        (left, right) =>
          right.progressPercent - left.progressPercent ||
          left.goal.name.localeCompare(right.goal.name, "es"),
      )
      .slice(0, 2)
    const relevantDebts = debts
      .filter(
        ({ lifecycleStatus, outstandingAmount }) =>
          lifecycleStatus === "active" && outstandingAmount > 0,
      )
      .map((debt) => ({
        debt,
        schedule: deriveDebtSchedule(debt, currentDate),
        progressPercent: deriveDebtProgressPercent(
          debt.totalAmount,
          debt.outstandingAmount,
        ),
      }))
      .toSorted((left, right) => {
        if (left.debt.paymentStatus !== right.debt.paymentStatus) {
          if (left.debt.paymentStatus === "overdue") return -1
          if (right.debt.paymentStatus === "overdue") return 1
        }
        return right.debt.outstandingAmount - left.debt.outstandingAmount
      })
      .slice(0, 2)
    const activeAccounts = accounts
      .filter(({ status }) => status === "active")
      .toSorted(
        (left, right) =>
          right.currentBalance - left.currentBalance ||
          left.name.localeCompare(right.name, "es"),
      )
      .slice(0, 3)

    return {
      period,
      summary,
      totalBalance,
      totalAccountBalance,
      totalSavingsBalance,
      periodExpenseAmount,
      accounts: activeAccounts,
      relevantGoals,
      relevantDebts,
      isEmpty:
        accounts.length === 0 &&
        goals.length === 0 &&
        debts.length === 0 &&
        operations.length === 0 &&
        instances.length === 0,
    }
  }
}

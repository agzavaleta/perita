import type {
  AccountStatus,
  CategoryStatus,
  DebtLifecycleStatus,
  DebtPaymentStatus,
  FixedExpenseInstanceStatus,
  FixedExpenseTemplateStatus,
  GoalLifecycleStatus,
  GoalProgressStatus,
} from "@/domain/constants"
import type {
  CivilDate,
  ClpAmount,
  EntityId,
  MutableEntityRecord,
  PositiveClpAmount,
  Revision,
  UtcTimestamp,
} from "@/domain/primitives"

export interface FinancialSettings {
  readonly key: "current"
  readonly salaryReferenceAmount: ClpAmount
  readonly currency: "CLP"
  readonly timezone: "America/Santiago"
  readonly revision: Revision
  readonly createdAt: UtcTimestamp
  readonly updatedAt: UtcTimestamp
}

export interface Account extends MutableEntityRecord {
  readonly name: string
  readonly bank: string | null
  readonly openingBalance: ClpAmount
  readonly currentBalance: ClpAmount
  readonly status: AccountStatus
}

export interface SavingsGoal extends MutableEntityRecord {
  readonly name: string
  readonly bank: string | null
  readonly targetAmount: PositiveClpAmount
  readonly openingBalance: ClpAmount
  readonly currentBalance: ClpAmount
  readonly plannedMonthlyAmount: ClpAmount
  readonly lifecycleStatus: GoalLifecycleStatus
  readonly progressStatus: GoalProgressStatus
  readonly closedAt: UtcTimestamp | null
}

export interface Debt extends MutableEntityRecord {
  readonly name: string
  readonly totalAmount: PositiveClpAmount
  readonly openingOutstanding: ClpAmount
  readonly outstandingAmount: ClpAmount
  readonly dueDate: CivilDate | null
  readonly monthlyPaymentAmount: PositiveClpAmount | null
  readonly paymentDay: number | null
  readonly lifecycleStatus: DebtLifecycleStatus
  readonly paymentStatus: DebtPaymentStatus
}

export interface Category extends MutableEntityRecord {
  readonly name: string
  readonly status: CategoryStatus
}

export interface FixedExpenseTemplate extends MutableEntityRecord {
  readonly name: string
  readonly referenceAmount: PositiveClpAmount
  readonly status: FixedExpenseTemplateStatus
}

interface FixedExpenseInstanceBase extends MutableEntityRecord {
  readonly periodId: EntityId
  readonly templateId: EntityId
  readonly nameSnapshot: string
  readonly plannedAmount: PositiveClpAmount
}

export type FixedExpenseInstance = FixedExpenseInstanceBase &
  (
    | {
        readonly status: "pending" | "unpaid"
        readonly activePaymentOperationId: null
      }
    | {
        readonly status: Extract<FixedExpenseInstanceStatus, "paid">
        readonly activePaymentOperationId: EntityId
      }
  )

export type FinancialTarget = Account | SavingsGoal | Debt

export type FinancialTargetByType = {
  readonly account: Account
  readonly savings_goal: SavingsGoal
  readonly debt: Debt
}

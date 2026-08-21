import type { AuditEvent } from "@/domain/audit"
import type { PeriodStatus } from "@/domain/constants"
import type {
  Account,
  Category,
  Debt,
  FixedExpenseInstance,
  SavingsGoal,
} from "@/domain/entities"
import type { Movement, Operation } from "@/domain/operations"
import type {
  ClpAmount,
  EntityId,
  PeriodKey,
  Revision,
  UtcTimestamp,
} from "@/domain/primitives"

interface PeriodBase {
  readonly id: EntityId
  readonly periodKey: PeriodKey
  readonly plannedSalaryAmount: ClpAmount
  readonly openedAt: UtcTimestamp
  readonly revision: Revision
}

type PeriodLifecycle =
  | {
      readonly status: Extract<PeriodStatus, "open">
      readonly closedAt: null
      readonly snapshotId: null
    }
  | {
      readonly status: Extract<PeriodStatus, "closed">
      readonly closedAt: UtcTimestamp
      readonly snapshotId: EntityId
    }

export type Period = PeriodBase & PeriodLifecycle
export type OpenPeriod = Extract<Period, { readonly status: "open" }>
export type ClosedPeriod = Extract<Period, { readonly status: "closed" }>

export interface PeriodOpening {
  readonly id: EntityId
  readonly periodId: EntityId
  readonly targetType: "account" | "savings_goal" | "debt"
  readonly targetId: EntityId
  readonly openingAmount: ClpAmount
}

export interface MonthlySummary {
  readonly periodId: EntityId
  readonly periodKey: PeriodKey
  readonly plannedSalaryAmount: ClpAmount
  readonly receivedSalaryAmount: ClpAmount
  readonly additionalIncomeAmount: ClpAmount
  readonly totalIncomeAmount: ClpAmount
  readonly fixedExpensePlannedAmount: ClpAmount
  readonly fixedExpensePaidAmount: ClpAmount
  readonly fixedExpenseUnpaidAmount: ClpAmount
  readonly variableExpenseAmount: ClpAmount
  readonly debtPaymentAmount: ClpAmount
  readonly netSavingsAmount: ClpAmount
  readonly availableAmount: ClpAmount
}

export type FinancialBalanceMap = Readonly<Record<string, ClpAmount>>

export interface PeriodSnapshotData {
  readonly periodPlan: {
    readonly plannedSalaryAmount: ClpAmount
  }
  readonly operations: readonly Operation[]
  readonly movements: readonly Movement[]
  readonly fixedExpenses: readonly FixedExpenseInstance[]
  readonly periodOpenings: readonly PeriodOpening[]
  readonly auditEvents: readonly AuditEvent[]
  readonly entitySnapshots: {
    readonly accounts: readonly Account[]
    readonly savingsGoals: readonly SavingsGoal[]
    readonly debts: readonly Debt[]
    readonly categories: readonly Category[]
  }
  readonly openingBalances: FinancialBalanceMap
  readonly closingBalances: FinancialBalanceMap
  readonly totals: MonthlySummary
  readonly warnings: readonly string[]
}

export interface PeriodSnapshot {
  readonly id: EntityId
  readonly periodId: EntityId
  readonly periodKey: PeriodKey
  readonly schemaVersion: "1.1.0"
  readonly snapshotKind: "canonical"
  readonly closedAt: UtcTimestamp
  readonly data: PeriodSnapshotData
  readonly integrity: {
    readonly algorithm: "SHA-256"
    readonly payloadHash: string
  }
}

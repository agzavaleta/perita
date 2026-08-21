import type { AuditEvent } from "@/domain/audit"
import type {
  Account,
  Category,
  Debt,
  FinancialSettings,
  FixedExpenseInstance,
  FixedExpenseTemplate,
  SavingsGoal,
} from "@/domain/entities"
import type { Movement, Operation, OperationRevision } from "@/domain/operations"
import type { Period, PeriodOpening, PeriodSnapshot } from "@/domain/periods"

/** Portable domain data. It intentionally contains no IndexedDB metadata. */
export interface PeritaDataSnapshot {
  readonly financialSettings: readonly FinancialSettings[]
  readonly periods: readonly Period[]
  readonly periodOpenings: readonly PeriodOpening[]
  readonly accounts: readonly Account[]
  readonly savingsGoals: readonly SavingsGoal[]
  readonly debts: readonly Debt[]
  readonly categories: readonly Category[]
  readonly fixedExpenseTemplates: readonly FixedExpenseTemplate[]
  readonly fixedExpenseInstances: readonly FixedExpenseInstance[]
  readonly operations: readonly Operation[]
  readonly movements: readonly Movement[]
  readonly operationRevisions: readonly OperationRevision[]
  readonly auditEvents: readonly AuditEvent[]
  readonly periodSnapshots: readonly PeriodSnapshot[]
}

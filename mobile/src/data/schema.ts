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
import type {
  Movement,
  Operation,
  OperationRevision,
} from "@/domain/operations"
import type {
  Period,
  PeriodOpening,
  PeriodSnapshot,
} from "@/domain/periods"
import type { EntityId } from "@/domain/primitives"

export const DATABASE_NAME = "perita_mobile" as const
export const DATABASE_VERSION = 1 as const

export const STORE_NAMES = {
  financialSettings: "financialSettings",
  periods: "periods",
  periodOpenings: "periodOpenings",
  accounts: "accounts",
  savingsGoals: "savingsGoals",
  debts: "debts",
  categories: "categories",
  fixedExpenseTemplates: "fixedExpenseTemplates",
  fixedExpenseInstances: "fixedExpenseInstances",
  operations: "operations",
  movements: "movements",
  operationRevisions: "operationRevisions",
  auditEvents: "auditEvents",
  periodSnapshots: "periodSnapshots",
} as const

export type StoreName = (typeof STORE_NAMES)[keyof typeof STORE_NAMES]

export const INDEX_NAMES = {
  byPeriodKey: "byPeriodKey",
  byStatus: "byStatus",
  byPeriod: "byPeriod",
  byPeriodTarget: "byPeriodTarget",
  byPeriodTemplate: "byPeriodTemplate",
  byPeriodType: "byPeriodType",
  byOperation: "byOperation",
  byTarget: "byTarget",
  byOperationRevision: "byOperationRevision",
  bySubject: "bySubject",
} as const

export interface StoreSchema {
  readonly financialSettings: {
    readonly key: "current"
    readonly value: FinancialSettings
  }
  readonly periods: { readonly key: EntityId; readonly value: Period }
  readonly periodOpenings: {
    readonly key: EntityId
    readonly value: PeriodOpening
  }
  readonly accounts: { readonly key: EntityId; readonly value: Account }
  readonly savingsGoals: { readonly key: EntityId; readonly value: SavingsGoal }
  readonly debts: { readonly key: EntityId; readonly value: Debt }
  readonly categories: { readonly key: EntityId; readonly value: Category }
  readonly fixedExpenseTemplates: {
    readonly key: EntityId
    readonly value: FixedExpenseTemplate
  }
  readonly fixedExpenseInstances: {
    readonly key: EntityId
    readonly value: FixedExpenseInstance
  }
  readonly operations: { readonly key: EntityId; readonly value: Operation }
  readonly movements: { readonly key: EntityId; readonly value: Movement }
  readonly operationRevisions: {
    readonly key: EntityId
    readonly value: OperationRevision
  }
  readonly auditEvents: { readonly key: EntityId; readonly value: AuditEvent }
  readonly periodSnapshots: {
    readonly key: EntityId
    readonly value: PeriodSnapshot
  }
}

export type StoreValue<Name extends StoreName> = StoreSchema[Name]["value"]
export type StoreKey<Name extends StoreName> = StoreSchema[Name]["key"]

import type {
  AuditAction,
  AuditSubjectType,
} from "@/domain/constants"
import type {
  Account,
  Category,
  Debt,
  FinancialSettings,
  FixedExpenseInstance,
  FixedExpenseTemplate,
  SavingsGoal,
} from "@/domain/entities"
import type { Period } from "@/domain/periods"
import type {
  EntityId,
  Revision,
  UtcTimestamp,
} from "@/domain/primitives"

export type AuditSnapshot =
  | FinancialSettings
  | Period
  | Account
  | SavingsGoal
  | Debt
  | Category
  | FixedExpenseTemplate
  | FixedExpenseInstance

type AuditSubject =
  | {
      readonly subjectType: "financial_settings"
      readonly subjectId: "current"
    }
  | {
      readonly subjectType: Exclude<AuditSubjectType, "financial_settings">
      readonly subjectId: EntityId
    }

interface AuditIdentity {
  readonly id: EntityId
  readonly periodId: EntityId | null
  readonly commandType: string
  readonly reason: string | null
  readonly occurredAt: UtcTimestamp
}

interface CreatedAuditState {
  readonly action: "created"
  readonly previousRevision: null
  readonly nextRevision: Revision
  readonly previousValue: null
  readonly nextValue: AuditSnapshot
}

interface DeletedAuditIdentity {
  readonly action: "deleted"
  readonly previousRevision: Revision
  readonly previousValue: AuditSnapshot
}

type DeletedAuditState = DeletedAuditIdentity &
  (
    | { readonly nextRevision: null; readonly nextValue: null }
    | { readonly nextRevision: Revision; readonly nextValue: AuditSnapshot }
  )

interface ChangedAuditState {
  readonly action: Exclude<AuditAction, "created" | "deleted">
  readonly previousRevision: Revision
  readonly nextRevision: Revision
  readonly previousValue: AuditSnapshot
  readonly nextValue: AuditSnapshot
}

/** Non-financial audit only. Financial edits/voids use OperationRevision. */
export type AuditEvent = AuditIdentity &
  AuditSubject &
  (CreatedAuditState | DeletedAuditState | ChangedAuditState)

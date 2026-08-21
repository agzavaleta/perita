import type {
  MovementEffectType,
  MovementTargetType,
  OperationRevisionChangeType,
  OperationStatus,
  OperationType,
} from "@/domain/constants"
import type {
  CivilDate,
  ClpAmount,
  EntityId,
  MutableEntityRecord,
  NonZeroClpDelta,
  PositiveClpAmount,
  Revision,
  UtcTimestamp,
} from "@/domain/primitives"

interface PostedOperationState {
  readonly status: "posted"
  readonly voidedAt: null
  readonly voidReason: null
}

interface VoidedOperationState {
  readonly status: "voided"
  readonly voidedAt: UtcTimestamp
  readonly voidReason: string | null
}

type OperationLifecycle = PostedOperationState | VoidedOperationState

interface OperationIdentity<
  Type extends OperationType,
  Details extends object,
> extends MutableEntityRecord {
  readonly periodId: EntityId
  readonly type: Type
  readonly operationDate: CivilDate
  /** Always a positive CLP magnitude. Financial sign belongs to Movement.delta. */
  readonly amount: PositiveClpAmount
  readonly details: Details
}

export type OperationRecord<
  Type extends OperationType,
  Details extends object,
> = OperationIdentity<Type, Details> & OperationLifecycle

export interface AccountOperationDetails {
  readonly accountId: EntityId
}

export interface AdditionalIncomeDetails extends AccountOperationDetails {
  readonly concept: string | null
  readonly observation: string | null
}

export interface VariableExpenseDetails extends AccountOperationDetails {
  readonly categoryId: EntityId
  readonly categoryName: string
  readonly concept: string
  readonly observation: string | null
}

export interface FixedExpensePaymentDetails extends AccountOperationDetails {
  readonly fixedExpenseInstanceId: EntityId
}

export interface DebtPaymentDetails extends AccountOperationDetails {
  readonly debtId: EntityId
  readonly concept: string | null
  readonly observation: string | null
}

export interface DebtTotalAdjustmentDetails {
  readonly debtId: EntityId
  readonly previousTotalAmount: PositiveClpAmount
  readonly newTotalAmount: PositiveClpAmount
  readonly previousOutstandingAmount: ClpAmount
  readonly newOutstandingAmount: ClpAmount
  readonly validPostedPaymentsTotal: ClpAmount
}

export interface SavingsOperationDetails {
  readonly goalId: EntityId
  readonly concept: string | null
  readonly observation: string | null
}

export type TransferEndpointType = "account" | "savings_goal"

export interface TransferDetails {
  readonly sourceType: TransferEndpointType
  readonly sourceId: EntityId
  readonly destinationType: TransferEndpointType
  readonly destinationId: EntityId
  readonly concept: string | null
  readonly observation: string | null
}

export type BalanceAdjustmentDetails =
  | {
      readonly accountId: EntityId
      readonly goalId?: never
      readonly reason: string
    }
  | {
      readonly accountId?: never
      readonly goalId: EntityId
      readonly reason: string
    }

export type BalanceAdjustmentOperation = OperationRecord<
  "balance_adjustment",
  BalanceAdjustmentDetails
>
export type SalaryReceiptOperation = OperationRecord<
  "salary_receipt",
  AccountOperationDetails
>
export type AdditionalIncomeOperation = OperationRecord<
  "additional_income",
  AdditionalIncomeDetails
>
export type VariableExpenseOperation = OperationRecord<
  "variable_expense",
  VariableExpenseDetails
>
export type FixedExpensePaymentOperation = OperationRecord<
  "fixed_expense_payment",
  FixedExpensePaymentDetails
>
export type DebtPaymentOperation = OperationRecord<
  "debt_payment",
  DebtPaymentDetails
>
export type DebtTotalAdjustmentOperation = OperationRecord<
  "debt_total_adjustment",
  DebtTotalAdjustmentDetails
>
export type SavingsDepositOperation = OperationRecord<
  "savings_deposit",
  SavingsOperationDetails
>
export type SavingsWithdrawalOperation = OperationRecord<
  "savings_withdrawal",
  SavingsOperationDetails
>
export type TransferOperation = OperationRecord<"transfer", TransferDetails>

export type Operation =
  | BalanceAdjustmentOperation
  | SalaryReceiptOperation
  | AdditionalIncomeOperation
  | VariableExpenseOperation
  | FixedExpensePaymentOperation
  | DebtPaymentOperation
  | DebtTotalAdjustmentOperation
  | SavingsDepositOperation
  | SavingsWithdrawalOperation
  | TransferOperation

export interface Movement {
  readonly id: EntityId
  readonly operationId: EntityId
  readonly periodId: EntityId
  readonly targetType: MovementTargetType
  readonly targetId: EntityId
  readonly effectType: MovementEffectType
  readonly delta: NonZeroClpDelta
  readonly status: OperationStatus
  readonly createdAt: UtcTimestamp
  readonly updatedAt: UtcTimestamp
}

export interface OperationRevision {
  readonly id: EntityId
  readonly operationId: EntityId
  readonly periodId: EntityId
  /** Revision of the complete operation state captured before the change. */
  readonly revisionNumber: Revision
  readonly changeType: OperationRevisionChangeType
  readonly previousOperation: Operation
  readonly previousMovements: readonly Movement[]
  readonly reason: string | null
  readonly createdAt: UtcTimestamp
}

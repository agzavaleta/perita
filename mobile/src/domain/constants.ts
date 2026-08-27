export const DOMAIN_VERSION = "1.1.0" as const
export const CURRENCY = "CLP" as const
export const CHILE_TIME_ZONE = "America/Santiago" as const

export const PERIOD_STATUSES = ["open", "closed"] as const
export const ACCOUNT_STATUSES = ["active", "inactive", "deleted"] as const
export const GOAL_LIFECYCLE_STATUSES = ["active", "closed"] as const
export const GOAL_PROGRESS_STATUSES = ["in_progress", "completed"] as const
export const DEBT_LIFECYCLE_STATUSES = ["active", "inactive"] as const
export const DEBT_PAYMENT_STATUSES = ["active", "overdue", "paid"] as const
export const CATEGORY_STATUSES = ["active", "inactive"] as const
export const FIXED_EXPENSE_TEMPLATE_STATUSES = ["active", "inactive"] as const
export const FIXED_EXPENSE_INSTANCE_STATUSES = ["pending", "paid", "unpaid"] as const
export const OPERATION_STATUSES = ["posted", "voided"] as const
export const OPERATION_TYPES = [
  "balance_adjustment",
  "salary_receipt",
  "additional_income",
  "variable_expense",
  "fixed_expense_payment",
  "debt_payment",
  "debt_total_adjustment",
  "savings_deposit",
  "savings_withdrawal",
  "transfer",
] as const
export const MOVEMENT_TARGET_TYPES = ["account", "savings_goal", "debt"] as const
export const MOVEMENT_EFFECT_TYPES = ["asset_balance", "debt_outstanding"] as const
export const OPERATION_REVISION_CHANGE_TYPES = ["edit", "void"] as const
export const AUDIT_SUBJECT_TYPES = [
  "financial_settings",
  "period",
  "account",
  "savings_goal",
  "debt",
  "category",
  "fixed_expense_template",
  "fixed_expense_instance",
] as const
export const AUDIT_ACTIONS = [
  "created",
  "updated",
  "activated",
  "deactivated",
  "closed",
  "deleted",
] as const

export type PeriodStatus = (typeof PERIOD_STATUSES)[number]
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]
export type GoalLifecycleStatus = (typeof GOAL_LIFECYCLE_STATUSES)[number]
export type GoalProgressStatus = (typeof GOAL_PROGRESS_STATUSES)[number]
export type DebtLifecycleStatus = (typeof DEBT_LIFECYCLE_STATUSES)[number]
export type DebtPaymentStatus = (typeof DEBT_PAYMENT_STATUSES)[number]
export type CategoryStatus = (typeof CATEGORY_STATUSES)[number]
export type FixedExpenseTemplateStatus =
  (typeof FIXED_EXPENSE_TEMPLATE_STATUSES)[number]
export type FixedExpenseInstanceStatus =
  (typeof FIXED_EXPENSE_INSTANCE_STATUSES)[number]
export type OperationStatus = (typeof OPERATION_STATUSES)[number]
export type OperationType = (typeof OPERATION_TYPES)[number]
export type MovementTargetType = (typeof MOVEMENT_TARGET_TYPES)[number]
export type MovementEffectType = (typeof MOVEMENT_EFFECT_TYPES)[number]
export type OperationRevisionChangeType =
  (typeof OPERATION_REVISION_CHANGE_TYPES)[number]
export type AuditSubjectType = (typeof AUDIT_SUBJECT_TYPES)[number]
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

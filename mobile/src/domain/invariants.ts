import type { GoalProgressStatus } from "@/domain/constants"
import type { AuditEvent } from "@/domain/audit"
import type {
  Account,
  Debt,
  FixedExpenseInstance,
  FixedExpenseTemplate,
  SavingsGoal,
} from "@/domain/entities"
import type {
  Movement,
  Operation,
  OperationRevision,
} from "@/domain/operations"
import type { Period, PeriodOpening } from "@/domain/periods"
import {
  asCivilDate,
  asClpAmount,
  asPositiveClpAmount,
  daysInMonth,
  DomainContractError,
  type CivilDate,
  type ClpAmount,
  type EntityId,
  type PositiveClpAmount,
} from "@/domain/primitives"

function fail(message: string): never {
  throw new DomainContractError(message)
}

function assertNonEmpty(value: string, field: string) {
  if (value.trim().length === 0) fail(`${field} must not be empty`)
}

export function deriveSavingsGoalProgress(
  currentBalance: ClpAmount,
  targetAmount: PositiveClpAmount,
): GoalProgressStatus {
  return currentBalance >= targetAmount ? "completed" : "in_progress"
}

export function assertAccountInvariant(account: Account): Account {
  assertNonEmpty(account.emoji, "Account.emoji")
  assertNonEmpty(account.name, "Account.name")
  asClpAmount(account.openingBalance, { allowNegative: true })
  asClpAmount(account.currentBalance, { allowNegative: true })
  if (account.status === "inactive" && account.currentBalance !== 0) {
    fail("An inactive Account must have zero current balance")
  }
  return account
}

export function assertSavingsGoalInvariant(goal: SavingsGoal): SavingsGoal {
  assertNonEmpty(goal.emoji, "SavingsGoal.emoji")
  assertNonEmpty(goal.name, "SavingsGoal.name")
  asPositiveClpAmount(goal.targetAmount)
  asClpAmount(goal.openingBalance)
  asClpAmount(goal.currentBalance)
  asClpAmount(goal.plannedMonthlyAmount)

  const expectedProgress = deriveSavingsGoalProgress(
    goal.currentBalance,
    goal.targetAmount,
  )
  if (goal.progressStatus !== expectedProgress) {
    fail("SavingsGoal progress does not match balance and target")
  }
  if (goal.lifecycleStatus === "active" && goal.closedAt !== null) {
    fail("An active SavingsGoal cannot have closedAt")
  }
  if (
    goal.lifecycleStatus === "closed" &&
    (goal.currentBalance !== 0 || goal.closedAt === null)
  ) {
    fail("A closed SavingsGoal requires zero balance and closedAt")
  }
  return goal
}

export function assertFixedExpenseTemplateInvariant(
  template: FixedExpenseTemplate,
): FixedExpenseTemplate {
  assertNonEmpty(template.name, "FixedExpenseTemplate.name")
  asPositiveClpAmount(template.referenceAmount)
  return template
}

export function assertFixedExpenseInstanceInvariant(
  instance: FixedExpenseInstance,
): FixedExpenseInstance {
  assertNonEmpty(instance.nameSnapshot, "FixedExpenseInstance.nameSnapshot")
  asPositiveClpAmount(instance.plannedAmount)
  if (
    (instance.status === "paid") !==
    (instance.activePaymentOperationId !== null)
  ) {
    fail("FixedExpenseInstance payment link must match paid status")
  }
  return instance
}

export function assertDebtInvariant(debt: Debt): Debt {
  assertNonEmpty(debt.name, "Debt.name")
  asPositiveClpAmount(debt.totalAmount)
  asClpAmount(debt.openingOutstanding)
  asClpAmount(debt.outstandingAmount)
  if (debt.dueDate !== null) asCivilDate(debt.dueDate)

  asPositiveClpAmount(debt.monthlyPaymentAmount)
  if (
    debt.paymentDay !== null &&
    (!Number.isSafeInteger(debt.paymentDay) ||
      debt.paymentDay < 1 ||
      debt.paymentDay > 31)
  ) {
    fail("Debt payment day must be an integer from 1 to 31")
  }
  if ((debt.outstandingAmount === 0) !== (debt.paymentStatus === "paid")) {
    fail("Debt must be paid exactly when outstanding amount is zero")
  }
  if (debt.paymentStatus === "overdue" && debt.dueDate === null) {
    fail("An overdue Debt requires a due date")
  }
  if (debt.lifecycleStatus === "inactive" && debt.outstandingAmount !== 0) {
    fail("An inactive Debt must have zero outstanding amount")
  }
  return debt
}

export interface InitialBalancePolicy {
  readonly targetType: "account" | "savings_goal"
  readonly duringSetup: boolean
  readonly openingBalance: ClpAmount
  readonly currentBalance: ClpAmount
}

export function assertInitialBalancePolicy(
  policy: InitialBalancePolicy,
): InitialBalancePolicy {
  const allowNegative = policy.targetType === "account" && policy.duringSetup
  asClpAmount(policy.openingBalance, { allowNegative })
  asClpAmount(policy.currentBalance, { allowNegative })
  if (policy.currentBalance !== policy.openingBalance) {
    fail("A new entity must begin with current balance equal to opening balance")
  }
  if (
    policy.targetType === "account" &&
    !policy.duringSetup &&
    policy.openingBalance !== 0
  ) {
    fail("An Account created after setup must begin at zero")
  }
  if (policy.targetType === "savings_goal" && policy.openingBalance !== 0) {
    fail("A SavingsGoal must begin at zero")
  }
  return policy
}

export function assertNewDebtOpening(
  debt: Debt,
  opening: PeriodOpening,
  periodId: EntityId,
) {
  assertDebtInvariant(debt)
  if (
    debt.openingOutstanding !== debt.totalAmount ||
    debt.outstandingAmount !== debt.totalAmount ||
    opening.periodId !== periodId ||
    opening.targetType !== "debt" ||
    opening.targetId !== debt.id ||
    opening.openingAmount !== debt.totalAmount
  ) {
    fail("A new Debt must open with outstanding amounts equal to total amount")
  }
  return { debt, opening } as const
}

export function assertCurrentPeriodFixedExpenseInstance(input: {
  readonly template: FixedExpenseTemplate
  readonly activePeriod: Period
  readonly instance: FixedExpenseInstance
  readonly instances: readonly FixedExpenseInstance[]
}) {
  const { template, activePeriod, instance, instances } = input
  assertFixedExpenseTemplateInvariant(template)
  assertFixedExpenseInstanceInvariant(instance)
  if (activePeriod.status !== "open") {
    fail("Fixed expense instance creation requires an open Period")
  }
  if (
    instance.periodId !== activePeriod.id ||
    instance.templateId !== template.id ||
    instance.nameSnapshot !== template.name ||
    instance.plannedAmount !== template.referenceAmount ||
    instance.status !== "pending" ||
    instance.activePaymentOperationId !== null ||
    instance.revision !== 1
  ) {
    fail("Fixed expense instance must snapshot its Period and Template")
  }
  if (
    instances.some(
      (stored) =>
        stored.periodId === activePeriod.id && stored.templateId === template.id,
    )
  ) {
    fail("Open Period can contain only one instance per fixed expense template")
  }
  return input
}

export function movementAffectsBalance(movement: Movement) {
  return movement.status === "posted"
}

export function assertOperationRevisionInvariant(
  revision: OperationRevision,
): OperationRevision {
  if (
    revision.previousOperation.id !== revision.operationId ||
    revision.previousOperation.periodId !== revision.periodId ||
    revision.previousOperation.revision !== revision.revisionNumber ||
    revision.previousMovements.length === 0
  ) {
    fail("OperationRevision must preserve the complete prior operation state")
  }
  assertOperationMovementInvariant(
    revision.previousOperation,
    revision.previousMovements,
  )
  return revision
}

export function assertAuditEventInvariant(event: AuditEvent): AuditEvent {
  if (event.action === "created" && event.nextRevision !== 1) {
    fail("Created AuditEvent must begin at revision 1")
  }
  if (
    event.action !== "created" &&
    event.action !== "deleted" &&
    event.nextRevision !== event.previousRevision + 1
  ) {
    fail("State-change AuditEvent revisions must be consecutive")
  }
  return event
}

function assertMovementIdentity(operation: Operation, movement: Movement) {
  if (
    movement.operationId !== operation.id ||
    movement.periodId !== operation.periodId ||
    movement.status !== operation.status
  ) {
    fail("Movement identity, period, and status must match its Operation")
  }
  const expectedEffect =
    movement.targetType === "debt" ? "debt_outstanding" : "asset_balance"
  if (movement.effectType !== expectedEffect) {
    fail("Movement effect type must match its target type")
  }
}

function assertSingleMovement(
  movements: readonly Movement[],
  targetType: Movement["targetType"],
  targetId: string,
  delta: number,
) {
  const movement = movements[0]
  if (
    movements.length !== 1 ||
    !movement ||
    movement.targetType !== targetType ||
    movement.targetId !== targetId ||
    movement.delta !== delta
  ) {
    fail("Operation requires one Movement with the approved target and delta")
  }
}

function assertBalancedPair(
  movements: readonly Movement[],
  source: { readonly type: Movement["targetType"]; readonly id: string },
  destination: { readonly type: Movement["targetType"]; readonly id: string },
  amount: number,
) {
  const sourceMovement = movements.find(
    (movement) =>
      movement.targetType === source.type && movement.targetId === source.id,
  )
  const destinationMovement = movements.find(
    (movement) =>
      movement.targetType === destination.type &&
      movement.targetId === destination.id,
  )
  if (
    movements.length !== 2 ||
    !sourceMovement ||
    !destinationMovement ||
    sourceMovement.id === destinationMovement.id ||
    sourceMovement.delta !== -amount ||
    destinationMovement.delta !== amount
  ) {
    fail("Operation requires a balanced pair of Movements")
  }
}

/**
 * Enforces the canonical V1.1.0 Movement cardinality, targets, and signs.
 * Voided records retain their deltas for history but projections must ignore them.
 */
export function assertOperationMovementInvariant(
  operation: Operation,
  movements: readonly Movement[],
): readonly Movement[] {
  asPositiveClpAmount(operation.amount)
  if (new Set(movements.map((movement) => movement.id)).size !== movements.length) {
    fail("Movement IDs must be unique within an Operation")
  }
  movements.forEach((movement) => assertMovementIdentity(operation, movement))

  switch (operation.type) {
    case "balance_adjustment": {
      const details = operation.details
      const targetType = "accountId" in details ? "account" : "savings_goal"
      const targetId =
        "accountId" in details ? details.accountId : details.goalId
      const movement = movements[0]
      if (
        movements.length !== 1 ||
        !movement ||
        movement.targetType !== targetType ||
        movement.targetId !== targetId ||
        Math.abs(movement.delta) !== operation.amount
      ) {
        fail("Balance adjustment must match one Account or SavingsGoal Movement")
      }
      break
    }
    case "salary_receipt":
    case "additional_income":
      assertSingleMovement(
        movements,
        "account",
        operation.details.accountId,
        operation.amount,
      )
      break
    case "variable_expense":
    case "fixed_expense_payment":
      assertSingleMovement(
        movements,
        "account",
        operation.details.accountId,
        -operation.amount,
      )
      break
    case "debt_payment": {
      const accountMovement = movements.find(
        (movement) => movement.targetType === "account",
      )
      const debtMovement = movements.find(
        (movement) => movement.targetType === "debt",
      )
      if (
        movements.length !== 2 ||
        !accountMovement ||
        !debtMovement ||
        accountMovement.targetId !== operation.details.accountId ||
        debtMovement.targetId !== operation.details.debtId ||
        accountMovement.delta !== -operation.amount ||
        debtMovement.delta !== -operation.amount
      ) {
        fail("Debt payment must decrease its Account and outstanding Debt equally")
      }
      break
    }
    case "debt_total_adjustment": {
      const expectedDelta =
        operation.details.newOutstandingAmount -
        operation.details.previousOutstandingAmount
      if (
        expectedDelta === 0 ||
        Math.abs(expectedDelta) !== operation.amount
      ) {
        fail("Debt adjustment magnitude must match its outstanding change")
      }
      assertSingleMovement(
        movements,
        "debt",
        operation.details.debtId,
        expectedDelta,
      )
      break
    }
    case "savings_deposit":
      assertSingleMovement(
        movements,
        "savings_goal",
        operation.details.goalId,
        operation.amount,
      )
      break
    case "savings_withdrawal":
      assertSingleMovement(
        movements,
        "savings_goal",
        operation.details.goalId,
        -operation.amount,
      )
      break
    case "transfer": {
      const details = operation.details
      if (
        details.sourceType === details.destinationType &&
        details.sourceId === details.destinationId
      ) {
        fail("Transfer source and destination must be different")
      }
      assertBalancedPair(
        movements,
        { type: details.sourceType, id: details.sourceId },
        { type: details.destinationType, id: details.destinationId },
        operation.amount,
      )
      break
    }
  }
  return movements
}

export interface DebtScheduleInput {
  readonly outstandingAmount: ClpAmount
  readonly monthlyPaymentAmount: PositiveClpAmount
  readonly paymentDay: number | null
}

export interface DebtSchedule {
  readonly remainingInstallments: number
  readonly nextPaymentDate: CivilDate | null
  readonly estimatedEndDate: CivilDate | null
}

function scheduledCivilDate(year: number, month: number, paymentDay: number) {
  const day = Math.min(paymentDay, daysInMonth(year, month))
  return asCivilDate(
    `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  )
}

function advanceMonth(year: number, month: number, offset: number) {
  const zeroBased = year * 12 + month - 1 + offset
  return {
    year: Math.floor(zeroBased / 12),
    month: (zeroBased % 12) + 1,
  }
}

export function deriveDebtSchedule(
  input: DebtScheduleInput,
  currentCivilDate: CivilDate,
): DebtSchedule {
  asClpAmount(input.outstandingAmount)
  const monthlyPaymentAmount = asPositiveClpAmount(input.monthlyPaymentAmount)
  if (
    input.paymentDay !== null &&
    (!Number.isSafeInteger(input.paymentDay) ||
      input.paymentDay < 1 ||
      input.paymentDay > 31)
  ) {
    fail("Debt schedule payment day must be from 1 to 31")
  }
  if (input.outstandingAmount === 0) {
    return {
      remainingInstallments: 0,
      nextPaymentDate: null,
      estimatedEndDate: null,
    }
  }
  const remainingInstallments = Math.ceil(
    input.outstandingAmount / monthlyPaymentAmount,
  )
  if (input.paymentDay === null) {
    return {
      remainingInstallments,
      nextPaymentDate: null,
      estimatedEndDate: null,
    }
  }

  const [year, month] = currentCivilDate.split("-").map(Number)
  let scheduled = advanceMonth(year, month, 0)
  let nextPaymentDate = scheduledCivilDate(
    scheduled.year,
    scheduled.month,
    input.paymentDay,
  )
  if (nextPaymentDate < currentCivilDate) {
    scheduled = advanceMonth(year, month, 1)
    nextPaymentDate = scheduledCivilDate(
      scheduled.year,
      scheduled.month,
      input.paymentDay,
    )
  }
  const finalMonth = advanceMonth(
    scheduled.year,
    scheduled.month,
    remainingInstallments - 1,
  )
  return {
    remainingInstallments,
    nextPaymentDate,
    estimatedEndDate: scheduledCivilDate(
      finalMonth.year,
      finalMonth.month,
      input.paymentDay,
    ),
  }
}

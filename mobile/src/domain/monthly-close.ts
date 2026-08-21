import type {
  Account,
  Category,
  Debt,
  FixedExpenseInstance,
  SavingsGoal,
} from "@/domain/entities"
import { assertOperationMovementInvariant } from "@/domain/invariants"
import type { Movement, Operation } from "@/domain/operations"
import type {
  FinancialBalanceMap,
  MonthlySummary,
  Period,
  PeriodOpening,
} from "@/domain/periods"
import {
  asClpAmount,
  DomainContractError,
  type ClpAmount,
  type EntityId,
} from "@/domain/primitives"

interface MonthlySummaryInput {
  readonly period: Period
  readonly operations: readonly Operation[]
  readonly movements: readonly Movement[]
  readonly fixedExpenseInstances: readonly FixedExpenseInstance[]
}

interface FinancialEntities {
  readonly accounts: readonly Account[]
  readonly savingsGoals: readonly SavingsGoal[]
  readonly debts: readonly Debt[]
}

interface ReconciliationInput extends FinancialEntities {
  readonly periodId: EntityId
  readonly operations: readonly Operation[]
  readonly movements: readonly Movement[]
  readonly periodOpenings: readonly PeriodOpening[]
}

function fail(message: string): never {
  throw new DomainContractError(message)
}

function checked(current: number, amount: number, field: string) {
  const value = current + amount
  if (!Number.isSafeInteger(value)) fail(`${field} exceeds the CLP safe-integer range`)
  return value
}

export function financialTargetKey(
  targetType: Movement["targetType"],
  targetId: EntityId,
) {
  return `${targetType}:${targetId}`
}

export function deriveMonthlySummary(input: MonthlySummaryInput): MonthlySummary {
  const operations = input.operations.filter(
    (operation) => operation.periodId === input.period.id,
  )
  const operationIds = new Set(operations.map(({ id }) => id))
  const movements = input.movements.filter(
    (movement) => movement.periodId === input.period.id,
  )
  if (movements.some((movement) => !operationIds.has(movement.operationId))) {
    fail("Monthly close found a Movement without an Operation in the Period")
  }

  const movementsByOperation = new Map<EntityId, Movement[]>()
  for (const movement of movements) {
    const related = movementsByOperation.get(movement.operationId) ?? []
    related.push(movement)
    movementsByOperation.set(movement.operationId, related)
  }

  let receivedSalaryAmount = 0
  let additionalIncomeAmount = 0
  let fixedExpensePaidAmount = 0
  let variableExpenseAmount = 0
  let debtPaymentAmount = 0
  let netSavingsAmount = 0
  const postedSalaryIds: EntityId[] = []
  const postedFixedPayments = new Map<EntityId, EntityId>()

  for (const operation of operations) {
    const related = movementsByOperation.get(operation.id) ?? []
    assertOperationMovementInvariant(operation, related)
    if (operation.status !== "posted") continue
    switch (operation.type) {
      case "salary_receipt":
        postedSalaryIds.push(operation.id)
        receivedSalaryAmount = checked(
          receivedSalaryAmount,
          operation.amount,
          "receivedSalaryAmount",
        )
        break
      case "additional_income":
        additionalIncomeAmount = checked(
          additionalIncomeAmount,
          operation.amount,
          "additionalIncomeAmount",
        )
        break
      case "variable_expense":
        variableExpenseAmount = checked(
          variableExpenseAmount,
          operation.amount,
          "variableExpenseAmount",
        )
        break
      case "fixed_expense_payment": {
        const instanceId = operation.details.fixedExpenseInstanceId
        if (postedFixedPayments.has(instanceId)) {
          fail("Monthly close found multiple posted payments for one fixed expense")
        }
        postedFixedPayments.set(instanceId, operation.id)
        fixedExpensePaidAmount = checked(
          fixedExpensePaidAmount,
          operation.amount,
          "fixedExpensePaidAmount",
        )
        break
      }
      case "debt_payment":
        debtPaymentAmount = checked(
          debtPaymentAmount,
          operation.amount,
          "debtPaymentAmount",
        )
        break
      case "savings_deposit":
        netSavingsAmount = checked(
          netSavingsAmount,
          operation.amount,
          "netSavingsAmount",
        )
        break
      case "savings_withdrawal":
        netSavingsAmount = checked(
          netSavingsAmount,
          -operation.amount,
          "netSavingsAmount",
        )
        break
      case "transfer": {
        const { sourceType, destinationType } = operation.details
        const delta =
          sourceType === "account" && destinationType === "savings_goal"
            ? operation.amount
            : sourceType === "savings_goal" && destinationType === "account"
              ? -operation.amount
              : 0
        netSavingsAmount = checked(netSavingsAmount, delta, "netSavingsAmount")
        break
      }
      default:
        break
    }
  }
  if (postedSalaryIds.length > 1) fail("Monthly close found multiple salary receipts")

  let fixedExpensePlannedAmount = 0
  let fixedExpenseUnpaidAmount = 0
  for (const instance of input.fixedExpenseInstances.filter(
    ({ periodId }) => periodId === input.period.id,
  )) {
    fixedExpensePlannedAmount = checked(
      fixedExpensePlannedAmount,
      instance.plannedAmount,
      "fixedExpensePlannedAmount",
    )
    const postedPaymentId = postedFixedPayments.get(instance.id) ?? null
    if (
      (instance.status === "paid" &&
        instance.activePaymentOperationId !== postedPaymentId) ||
      (instance.status !== "paid" &&
        (instance.activePaymentOperationId !== null || postedPaymentId !== null))
    ) {
      fail("Fixed expense state does not match its posted payment")
    }
    if (instance.status !== "paid") {
      fixedExpenseUnpaidAmount = checked(
        fixedExpenseUnpaidAmount,
        instance.plannedAmount,
        "fixedExpenseUnpaidAmount",
      )
    }
  }

  const totalIncomeAmount = checked(
    receivedSalaryAmount,
    additionalIncomeAmount,
    "totalIncomeAmount",
  )
  const availableAmount = [
    -fixedExpensePaidAmount,
    -variableExpenseAmount,
    -debtPaymentAmount,
    -netSavingsAmount,
  ].reduce((total, amount) => checked(total, amount, "availableAmount"), totalIncomeAmount)

  return {
    periodId: input.period.id,
    periodKey: input.period.periodKey,
    plannedSalaryAmount: input.period.plannedSalaryAmount,
    receivedSalaryAmount: asClpAmount(receivedSalaryAmount),
    additionalIncomeAmount: asClpAmount(additionalIncomeAmount),
    totalIncomeAmount: asClpAmount(totalIncomeAmount),
    fixedExpensePlannedAmount: asClpAmount(fixedExpensePlannedAmount),
    fixedExpensePaidAmount: asClpAmount(fixedExpensePaidAmount),
    fixedExpenseUnpaidAmount: asClpAmount(fixedExpenseUnpaidAmount),
    variableExpenseAmount: asClpAmount(variableExpenseAmount),
    debtPaymentAmount: asClpAmount(debtPaymentAmount),
    netSavingsAmount: asClpAmount(netSavingsAmount, { allowNegative: true }),
    availableAmount: asClpAmount(availableAmount, { allowNegative: true }),
  }
}

function balanceOf(
  targetType: Movement["targetType"],
  target: Account | SavingsGoal | Debt,
) {
  if (targetType === "account") return (target as Account).currentBalance
  if (targetType === "savings_goal") return (target as SavingsGoal).currentBalance
  return (target as Debt).outstandingAmount
}

function originalOpeningOf(
  targetType: Movement["targetType"],
  target: Account | SavingsGoal | Debt,
) {
  if (targetType === "debt") return (target as Debt).openingOutstanding
  return (target as Account | SavingsGoal).openingBalance
}

export function reconcileMonthlyBalances(
  input: ReconciliationInput,
): {
  readonly openingBalances: FinancialBalanceMap
  readonly closingBalances: FinancialBalanceMap
} {
  const operations = new Map(input.operations.map((operation) => [operation.id, operation]))
  const targets = new Map<string, Account | SavingsGoal | Debt>([
    ...input.accounts.map((item) => [financialTargetKey("account", item.id), item] as const),
    ...input.savingsGoals.map((item) => [financialTargetKey("savings_goal", item.id), item] as const),
    ...input.debts.map((item) => [financialTargetKey("debt", item.id), item] as const),
  ])
  const globalDeltas = new Map<string, number>()
  const periodDeltas = new Map<string, number>()

  for (const movement of input.movements) {
    const operation = operations.get(movement.operationId)
    if (!operation || operation.status !== movement.status) {
      fail("Movement has a missing or incompatible Operation at monthly close")
    }
    const key = financialTargetKey(movement.targetType, movement.targetId)
    if (!targets.has(key)) fail("Movement has a missing financial target")
    if (movement.status !== "posted") continue
    globalDeltas.set(
      key,
      checked(globalDeltas.get(key) ?? 0, movement.delta, "entityMovementDelta"),
    )
    if (movement.periodId === input.periodId) {
      periodDeltas.set(
        key,
        checked(periodDeltas.get(key) ?? 0, movement.delta, "periodMovementDelta"),
      )
    }
  }

  for (const [key, target] of targets) {
    const targetType = key.split(":")[0] as Movement["targetType"]
    const calculated = checked(
      originalOpeningOf(targetType, target),
      globalDeltas.get(key) ?? 0,
      "entityBalance",
    )
    if (calculated !== balanceOf(targetType, target)) {
      fail("Cached financial balance cannot be reconciled at monthly close")
    }
  }

  const openingBalances: Record<string, ClpAmount> = {}
  const closingBalances: Record<string, ClpAmount> = {}
  const openingKeys = new Set<string>()
  for (const opening of input.periodOpenings.filter(
    ({ periodId }) => periodId === input.periodId,
  )) {
    const key = financialTargetKey(opening.targetType, opening.targetId)
    if (openingKeys.has(key)) fail("Monthly close found duplicate PeriodOpening records")
    const target = targets.get(key)
    if (!target) fail("PeriodOpening has no financial entity")
    const calculated = checked(
      opening.openingAmount,
      periodDeltas.get(key) ?? 0,
      "periodClosingBalance",
    )
    if (calculated !== balanceOf(opening.targetType, target)) {
      fail("Period opening and posted movements do not match closing balance")
    }
    openingKeys.add(key)
    openingBalances[key] = opening.openingAmount
    closingBalances[key] = asClpAmount(calculated, {
      allowNegative: opening.targetType === "account",
    })
  }
  for (const key of periodDeltas.keys()) {
    if (!openingKeys.has(key)) fail("A used financial target has no PeriodOpening")
  }
  return { openingBalances, closingBalances }
}

export interface SnapshotEntities extends FinancialEntities {
  readonly categories: readonly Category[]
}

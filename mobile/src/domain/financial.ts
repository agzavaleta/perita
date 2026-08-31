import type { Account, SavingsGoal } from "@/domain/entities"
import { CHILE_TIME_ZONE } from "@/domain/constants"
import {
  assertAccountInvariant,
  assertSavingsGoalInvariant,
  deriveSavingsGoalProgress,
} from "@/domain/invariants"
import type { Operation } from "@/domain/operations"
import type { Period } from "@/domain/periods"
import {
  asCivilDate,
  asClpAmount,
  asRevision,
  DomainContractError,
  type CivilDate,
  type NonZeroClpDelta,
  type UtcTimestamp,
} from "@/domain/primitives"

function chileCivilDate(timestamp: UtcTimestamp) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: CHILE_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(timestamp))
      .map(({ type, value }) => [type, value]),
  )
  return asCivilDate(`${values.year}-${values.month}-${values.day}`)
}

export function assertOperationDateContext(
  operation: Operation,
  period: Period,
  currentCivilDate: CivilDate,
) {
  asCivilDate(operation.operationDate)
  asCivilDate(currentCivilDate)
  if (period.status !== "open" || operation.periodId !== period.id) {
    throw new DomainContractError(
      "Operation must belong to the active open Period",
    )
  }
  if (operation.operationDate < chileCivilDate(period.openedAt)) {
    throw new DomainContractError(
      "Operation date cannot be before the Period opening date",
    )
  }
  if (operation.operationDate > currentCivilDate) {
    throw new DomainContractError("Operation date cannot be in the future")
  }
  return operation
}

function applyDelta(balance: number, delta: number) {
  return asClpAmount(balance + delta)
}

/** Reverses the previous posted effect before applying the replacement. */
export function applyAccountMovementChange(input: {
  readonly account: Account
  readonly previousDelta: NonZeroClpDelta | null
  readonly nextDelta: NonZeroClpDelta | null
  readonly occurredAt: UtcTimestamp
}) {
  let balance = asClpAmount(input.account.currentBalance, {
    allowNegative: true,
  })
  if (input.previousDelta !== null) {
    balance = applyDelta(balance, -input.previousDelta)
  }
  if (input.nextDelta !== null) {
    balance = applyDelta(balance, input.nextDelta)
  }
  if (balance === input.account.currentBalance) return input.account

  return assertAccountInvariant({
    ...input.account,
    currentBalance: balance,
    revision: asRevision(Number(input.account.revision) + 1),
    updatedAt: input.occurredAt,
  })
}

/** Applies the same reversal-then-replacement rule to a SavingsGoal. */
export function applySavingsGoalMovementChange(input: {
  readonly goal: SavingsGoal
  readonly previousDelta: NonZeroClpDelta | null
  readonly nextDelta: NonZeroClpDelta | null
  readonly occurredAt: UtcTimestamp
}) {
  let balance = asClpAmount(input.goal.currentBalance)
  if (input.previousDelta !== null) {
    balance = applyDelta(balance, -input.previousDelta)
  }
  if (input.nextDelta !== null) {
    balance = applyDelta(balance, input.nextDelta)
  }
  if (balance === input.goal.currentBalance) return input.goal

  return assertSavingsGoalInvariant({
    ...input.goal,
    currentBalance: balance,
    progressStatus: deriveSavingsGoalProgress(balance, input.goal.targetAmount),
    revision: asRevision(Number(input.goal.revision) + 1),
    updatedAt: input.occurredAt,
  })
}

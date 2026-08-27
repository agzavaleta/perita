import { describe, expect, it } from "vitest"

import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asNonZeroClpDelta,
  asPositiveClpAmount,
  asRevision,
  asUtcTimestamp,
  assertAccountInvariant,
  assertDebtInvariant,
  assertInitialBalancePolicy,
  assertOperationMovementInvariant,
  assertSavingsGoalInvariant,
  deriveDebtSchedule,
  movementAffectsBalance,
  nextPeriod,
  periodFromCivilDate,
  type Account,
  type Debt,
  type Movement,
  type SavingsGoal,
  type TransferOperation,
} from "@/domain"

const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")

function id(value: number) {
  return asEntityId(
    `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`,
  )
}

describe("primitive domain contracts", () => {
  it("accepts only safe integer CLP amounts", () => {
    expect(asClpAmount(125_000)).toBe(125_000)
    expect(asClpAmount(-20_000, { allowNegative: true })).toBe(-20_000)
    expect(() => asClpAmount(1.5)).toThrow(/safe integers/)
    expect(() => asPositiveClpAmount(0)).toThrow(/must not be zero/)
  })

  it("keeps civil dates and monthly periods independent from UI formats", () => {
    const date = asCivilDate("2028-02-29")
    expect(periodFromCivilDate(date)).toBe("2028-02")
    expect(nextPeriod(periodFromCivilDate(asCivilDate("2026-12-15")))).toBe(
      "2027-01",
    )
    expect(() => asCivilDate("2026-02-29")).toThrow(/valid calendar date/)
  })
})

describe("entity lifecycle invariants", () => {
  it("requires inactive accounts to have zero balance", () => {
    const account: Account = {
      id: id(1),
      emoji: "💳",
      name: "Cuenta principal",
      bank: null,
      openingBalance: asClpAmount(0, { allowNegative: true }),
      currentBalance: asClpAmount(10_000, { allowNegative: true }),
      status: "inactive",
      deletedAt: null,
      balanceAtDeletion: null,
      revision: asRevision(1),
      createdAt: NOW,
      updatedAt: NOW,
    }

    expect(() => assertAccountInvariant(account)).toThrow(/zero current balance/)
    expect(() =>
      assertAccountInvariant({ ...account, emoji: "", currentBalance: asClpAmount(0) }),
    ).toThrow(/Account\.emoji/)
  })

  it("allows existing account balances only during initial setup", () => {
    expect(() =>
      assertInitialBalancePolicy({
        targetType: "account",
        duringSetup: false,
        openingBalance: asClpAmount(50_000),
        currentBalance: asClpAmount(50_000),
      }),
    ).toThrow(/after setup/)

    expect(
      assertInitialBalancePolicy({
        targetType: "account",
        duringSetup: true,
        openingBalance: asClpAmount(-10_000, { allowNegative: true }),
        currentBalance: asClpAmount(-10_000, { allowNegative: true }),
      }).openingBalance,
    ).toBe(-10_000)
  })

  it("requires deleted accounts to preserve their balance and timestamp", () => {
    const deleted: Account = {
      id: id(2),
      emoji: "💳",
      name: "Cuenta eliminada",
      bank: null,
      openingBalance: asClpAmount(10_000),
      currentBalance: asClpAmount(25_000),
      status: "deleted",
      deletedAt: NOW,
      balanceAtDeletion: asClpAmount(25_000),
      revision: asRevision(2),
      createdAt: NOW,
      updatedAt: NOW,
    }

    expect(assertAccountInvariant(deleted)).toBe(deleted)
    expect(() => assertAccountInvariant({
      ...deleted,
      balanceAtDeletion: asClpAmount(20_000),
    })).toThrow(/preserve its balance/)
  })

  it("requires a positive debt installment while allowing optional dates", () => {
    const debt: Debt = {
      id: id(20),
      name: "Crédito",
      totalAmount: asPositiveClpAmount(100_000),
      openingOutstanding: asClpAmount(100_000),
      outstandingAmount: asClpAmount(100_000),
      dueDate: null,
      monthlyPaymentAmount: asPositiveClpAmount(25_000),
      paymentDay: null,
      lifecycleStatus: "active",
      paymentStatus: "active",
      revision: asRevision(1),
      createdAt: NOW,
      updatedAt: NOW,
    }

    expect(assertDebtInvariant(debt)).toBe(debt)
    expect(assertDebtInvariant({ ...debt, paymentDay: 31 })).toMatchObject({
      paymentDay: 31,
    })
    expect(() =>
      assertDebtInvariant({
        ...debt,
        monthlyPaymentAmount: asClpAmount(0) as Debt["monthlyPaymentAmount"],
      }),
    ).toThrow(/must not be zero/)
    expect(() => assertDebtInvariant({ ...debt, paymentDay: 32 })).toThrow(
      /from 1 to 31/,
    )
  })

  it("derives savings progress from balance and target", () => {
    const goal: SavingsGoal = {
      id: id(2),
      emoji: "💰",
      name: "Emergencias",
      bank: "Banco de ejemplo",
      targetAmount: asPositiveClpAmount(500_000),
      openingBalance: asClpAmount(0),
      currentBalance: asClpAmount(500_000),
      plannedMonthlyAmount: asClpAmount(50_000),
      lifecycleStatus: "active",
      progressStatus: "completed",
      closedAt: null,
      revision: asRevision(1),
      createdAt: NOW,
      updatedAt: NOW,
    }

    expect(assertSavingsGoalInvariant(goal)).toBe(goal)
    expect(() => assertSavingsGoalInvariant({ ...goal, emoji: " " })).toThrow(
      /SavingsGoal\.emoji/,
    )
    expect(() =>
      assertSavingsGoalInvariant({ ...goal, progressStatus: "in_progress" }),
    ).toThrow(/progress/)
  })
})

describe("operation and movement relations", () => {
  const sourceId = id(10)
  const destinationId = id(11)
  const operationId = id(12)
  const periodId = id(13)

  const transfer: TransferOperation = {
    id: operationId,
    periodId,
    type: "transfer",
    operationDate: asCivilDate("2026-08-21"),
    amount: asPositiveClpAmount(30_000),
    status: "posted",
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
    voidedAt: null,
    voidReason: null,
    details: {
      sourceType: "account",
      sourceId,
      destinationType: "savings_goal",
      destinationId,
      concept: null,
      observation: null,
    },
  }

  const movements: readonly Movement[] = [
    {
      id: id(14),
      operationId,
      periodId,
      targetType: "account",
      targetId: sourceId,
      effectType: "asset_balance",
      delta: asNonZeroClpDelta(-30_000),
      status: "posted",
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: id(15),
      operationId,
      periodId,
      targetType: "savings_goal",
      targetId: destinationId,
      effectType: "asset_balance",
      delta: asNonZeroClpDelta(30_000),
      status: "posted",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]

  it("requires internal transfers to be balanced and use distinct endpoints", () => {
    expect(assertOperationMovementInvariant(transfer, movements)).toBe(movements)
    expect(() =>
      assertOperationMovementInvariant(transfer, [
        movements[0],
        { ...movements[1], delta: asNonZeroClpDelta(20_000) },
      ]),
    ).toThrow(/balanced pair/)
  })

  it("keeps voided movements as history but excludes them from balances", () => {
    expect(movementAffectsBalance(movements[0])).toBe(true)
    expect(movementAffectsBalance({ ...movements[0], status: "voided" })).toBe(
      false,
    )
  })
})

describe("derived debt schedule", () => {
  it("calculates installments without inventing dates when payment day is absent", () => {
    expect(
      deriveDebtSchedule(
        {
          outstandingAmount: asClpAmount(250_000),
          monthlyPaymentAmount: asPositiveClpAmount(100_000),
          paymentDay: null,
        },
        asCivilDate("2026-02-15"),
      ),
    ).toEqual({
      remainingInstallments: 3,
      nextPaymentDate: null,
      estimatedEndDate: null,
    })
  })

  it("clamps payment day to the month and preserves a partial final installment", () => {
    expect(
      deriveDebtSchedule(
        {
          outstandingAmount: asClpAmount(250_000),
          monthlyPaymentAmount: asPositiveClpAmount(100_000),
          paymentDay: 31,
        },
        asCivilDate("2026-02-15"),
      ),
    ).toEqual({
      remainingInstallments: 3,
      nextPaymentDate: "2026-02-28",
      estimatedEndDate: "2026-04-30",
    })
  })

  it("returns a completed schedule for a paid debt", () => {
    expect(
      deriveDebtSchedule(
        {
          outstandingAmount: asClpAmount(0),
          monthlyPaymentAmount: asPositiveClpAmount(100_000),
          paymentDay: null,
        },
        asCivilDate("2026-02-15"),
      ),
    ).toEqual({
      remainingInstallments: 0,
      nextPaymentDate: null,
      estimatedEndDate: null,
    })
  })
})

import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Account } from "@/domain/entities"
import type { Period } from "@/domain/periods"
import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asPeriodKey,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import { openPeritaDatabase, type PeritaDatabase } from "@/data/database"
import { createRepositories, type PeritaRepositories } from "@/data/repositories"
import { DebtUseCases } from "@/features/planning/application/debt-use-cases"

const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")
const LATER = asUtcTimestamp("2026-08-21T13:00:00.000Z")
const TODAY = asCivilDate("2026-08-21")
const PERIOD_ID = asEntityId("70000000-0000-4000-8000-000000000001")
const ACCOUNT_A = asEntityId("70000000-0000-4000-8000-000000000002")
const ACCOUNT_B = asEntityId("70000000-0000-4000-8000-000000000003")
const NEXT_PERIOD_ID = asEntityId("70000000-0000-4000-8000-000000000004")

function period(): Period {
  return {
    id: PERIOD_ID,
    periodKey: asPeriodKey("2026-08"),
    plannedSalaryAmount: asClpAmount(0),
    openedAt: NOW,
    status: "open",
    closedAt: null,
    snapshotId: null,
    revision: asRevision(1),
  }
}

function account(id: typeof ACCOUNT_A, name: string, balance: number): Account {
  return {
    id,
    name,
    bank: null,
    openingBalance: asClpAmount(balance),
    currentBalance: asClpAmount(balance),
    status: "active",
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function idSequence() {
  let value = 100
  return () =>
    asEntityId(`70000000-0000-4000-8000-${String(value++).padStart(12, "0")}`)
}

describe("DebtUseCases", () => {
  let database: PeritaDatabase
  let repositories: PeritaRepositories
  let debts: DebtUseCases
  let now: typeof NOW | typeof LATER

  beforeEach(async () => {
    database = await openPeritaDatabase({
      name: `debts-${crypto.randomUUID()}`,
      indexedDB: new IDBFactory(),
    })
    repositories = createRepositories(database)
    await repositories.periods.add(period())
    await repositories.accounts.add(account(ACCOUNT_A, "Principal", 200_000))
    await repositories.accounts.add(account(ACCOUNT_B, "Secundaria", 80_000))
    now = NOW
    debts = new DebtUseCases(repositories, {
      now: () => now,
      today: () => TODAY,
      createId: idSequence(),
    })
  })

  afterEach(() => database.close())

  async function createDebt() {
    return debts.createDebt({
      name: "Crédito",
      totalAmount: 100_000,
      monthlyPaymentAmount: 25_000,
      paymentDay: 31,
    })
  }

  it("creates the exact active opening and derives next payment and estimated end", async () => {
    const debt = await createDebt()
    expect(debt).toMatchObject({
      openingOutstanding: 100_000,
      outstandingAmount: 100_000,
      dueDate: null,
      lifecycleStatus: "active",
      paymentStatus: "active",
      revision: 1,
    })
    expect(await repositories.periodOpenings.listByPeriod(PERIOD_ID)).toEqual([
      expect.objectContaining({
        targetType: "debt",
        targetId: debt.id,
        openingAmount: 100_000,
      }),
    ])
    const [item] = await debts.listDebts()
    expect(item?.schedule).toEqual({
      remainingInstallments: 4,
      nextPaymentDate: "2026-08-31",
      estimatedEndDate: "2026-11-30",
    })
  })

  it("pays partially and totally while updating both balances atomically", async () => {
    const debt = await createDebt()
    await debts.registerPayment({
      debtId: debt.id,
      accountId: ACCOUNT_A,
      operationDate: TODAY,
      amount: 20_000,
      concept: "Cuota 1",
    })
    expect(await repositories.accounts.get(ACCOUNT_A)).toMatchObject({
      currentBalance: 180_000,
      revision: 2,
    })
    expect(await repositories.debts.get(debt.id)).toMatchObject({
      outstandingAmount: 80_000,
      paymentStatus: "active",
      revision: 2,
    })

    await debts.registerPayment({
      debtId: debt.id,
      accountId: ACCOUNT_A,
      operationDate: TODAY,
      amount: 80_000,
    })
    expect(await repositories.debts.get(debt.id)).toMatchObject({
      outstandingAmount: 0,
      paymentStatus: "paid",
    })

    const poor = await createDebt()
    await expect(
      debts.registerPayment({
        debtId: poor.id,
        accountId: ACCOUNT_B,
        operationDate: TODAY,
        amount: 80_001,
      }),
    ).rejects.toMatchObject({ code: "insufficient_balance" })
    expect((await repositories.debts.get(poor.id))?.outstandingAmount).toBe(100_000)
  })

  it("edits and voids a payment with complete revisions and both reversals", async () => {
    const debt = await createDebt()
    const payment = await debts.registerPayment({
      debtId: debt.id,
      accountId: ACCOUNT_A,
      operationDate: TODAY,
      amount: 20_000,
    })
    now = LATER
    const edited = await debts.editPayment({
      debtId: debt.id,
      operationId: payment.operation.id,
      expectedRevision: payment.operation.revision,
      accountId: ACCOUNT_B,
      operationDate: TODAY,
      amount: 30_000,
    })
    expect(await repositories.accounts.get(ACCOUNT_A)).toMatchObject({ currentBalance: 200_000 })
    expect(await repositories.accounts.get(ACCOUNT_B)).toMatchObject({ currentBalance: 50_000 })
    expect(await repositories.debts.get(debt.id)).toMatchObject({ outstandingAmount: 70_000 })
    expect(await repositories.operationRevisions.listByOperation(payment.operation.id)).toHaveLength(1)

    await debts.voidPayment(edited.operation.id, edited.operation.revision, "Pago duplicado")
    expect(await repositories.accounts.get(ACCOUNT_B)).toMatchObject({ currentBalance: 80_000 })
    expect(await repositories.debts.get(debt.id)).toMatchObject({
      outstandingAmount: 100_000,
      paymentStatus: "active",
    })
    const detail = await debts.getDebtDetail(debt.id)
    expect(detail.payments[0]?.operation).toMatchObject({ status: "voided", revision: 3 })
    expect(detail.payments[0]?.revisions).toHaveLength(2)
  })

  it("edits planning fields separately and adjusts total against valid posted payments", async () => {
    const debt = await createDebt()
    const edited = await debts.editDebt({
      debtId: debt.id,
      expectedRevision: debt.revision,
      name: "Crédito consumo",
      monthlyPaymentAmount: 30_000,
      paymentDay: 15,
    })
    expect(edited).toMatchObject({
      name: "Crédito consumo",
      totalAmount: 100_000,
      revision: 2,
    })
    await debts.registerPayment({
      debtId: debt.id,
      accountId: ACCOUNT_A,
      operationDate: TODAY,
      amount: 20_000,
    })
    const current = await repositories.debts.get(debt.id)
    if (!current) throw new Error("fixture Debt missing")
    const adjusted = await debts.adjustDebtTotal(
      debt.id,
      current.revision,
      TODAY,
      120_000,
    )
    expect(adjusted).toMatchObject({
      totalAmount: 120_000,
      openingOutstanding: 100_000,
      outstandingAmount: 100_000,
    })
    await expect(
      debts.adjustDebtTotal(debt.id, adjusted.revision, TODAY, 10_000),
    ).rejects.toMatchObject({ code: "invalid_amount" })
  })

  it("keeps lifetime debt payments in detail and total adjustments after a monthly close", async () => {
    const debt = await createDebt()
    const payment = await debts.registerPayment({
      debtId: debt.id,
      accountId: ACCOUNT_A,
      operationDate: TODAY,
      amount: 20_000,
    })
    await repositories.periods.put({
      ...period(),
      status: "closed",
      closedAt: LATER,
      snapshotId: asEntityId("70000000-0000-4000-8000-000000000005"),
      revision: asRevision(2),
    })
    await repositories.periods.add({
      id: NEXT_PERIOD_ID,
      periodKey: asPeriodKey("2026-09"),
      plannedSalaryAmount: asClpAmount(0),
      openedAt: LATER,
      status: "open",
      closedAt: null,
      snapshotId: null,
      revision: asRevision(1),
    })
    const currentDebt = await repositories.debts.get(debt.id)
    const currentAccountA = await repositories.accounts.get(ACCOUNT_A)
    const currentAccountB = await repositories.accounts.get(ACCOUNT_B)
    if (!currentDebt || !currentAccountA || !currentAccountB) {
      throw new Error("fixture missing")
    }
    let nextOpeningNumber = 800
    for (const [targetType, targetId, openingAmount] of [
      ["debt", debt.id, currentDebt.outstandingAmount],
      ["account", ACCOUNT_A, currentAccountA.currentBalance],
      ["account", ACCOUNT_B, currentAccountB.currentBalance],
    ] as const) {
      await repositories.periodOpenings.add({
        id: asEntityId(
          `70000000-0000-4000-8000-${String(nextOpeningNumber++).padStart(12, "0")}`,
        ),
        periodId: NEXT_PERIOD_ID,
        targetType,
        targetId,
        openingAmount,
      })
    }
    debts = new DebtUseCases(repositories, {
      now: () => LATER,
      today: () => asCivilDate("2026-09-10"),
      createId: idSequence(),
    })

    expect((await debts.getDebtDetail(debt.id)).payments).toHaveLength(1)
    const adjusted = await debts.adjustDebtTotal(
      debt.id,
      currentDebt.revision,
      asCivilDate("2026-09-10"),
      110_000,
    )
    expect(adjusted).toMatchObject({
      totalAmount: 110_000,
      outstandingAmount: 90_000,
    })
    await expect(
      debts.voidPayment(payment.operation.id, payment.operation.revision),
    ).rejects.toBeDefined()
    await expect(
      debts.editPayment({
        debtId: debt.id,
        operationId: payment.operation.id,
        expectedRevision: payment.operation.revision,
        accountId: ACCOUNT_A,
        operationDate: asCivilDate("2026-09-10"),
        amount: 10_000,
      }),
    ).rejects.toBeDefined()
  })
})

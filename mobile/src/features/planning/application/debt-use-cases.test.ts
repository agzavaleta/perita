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
import {
  DebtUseCases,
  type DebtDraft,
} from "@/features/planning/application/debt-use-cases"

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
    variableExpenseBudgetAmount: asClpAmount(0),
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
    emoji: "💳",
    name,
    bank: null,
    openingBalance: asClpAmount(balance),
    currentBalance: asClpAmount(balance),
    status: "active",
    deletedAt: null,
    balanceAtDeletion: null,
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
    expect(item).toMatchObject({ paidAmount: 0, progressPercent: 0 })
    expect(item?.schedule).toEqual({
      remainingInstallments: 4,
      nextPaymentDate: "2026-08-31",
      estimatedEndDate: "2026-11-30",
    })
  })

  it("creates a partially paid opening without operations, movements or account impact", async () => {
    const accountsBefore = await repositories.accounts.getAll()
    const debt = await debts.createDebt({
      name: "Crédito anterior",
      totalAmount: 1_000_000,
      currentOutstandingAmount: 600_000,
      monthlyPaymentAmount: 100_000,
    })

    expect(debt).toMatchObject({
      totalAmount: 1_000_000,
      openingOutstanding: 600_000,
      outstandingAmount: 600_000,
    })
    expect(await repositories.periodOpenings.listByPeriod(PERIOD_ID)).toEqual([
      expect.objectContaining({
        targetType: "debt",
        targetId: debt.id,
        openingAmount: 600_000,
      }),
    ])
    expect(await repositories.operations.count()).toBe(0)
    expect(await repositories.movements.count()).toBe(0)
    expect(await repositories.accounts.getAll()).toEqual(accountsBefore)
    expect((await debts.listDebts())[0]).toMatchObject({
      paidAmount: 400_000,
      progressPercent: 40,
    })
    expect(await debts.getDebtDetail(debt.id)).toMatchObject({
      paidAmount: 400_000,
      progressPercent: 40,
    })
  })

  it("lists current debts before inactive or paid debts and sorts each group by name", async () => {
    async function createNamedDebt(name: string) {
      return debts.createDebt({
        name,
        totalAmount: 10_000,
        monthlyPaymentAmount: 1_000,
      })
    }

    const paid = await createNamedDebt("Abeja pagada")
    const inactive = await createNamedDebt("Beta inactiva")
    await createNamedDebt("Zeta vigente")
    await createNamedDebt("Alfa vigente")
    const otherPaid = await createNamedDebt("Zeta pagada")
    await repositories.debts.put({
      ...paid,
      outstandingAmount: asClpAmount(0),
      paymentStatus: "paid",
    })
    await repositories.debts.put({
      ...inactive,
      outstandingAmount: asClpAmount(0),
      lifecycleStatus: "inactive",
      paymentStatus: "paid",
    })
    await repositories.debts.put({
      ...otherPaid,
      outstandingAmount: asClpAmount(0),
      paymentStatus: "paid",
    })

    expect((await debts.listDebts()).map(({ debt }) => debt.name)).toEqual([
      "Alfa vigente",
      "Zeta vigente",
      "Abeja pagada",
      "Beta inactiva",
      "Zeta pagada",
    ])
  })

  it("deletes a new debt with initial outstanding balance, opening and audits", async () => {
    const debt = await createDebt()

    expect((await debts.getDebtDetail(debt.id)).canDelete).toBe(true)
    await debts.deleteDebt(debt.id, debt.revision)

    expect(await repositories.debts.get(debt.id)).toBeUndefined()
    expect((await repositories.periodOpenings.getAll()).some(({ targetId }) => targetId === debt.id)).toBe(false)
    expect(await repositories.auditEvents.listBySubject("debt", debt.id)).toEqual([])
  })

  it("blocks deletion after payments, voided payments, total adjustments, or historical openings", async () => {
    const paid = await createDebt()
    await debts.registerPayment({ debtId: paid.id, accountId: ACCOUNT_A, operationDate: TODAY, amount: 1 })
    const paidCurrent = await repositories.debts.get(paid.id)
    if (!paidCurrent) throw new Error("fixture debt missing")
    await expect(debts.deleteDebt(paid.id, paidCurrent.revision)).rejects.toMatchObject({ code: "cannot_delete" })

    const voided = await createDebt()
    const payment = await debts.registerPayment({ debtId: voided.id, accountId: ACCOUNT_A, operationDate: TODAY, amount: 1 })
    await debts.voidPayment(payment.operation.id, payment.operation.revision)
    const voidedCurrent = await repositories.debts.get(voided.id)
    if (!voidedCurrent) throw new Error("fixture debt missing")
    await expect(debts.deleteDebt(voided.id, voidedCurrent.revision)).rejects.toMatchObject({ code: "cannot_delete" })

    const adjusted = await createDebt()
    const adjustedCurrent = await debts.adjustDebtTotal(adjusted.id, adjusted.revision, TODAY, 110_000)
    await expect(debts.deleteDebt(adjusted.id, adjustedCurrent.revision)).rejects.toMatchObject({ code: "cannot_delete" })

    const historical = await createDebt()
    await repositories.periodOpenings.add({
      id: asEntityId("70000000-0000-4000-8000-000000009001"),
      periodId: NEXT_PERIOD_ID,
      targetType: "debt",
      targetId: historical.id,
      openingAmount: historical.outstandingAmount,
    })
    await expect(debts.deleteDebt(historical.id, historical.revision)).rejects.toMatchObject({ code: "cannot_delete" })
  })

  it("rejects an informed opening outstanding amount outside its valid range", async () => {
    const draft = {
      name: "Inválida",
      totalAmount: 100_000,
      monthlyPaymentAmount: 25_000,
    }
    await expect(
      debts.createDebt({ ...draft, currentOutstandingAmount: 100_001 }),
    ).rejects.toMatchObject({
      code: "invalid_amount",
      message: "El saldo pendiente no puede superar el total de la deuda.",
    })
    await expect(
      debts.createDebt({ ...draft, currentOutstandingAmount: 0 }),
    ).rejects.toMatchObject({ code: "invalid_amount" })
    await expect(
      debts.createDebt({ ...draft, currentOutstandingAmount: -1 }),
    ).rejects.toMatchObject({ code: "invalid_amount" })
    expect(await repositories.debts.count()).toBe(0)
    expect(await repositories.periodOpenings.count()).toBe(0)
  })

  it("creates a debt with optional due date and payment day", async () => {
    const debt = await debts.createDebt({
      name: "Sin calendario",
      totalAmount: 90_000,
      dueDate: null,
      monthlyPaymentAmount: 20_000,
      paymentDay: null,
    })

    expect(debt).toMatchObject({
      dueDate: null,
      monthlyPaymentAmount: 20_000,
      paymentDay: null,
      paymentStatus: "active",
    })
    expect((await debts.getDebtDetail(debt.id)).schedule).toEqual({
      remainingInstallments: 5,
      nextPaymentDate: null,
      estimatedEndDate: null,
    })
  })

  it("rejects missing or zero installment and invalid payment days", async () => {
    const base = {
      name: "Inválida",
      totalAmount: 100_000,
      monthlyPaymentAmount: 10_000,
    }
    await expect(
      debts.createDebt({ ...base, monthlyPaymentAmount: 0 }),
    ).rejects.toMatchObject({ code: "invalid_amount" })
    await expect(
      debts.createDebt({
        ...base,
        monthlyPaymentAmount: undefined,
      } as unknown as DebtDraft),
    ).rejects.toMatchObject({ code: "invalid_amount" })
    await expect(
      debts.createDebt({ ...base, paymentDay: 0 }),
    ).rejects.toMatchObject({ code: "invalid_day" })
    await expect(
      debts.createDebt({ ...base, paymentDay: 32 }),
    ).rejects.toMatchObject({ code: "invalid_day" })
    await expect(
      debts.createDebt({
        ...base,
        dueDate: "2026-02-30" as ReturnType<typeof asCivilDate>,
      }),
    ).rejects.toMatchObject({ code: "invalid_date" })
  })

  it("derives overdue exclusively from a past due date", async () => {
    const overdue = await debts.createDebt({
      name: "Vencida",
      totalAmount: 100_000,
      dueDate: asCivilDate("2026-08-20"),
      monthlyPaymentAmount: 25_000,
      paymentDay: null,
    })
    const scheduled = await debts.createDebt({
      name: "Con día futuro",
      totalAmount: 100_000,
      dueDate: asCivilDate("2026-08-22"),
      monthlyPaymentAmount: 25_000,
      paymentDay: 1,
    })

    expect(overdue.paymentStatus).toBe("overdue")
    expect(scheduled.paymentStatus).toBe("active")
  })

  it("edits due date and payment day independently and permits removing both", async () => {
    const debt = await debts.createDebt({
      name: "Editable",
      totalAmount: 100_000,
      monthlyPaymentAmount: 25_000,
      paymentDay: null,
      dueDate: null,
    })
    const scheduled = await debts.editDebt({
      debtId: debt.id,
      expectedRevision: debt.revision,
      name: debt.name,
      dueDate: asCivilDate("2026-08-20"),
      monthlyPaymentAmount: 20_000,
      paymentDay: 15,
    })
    expect(scheduled).toMatchObject({
      dueDate: "2026-08-20",
      monthlyPaymentAmount: 20_000,
      paymentDay: 15,
      paymentStatus: "overdue",
      revision: 2,
    })

    const unscheduled = await debts.editDebt({
      debtId: scheduled.id,
      expectedRevision: scheduled.revision,
      name: scheduled.name,
      dueDate: null,
      monthlyPaymentAmount: scheduled.monthlyPaymentAmount,
      paymentDay: null,
    })
    expect(unscheduled).toMatchObject({
      dueDate: null,
      paymentDay: null,
      paymentStatus: "active",
      revision: 3,
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

  it("excludes deleted accounts from debt payments", async () => {
    const debt = await createDebt()
    const current = await repositories.accounts.get(ACCOUNT_A)
    if (!current) throw new Error("Missing account fixture")
    await repositories.accounts.put({
      ...current,
      status: "deleted",
      deletedAt: NOW,
      balanceAtDeletion: current.currentBalance,
      revision: asRevision(2),
    })

    expect((await debts.getPaymentFormOptions()).accounts).toEqual([
      expect.objectContaining({ id: ACCOUNT_B }),
    ])
    await expect(debts.registerPayment({
      debtId: debt.id,
      accountId: ACCOUNT_A,
      operationDate: TODAY,
      amount: 10_000,
    })).rejects.toMatchObject({ code: "invalid_state" })
    expect(await repositories.operations.count()).toBe(0)
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

  it("recalculates partial-opening progress after payment edit and void", async () => {
    const debt = await debts.createDebt({
      name: "Crédito anterior",
      totalAmount: 1_000_000,
      currentOutstandingAmount: 600_000,
      monthlyPaymentAmount: 100_000,
    })
    const payment = await debts.registerPayment({
      debtId: debt.id,
      accountId: ACCOUNT_A,
      operationDate: TODAY,
      amount: 100_000,
    })
    expect(await debts.getDebtDetail(debt.id)).toMatchObject({
      debt: { outstandingAmount: 500_000 },
      paidAmount: 500_000,
      progressPercent: 50,
    })

    const edited = await debts.editPayment({
      debtId: debt.id,
      operationId: payment.operation.id,
      expectedRevision: payment.operation.revision,
      accountId: ACCOUNT_A,
      operationDate: TODAY,
      amount: 150_000,
    })
    expect(await debts.getDebtDetail(debt.id)).toMatchObject({
      debt: { outstandingAmount: 450_000 },
      paidAmount: 550_000,
      progressPercent: 55,
    })

    await debts.voidPayment(edited.operation.id, edited.operation.revision)
    expect(await debts.getDebtDetail(debt.id)).toMatchObject({
      debt: { outstandingAmount: 600_000 },
      paidAmount: 400_000,
      progressPercent: 40,
    })
  })

  it("preserves pre-Perita and posted paid amounts when adjusting the total", async () => {
    const debt = await debts.createDebt({
      name: "Crédito anterior",
      totalAmount: 1_000_000,
      currentOutstandingAmount: 600_000,
      monthlyPaymentAmount: 100_000,
    })
    await debts.registerPayment({
      debtId: debt.id,
      accountId: ACCOUNT_A,
      operationDate: TODAY,
      amount: 100_000,
    })
    const current = await repositories.debts.get(debt.id)
    if (!current) throw new Error("fixture Debt missing")
    const adjusted = await debts.adjustDebtTotal(
      debt.id,
      current.revision,
      TODAY,
      1_200_000,
    )
    expect(adjusted).toMatchObject({
      totalAmount: 1_200_000,
      openingOutstanding: 600_000,
      outstandingAmount: 700_000,
    })
    const detail = await debts.getDebtDetail(debt.id)
    expect(detail.paidAmount).toBe(500_000)
    expect(detail.progressPercent).toBeCloseTo(41.67, 2)
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
      variableExpenseBudgetAmount: asClpAmount(0),
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

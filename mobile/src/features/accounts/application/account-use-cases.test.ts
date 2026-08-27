import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Account } from "@/domain/entities"
import type { Period, PeriodSnapshot } from "@/domain/periods"
import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asPeriodKey,
  asNonZeroClpDelta,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import { openPeritaDatabase, type PeritaDatabase } from "@/data/database"
import {
  createRepositories,
  type PeritaRepositories,
} from "@/data/repositories"
import { AccountUseCases } from "@/features/accounts/application/account-use-cases"
import { BalanceAdjustmentUseCases } from "@/features/accounts/application/balance-adjustment-use-cases"

const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")
const PERIOD_ID = asEntityId("10000000-0000-4000-8000-000000000001")

function openPeriod(): Period {
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

function idSequence() {
  let value = 10
  return () =>
    asEntityId(
      `10000000-0000-4000-8000-${String(value++).padStart(12, "0")}`,
    )
}

function accountSnapshot(account: Account): PeriodSnapshot {
  return {
    id: asEntityId("10000000-0000-4000-8000-000000009001"),
    periodId: PERIOD_ID,
    periodKey: asPeriodKey("2026-07"),
    schemaVersion: "1.1.0",
    snapshotKind: "canonical",
    closedAt: NOW,
    data: {
      periodPlan: { plannedSalaryAmount: asClpAmount(0), variableExpenseBudgetAmount: asClpAmount(0) },
      operations: [], movements: [], fixedExpenses: [], periodOpenings: [], auditEvents: [],
      entitySnapshots: { accounts: [account], savingsGoals: [], debts: [], categories: [] },
      openingBalances: {}, closingBalances: {},
      totals: {
        periodId: PERIOD_ID, periodKey: asPeriodKey("2026-07"), plannedSalaryAmount: asClpAmount(0),
        receivedSalaryAmount: asClpAmount(0), additionalIncomeAmount: asClpAmount(0), totalIncomeAmount: asClpAmount(0),
        fixedExpensePlannedAmount: asClpAmount(0), fixedExpensePaidAmount: asClpAmount(0), fixedExpenseUnpaidAmount: asClpAmount(0),
        variableExpenseAmount: asClpAmount(0), debtPaymentAmount: asClpAmount(0), netSavingsAmount: asClpAmount(0), availableAmount: asClpAmount(0),
      },
      warnings: [],
    },
    integrity: { algorithm: "SHA-256", payloadHash: "snapshot" },
  }
}

describe("AccountUseCases", () => {
  let database: PeritaDatabase
  let repositories: PeritaRepositories
  let useCases: AccountUseCases

  beforeEach(async () => {
    database = await openPeritaDatabase({
      name: `accounts-${crypto.randomUUID()}`,
      indexedDB: new IDBFactory(),
    })
    repositories = createRepositories(database)
    await repositories.periods.add(openPeriod())
    useCases = new AccountUseCases(repositories, {
      now: () => NOW,
      createId: idSequence(),
    })
  })

  afterEach(() => database.close())

  it("creates an active zero-balance account with opening and audit atomically", async () => {
    const account = await useCases.createAccount({
      emoji: "🏦",
      name: "  Cuenta principal  ",
      bank: "  Banco Estado  ",
    })

    expect(account).toMatchObject({
      emoji: "🏦",
      name: "Cuenta principal",
      bank: "Banco Estado",
      openingBalance: 0,
      currentBalance: 0,
      status: "active",
      revision: 1,
    })
    expect(await repositories.periodOpenings.listByPeriod(PERIOD_ID)).toEqual([
      expect.objectContaining({
        targetType: "account",
        targetId: account.id,
        openingAmount: 0,
      }),
    ])
    expect(await repositories.auditEvents.listBySubject("account", account.id)).toEqual([
      expect.objectContaining({
        action: "created",
        commandType: "account.create",
        previousValue: null,
        nextValue: account,
      }),
    ])
    expect(await repositories.operations.count()).toBe(0)
    expect(await repositories.movements.count()).toBe(0)
  })

  it("edits only descriptive data, advances revision and rejects stale/no-op writes", async () => {
    const created = await useCases.createAccount({ name: "Cuenta", bank: null })
    const edited = await useCases.editAccount({
      accountId: created.id,
      expectedRevision: created.revision,
      emoji: "💵",
      name: "Cuenta diaria",
      bank: "Banco Uno",
    })

    expect(edited).toMatchObject({
      emoji: "💵",
      name: "Cuenta diaria",
      bank: "Banco Uno",
      openingBalance: 0,
      currentBalance: 0,
      status: "active",
      revision: 2,
    })
    await expect(
      useCases.editAccount({
        accountId: edited.id,
        expectedRevision: created.revision,
        name: "Otro nombre",
        bank: edited.bank,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" })
    await expect(
      useCases.editAccount({
        accountId: edited.id,
        expectedRevision: edited.revision,
        name: edited.name,
        bank: edited.bank,
      }),
    ).rejects.toMatchObject({ code: "no_changes" })
  })

  it("requires an open period for every account mutation", async () => {
    await repositories.periods.delete(PERIOD_ID)

    await expect(
      useCases.createAccount({ name: "Sin período", bank: null }),
    ).rejects.toMatchObject({ code: "no_open_period" })
    expect(await repositories.accounts.count()).toBe(0)
  })

  it("returns enriched related history ordered by operation date", async () => {
    const created = await useCases.createAccount({ name: "Cuenta", bank: null })
    let id = 800
    const adjustments = new BalanceAdjustmentUseCases(repositories, {
      now: () => NOW,
      today: () => asCivilDate("2026-08-21"),
      createId: () => asEntityId(
        `10000000-0000-4000-8000-${String(id++).padStart(12, "0")}`,
      ),
    })
    const first = await adjustments.createAdjustment({
      accountId: created.id,
      expectedAccountRevision: created.revision,
      operationDate: asCivilDate("2026-08-19"),
      targetBalance: 20_000,
      reason: "Saldo inicial conciliado",
    })
    const second = await adjustments.createAdjustment({
      accountId: created.id,
      expectedAccountRevision: first.account.revision,
      operationDate: asCivilDate("2026-08-21"),
      targetBalance: 15_000,
      reason: "Comisión bancaria",
    })

    expect(await useCases.listRelatedMovements(created.id)).toEqual([
      expect.objectContaining({
        operation: expect.objectContaining({ id: second.operation.id }),
        movement: expect.objectContaining({ delta: -5_000 }),
        title: "Ajuste de saldo",
        description: "Comisión bancaria",
        signedAmount: -5_000,
      }),
      expect.objectContaining({
        operation: expect.objectContaining({ id: first.operation.id }),
        signedAmount: 20_000,
      }),
    ])
  })

  it("requires zero balance to deactivate and supports explicit reactivation", async () => {
    const created = await useCases.createAccount({ name: "Cuenta", bank: null })
    const withBalance: Account = {
      ...created,
      currentBalance: asClpAmount(25_000),
    }
    await repositories.accounts.put(withBalance)

    await expect(
      useCases.deactivateAccount({
        accountId: withBalance.id,
        expectedRevision: withBalance.revision,
      }),
    ).rejects.toMatchObject({ code: "nonzero_balance" })

    const atZero: Account = { ...withBalance, currentBalance: asClpAmount(0) }
    await repositories.accounts.put(atZero)
    const inactive = await useCases.deactivateAccount({
      accountId: atZero.id,
      expectedRevision: atZero.revision,
    })
    expect(inactive).toMatchObject({ status: "inactive", revision: 2 })

    await expect(
      useCases.deactivateAccount({
        accountId: inactive.id,
        expectedRevision: inactive.revision,
      }),
    ).rejects.toMatchObject({ code: "invalid_account_state" })
    expect(
      (await repositories.auditEvents.listBySubject("account", inactive.id)).map(
        ({ action }) => action,
      ),
    ).toEqual(["created", "deactivated"])
  })

  it("deletes a new zero-balance account with its current opening and audits", async () => {
    const removable = await useCases.createAccount({ name: "Temporal", bank: null })
    await useCases.createAccount({ name: "Principal", bank: null })

    expect(await useCases.canDeleteAccount(removable.id)).toBe(true)
    await useCases.deleteAccount({
      accountId: removable.id,
      expectedRevision: removable.revision,
    })

    expect(await repositories.accounts.get(removable.id)).toBeUndefined()
    expect((await repositories.periodOpenings.getAll()).some(({ targetId }) => targetId === removable.id)).toBe(false)
    expect(await repositories.auditEvents.listBySubject("account", removable.id)).toEqual([])
  })

  it("blocks account deletion after any movement, snapshot, or when it is the last account", async () => {
    const used = await useCases.createAccount({ name: "Usada", bank: null })
    await useCases.createAccount({ name: "Otra", bank: null })
    await repositories.movements.add({
      id: asEntityId("10000000-0000-4000-8000-000000009002"), operationId: asEntityId("10000000-0000-4000-8000-000000009003"),
      periodId: PERIOD_ID, targetType: "account", targetId: used.id, effectType: "asset_balance",
      delta: asNonZeroClpDelta(1), status: "voided", createdAt: NOW, updatedAt: NOW,
    })
    await expect(useCases.deleteAccount({ accountId: used.id, expectedRevision: used.revision })).rejects.toMatchObject({ code: "cannot_delete" })

    const historical = await useCases.createAccount({ name: "Histórica", bank: null })
    await repositories.periodSnapshots.add(accountSnapshot(historical))
    await expect(useCases.deleteAccount({ accountId: historical.id, expectedRevision: historical.revision })).rejects.toMatchObject({ code: "cannot_delete" })

    for (const account of await repositories.accounts.getAll()) {
      if (account.id !== historical.id) await repositories.accounts.delete(account.id)
    }
    await expect(useCases.deleteAccount({ accountId: historical.id, expectedRevision: historical.revision })).rejects.toMatchObject({ code: "cannot_delete" })
  })

  it("leaves account, opening and audits intact when deletion conflicts", async () => {
    const removable = await useCases.createAccount({ name: "Temporal", bank: null })
    await useCases.createAccount({ name: "Otra", bank: null })
    const originalDelete = repositories.accounts.deleteUnused.bind(repositories.accounts)
    const repository = repositories.accounts as { deleteUnused: typeof originalDelete }
    repository.deleteUnused = async (input) => {
      await repositories.accounts.put({ ...removable, revision: asRevision(2) })
      await originalDelete(input)
    }

    await expect(useCases.deleteAccount({ accountId: removable.id, expectedRevision: removable.revision })).rejects.toMatchObject({ code: "revision_conflict" })
    expect(await repositories.accounts.get(removable.id)).toBeDefined()
    expect((await repositories.periodOpenings.getAll()).some(({ targetId }) => targetId === removable.id)).toBe(true)
    expect(await repositories.auditEvents.listBySubject("account", removable.id)).not.toEqual([])
  })
})

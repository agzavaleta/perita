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
      deletedAt: null,
      balanceAtDeletion: null,
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

  it("logically deletes an account with positive balance and history", async () => {
    const created = await useCases.createAccount({ name: "Usada", bank: "Banco" })
    let id = 900
    const adjustments = new BalanceAdjustmentUseCases(repositories, {
      now: () => NOW,
      today: () => asCivilDate("2026-08-21"),
      createId: () => asEntityId(
        `10000000-0000-4000-8000-${String(id++).padStart(12, "0")}`,
      ),
    })
    const adjusted = await adjustments.createAdjustment({
      accountId: created.id,
      expectedAccountRevision: created.revision,
      operationDate: asCivilDate("2026-08-21"),
      targetBalance: 25_000,
      reason: "Conciliación",
    })

    await useCases.deleteAccount({
      accountId: created.id,
      expectedRevision: adjusted.account.revision,
    })

    const deleted = await repositories.accounts.get(created.id)
    expect(deleted).toMatchObject({
      id: created.id,
      name: "Usada",
      bank: "Banco",
      currentBalance: 25_000,
      balanceAtDeletion: 25_000,
      deletedAt: NOW,
      status: "deleted",
      revision: 3,
    })
    expect(await useCases.listAccounts()).toEqual([])
    expect(await useCases.listRelatedMovements(created.id)).toEqual([
      expect.objectContaining({
        operation: expect.objectContaining({ id: adjusted.operation.id }),
        signedAmount: 25_000,
      }),
    ])
    expect(await repositories.periodOpenings.listByPeriod(PERIOD_ID)).toEqual([
      expect.objectContaining({ targetId: created.id }),
    ])
    expect(await repositories.auditEvents.listBySubject("account", created.id)).toEqual([
      expect.objectContaining({ action: "created", commandType: "account.create" }),
      expect.objectContaining({
        action: "deleted",
        commandType: "account.delete",
        previousRevision: 2,
        nextRevision: 3,
        previousValue: adjusted.account,
        nextValue: deleted,
      }),
    ])
    await expect(adjustments.createAdjustment({
      accountId: created.id,
      expectedAccountRevision: deleted?.revision ?? asRevision(0),
      operationDate: asCivilDate("2026-08-21"),
      targetBalance: 30_000,
      reason: "No permitido",
    })).rejects.toMatchObject({ code: "inactive_account" })
  })

  it("logically deletes an account with a negative balance", async () => {
    const created = await useCases.createAccount({ name: "Sobregiro", bank: null })
    const negative: Account = {
      ...created,
      currentBalance: asClpAmount(-25_000, { allowNegative: true }),
    }
    await repositories.accounts.put(negative)

    await useCases.deleteAccount({
      accountId: negative.id,
      expectedRevision: negative.revision,
    })

    expect(await repositories.accounts.get(negative.id)).toMatchObject({
      currentBalance: -25_000,
      balanceAtDeletion: -25_000,
      deletedAt: NOW,
      status: "deleted",
    })
  })

  it("validates the expected revision before logical deletion", async () => {
    const created = await useCases.createAccount({ name: "Cuenta", bank: null })

    await expect(useCases.deleteAccount({
      accountId: created.id,
      expectedRevision: asRevision(99),
    })).rejects.toMatchObject({ code: "revision_conflict" })
    expect(await repositories.accounts.get(created.id)).toEqual(created)
  })

  it("rejects edits, status changes and repeated deletion after logical deletion", async () => {
    const created = await useCases.createAccount({ name: "Cuenta", bank: null })
    await useCases.deleteAccount({
      accountId: created.id,
      expectedRevision: created.revision,
    })
    const deleted = await useCases.getAccount(created.id)

    await expect(useCases.editAccount({
      accountId: deleted.id,
      expectedRevision: deleted.revision,
      name: "Renombrada",
      bank: null,
    })).rejects.toMatchObject({ code: "invalid_account_state" })
    await expect(useCases.deactivateAccount({
      accountId: deleted.id,
      expectedRevision: deleted.revision,
    })).rejects.toMatchObject({ code: "invalid_account_state" })
    await expect(useCases.deleteAccount({
      accountId: deleted.id,
      expectedRevision: deleted.revision,
    })).rejects.toMatchObject({ code: "invalid_account_state" })
  })
})

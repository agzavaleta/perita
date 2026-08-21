import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Account } from "@/domain/entities"
import type { Period } from "@/domain/periods"
import {
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

const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")
const PERIOD_ID = asEntityId("10000000-0000-4000-8000-000000000001")

function openPeriod(): Period {
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
      name: "  Cuenta principal  ",
      bank: "  Banco Estado  ",
    })

    expect(account).toMatchObject({
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
      name: "Cuenta diaria",
      bank: "Banco Uno",
    })

    expect(edited).toMatchObject({
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
})

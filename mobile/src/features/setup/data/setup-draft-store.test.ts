import { IDBFactory } from "fake-indexeddb"
import { describe, expect, it } from "vitest"

import {
  openSetupDraftStore,
  type SetupDraft,
} from "@/features/setup/data/setup-draft-store"

const FIRST_DRAFT: SetupDraft = {
  periodKey: "2026-08",
  salaryReferenceAmount: 900_000,
  account: {
    id: "draft-account-1",
    name: "Principal",
    bank: "BancoEstado",
    openingBalance: 100_000,
    emoji: "💳",
  },
}

describe("SetupDraftStore", () => {
  it("saves, reopens and clears the single setup draft", async () => {
    const indexedDB = new IDBFactory()
    const options = { name: "setup-draft-lifecycle", indexedDB }
    const firstConnection = await openSetupDraftStore(options)
    expect(await firstConnection.read()).toBeNull()
    await firstConnection.save(FIRST_DRAFT)
    firstConnection.close()

    const reopened = await openSetupDraftStore(options)
    expect(await reopened.read()).toEqual(FIRST_DRAFT)
    await reopened.clear()
    expect(await reopened.read()).toBeNull()
    reopened.close()
  })

  it("replaces the existing draft instead of accumulating records", async () => {
    const store = await openSetupDraftStore({
      name: "setup-draft-replace",
      indexedDB: new IDBFactory(),
    })
    await store.save(FIRST_DRAFT)
    const replacement: SetupDraft = {
      ...FIRST_DRAFT,
      periodKey: "2026-06",
      account: { ...FIRST_DRAFT.account, name: "Reemplazada" },
    }

    await store.save(replacement)

    expect(await store.read()).toEqual(replacement)
    store.close()
  })

  it("adapts a legacy draft using only its first account", async () => {
    const store = await openSetupDraftStore({
      name: "setup-draft-legacy",
      indexedDB: new IDBFactory(),
    })
    await store.save({
      periodKey: "2025-03",
      salaryReferenceAmount: 1_200_000,
      variableExpenseBudgetAmount: 350_000,
      accounts: [
        {
          id: "legacy-first",
          name: "Principal",
          bank: null,
          openingBalance: 45_000,
          emoji: "💳",
        },
        {
          id: "legacy-second",
          name: "Efectivo",
          bank: null,
          openingBalance: 10_000,
          emoji: "💵",
        },
      ],
    } as unknown as SetupDraft)

    expect(await store.read()).toEqual({
      periodKey: "2025-03",
      salaryReferenceAmount: 1_200_000,
      account: {
        id: "legacy-first",
        name: "Principal",
        bank: null,
        openingBalance: 45_000,
        emoji: "💳",
      },
    })
    store.close()
  })
})

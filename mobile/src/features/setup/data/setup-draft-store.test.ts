import { IDBFactory } from "fake-indexeddb"
import { describe, expect, it } from "vitest"

import {
  openSetupDraftStore,
  type SetupDraft,
} from "@/features/setup/data/setup-draft-store"

const FIRST_DRAFT: SetupDraft = {
  periodKey: "2026-08",
  salaryReferenceAmount: 900_000,
  variableExpenseBudgetAmount: 250_000,
  accounts: [{
    id: "draft-account-1",
    name: "Principal",
    bank: "BancoEstado",
    openingBalance: 100_000,
    emoji: "💳",
  }],
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
      accounts: [{ ...FIRST_DRAFT.accounts[0]!, name: "Reemplazada" }],
    }

    await store.save(replacement)

    expect(await store.read()).toEqual(replacement)
    store.close()
  })
})

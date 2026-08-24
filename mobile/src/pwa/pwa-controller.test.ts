import { IDBFactory } from "fake-indexeddb"
import { describe, expect, it, vi } from "vitest"

import {
  asClpAmount,
  asEntityId,
  asRevision,
  asUtcTimestamp,
  type Account,
} from "@/domain"
import { createRepositories, openPeritaDatabase } from "@/data"
import { PwaController, type PwaState } from "@/pwa/pwa-controller"

class FakeRegistration extends EventTarget {
  readonly waitingWorker = { postMessage: vi.fn() }
  waiting: ServiceWorker | null = this.waitingWorker as unknown as ServiceWorker
  installing: ServiceWorker | null = null
  readonly update = vi.fn().mockResolvedValue(undefined)
}

class FakeServiceWorkerContainer extends EventTarget {
  controller = {} as ServiceWorker
  readonly register = vi.fn()
  readonly ready: Promise<ServiceWorkerRegistration>

  readonly registration: FakeRegistration

  constructor(registration: FakeRegistration) {
    super()
    this.registration = registration
    this.register.mockResolvedValue(registration)
    this.ready = Promise.resolve(registration as unknown as ServiceWorkerRegistration)
  }
}

function setupController() {
  const registration = new FakeRegistration()
  const serviceWorker = new FakeServiceWorkerContainer(registration)
  const reload = vi.fn()
  const controller = new PwaController({
    serviceWorker,
    windowTarget: window,
    documentTarget: document,
    reload,
    updateIntervalMs: 2_147_483_647,
  })
  const states: PwaState[] = []
  controller.subscribe((state) => states.push(state))
  return { controller, registration, serviceWorker, reload, states }
}

function account(): Account {
  const timestamp = asUtcTimestamp("2026-08-21T12:00:00.000Z")
  return {
    id: asEntityId("00000000-0000-4000-8000-000000000001"),
    emoji: "💳",
    name: "Cuenta persistente",
    bank: null,
    openingBalance: asClpAmount(25_000),
    currentBalance: asClpAmount(25_000),
    status: "active",
    revision: asRevision(1),
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

describe("PWA update controller", () => {
  it("registers without HTTP cache and activates a waiting worker only after consent", async () => {
    const f = setupController()
    await f.controller.start()

    expect(f.serviceWorker.register).toHaveBeenCalledWith("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    })
    expect(f.states.at(-1)?.updateAvailable).toBe(true)
    expect(f.registration.waitingWorker.postMessage).not.toHaveBeenCalled()

    await f.controller.acceptUpdate()
    expect(f.registration.waitingWorker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" })
    expect(f.reload).not.toHaveBeenCalled()

    f.serviceWorker.dispatchEvent(new Event("controllerchange"))
    f.serviceWorker.dispatchEvent(new Event("controllerchange"))
    expect(f.reload).toHaveBeenCalledTimes(1)
    f.controller.dispose()
  })

  it("does not reload after an early controller change until the user accepts", async () => {
    const f = setupController()
    f.registration.waiting = null
    await f.controller.start()

    f.serviceWorker.dispatchEvent(new Event("controllerchange"))
    expect(f.states.at(-1)?.updateAvailable).toBe(true)
    expect(f.reload).not.toHaveBeenCalled()

    await f.controller.acceptUpdate()
    expect(f.reload).toHaveBeenCalledTimes(1)
    f.controller.dispose()
  })

  it("preserves IndexedDB records across service-worker activation and reopening", async () => {
    const factory = new IDBFactory()
    const options = { name: "pwa-update-persistence", indexedDB: factory }
    const first = await openPeritaDatabase(options)
    await createRepositories(first).accounts.add(account())

    const f = setupController()
    await f.controller.start()
    await f.controller.acceptUpdate()
    f.serviceWorker.dispatchEvent(new Event("controllerchange"))
    first.close()

    const reopened = await openPeritaDatabase(options)
    expect(await createRepositories(reopened).accounts.get(account().id)).toEqual(account())
    reopened.close()
    f.controller.dispose()
  })
})

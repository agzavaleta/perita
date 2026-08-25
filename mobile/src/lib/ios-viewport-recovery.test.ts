import { afterEach, describe, expect, it, vi } from "vitest"

import { installIosViewportRecovery } from "@/lib/ios-viewport-recovery"

type AnimationFrameCallback = (time: number) => void

function createAnimationFrameQueue() {
  let nextId = 1
  const callbacks = new Map<number, AnimationFrameCallback>()

  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextId
    nextId += 1
    callbacks.set(id, callback)
    return id
  })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id)
  })

  return {
    flush() {
      const queuedCallbacks = [...callbacks.values()]
      callbacks.clear()
      queuedCallbacks.forEach((callback) => callback(0))
    },
    size() {
      return callbacks.size
    },
  }
}

describe("installIosViewportRecovery", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  })

  it("recovers after focus, viewport resize and blur without moving main content", () => {
    const frames = createAnimationFrameQueue()
    const viewport = new EventTarget()
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    })

    const main = document.createElement("main")
    main.id = "main-content"
    main.scrollTop = 246
    const input = document.createElement("input")
    main.append(input)
    document.body.append(main)
    document.documentElement.scrollTop = 19
    document.body.scrollTop = 11

    const uninstall = installIosViewportRecovery({ enabled: true })

    input.focus()
    viewport.dispatchEvent(new Event("resize"))
    expect(frames.size()).toBe(0)

    input.blur()
    expect(frames.size()).toBe(1)
    expect(document.documentElement.scrollTop).toBe(19)

    frames.flush()
    expect(frames.size()).toBe(1)
    expect(document.documentElement.scrollTop).toBe(19)

    frames.flush()
    expect(document.documentElement.scrollTop).toBe(0)
    expect(document.body.scrollTop).toBe(0)
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
    expect(main.scrollTop).toBe(246)

    uninstall()
  })

  it("removes listeners and cancels a pending recovery", () => {
    const frames = createAnimationFrameQueue()
    const viewport = new EventTarget()
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    })

    const input = document.createElement("input")
    document.body.append(input)
    const uninstall = installIosViewportRecovery({ enabled: true })

    input.focus()
    input.blur()
    expect(frames.size()).toBe(1)

    uninstall()
    expect(frames.size()).toBe(0)

    input.focus()
    viewport.dispatchEvent(new Event("resize"))
    input.blur()
    expect(frames.size()).toBe(0)
  })
})

import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PwaStatus } from "@/pwa/PwaStatus"

describe("PwaStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("shows each online-to-offline transition for four seconds", () => {
    render(<PwaStatus />)
    const message = "Sin conexión · tus datos locales siguen disponibles"

    expect(screen.queryByText(message)).toBeNull()
    act(() => window.dispatchEvent(new Event("offline")))
    expect(screen.getByText(message)).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(3_999))
    expect(screen.getByText(message)).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByText(message)).toBeNull()

    act(() => window.dispatchEvent(new Event("offline")))
    expect(screen.queryByText(message)).toBeNull()

    act(() => window.dispatchEvent(new Event("online")))
    act(() => window.dispatchEvent(new Event("offline")))
    expect(screen.getByText(message)).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(4_000))
    expect(screen.queryByText(message)).toBeNull()
  })

  it("does not render an offline-readiness banner", () => {
    render(<PwaStatus />)

    expect(
      screen.queryByText("Perita está lista para usarse offline."),
    ).toBeNull()
  })

  it("shows the deferred update action as an outlined button", async () => {
    const registration = {
      waiting: { postMessage: vi.fn() },
      installing: null,
      addEventListener: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as ServiceWorkerRegistration
    const serviceWorker = Object.assign(new EventTarget(), {
      controller: {} as ServiceWorker,
      register: vi.fn().mockResolvedValue(registration),
    })
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: serviceWorker,
    })

    render(<PwaStatus />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const later = screen.getByRole("button", { name: "Después" })
    expect(later).toHaveAttribute("data-variant", "outline")
    expect(screen.getByRole("button", { name: "Actualizar ahora" }))
      .toHaveAttribute("data-variant", "default")
    fireEvent.click(later)
    expect(screen.queryByText("Hay una nueva versión de Perita.")).toBeNull()
  })
})

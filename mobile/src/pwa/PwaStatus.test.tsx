import { act, render, screen } from "@testing-library/react"
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
})

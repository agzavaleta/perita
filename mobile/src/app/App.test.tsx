import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { App } from "@/app/App"
import type { SetupUseCasesPort } from "@/features/setup/application/setup-use-cases"

function setupService(status: "not_started" | "incomplete" | "completed"): SetupUseCasesPort {
  return {
    getState: vi.fn().mockResolvedValue({
      status,
      allowedPeriodKeys: ["2026-08", "2026-07"],
      draft: null,
    }),
    saveDraft: vi.fn(),
    deleteDraft: vi.fn(),
    completeSetup: vi.fn(),
  }
}

describe("App", () => {
  it("shows one dynamic page heading in the header while navigating", async () => {
    render(<App setupUseCases={setupService("completed")} />)

    const movementsButton = await screen.findByRole("button", { name: "Movimientos" })
    const logo = document.querySelector<HTMLImageElement>(
      'header img[src="/apple-touch-icon-v2.png"]',
    )
    expect(logo).toBeInTheDocument()
    expect(logo).toHaveAttribute("alt", "")
    expect(logo).toHaveClass("size-8")
    expect(logo?.parentElement).toHaveTextContent("Inicio")
    expect(movementsButton.querySelector("span")).toHaveClass("whitespace-nowrap")
    expect(movementsButton.querySelector("span")).not.toHaveClass("truncate")
    expect(screen.getAllByRole("heading", { name: "Inicio" })).toHaveLength(1)
    expect(document.querySelector("main h1")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Movimientos" }))
    await screen.findByRole("heading", { name: "Movimientos" })
    expect(screen.getAllByRole("heading", { name: "Movimientos" })).toHaveLength(1)
    expect(document.querySelector("main h1")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Cuentas" }))
    await screen.findByRole("heading", { name: "Cuentas" })
    expect(screen.getAllByRole("heading", { name: "Cuentas" })).toHaveLength(1)
    expect(document.querySelector("main h1")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Planificar" }))
    await screen.findByRole("heading", { name: "Planificar" })
    expect(screen.getAllByRole("heading", { name: "Planificar" })).toHaveLength(1)
    expect(document.querySelector("main h1")).toBeNull()
    expect(screen.queryByText("Metas, gastos fijos, deudas y cierre del período.")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Configuración" }))
    await screen.findByRole("heading", { name: "Configuración" })
    expect(screen.getAllByRole("heading", { name: "Configuración" })).toHaveLength(1)
    expect(document.querySelector("main h1")).toBeNull()
  })

  it("conecta ingreso, gasto y Mover dinero", async () => {
    render(<App setupUseCases={setupService("completed")} />)

    await screen.findByRole("button", { name: "Agregar movimiento" })

    fireEvent.click(screen.getByRole("button", { name: "Agregar movimiento" }))

    const dialog = screen.getByRole("dialog")
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveClass("mx-auto")
    expect(dialog).not.toHaveClass("-translate-x-1/2")
    expect(
      screen.getByRole("button", { name: "Registrar ingreso" }),
    ).toBeEnabled()
    expect(
      screen.getByRole("button", { name: "Registrar gasto" }),
    ).toBeEnabled()
    expect(
      screen.getByRole("button", { name: "Mover dinero" }),
    ).toBeEnabled()

    fireEvent.click(screen.getByRole("button", { name: "Registrar ingreso" }))
    expect(await screen.findByRole("heading", { name: "Movimientos" })).toBeInTheDocument()
  })

  it("opens a new installation on guided Inicio and blocks normal navigation", async () => {
    render(<App setupUseCases={setupService("not_started")} />)

    expect(await screen.findByRole("heading", { name: "Comienza en Perita" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Movimientos" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Agregar movimiento" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Comenzar" })).toBeDisabled()
  })
})

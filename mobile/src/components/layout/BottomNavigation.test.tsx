import { render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { BottomNavigation } from "@/components/layout/BottomNavigation"

describe("BottomNavigation", () => {
  it("renders the accessible actions in the required order", () => {
    render(
      <BottomNavigation
        activeSection="home"
        onNavigate={vi.fn()}
        onQuickAction={vi.fn()}
      />,
    )

    const navigation = screen.getByRole("navigation", {
      name: "Navegación principal",
    })
    const labels = within(navigation)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent)

    expect(labels).toEqual([
      "Inicio",
      "Cuentas",
      "Agregar movimiento",
      "Planificar",
      "Movimientos",
    ])
  })
})

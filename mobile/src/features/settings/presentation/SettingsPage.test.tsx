import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { SettingsUseCasesPort } from "@/features/settings/application/settings-use-cases"
import { SettingsPage } from "@/features/settings/presentation/SettingsPage"

function useCases(): SettingsUseCasesPort {
  return {
    getSettings: vi.fn().mockResolvedValue(null),
    updateReferenceSalary: vi.fn().mockImplementation(async (amount: number) => ({
      key: "current", salaryReferenceAmount: amount, currency: "CLP",
      timezone: "America/Santiago", revision: 1,
      createdAt: "2026-08-21T12:00:00.000Z", updatedAt: "2026-08-21T12:00:00.000Z",
    })),
    exportBackup: vi.fn().mockResolvedValue({ documentType: "perita-backup" }),
    validateBackup: vi.fn(),
    restoreBackup: vi.fn(),
    deleteAllData: vi.fn().mockResolvedValue({ deleted: true }),
  } as unknown as SettingsUseCasesPort
}

describe("SettingsPage", () => {
  it("renders the V1.1.0 settings and keeps destructive deletion gated", async () => {
    const api = useCases()
    render(<SettingsPage useCases={api} />)

    expect(await screen.findByText("Contrato de datos")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Configuración" })).toBeInTheDocument()
    const destructive = screen.getByRole("button", { name: "Eliminar definitivamente" })
    expect(destructive).toBeDisabled()

    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    fireEvent.click(screen.getByRole("button", { name: "Exportar respaldo" }))
    await waitFor(() => expect(api.exportBackup).toHaveBeenCalled())
    click.mockRestore()
    fireEvent.change(screen.getByLabelText("Escribe ELIMINAR"), { target: { value: "ELIMINAR" } })
    expect(destructive).toBeEnabled()
  })

  it("saves the reference salary through the application use case", async () => {
    const api = useCases()
    render(<SettingsPage useCases={api} />)
    const input = await screen.findByLabelText("Sueldo mensual (CLP)")
    fireEvent.change(input, { target: { value: "1000000" } })
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }))
    await waitFor(() => expect(api.updateReferenceSalary).toHaveBeenCalledWith(1_000_000))
  })
})

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { Category } from "@/domain/entities"
import { asEntityId, asRevision, asUtcTimestamp } from "@/domain/primitives"
import type { CategoryUseCasesPort } from "@/features/settings/application/category-use-cases"
import type { SettingsUseCasesPort } from "@/features/settings/application/settings-use-cases"
import { SettingsPage } from "@/features/settings/presentation/SettingsPage"

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const NOW = asUtcTimestamp("2026-08-24T12:00:00.000Z")
const ACTIVE_ID = asEntityId("c4b00000-0000-4000-8000-000000000001")
const INACTIVE_ID = asEntityId("c4b00000-0000-4000-8000-000000000002")
const NEW_ID = asEntityId("c4b00000-0000-4000-8000-000000000003")

function category(
  id: typeof ACTIVE_ID,
  name: string,
  status: Category["status"] = "active",
): Category {
  return {
    id,
    name,
    status,
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

const INITIAL_CATEGORIES = [
  category(ACTIVE_ID, "Alimentación"),
  category(INACTIVE_ID, "Anterior", "inactive"),
]

function settingsUseCases(): SettingsUseCasesPort {
  return {
    getSettings: vi.fn().mockResolvedValue(null),
    updateReferenceSalary: vi.fn().mockImplementation(async (amount: number) => ({
      key: "current", salaryReferenceAmount: amount, currency: "CLP",
      timezone: "America/Santiago", revision: 1,
      createdAt: NOW, updatedAt: NOW,
    })),
    exportBackup: vi.fn().mockResolvedValue({ documentType: "perita-backup" }),
    validateBackup: vi.fn(),
    restoreBackup: vi.fn(),
    deleteAllData: vi.fn().mockResolvedValue({ deleted: true }),
  } as unknown as SettingsUseCasesPort
}

function categoryUseCases(
  initial: readonly Category[] = INITIAL_CATEGORIES,
): CategoryUseCasesPort {
  let values = [...initial]
  return {
    ensureDefaultCategories: vi.fn(async () => values),
    listCategories: vi.fn(async () => values),
    listActiveCategories: vi.fn(async () =>
      values.filter(({ status }) => status === "active"),
    ),
    createCategory: vi.fn(async (name: string) => {
      const created = category(NEW_ID, name.trim())
      values = [...values, created]
      return created
    }),
    renameCategory: vi.fn(async (id, expectedRevision, name) => {
      const previous = values.find((item) => item.id === id)!
      const renamed: Category = {
        ...previous,
        name: name.trim(),
        revision: asRevision(Number(expectedRevision) + 1),
        updatedAt: NOW,
      }
      values = values.map((item) => item.id === id ? renamed : item)
      return renamed
    }),
    deactivateCategory: vi.fn(async (id, expectedRevision) => {
      const previous = values.find((item) => item.id === id)!
      const inactive: Category = {
        ...previous,
        status: "inactive",
        revision: asRevision(Number(expectedRevision) + 1),
        updatedAt: NOW,
      }
      values = values.map((item) => item.id === id ? inactive : item)
      return inactive
    }),
  }
}

function renderSettings(
  categories: CategoryUseCasesPort = categoryUseCases(),
) {
  const settings = settingsUseCases()
  render(<SettingsPage useCases={settings} categoryUseCases={categories} />)
  return { settings, categories }
}

describe("SettingsPage", () => {
  it("renders settings, loads active and inactive categories, and gates deletion", async () => {
    const { settings, categories } = renderSettings()

    expect(await screen.findByText("Contrato de datos")).toBeInTheDocument()
    expect(await screen.findByText("Alimentación")).toBeInTheDocument()
    expect(screen.getByText("Anterior")).toBeInTheDocument()
    expect(screen.getByText("Activa")).toBeInTheDocument()
    expect(screen.getByText("Inactiva")).toBeInTheDocument()
    expect(screen.getByText(
      "Preferencias, respaldo y administración de tus datos.",
    )).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Configuración" })).toBeNull()
    expect(categories.listCategories).toHaveBeenCalledOnce()
    const destructive = screen.getByRole("button", { name: "Eliminar definitivamente" })
    expect(destructive).toBeDisabled()

    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    fireEvent.click(screen.getByRole("button", { name: "Exportar respaldo" }))
    await waitFor(() => expect(settings.exportBackup).toHaveBeenCalled())
    click.mockRestore()
    fireEvent.change(screen.getByLabelText("Escribe ELIMINAR"), {
      target: { value: "ELIMINAR" },
    })
    expect(destructive).toBeEnabled()
  })

  it("saves the reference salary through its separate application port", async () => {
    const { settings } = renderSettings()
    const input = await screen.findByLabelText("Sueldo mensual (CLP)")
    fireEvent.change(input, { target: { value: "1000000" } })
    expect(input).toHaveValue("1.000.000")
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }))
    await waitFor(() => expect(settings.updateReferenceSalary).toHaveBeenCalledWith(1_000_000))
  })

  it("keeps zero visible and normalizes an empty salary safely", async () => {
    const { settings } = renderSettings()
    const input = await screen.findByLabelText("Sueldo mensual (CLP)")

    expect(input).toHaveValue("0")
    fireEvent.change(input, { target: { value: "" } })
    expect(input).toHaveValue("")
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }))

    await waitFor(() =>
      expect(settings.updateReferenceSalary).toHaveBeenCalledWith(0),
    )
    expect(input).toHaveValue("0")
  })

  it("opens a non-autofocused Sheet, creates a category, and updates the list", async () => {
    const { categories } = renderSettings()
    await screen.findByText("Alimentación")

    fireEvent.click(screen.getByRole("button", { name: "Nueva categoría" }))
    expect(screen.getByRole("heading", { name: "Nueva categoría" })).toBeInTheDocument()
    const input = screen.getByLabelText("Nombre")
    expect(input).not.toHaveFocus()
    expect(input).not.toHaveAttribute("autofocus")
    fireEvent.change(input, { target: { value: "Educación" } })
    fireEvent.click(screen.getByRole("button", { name: "Guardar categoría" }))

    await waitFor(() => expect(categories.createCategory).toHaveBeenCalledWith("Educación"))
    expect(await screen.findByText("Educación")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Nueva categoría" })).not.toBeInTheDocument()
  })

  it("keeps the creation Sheet open and displays a duplicate error", async () => {
    const categories = categoryUseCases()
    vi.mocked(categories.createCategory).mockRejectedValueOnce(
      new Error("Ya existe una categoría con ese nombre."),
    )
    renderSettings(categories)
    await screen.findByText("Alimentación")

    fireEvent.click(screen.getByRole("button", { name: "Nueva categoría" }))
    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "alimentación" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Guardar categoría" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Ya existe una categoría con ese nombre.",
    )
    expect(screen.getByRole("heading", { name: "Nueva categoría" })).toBeInTheDocument()
  })

  it("renames an active category with its current revision", async () => {
    const { categories } = renderSettings()
    await screen.findByText("Alimentación")

    fireEvent.click(screen.getByRole("button", { name: "Editar Alimentación" }))
    expect(screen.getByRole("heading", { name: "Editar categoría" })).toBeInTheDocument()
    const input = screen.getByLabelText("Nombre")
    expect(input).toHaveValue("Alimentación")
    fireEvent.change(input, { target: { value: "Comida" } })
    fireEvent.click(screen.getByRole("button", { name: "Guardar categoría" }))

    await waitFor(() =>
      expect(categories.renameCategory).toHaveBeenCalledWith(
        ACTIVE_ID,
        asRevision(1),
        "Comida",
      ),
    )
    expect(await screen.findByText("Comida")).toBeInTheDocument()
  })

  it("confirms deactivation and keeps the category visible as inactive", async () => {
    const { categories } = renderSettings()
    await screen.findByText("Alimentación")

    fireEvent.click(screen.getByRole("button", { name: "Desactivar Alimentación" }))
    const dialog = screen.getByRole("alertdialog")
    expect(within(dialog).getByText(/ya no estará disponible para nuevos gastos/i)).toBeInTheDocument()
    expect(within(dialog).getByText(/gastos históricos conservarán/i)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole("button", { name: "Desactivar categoría" }))

    await waitFor(() =>
      expect(categories.deactivateCategory).toHaveBeenCalledWith(
        ACTIVE_ID,
        asRevision(1),
      ),
    )
    expect(screen.getByText("Alimentación")).toBeInTheDocument()
    expect(screen.getAllByText("Inactiva")).toHaveLength(2)
    expect(screen.queryByRole("button", { name: "Desactivar Alimentación" })).not.toBeInTheDocument()
  })

  it("offers neither reactivation nor physical category deletion", async () => {
    renderSettings()
    await screen.findByText("Anterior")

    expect(screen.queryByRole("button", { name: /Reactivar/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Eliminar Alimentación/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Editar Anterior/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Desactivar Anterior/ })).not.toBeInTheDocument()
  })
})

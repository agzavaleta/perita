import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { Account, Category } from "@/domain/entities"
import type { Movement, Operation } from "@/domain/operations"
import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asNonZeroClpDelta,
  asPositiveClpAmount,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import type {
  MovementFormOptions,
  MovementListItem,
  MovementUseCasesPort,
} from "@/features/movements/application/movement-use-cases"
import { categoryBadgeClassName } from "@/features/movements/presentation/category-badge-style"
import { MovementForm } from "@/features/movements/presentation/MovementForm"

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const NOW = asUtcTimestamp("2026-08-24T12:00:00.000Z")
const TODAY = asCivilDate("2026-08-24")
const ACCOUNT_ID = asEntityId("c4c00000-0000-4000-8000-000000000001")
const ACTIVE_ID = asEntityId("c4c00000-0000-4000-8000-000000000002")
const INACTIVE_ID = asEntityId("c4c00000-0000-4000-8000-000000000003")
const PERIOD_ID = asEntityId("c4c00000-0000-4000-8000-000000000004")
const OPERATION_ID = asEntityId("c4c00000-0000-4000-8000-000000000005")
const MOVEMENT_ID = asEntityId("c4c00000-0000-4000-8000-000000000006")

const account: Account = {
  id: ACCOUNT_ID,
  emoji: "💳",
  name: "Principal",
  bank: null,
  openingBalance: asClpAmount(50_000),
  currentBalance: asClpAmount(50_000),
  status: "active",
  revision: asRevision(1),
  createdAt: NOW,
  updatedAt: NOW,
}

function category(
  id: typeof ACTIVE_ID,
  name: string,
  status: Category["status"],
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

const active = category(ACTIVE_ID, "Alimentación", "active")
const inactive = category(INACTIVE_ID, "Viajes antiguos", "inactive")

const historicalOperation: Operation = {
  id: OPERATION_ID,
  periodId: PERIOD_ID,
  type: "variable_expense",
  operationDate: TODAY,
  amount: asPositiveClpAmount(10_000),
  details: {
    accountId: ACCOUNT_ID,
    categoryId: INACTIVE_ID,
    categoryName: "Nombre histórico conservado",
    concept: "Pasaje",
    observation: null,
  },
  status: "posted",
  voidedAt: null,
  voidReason: null,
  revision: asRevision(2),
  createdAt: NOW,
  updatedAt: NOW,
}

const historicalMovement: Movement = {
  id: MOVEMENT_ID,
  operationId: OPERATION_ID,
  periodId: PERIOD_ID,
  targetType: "account",
  targetId: ACCOUNT_ID,
  effectType: "asset_balance",
  delta: asNonZeroClpDelta(-10_000),
  status: "posted",
  createdAt: NOW,
  updatedAt: NOW,
}

const historicalItem: MovementListItem = {
  operation: historicalOperation,
  movement: historicalMovement,
  movements: [historicalMovement],
  kind: "expense",
  title: "Pasaje",
  description: "Nombre histórico conservado",
  accountName: account.name,
  signedAmount: -10_000,
}

function options(categories: readonly Category[]): MovementFormOptions {
  return { accounts: [account], categories, currentDate: TODAY }
}

function service(overrides: Partial<MovementUseCasesPort> = {}) {
  return {
    registerIncome: vi.fn().mockResolvedValue(historicalItem),
    registerExpense: vi.fn().mockResolvedValue(historicalItem),
    editMovement: vi.fn().mockResolvedValue(historicalItem),
    ...overrides,
  } as unknown as MovementUseCasesPort
}

function renderForm({
  categories = [active, inactive],
  editing = false,
  kind = "expense",
  useCases = service(),
  onManageCategories = vi.fn(),
  onSaved = vi.fn(),
}: {
  readonly categories?: readonly Category[]
  readonly editing?: boolean
  readonly kind?: "income" | "expense"
  readonly useCases?: MovementUseCasesPort
  readonly onManageCategories?: () => void
  readonly onSaved?: (item: MovementListItem) => void
} = {}) {
  render(
    <MovementForm
      editor={{ kind, item: editing ? historicalItem : undefined }}
      options={options(categories)}
      useCases={useCases}
      onSaved={onSaved}
      onClose={vi.fn()}
      onManageCategories={onManageCategories}
    />,
  )
  return { useCases, onManageCategories }
}

describe("MovementForm C2 infrastructure", () => {
  it("uses the mobile form sheet without a two-column field layout", () => {
    renderForm()

    const dialog = screen.getByRole("dialog")
    expect(dialog).toHaveAttribute("data-side", "bottom")
    expect(dialog).toHaveClass(
      "max-h-[92dvh]",
      "data-[side=bottom]:overflow-y-auto",
    )
    expect(dialog).toHaveClass(
      "data-[side=bottom]:pb-[calc(1rem+env(safe-area-inset-bottom))]",
    )
    expect(dialog.querySelector(".grid-cols-2")).not.toBeInTheDocument()
  })

  it("formats CLP live and preserves the expense payload", async () => {
    const registerExpense = vi.fn().mockResolvedValue(historicalItem)
    renderForm({ useCases: service({ registerExpense }) })

    const amount = screen.getByRole("textbox", { name: "Monto" })
    fireEvent.change(amount, { target: { value: "1500000" } })
    expect(amount).toHaveValue("1.500.000")
    fireEvent.change(screen.getByLabelText("Concepto"), {
      target: { value: "Almuerzo" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Registrar" }))

    await waitFor(() =>
      expect(registerExpense).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        categoryId: ACTIVE_ID,
        operationDate: TODAY,
        amount: 1_500_000,
        concept: "Almuerzo",
        observation: "",
      }),
    )
  })

  it("shows the optional labels for additional income and keeps its payload", async () => {
    const registerIncome = vi.fn().mockResolvedValue(historicalItem)
    renderForm({ kind: "income", useCases: service({ registerIncome }) })

    expect(screen.getByLabelText("Descripción (opcional)")).toBeInTheDocument()
    expect(screen.getByLabelText("Observación (opcional)")).toBeInTheDocument()
    fireEvent.change(screen.getByRole("textbox", { name: "Monto" }), {
      target: { value: "25000" },
    })
    fireEvent.change(screen.getByLabelText("Descripción (opcional)"), {
      target: { value: "Freelance" },
    })
    fireEvent.change(screen.getByLabelText("Observación (opcional)"), {
      target: { value: "Cliente recurrente" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Registrar" }))

    await waitFor(() =>
      expect(registerIncome).toHaveBeenCalledWith({
        incomeType: "additional",
        accountId: ACCOUNT_ID,
        operationDate: TODAY,
        amount: 25_000,
        concept: "Freelance",
        observation: "Cliente recurrente",
      }),
    )
  })

  it("hides extra fields for salary and does not autofocus on open", async () => {
    renderForm({ kind: "income" })

    fireEvent.click(screen.getByRole("combobox", { name: "Tipo de ingreso" }))
    fireEvent.click(screen.getByRole("option", { name: "Sueldo recibido" }))

    expect(screen.queryByLabelText(/Descripción/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Observación/)).not.toBeInTheDocument()
    expect(screen.getByLabelText("Cuenta")).toBeInTheDocument()
    expect(screen.getByLabelText("Fecha")).toBeInTheDocument()
    expect(screen.getByLabelText("Monto")).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(document.body))
    expect(document.querySelector("[autofocus]")).not.toBeInTheDocument()
  })
})

describe("MovementForm category behavior", () => {
  it("offers only active categories for a new variable expense", () => {
    renderForm()

    fireEvent.click(screen.getByRole("combobox", { name: "Categoría" }))
    expect(screen.getByRole("option", { name: "Alimentación" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /Viajes antiguos/ })).not.toBeInTheDocument()
  })

  it("shows and preserves the inactive historical category during editing", async () => {
    const editMovement = vi.fn().mockResolvedValue(historicalItem)
    renderForm({ editing: true, categories: [inactive], useCases: service({ editMovement }) })

    expect(screen.getByRole("combobox", { name: "Categoría" })).toHaveTextContent(
      "Viajes antiguos",
    )
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }))

    await waitFor(() =>
      expect(editMovement).toHaveBeenCalledWith({
        operationId: OPERATION_ID,
        expectedRevision: asRevision(2),
        accountId: ACCOUNT_ID,
        operationDate: TODAY,
        amount: 10_000,
        concept: "Pasaje",
        observation: "",
        categoryId: INACTIVE_ID,
      }),
    )
  })

  it("only offers active categories after changing the inactive historical value", () => {
    renderForm({ editing: true })

    fireEvent.click(screen.getByRole("combobox", { name: "Categoría" }))
    expect(screen.getByRole("option", { name: /Viajes antiguos/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("option", { name: "Alimentación" }))
    fireEvent.click(screen.getByRole("combobox", { name: "Categoría" }))

    expect(screen.getByRole("option", { name: "Alimentación" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /Viajes antiguos/ })).not.toBeInTheDocument()
  })

  it("shows the management CTA and prevents submit when no active category exists", () => {
    const registerExpense = vi.fn().mockResolvedValue(historicalItem)
    const onManageCategories = vi.fn()
    renderForm({
      categories: [inactive],
      useCases: service({ registerExpense }),
      onManageCategories,
    })

    expect(screen.getByText("No hay categorías activas")).toBeInTheDocument()
    const submit = screen.getByRole("button", { name: "Registrar" })
    expect(submit).toBeDisabled()
    fireEvent.click(submit)
    expect(registerExpense).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Administrar categorías" }))
    expect(onManageCategories).toHaveBeenCalledOnce()
  })

  it("assigns category presentation styles deterministically", () => {
    expect(categoryBadgeClassName(ACTIVE_ID)).toBe(
      categoryBadgeClassName(ACTIVE_ID),
    )
    expect(categoryBadgeClassName(ACTIVE_ID)).toMatch(
      /border-.+-200 bg-.+-50 text-.+-700|text-amber-800/,
    )
  })
})

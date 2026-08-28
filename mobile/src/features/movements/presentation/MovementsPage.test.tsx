import { useState } from "react"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { Account, Category, SavingsGoal } from "@/domain/entities"
import {
  AppHeader,
  type MovementHeaderControls,
} from "@/components/layout/AppHeader"
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
  MovementDetail,
  MovementFormOptions,
  MovementListItem,
  MovementUseCasesPort,
  TransferFormOptions,
} from "@/features/movements/application/movement-use-cases"
import { MovementsPage } from "@/features/movements/presentation/MovementsPage"

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const ACCOUNT_ID = asEntityId("40000000-0000-4000-8000-000000000001")
const CATEGORY_ID = asEntityId("40000000-0000-4000-8000-000000000002")
const PERIOD_ID = asEntityId("40000000-0000-4000-8000-000000000003")
const OPERATION_ID = asEntityId("40000000-0000-4000-8000-000000000004")
const MOVEMENT_ID = asEntityId("40000000-0000-4000-8000-000000000005")
const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")
const GOAL_ID = asEntityId("40000000-0000-4000-8000-000000000006")

const account: Account = {
  id: ACCOUNT_ID,
  emoji: "💳",
  name: "Cuenta principal",
  bank: null,
  openingBalance: asClpAmount(0),
  currentBalance: asClpAmount(25_000),
  status: "active",
  deletedAt: null,
  balanceAtDeletion: null,
  revision: asRevision(2),
  createdAt: NOW,
  updatedAt: NOW,
}

const category: Category = {
  id: CATEGORY_ID,
  name: "Comida",
  status: "active",
  revision: asRevision(1),
  createdAt: NOW,
  updatedAt: NOW,
}

const goal: SavingsGoal = {
  id: GOAL_ID,
  emoji: "💰",
  name: "Viaje",
  bank: null,
  targetAmount: asPositiveClpAmount(100_000),
  openingBalance: asClpAmount(0),
  currentBalance: asClpAmount(0),
  plannedMonthlyAmount: asClpAmount(10_000),
  lifecycleStatus: "active",
  progressStatus: "in_progress",
  closedAt: null,
  revision: asRevision(1),
  createdAt: NOW,
  updatedAt: NOW,
}

const operation: Operation = {
  id: OPERATION_ID,
  periodId: PERIOD_ID,
  type: "additional_income",
  operationDate: asCivilDate("2026-08-21"),
  amount: asPositiveClpAmount(25_000),
  details: {
    accountId: ACCOUNT_ID,
    concept: "Venta",
    observation: null,
  },
  status: "posted",
  voidedAt: null,
  voidReason: null,
  revision: asRevision(1),
  createdAt: NOW,
  updatedAt: NOW,
}

const movement: Movement = {
  id: MOVEMENT_ID,
  operationId: OPERATION_ID,
  periodId: PERIOD_ID,
  targetType: "account",
  targetId: ACCOUNT_ID,
  effectType: "asset_balance",
  delta: asNonZeroClpDelta(25_000),
  status: "posted",
  createdAt: NOW,
  updatedAt: NOW,
}

const item: MovementListItem = {
  operation,
  movement,
  movements: [movement],
  kind: "income",
  title: "Venta",
  description: null,
  accountName: account.name,
  signedAmount: 25_000,
}

const expenseItem: MovementListItem = {
  operation: {
    ...operation,
    id: asEntityId("40000000-0000-4000-8000-000000000007"),
    type: "variable_expense",
    amount: asPositiveClpAmount(12_000),
    details: {
      accountId: ACCOUNT_ID,
      categoryId: CATEGORY_ID,
      categoryName: category.name,
      concept: "Almuerzo",
      observation: null,
    },
  },
  movement: {
    ...movement,
    id: asEntityId("40000000-0000-4000-8000-000000000008"),
    operationId: asEntityId("40000000-0000-4000-8000-000000000007"),
    delta: asNonZeroClpDelta(-12_000),
  },
  movements: [],
  kind: "expense",
  title: "Almuerzo",
  description: null,
  accountName: account.name,
  signedAmount: -12_000,
}

const detail: MovementDetail = { ...item, revisions: [] }
const adjustmentOperation: MovementListItem["operation"] = {
  id: asEntityId("40000000-0000-4000-8000-000000000010"),
  periodId: PERIOD_ID,
  type: "balance_adjustment",
  operationDate: asCivilDate("2026-08-20"),
  amount: asPositiveClpAmount(12_000),
  details: {
    accountId: ACCOUNT_ID,
    reason: "Conciliación bancaria",
  },
  status: "posted",
  voidedAt: null,
  voidReason: null,
  revision: asRevision(1),
  createdAt: NOW,
  updatedAt: NOW,
}
const adjustmentMovement: Movement = {
  ...movement,
  id: asEntityId("40000000-0000-4000-8000-000000000011"),
  operationId: adjustmentOperation.id,
  delta: asNonZeroClpDelta(-12_000),
}
const adjustmentItem: MovementListItem = {
  operation: adjustmentOperation,
  movement: adjustmentMovement,
  movements: [adjustmentMovement],
  kind: "adjustment",
  title: "Ajuste de saldo",
  description: "Conciliación bancaria",
  accountName: account.name,
  signedAmount: -12_000,
}
const savingsOperation: MovementListItem["operation"] = {
  id: asEntityId("40000000-0000-4000-8000-000000000020"),
  periodId: PERIOD_ID,
  type: "savings_deposit",
  operationDate: asCivilDate("2026-08-19"),
  amount: asPositiveClpAmount(25_000),
  details: {
    goalId: GOAL_ID,
    concept: "Ahorro extra",
    observation: "Desde efectivo",
  },
  status: "posted",
  voidedAt: null,
  voidReason: null,
  revision: asRevision(2),
  createdAt: NOW,
  updatedAt: NOW,
}
const savingsMovement: Movement = {
  ...movement,
  id: asEntityId("40000000-0000-4000-8000-000000000021"),
  operationId: savingsOperation.id,
  targetType: "savings_goal",
  targetId: GOAL_ID,
  delta: asNonZeroClpDelta(25_000),
}
const savingsItem: MovementListItem = {
  operation: savingsOperation,
  movement: savingsMovement,
  movements: [savingsMovement],
  kind: "savings",
  title: "Depósito",
  description: "Ahorro extra · Desde efectivo",
  accountName: goal.name,
  signedAmount: 25_000,
}
const savingsDetail: MovementDetail = { ...savingsItem, revisions: [] }
const options: MovementFormOptions = {
  accounts: [account],
  categories: [category],
  currentDate: asCivilDate("2026-08-21"),
}
const transferOptions: TransferFormOptions = {
  accounts: [account],
  savingsGoals: [goal],
  currentDate: asCivilDate("2026-08-21"),
}

function service(overrides: Partial<MovementUseCasesPort> = {}): MovementUseCasesPort {
  return {
    getCurrentDate: vi.fn(() => asCivilDate("2026-08-21")),
    getOpenPeriodId: vi.fn().mockResolvedValue(PERIOD_ID),
    getFormOptions: vi.fn().mockResolvedValue(options),
    getTransferFormOptions: vi.fn().mockResolvedValue(transferOptions),
    listMovements: vi.fn().mockResolvedValue([item]),
    getMovementDetail: vi.fn().mockResolvedValue(detail),
    registerIncome: vi.fn().mockResolvedValue(item),
    registerExpense: vi.fn().mockResolvedValue(item),
    registerFixedExpensePayment: vi.fn().mockResolvedValue(item),
    registerTransfer: vi.fn().mockResolvedValue(item),
    previewTransfer: vi.fn().mockResolvedValue({
      source: { name: account.name, currentBalance: account.currentBalance, resultingBalance: account.currentBalance - 15_000 },
      destination: { name: goal.name, currentBalance: goal.currentBalance, resultingBalance: goal.currentBalance + 15_000 },
      amount: 15_000,
      operationDate: options.currentDate,
    }),
    registerSavingsDeposit: vi.fn(),
    registerSavingsWithdrawal: vi.fn(),
    editSavingsMovement: vi.fn(),
    voidSavingsMovement: vi.fn(),
    editMovement: vi.fn().mockResolvedValue(item),
    editTransfer: vi.fn().mockResolvedValue(item),
    voidMovement: vi.fn().mockResolvedValue(item),
    ...overrides,
  }
}

function MovementsHeaderHarness({
  useCases,
}: {
  readonly useCases: MovementUseCasesPort
}) {
  const [query, setQuery] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const controls: MovementHeaderControls = {
    query,
    searchOpen,
    filtersOpen,
    onQueryChange: setQuery,
    onSearchOpenChange: setSearchOpen,
    onFiltersOpenChange: setFiltersOpen,
  }

  return (
    <div data-testid="iphone-se-viewport" className="w-[320px] overflow-x-hidden">
      <AppHeader
        activeSection="movements"
        movementControls={controls}
        onOpenSettings={() => undefined}
      />
      <MovementsPage useCases={useCases} headerControls={controls} />
    </div>
  )
}

describe("MovementsPage", () => {
  it("uses sign-first amounts and semantic colors for income and expense cards", async () => {
    render(
      <MovementsPage
        useCases={service({
          listMovements: vi.fn().mockResolvedValue([item, expenseItem]),
        })}
      />,
    )

    expect(screen.getByText(
      "Ingresos, gastos, ahorro, ajustes y movimientos internos del período abierto.",
    )).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Movimientos" })).toBeNull()
    const incomeAmount = await screen.findByText("+ $25.000")
    const expenseAmount = screen.getByText("- $12.000")
    expect(incomeAmount).toHaveClass("text-green-600")
    expect(expenseAmount).toHaveClass("text-destructive")
    expect(screen.queryByRole("button", { name: "Gasto" })).toBeNull()
  })

  it("shows balance adjustments and exposes their explicit filter", async () => {
    const listMovements = vi.fn().mockResolvedValue([adjustmentItem])
    const adjustmentDetail: MovementDetail = { ...adjustmentItem, revisions: [] }
    render(<MovementsHeaderHarness useCases={service({
      listMovements,
      getMovementDetail: vi.fn().mockResolvedValue(adjustmentDetail),
    })} />)

    const title = await screen.findByText("Ajuste de saldo")
    const movementCard = title.closest<HTMLElement>('[data-slot="card"]')
    if (!movementCard) throw new Error("Missing movement card")
    expect(movementCard).toHaveClass("gap-3")
    expect(movementCard).toHaveAttribute("data-size", "default")
    expect(within(movementCard).queryByText("Conciliación bancaria")).toBeNull()
    expect(within(movementCard).getByText("Cuenta principal · 20-08-2026"))
      .toBeInTheDocument()
    expect(within(movementCard).getByText(/-.*12\.000/)).toBeInTheDocument()
    const detailButton = within(movementCard).getByRole("button", {
      name: "Ver detalle de Ajuste de saldo",
    })
    expect(detailButton).toBeInTheDocument()
    expect(
      screen.queryByText("Aún no has registrado movimientos"),
    ).not.toBeInTheDocument()

    fireEvent.click(detailButton)
    const detailDialog = await screen.findByRole("dialog")
    expect(within(detailDialog).getByText("Conciliación bancaria")).toBeInTheDocument()
    const detailCard = within(detailDialog).getByText("Impacto")
      .closest<HTMLElement>('[data-slot="card"]')
    expect(detailCard).not.toHaveClass("gap-3")
    fireEvent.click(within(detailDialog).getByRole("button", { name: "Cerrar" }))

    fireEvent.click(screen.getByRole("button", { name: "Filtros" }))
    const filters = await screen.findByRole("dialog", { name: "Filtros" })
    expect(within(filters).getByText("Tipo")).toBeInTheDocument()
    expect(within(filters).getByText("Estado")).toBeInTheDocument()
    expect(within(filters).getByText("Cuenta")).toBeInTheDocument()
    expect(within(filters).getByRole("combobox", { name: "Filtrar por cuenta" }))
      .toBeInTheDocument()
    fireEvent.click(within(filters).getByRole("combobox", { name: "Tipo de movimiento" }))
    fireEvent.click(screen.getByRole("option", { name: "Ajustes" }))
    fireEvent.click(within(filters).getByRole("combobox", { name: "Estado del movimiento" }))
    fireEvent.click(screen.getByRole("option", { name: "Vigentes" }))
    fireEvent.click(within(filters).getByRole("combobox", { name: "Filtrar por cuenta" }))
    fireEvent.click(screen.getByRole("option", { name: "Cuenta principal" }))
    await waitFor(() =>
      expect(listMovements).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: ACCOUNT_ID,
          kind: "adjustment",
          status: "posted",
        }),
      ),
    )
  })

  it("keeps the voided status badge on compact movement cards", async () => {
    const voidedItem: MovementListItem = {
      ...adjustmentItem,
      operation: {
        ...adjustmentItem.operation,
        status: "voided",
        voidedAt: NOW,
        voidReason: "Duplicado",
      },
    }
    render(<MovementsPage useCases={service({
      listMovements: vi.fn().mockResolvedValue([voidedItem]),
    })} />)

    const title = await screen.findByText("Ajuste de saldo")
    const movementCard = title.closest<HTMLElement>('[data-slot="card"]')
    if (!movementCard) throw new Error("Missing voided movement card")
    expect(within(movementCard).getByText("Anulado")).toBeInTheDocument()
    expect(movementCard).toHaveClass("gap-3", "opacity-60")
    expect(within(movementCard).getByText(/-.*12\.000/)).toHaveClass("line-through")
  })

  it("labels a savings-goal adjustment as Meta and keeps it read-only", async () => {
    const goalAdjustmentOperation = {
      ...adjustmentOperation,
      id: asEntityId("40000000-0000-4000-8000-000000000030"),
      details: { goalId: GOAL_ID, reason: "Saldo informado" },
    } as MovementListItem["operation"]
    const goalAdjustmentMovement = {
      ...adjustmentMovement,
      id: asEntityId("40000000-0000-4000-8000-000000000031"),
      operationId: goalAdjustmentOperation.id,
      targetType: "savings_goal" as const,
      targetId: GOAL_ID,
      delta: asNonZeroClpDelta(12_000),
    }
    const goalAdjustmentItem: MovementListItem = {
      operation: goalAdjustmentOperation,
      movement: goalAdjustmentMovement,
      movements: [goalAdjustmentMovement],
      kind: "adjustment",
      title: "Ajuste de saldo",
      description: "Saldo informado",
      accountName: goal.name,
      signedAmount: 12_000,
    }
    render(
      <MovementsPage
        useCases={service({
          listMovements: vi.fn().mockResolvedValue([goalAdjustmentItem]),
          getMovementDetail: vi.fn().mockResolvedValue({
            ...goalAdjustmentItem,
            revisions: [],
          }),
        })}
      />,
    )

    await screen.findByText("Ajuste de saldo")
    fireEvent.click(
      screen.getByRole("button", { name: "Ver detalle de Ajuste de saldo" }),
    )
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Meta")).toBeInTheDocument()
    expect(within(dialog).getByText("Viaje")).toBeInTheDocument()
    expect(within(dialog).queryByRole("button", { name: "Editar" })).toBeNull()
    expect(within(dialog).queryByRole("button", { name: "Anular" })).toBeNull()
  })

  it("shows the savings filter and edits or voids deposits through the B2 use cases", async () => {
    const listMovements = vi.fn().mockResolvedValue([savingsItem])
    const getMovementDetail = vi.fn().mockResolvedValue(savingsDetail)
    const editSavingsMovement = vi.fn().mockResolvedValue({
      goal,
      operation: savingsOperation,
      movement: savingsMovement,
    })
    const voidSavingsMovement = vi.fn().mockResolvedValue({
      goal,
      operation: { ...savingsOperation, status: "voided" },
      movement: { ...savingsMovement, status: "voided" },
    })
    const voidMovement = vi.fn()
    render(
      <MovementsHeaderHarness
        useCases={service({
          listMovements,
          getMovementDetail,
          editSavingsMovement,
          voidSavingsMovement,
          voidMovement,
        })}
      />,
    )

    expect(await screen.findByText("Depósito")).toBeInTheDocument()
    expect(screen.getByText("Viaje · 19-08-2026")).toBeInTheDocument()
    expect(screen.queryByText("Ahorro extra · Desde efectivo")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Filtros" }))
    const filters = await screen.findByRole("dialog", { name: "Filtros" })
    fireEvent.click(within(filters).getByRole("combobox", { name: "Tipo de movimiento" }))
    fireEvent.click(screen.getByRole("option", { name: "Ahorro" }))
    await waitFor(() =>
      expect(listMovements).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "savings" }),
      ),
    )
    fireEvent.click(within(filters).getByRole("button", { name: "Cerrar" }))

    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Depósito" }))
    const detailDialog = await screen.findByRole("dialog")
    expect(within(detailDialog).getByText(/Ahorro · Viaje/)).toBeInTheDocument()
    expect(within(detailDialog).getByText("Meta")).toBeInTheDocument()
    expect(within(detailDialog).getByText("Ahorro extra · Desde efectivo"))
      .toBeInTheDocument()
    fireEvent.click(within(detailDialog).getByRole("button", { name: "Editar" }))
    expect(
      await screen.findByRole("heading", { name: "Editar depósito" }),
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Monto"), {
      target: { value: "30000" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }))
    await waitFor(() =>
      expect(editSavingsMovement).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: savingsOperation.id,
          expectedRevision: savingsOperation.revision,
          amount: 30_000,
        }),
      ),
    )

    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Depósito" }))
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Anular",
      }),
    )
    const confirmation = await screen.findByRole("alertdialog")
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Anular movimiento" }),
    )
    await waitFor(() =>
      expect(voidSavingsMovement).toHaveBeenCalledWith({
        operationId: savingsOperation.id,
        expectedRevision: savingsOperation.revision,
        reason: "Anulado desde la interfaz",
      }),
    )
    expect(voidMovement).not.toHaveBeenCalled()
  })

  it("propagates category administration from a new expense without active categories", async () => {
    const onManageCategories = vi.fn()
    const inactiveCategory: Category = { ...category, status: "inactive" }
    const useCases = service({
      getFormOptions: vi.fn().mockResolvedValue({
        ...options,
        categories: [inactiveCategory],
      }),
    })
    render(
      <MovementsPage
        useCases={useCases}
        initialComposer="expense"
        onManageCategories={onManageCategories}
      />,
    )

    fireEvent.click(
      await screen.findByRole("button", { name: "Administrar categorías" }),
    )

    expect(onManageCategories).toHaveBeenCalledOnce()
  })

  it("opens Mover dinero from the quick action and delegates the internal move", async () => {
    const registerTransfer = vi.fn().mockResolvedValue(item)
    const onClose = vi.fn()
    render(
      <MovementsPage
        useCases={service({ registerTransfer })}
        initialComposer="transfer"
        onInitialComposerClose={onClose}
      />,
    )

    expect(
      await screen.findByRole("heading", { name: "Mover dinero" }),
    ).toBeInTheDocument()
    fireEvent.change(screen.getByRole("textbox", { name: "Monto" }), {
      target: { value: "15000" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: "Concepto (opcional)" }), {
      target: { value: "Aporte viaje" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Mover dinero" }))
    await screen.findByRole("alertdialog")
    fireEvent.click(screen.getByRole("button", { name: "Confirmar transferencia" }))

    await waitFor(() =>
      expect(registerTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceType: "account",
          sourceId: ACCOUNT_ID,
          destinationType: "savings_goal",
          destinationId: GOAL_ID,
          amount: 15_000,
          concept: "Aporte viaje",
        }),
      ),
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("opens the quick income composer and delegates balance-impacting work", async () => {
    const registerIncome = vi.fn().mockResolvedValue(item)
    const onClose = vi.fn()
    const useCases = service({ registerIncome })
    render(
      <MovementsPage
        useCases={useCases}
        initialComposer="income"
        onInitialComposerClose={onClose}
      />,
    )

    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("Monto"), {
      target: { value: "25000" },
    })
    fireEvent.change(within(dialog).getByLabelText("Descripción (opcional)"), {
      target: { value: "Venta" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Registrar" }))

    await waitFor(() =>
      expect(registerIncome).toHaveBeenCalledWith({
        incomeType: "additional",
        accountId: ACCOUNT_ID,
        operationDate: "2026-08-21",
        amount: 25_000,
        concept: "Venta",
        observation: "",
      }),
    )
    expect(onClose).toHaveBeenCalled()
  })

  it("delegates search filters and exposes detail with anulation confirmation", async () => {
    const listMovements = vi.fn().mockResolvedValue([item])
    const voidMovement = vi.fn().mockResolvedValue({
      ...item,
      operation: {
        ...operation,
        status: "voided",
        voidedAt: NOW,
        voidReason: "Anulado desde la interfaz",
      },
    })
    const useCases = service({ listMovements, voidMovement })
    render(<MovementsHeaderHarness useCases={useCases} />)

    await screen.findByText("Venta")
    expect(screen.queryByPlaceholderText(
      "Buscar por título, cuenta, meta, motivo o categoría",
    )).toBeNull()
    expect(screen.getByRole("button", { name: "Buscar" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Filtros" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Configuración" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }))
    const search = screen.getByLabelText("Buscar movimientos")
    expect(search).toHaveFocus()
    expect(search).toHaveAttribute("placeholder", "Buscar movimientos")
    expect(search).toHaveClass("min-w-0")
    expect(search.closest('[data-slot="card"]')).toBeNull()
    expect(screen.getByTestId("iphone-se-viewport")).toHaveClass("overflow-x-hidden")
    fireEvent.change(search, {
      target: { value: "venta" },
    })
    await waitFor(() =>
      expect(listMovements).toHaveBeenCalledWith(
        expect.objectContaining({ query: "venta" }),
      ),
    )
    fireEvent.click(screen.getByRole("button", { name: "Cerrar búsqueda" }))
    expect(screen.queryByLabelText("Buscar movimientos")).toBeNull()
    expect(screen.getByRole("button", { name: "Buscar" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Filtros" })).toBeInTheDocument()
    await waitFor(() =>
      expect(listMovements).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: "" }),
      ),
    )

    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Venta" }))
    const detailDialog = await screen.findByRole("dialog")
    fireEvent.click(within(detailDialog).getByRole("button", { name: "Anular" }))
    const confirmation = await screen.findByRole("alertdialog")
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Anular movimiento" }),
    )

    await waitFor(() =>
      expect(voidMovement).toHaveBeenCalledWith({
        operationId: OPERATION_ID,
        expectedRevision: operation.revision,
        reason: "Anulado desde la interfaz",
      }),
    )
  })
})

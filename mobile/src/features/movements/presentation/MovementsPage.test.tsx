import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { Account, Category, SavingsGoal } from "@/domain/entities"
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

const detail: MovementDetail = { ...item, revisions: [] }
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
    getFormOptions: vi.fn().mockResolvedValue(options),
    getTransferFormOptions: vi.fn().mockResolvedValue(transferOptions),
    listMovements: vi.fn().mockResolvedValue([item]),
    getMovementDetail: vi.fn().mockResolvedValue(detail),
    registerIncome: vi.fn().mockResolvedValue(item),
    registerExpense: vi.fn().mockResolvedValue(item),
    registerFixedExpensePayment: vi.fn().mockResolvedValue(item),
    registerTransfer: vi.fn().mockResolvedValue(item),
    editMovement: vi.fn().mockResolvedValue(item),
    editTransfer: vi.fn().mockResolvedValue(item),
    voidMovement: vi.fn().mockResolvedValue(item),
    ...overrides,
  }
}

describe("MovementsPage", () => {
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
        onManageCategories={onManageCategories}
      />,
    )

    await screen.findByText("Venta")
    fireEvent.click(screen.getByRole("button", { name: "Gasto" }))
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
    render(<MovementsPage useCases={useCases} />)

    await screen.findByText("Venta")
    fireEvent.change(screen.getByLabelText("Buscar movimientos"), {
      target: { value: "venta" },
    })
    await waitFor(() =>
      expect(listMovements).toHaveBeenCalledWith(
        expect.objectContaining({ query: "venta" }),
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

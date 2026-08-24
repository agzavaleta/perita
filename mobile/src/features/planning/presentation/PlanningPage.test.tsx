import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type {
  FixedExpenseInstance,
  FixedExpenseTemplate,
  Debt,
  SavingsGoal,
} from "@/domain/entities"
import {
  asClpAmount,
  asCivilDate,
  asEntityId,
  asPositiveClpAmount,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import type {
  DebtDetail,
  DebtUseCasesPort,
} from "@/features/planning/application/debt-use-cases"
import type {
  FixedExpenseListItem,
  PlanningUseCasesPort,
  SavingsGoalDetail,
} from "@/features/planning/application/planning-use-cases"
import type { MovementUseCasesPort } from "@/features/movements/application/movement-use-cases"
import { PlanningPage } from "@/features/planning/presentation/PlanningPage"

const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")
const GOAL_ID = asEntityId("60000000-0000-4000-8000-000000000001")
const TEMPLATE_ID = asEntityId("60000000-0000-4000-8000-000000000002")
const INSTANCE_ID = asEntityId("60000000-0000-4000-8000-000000000003")
const PERIOD_ID = asEntityId("60000000-0000-4000-8000-000000000004")
const DEBT_ID = asEntityId("60000000-0000-4000-8000-000000000005")
const ACCOUNT_ID = asEntityId("60000000-0000-4000-8000-000000000006")

const goal: SavingsGoal = {
  id: GOAL_ID,
  emoji: "💰",
  name: "Viaje",
  bank: null,
  targetAmount: asPositiveClpAmount(100_000),
  openingBalance: asClpAmount(0),
  currentBalance: asClpAmount(50_000),
  plannedMonthlyAmount: asClpAmount(10_000),
  lifecycleStatus: "active",
  progressStatus: "in_progress",
  closedAt: null,
  revision: asRevision(2),
  createdAt: NOW,
  updatedAt: NOW,
}

const template: FixedExpenseTemplate = {
  id: TEMPLATE_ID,
  name: "Internet",
  referenceAmount: asPositiveClpAmount(30_000),
  status: "active",
  revision: asRevision(1),
  createdAt: NOW,
  updatedAt: NOW,
}

const instance: FixedExpenseInstance = {
  id: INSTANCE_ID,
  periodId: PERIOD_ID,
  templateId: TEMPLATE_ID,
  nameSnapshot: "Internet",
  plannedAmount: asPositiveClpAmount(28_000),
  status: "pending",
  activePaymentOperationId: null,
  revision: asRevision(1),
  createdAt: NOW,
  updatedAt: NOW,
}

const fixedItem: FixedExpenseListItem = {
  template,
  currentInstance: instance,
}
const detail: SavingsGoalDetail = { goal, relatedMovements: [] }

const debt: Debt = {
  id: DEBT_ID,
  name: "Crédito",
  totalAmount: asPositiveClpAmount(100_000),
  openingOutstanding: asClpAmount(100_000),
  outstandingAmount: asClpAmount(75_000),
  dueDate: null,
  monthlyPaymentAmount: asPositiveClpAmount(25_000),
  paymentDay: 31,
  lifecycleStatus: "active",
  paymentStatus: "active",
  revision: asRevision(2),
  createdAt: NOW,
  updatedAt: NOW,
}

const debtDetail: DebtDetail = {
  debt,
  schedule: {
    remainingInstallments: 3,
    nextPaymentDate: asCivilDate("2026-08-31"),
    estimatedEndDate: asCivilDate("2026-10-31"),
  },
  payments: [],
  adjustments: [],
  auditEvents: [],
}

function service(
  overrides: Partial<PlanningUseCasesPort> = {},
): PlanningUseCasesPort {
  return {
    listSavingsGoals: vi.fn().mockResolvedValue([goal]),
    getSavingsGoalDetail: vi.fn().mockResolvedValue(detail),
    createSavingsGoal: vi.fn().mockResolvedValue(goal),
    editSavingsGoal: vi.fn().mockResolvedValue(goal),
    closeSavingsGoal: vi.fn().mockResolvedValue(goal),
    listFixedExpenses: vi.fn().mockResolvedValue([fixedItem]),
    getFixedExpenseDetail: vi.fn().mockResolvedValue(fixedItem),
    createFixedExpense: vi.fn().mockResolvedValue(fixedItem),
    editFixedExpense: vi.fn().mockResolvedValue(fixedItem),
    deactivateFixedExpense: vi.fn().mockResolvedValue(fixedItem),
    updateCurrentPlannedAmount: vi.fn().mockResolvedValue(instance),
    ...overrides,
  }
}

function debtService(overrides: Partial<DebtUseCasesPort> = {}): DebtUseCasesPort {
  return {
    listDebts: vi.fn().mockResolvedValue([
      { debt, schedule: debtDetail.schedule },
    ]),
    getDebtDetail: vi.fn().mockResolvedValue(debtDetail),
    getPaymentFormOptions: vi.fn().mockResolvedValue({
      currentDate: asCivilDate("2026-08-21"),
      accounts: [{
        id: ACCOUNT_ID,
        name: "Principal",
        bank: null,
        openingBalance: asClpAmount(200_000),
        currentBalance: asClpAmount(200_000),
        status: "active",
        revision: asRevision(1),
        createdAt: NOW,
        updatedAt: NOW,
      }],
    }),
    createDebt: vi.fn().mockResolvedValue(debt),
    editDebt: vi.fn().mockResolvedValue(debt),
    adjustDebtTotal: vi.fn().mockResolvedValue(debt),
    registerPayment: vi.fn(),
    editPayment: vi.fn(),
    voidPayment: vi.fn(),
    ...overrides,
  }
}

function movementService(
  overrides: Partial<MovementUseCasesPort> = {},
): MovementUseCasesPort {
  return {
    getFormOptions: vi.fn().mockResolvedValue({
      currentDate: asCivilDate("2026-08-21"),
      categories: [],
      accounts: [{
        id: ACCOUNT_ID,
        name: "Principal",
        bank: null,
        openingBalance: asClpAmount(200_000),
        currentBalance: asClpAmount(200_000),
        status: "active",
        revision: asRevision(1),
        createdAt: NOW,
        updatedAt: NOW,
      }],
    }),
    getTransferFormOptions: vi.fn(),
    listMovements: vi.fn(),
    getMovementDetail: vi.fn(),
    registerIncome: vi.fn(),
    registerExpense: vi.fn(),
    registerFixedExpensePayment: vi.fn(),
    registerTransfer: vi.fn(),
    editMovement: vi.fn(),
    editTransfer: vi.fn(),
    voidMovement: vi.fn(),
    ...overrides,
  }
}

describe("PlanningPage", () => {
  it("shows goal progress and connects its contribution to Mover dinero", async () => {
    const onMoveMoney = vi.fn()
    render(<PlanningPage useCases={service()} onMoveMoney={onMoveMoney} />)

    expect(await screen.findByText("Viaje")).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "Emoji de Viaje" })).toHaveTextContent(
      "💰",
    )
    expect(document.querySelector(".lucide-target")).toBeNull()
    expect(
      screen.getByRole("progressbar", { name: "Progreso de Viaje" }),
    ).toHaveAttribute("aria-valuenow", "50")
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Viaje" }))
    expect(
      await screen.findAllByRole("img", { name: "Emoji de Viaje" }),
    ).toHaveLength(1)
    fireEvent.click(await screen.findByRole("button", { name: "Aportar" }))
    expect(onMoveMoney).toHaveBeenCalledOnce()
  })

  it("delegates creation of a savings goal", async () => {
    const createSavingsGoal = vi.fn().mockResolvedValue(goal)
    render(<PlanningPage useCases={service({ createSavingsGoal })} />)
    await screen.findByText("Viaje")

    fireEvent.click(screen.getByRole("button", { name: "Nueva" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Nombre" }), {
      target: { value: "Casa" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: "Objetivo" }), {
      target: { value: "500000" },
    })
    fireEvent.change(
      screen.getByRole("textbox", { name: "Aporte mensual planificado" }),
      { target: { value: "50000" } },
    )
    fireEvent.click(screen.getByRole("button", { name: "Crear meta" }))

    await waitFor(() =>
      expect(createSavingsGoal).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Casa",
          targetAmount: 500_000,
          plannedMonthlyAmount: 50_000,
        }),
      ),
    )
  })

  it("shows fixed expenses and delegates persistent creation without payment flow", async () => {
    const createFixedExpense = vi.fn().mockResolvedValue(fixedItem)
    render(<PlanningPage useCases={service({ createFixedExpense })} />)
    await screen.findByText("Viaje")

    const fixedTab = screen.getByRole("tab", { name: "Fijos" })
    fireEvent.mouseDown(fixedTab, { button: 0, ctrlKey: false })
    expect(await screen.findByText("Internet")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Nuevo" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Nombre" }), {
      target: { value: "Arriendo" },
    })
    fireEvent.change(
      screen.getByRole("textbox", { name: "Monto de referencia" }),
      { target: { value: "450000" } },
    )
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }))

    await waitFor(() =>
      expect(createFixedExpense).toHaveBeenCalledWith({
        name: "Arriendo",
        referenceAmount: 450_000,
      }),
    )
  })

  it("registers a pending fixed-expense payment through the movement use case", async () => {
    const registerFixedExpensePayment = vi.fn().mockResolvedValue({})
    render(
      <PlanningPage
        useCases={service()}
        movementUseCases={movementService({ registerFixedExpensePayment })}
      />,
    )
    await screen.findByText("Viaje")

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Fijos" }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.click(
      await screen.findByRole("button", { name: "Ver detalle de Internet" }),
    )
    fireEvent.click(screen.getByRole("button", { name: "Registrar pago" }))
    expect(await screen.findByRole("textbox", { name: "Monto" })).toHaveValue("28.000")
    fireEvent.click(screen.getByRole("button", { name: "Registrar pago" }))

    await waitFor(() =>
      expect(registerFixedExpensePayment).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        fixedExpenseInstanceId: INSTANCE_ID,
        operationDate: "2026-08-21",
        amount: 28_000,
      }),
    )
  })

  it("integrates Debts and delegates payment registration without calculating balances", async () => {
    const registerPayment = vi.fn().mockResolvedValue({})
    render(
      <PlanningPage
        useCases={service()}
        debtUseCases={debtService({ registerPayment })}
      />,
    )
    await screen.findByText("Viaje")

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Deudas" }), {
      button: 0,
      ctrlKey: false,
    })
    expect(await screen.findByText("Crédito")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Crédito" }))
    fireEvent.click(await screen.findByRole("button", { name: "Registrar pago" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Monto" }), {
      target: { value: "25000" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Guardar pago" }))

    await waitFor(() =>
      expect(registerPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          debtId: DEBT_ID,
          accountId: ACCOUNT_ID,
          amount: 25_000,
        }),
      ),
    )
  })
})

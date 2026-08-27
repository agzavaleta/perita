import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type {
  FixedExpenseInstance,
  FixedExpenseTemplate,
  Debt,
  SavingsGoal,
} from "@/domain/entities"
import type { Movement, Operation } from "@/domain/operations"
import {
  asClpAmount,
  asCivilDate,
  asEntityId,
  asNonZeroClpDelta,
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
import { toast } from "sonner"

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }))

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
const detail: SavingsGoalDetail = { goal, relatedMovements: [], canDelete: false }

function relatedMovement(
  type: "savings_deposit" | "savings_withdrawal" | "transfer" | "balance_adjustment",
  index: number,
  delta: number,
) {
  const operationId = asEntityId(
    `60000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
  )
  const details =
    type === "transfer"
      ? {
          sourceType: "account" as const,
          sourceId: ACCOUNT_ID,
          destinationType: "savings_goal" as const,
          destinationId: GOAL_ID,
          concept: "Desde cuenta",
          observation: null,
        }
      : type === "balance_adjustment"
        ? { goalId: GOAL_ID, reason: "Saldo informado" }
        : {
            goalId: GOAL_ID,
            concept: type === "savings_deposit" ? "Ahorro extra" : null,
            observation: null,
          }
  const operation = {
    id: operationId,
    periodId: PERIOD_ID,
    type,
    operationDate: asCivilDate("2026-08-21"),
    amount: asPositiveClpAmount(Math.abs(delta)),
    details,
    status: "posted",
    voidedAt: null,
    voidReason: null,
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  } as Operation
  const movement: Movement = {
    id: asEntityId(
      `60000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`,
    ),
    operationId,
    periodId: PERIOD_ID,
    targetType: "savings_goal",
    targetId: GOAL_ID,
    effectType: "asset_balance",
    delta: asNonZeroClpDelta(delta),
    status: "posted",
    createdAt: NOW,
    updatedAt: NOW,
  }
  return { operation, movement }
}

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
  paidAmount: 25_000,
  progressPercent: 25,
  schedule: {
    remainingInstallments: 3,
    nextPaymentDate: asCivilDate("2026-08-31"),
    estimatedEndDate: asCivilDate("2026-10-31"),
  },
  payments: [],
  adjustments: [],
  auditEvents: [],
  canDelete: false,
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
    deleteSavingsGoal: vi.fn().mockResolvedValue(undefined),
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
      {
        debt,
        schedule: debtDetail.schedule,
        paidAmount: debtDetail.paidAmount,
        progressPercent: debtDetail.progressPercent,
      },
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
    deleteDebt: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function movementService(
  overrides: Partial<MovementUseCasesPort> = {},
): MovementUseCasesPort {
  return {
    getCurrentDate: vi.fn(() => asCivilDate("2026-08-21")),
    getOpenPeriodId: vi.fn().mockResolvedValue(PERIOD_ID),
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
    previewTransfer: vi.fn(),
    registerSavingsDeposit: vi.fn(),
    registerSavingsWithdrawal: vi.fn(),
    editSavingsMovement: vi.fn(),
    voidSavingsMovement: vi.fn(),
    editMovement: vi.fn(),
    editTransfer: vi.fn(),
    voidMovement: vi.fn(),
    ...overrides,
  }
}

describe("PlanningPage", () => {
  it("shows goal progress and preserves the Mover dinero action", async () => {
    const onMoveMoney = vi.fn()
    render(
      <PlanningPage
        useCases={service()}
        movementUseCases={movementService()}
        onMoveMoney={onMoveMoney}
      />,
    )

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
    expect(screen.getByRole("button", { name: "Depositar" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retirar" })).toBeInTheDocument()
    fireEvent.click(await screen.findByRole("button", { name: "Mover dinero" }))
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

  it("opens deposit and withdrawal forms and refreshes the goal detail", async () => {
    const getSavingsGoalDetail = vi.fn().mockResolvedValue(detail)
    const listSavingsGoals = vi.fn().mockResolvedValue([goal])
    const registerSavingsDeposit = vi.fn().mockResolvedValue({ goal })
    const registerSavingsWithdrawal = vi.fn().mockResolvedValue({ goal })
    render(
      <PlanningPage
        useCases={service({ getSavingsGoalDetail, listSavingsGoals })}
        movementUseCases={movementService({
          registerSavingsDeposit,
          registerSavingsWithdrawal,
        })}
      />,
    )

    await screen.findByText("Viaje")
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Viaje" }))
    fireEvent.click(await screen.findByRole("button", { name: "Depositar" }))
    expect(
      await screen.findByRole("heading", { name: "Depositar en Viaje" }),
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Monto"), {
      target: { value: "100000" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Depositar" }))
    await waitFor(() => expect(registerSavingsDeposit).toHaveBeenCalledOnce())
    await waitFor(() => expect(getSavingsGoalDetail).toHaveBeenCalledTimes(2))

    fireEvent.click(await screen.findByRole("button", { name: "Retirar" }))
    expect(
      await screen.findByRole("heading", { name: "Retirar de Viaje" }),
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Monto"), {
      target: { value: "40000" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Retirar" }))
    await waitFor(() => expect(registerSavingsWithdrawal).toHaveBeenCalledOnce())
    await waitFor(() => expect(getSavingsGoalDetail).toHaveBeenCalledTimes(3))
    expect(listSavingsGoals).toHaveBeenCalledTimes(3)
  })

  it("labels every related savings movement with its traceable concept", async () => {
    const historyDetail: SavingsGoalDetail = {
      goal,
      canDelete: false,
      relatedMovements: [
        relatedMovement("savings_deposit", 1, 10_000),
        relatedMovement("savings_withdrawal", 2, -5_000),
        relatedMovement("transfer", 3, 20_000),
        relatedMovement("balance_adjustment", 4, 50_000),
      ],
    }
    render(
      <PlanningPage
        useCases={service({
          getSavingsGoalDetail: vi.fn().mockResolvedValue(historyDetail),
        })}
      />,
    )
    await screen.findByText("Viaje")
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Viaje" }))

    expect(await screen.findByText("Depósito")).toBeInTheDocument()
    expect(screen.getByText("Retiro")).toBeInTheDocument()
    expect(screen.getAllByText("Mover dinero")).not.toHaveLength(0)
    expect(screen.getByText("Ajuste de saldo")).toBeInTheDocument()
    expect(screen.getByText("Ahorro extra")).toBeInTheDocument()
    expect(screen.getByText("Desde cuenta")).toBeInTheDocument()
    expect(screen.getByText("Saldo informado")).toBeInTheDocument()
  })

  it("shows and confirms permanent goal deletion only for an eligible goal", async () => {
    const deleteSavingsGoal = vi.fn().mockResolvedValue(undefined)
    const eligible = { ...detail, canDelete: true }
    render(
      <PlanningPage
        useCases={service({
          getSavingsGoalDetail: vi.fn().mockResolvedValue(eligible),
          deleteSavingsGoal,
        })}
      />,
    )
    await screen.findByText("Viaje")
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Viaje" }))
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar meta" }))
    expect(screen.getByRole("heading", { name: "¿Eliminar meta?" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
    expect(deleteSavingsGoal).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Eliminar meta" }))
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }))
    await waitFor(() => expect(deleteSavingsGoal).toHaveBeenCalledOnce())
    expect(deleteSavingsGoal).toHaveBeenCalledWith(goal.id, goal.revision)
    expect(toast.success).toHaveBeenCalledWith("Meta eliminada")
  })

  it("keeps the close-goal flow for a used goal at zero", async () => {
    const zeroGoal = { ...goal, currentBalance: asClpAmount(0) }
    const closeSavingsGoal = vi.fn().mockResolvedValue(zeroGoal)
    render(
      <PlanningPage
        useCases={service({
          listSavingsGoals: vi.fn().mockResolvedValue([zeroGoal]),
          getSavingsGoalDetail: vi.fn().mockResolvedValue({ goal: zeroGoal, relatedMovements: [], canDelete: false }),
          closeSavingsGoal,
        })}
      />,
    )
    await screen.findByText("Viaje")
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Viaje" }))
    expect(await screen.findByRole("button", { name: "Cerrar meta" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Eliminar meta" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Cerrar meta" }))
    fireEvent.click(screen.getByRole("button", { name: "Cerrar meta" }))
    await waitFor(() => expect(closeSavingsGoal).toHaveBeenCalledWith(zeroGoal.id, zeroGoal.revision))
  })

  it("edits and voids posted savings movements from the open-period history", async () => {
    const deposit = relatedMovement("savings_deposit", 1, 100_000)
    const historyDetail: SavingsGoalDetail = {
      goal,
      canDelete: false,
      relatedMovements: [deposit],
    }
    const getSavingsGoalDetail = vi.fn().mockResolvedValue(historyDetail)
    const editSavingsMovement = vi.fn().mockResolvedValue({
      goal,
      operation: deposit.operation,
      movement: deposit.movement,
    })
    const voidSavingsMovement = vi.fn().mockResolvedValue({
      goal,
      operation: { ...deposit.operation, status: "voided" },
      movement: { ...deposit.movement, status: "voided" },
    })
    render(
      <PlanningPage
        useCases={service({ getSavingsGoalDetail })}
        movementUseCases={movementService({
          editSavingsMovement,
          voidSavingsMovement,
        })}
      />,
    )

    await screen.findByText("Viaje")
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Viaje" }))
    fireEvent.click(await screen.findByRole("button", { name: "Editar depósito" }))
    expect(
      await screen.findByRole("heading", { name: "Editar depósito" }),
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Monto"), {
      target: { value: "120000" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }))
    await waitFor(() =>
      expect(editSavingsMovement).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: deposit.operation.id,
          expectedRevision: deposit.operation.revision,
          amount: 120_000,
        }),
      ),
    )

    fireEvent.click(await screen.findByRole("button", { name: "Anular depósito" }))
    expect(
      screen.getByRole("heading", { name: "Anular depósito" }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Anular movimiento" }))
    await waitFor(() =>
      expect(voidSavingsMovement).toHaveBeenCalledWith({
        operationId: deposit.operation.id,
        expectedRevision: deposit.operation.revision,
      }),
    )
    expect(getSavingsGoalDetail).toHaveBeenCalledTimes(3)
  })

  it("does not offer savings edit or void actions for voided, transfer, or closed-period history", async () => {
    const voidedDeposit = relatedMovement("savings_deposit", 1, 10_000)
    const closedWithdrawal = relatedMovement("savings_withdrawal", 2, -5_000)
    const historyDetail: SavingsGoalDetail = {
      goal,
      canDelete: false,
      relatedMovements: [
        {
          ...voidedDeposit,
          operation: {
            ...voidedDeposit.operation,
            status: "voided",
            voidedAt: NOW,
            voidReason: null,
          } as Operation,
          movement: { ...voidedDeposit.movement, status: "voided" },
        },
        {
          ...closedWithdrawal,
          operation: {
            ...closedWithdrawal.operation,
            periodId: asEntityId("60000000-0000-4000-8000-000000000999"),
          },
        },
        relatedMovement("transfer", 3, 20_000),
        relatedMovement("balance_adjustment", 4, 50_000),
      ],
    }
    render(
      <PlanningPage
        useCases={service({
          getSavingsGoalDetail: vi.fn().mockResolvedValue(historyDetail),
        })}
        movementUseCases={movementService()}
      />,
    )
    await screen.findByText("Viaje")
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Viaje" }))
    await screen.findByText(/Anulado/)
    expect(screen.queryByRole("button", { name: /Editar (depósito|retiro)/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Anular (depósito|retiro)/ })).toBeNull()
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

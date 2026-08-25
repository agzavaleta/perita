import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { SavingsGoal } from "@/domain/entities"
import type {
  SavingsDepositOperation,
  SavingsWithdrawalOperation,
} from "@/domain/operations"
import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asPositiveClpAmount,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import type { MovementUseCasesPort } from "@/features/movements/application/movement-use-cases"
import { SavingsMovementForm } from "@/features/movements/presentation/SavingsMovementForm"

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const NOW = asUtcTimestamp("2026-08-25T12:00:00.000Z")
const GOAL_ID = asEntityId("b1000000-0000-4000-8000-000000000001")
const goal: SavingsGoal = {
  id: GOAL_ID,
  emoji: "💰",
  name: "Viaje",
  bank: null,
  targetAmount: asPositiveClpAmount(1_000_000),
  openingBalance: asClpAmount(0),
  currentBalance: asClpAmount(400_000),
  plannedMonthlyAmount: asClpAmount(50_000),
  lifecycleStatus: "active",
  progressStatus: "in_progress",
  closedAt: null,
  revision: asRevision(2),
  createdAt: NOW,
  updatedAt: NOW,
}

function savingsOperation(
  type: "savings_deposit" | "savings_withdrawal",
  amount: number,
): SavingsDepositOperation | SavingsWithdrawalOperation {
  return {
    id: asEntityId("b1000000-0000-4000-8000-000000000010"),
    periodId: asEntityId("b1000000-0000-4000-8000-000000000011"),
    type,
    operationDate: asCivilDate("2026-08-20"),
    amount: asPositiveClpAmount(amount),
    details: {
      goalId: GOAL_ID,
      concept: "Ahorro original",
      observation: "Nota original",
    },
    status: "posted",
    voidedAt: null,
    voidReason: null,
    revision: asRevision(3),
    createdAt: NOW,
    updatedAt: NOW,
  } as SavingsDepositOperation | SavingsWithdrawalOperation
}

function service(overrides: Partial<MovementUseCasesPort> = {}) {
  return {
    getCurrentDate: vi.fn(() => asCivilDate("2026-08-25")),
    registerSavingsDeposit: vi.fn(),
    registerSavingsWithdrawal: vi.fn(),
    ...overrides,
  } as unknown as MovementUseCasesPort
}

describe("SavingsMovementForm", () => {
  it("registers a deposit with the shared mobile form", async () => {
    const result = { goal }
    const registerSavingsDeposit = vi.fn().mockResolvedValue(result)
    const onSaved = vi.fn()
    render(
      <SavingsMovementForm
        goal={goal}
        mode="deposit"
        useCases={service({ registerSavingsDeposit })}
        onSaved={onSaved}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole("heading", { name: "Depositar en Viaje" }))
      .toBeInTheDocument()
    expect(document.querySelector("[autofocus]")).not.toBeInTheDocument()
    expect(screen.getByRole("dialog")).toHaveClass("max-h-[92dvh]")
    fireEvent.change(screen.getByLabelText("Monto"), {
      target: { value: "100000" },
    })
    fireEvent.change(screen.getByLabelText("Concepto (opcional)"), {
      target: { value: "Ahorro extra" },
    })
    fireEvent.change(screen.getByLabelText("Observación (opcional)"), {
      target: { value: "Desde efectivo" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Depositar" }))

    await waitFor(() =>
      expect(registerSavingsDeposit).toHaveBeenCalledWith({
        goalId: GOAL_ID,
        amount: 100_000,
        operationDate: asCivilDate("2026-08-25"),
        concept: "Ahorro extra",
        observation: "Desde efectivo",
      }),
    )
    expect(onSaved).toHaveBeenCalledWith(result)
  })

  it("shows available balance and blocks an excessive withdrawal", () => {
    const registerSavingsWithdrawal = vi.fn()
    render(
      <SavingsMovementForm
        goal={goal}
        mode="withdrawal"
        useCases={service({ registerSavingsWithdrawal })}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole("heading", { name: "Retirar de Viaje" }))
      .toBeInTheDocument()
    expect(screen.getByText(/Saldo disponible:/)).toHaveTextContent("$400.000")
    fireEvent.change(screen.getByLabelText("Monto"), {
      target: { value: "400001" },
    })
    expect(screen.getByText("Saldo insuficiente")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retirar" })).toBeDisabled()
    expect(registerSavingsWithdrawal).not.toHaveBeenCalled()
  })

  it("registers a valid withdrawal", async () => {
    const registerSavingsWithdrawal = vi.fn().mockResolvedValue({ goal })
    render(
      <SavingsMovementForm
        goal={goal}
        mode="withdrawal"
        useCases={service({ registerSavingsWithdrawal })}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText("Monto"), {
      target: { value: "40000" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Retirar" }))

    await waitFor(() =>
      expect(registerSavingsWithdrawal).toHaveBeenCalledWith(
        expect.objectContaining({ goalId: GOAL_ID, amount: 40_000 }),
      ),
    )
  })

  it("edits a deposit with its initial values and fixed operation type", async () => {
    const operation = savingsOperation("savings_deposit", 100_000)
    const editSavingsMovement = vi.fn().mockResolvedValue({ goal, operation })
    render(
      <SavingsMovementForm
        goal={goal}
        mode="deposit"
        operation={operation}
        useCases={service({ editSavingsMovement })}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole("heading", { name: "Editar depósito" }))
      .toBeInTheDocument()
    expect(screen.getByLabelText("Monto")).toHaveValue("100.000")
    expect(screen.getByLabelText("Fecha")).toHaveValue("2026-08-20")
    expect(screen.getByLabelText("Concepto (opcional)")).toHaveValue(
      "Ahorro original",
    )
    fireEvent.change(screen.getByLabelText("Monto"), {
      target: { value: "150000" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }))

    await waitFor(() =>
      expect(editSavingsMovement).toHaveBeenCalledWith({
        operationId: operation.id,
        expectedRevision: operation.revision,
        operationDate: asCivilDate("2026-08-20"),
        amount: 150_000,
        concept: "Ahorro original",
        observation: "Nota original",
      }),
    )
    expect(screen.queryByRole("button", { name: "Retirar" })).toBeNull()
  })

  it("validates an edited withdrawal against the final projected balance", async () => {
    const operation = savingsOperation("savings_withdrawal", 390_000)
    const lowGoal = { ...goal, currentBalance: asClpAmount(10_000) }
    const editSavingsMovement = vi.fn().mockResolvedValue({
      goal: lowGoal,
      operation,
    })
    render(
      <SavingsMovementForm
        goal={lowGoal}
        mode="withdrawal"
        operation={operation}
        useCases={service({ editSavingsMovement })}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole("heading", { name: "Editar retiro" }))
      .toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Monto"), {
      target: { value: "400000" },
    })
    expect(screen.queryByText("Saldo insuficiente")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }))
    await waitFor(() => expect(editSavingsMovement).toHaveBeenCalledOnce())

    fireEvent.change(screen.getByLabelText("Monto"), {
      target: { value: "400001" },
    })
    expect(screen.getByText("Saldo insuficiente")).toBeInTheDocument()
  })
})

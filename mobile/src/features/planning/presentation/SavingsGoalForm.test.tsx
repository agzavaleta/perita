import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { SavingsGoal } from "@/domain/entities"
import {
  asClpAmount,
  asEntityId,
  asPositiveClpAmount,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import type { PlanningUseCasesPort } from "@/features/planning/application/planning-use-cases"
import { SavingsGoalForm } from "@/features/planning/presentation/SavingsGoalForm"

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const NOW = asUtcTimestamp("2026-08-24T12:00:00.000Z")
const GOAL_ID = asEntityId("c6e00000-0000-4000-8000-000000000001")

const goal: SavingsGoal = {
  id: GOAL_ID,
  emoji: "💰",
  name: "Viaje",
  bank: "Cooperativa histórica",
  targetAmount: asPositiveClpAmount(1_500_000),
  openingBalance: asClpAmount(0),
  currentBalance: asClpAmount(250_000),
  plannedMonthlyAmount: asClpAmount(50_000),
  lifecycleStatus: "active",
  progressStatus: "in_progress",
  closedAt: null,
  revision: asRevision(4),
  createdAt: NOW,
  updatedAt: NOW,
}

function service(overrides: Partial<PlanningUseCasesPort> = {}) {
  return {
    createSavingsGoal: vi.fn().mockResolvedValue(goal),
    editSavingsGoal: vi.fn().mockResolvedValue(goal),
    ...overrides,
  } as unknown as PlanningUseCasesPort
}

function renderForm({
  currentGoal,
  useCases = service(),
}: {
  readonly currentGoal?: SavingsGoal
  readonly useCases?: PlanningUseCasesPort
} = {}) {
  render(
    <SavingsGoalForm
      goal={currentGoal}
      useCases={useCases}
      onSaved={vi.fn()}
      onClose={vi.fn()}
    />,
  )
  return useCases
}

describe("SavingsGoalForm C6E", () => {
  it("uses C2 components and creates with an empty institution and zero contribution", async () => {
    const createSavingsGoal = vi.fn().mockResolvedValue(goal)
    renderForm({ useCases: service({ createSavingsGoal }) })

    const dialog = screen.getByRole("dialog")
    expect(dialog).toHaveClass(
      "max-h-[92dvh]",
      "overflow-y-auto",
      "pb-[calc(1rem+env(safe-area-inset-bottom))]",
    )
    expect(dialog.querySelector("form")?.querySelector(".grid-cols-2")).not.toBeInTheDocument()
    expect(document.querySelector("[autofocus]")).not.toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Emoji" })).toHaveValue("💰")
    expect(screen.getByRole("textbox", { name: "Emoji" })).toBeRequired()
    expect(
      screen.getByRole("combobox", { name: "Banco o institución (opcional)" }),
    ).toHaveTextContent("Sin institución")

    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Casa" },
    })
    const target = screen.getByRole("textbox", { name: "Objetivo" })
    expect(target).toBeRequired()
    fireEvent.change(target, { target: { value: "1500000" } })
    expect(target).toHaveValue("1.500.000")
    expect(screen.getByLabelText("Aporte mensual planificado")).toHaveValue("0")
    fireEvent.click(screen.getByRole("button", { name: "Crear meta" }))

    await waitFor(() =>
      expect(createSavingsGoal).toHaveBeenCalledWith({
        emoji: "💰",
        name: "Casa",
        bank: null,
        targetAmount: 1_500_000,
        plannedMonthlyAmount: 0,
      }),
    )
  })

  it("emits a canonical institution and formatted planned amount", async () => {
    const createSavingsGoal = vi.fn().mockResolvedValue(goal)
    renderForm({ useCases: service({ createSavingsGoal }) })

    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Emergencias" },
    })
    fireEvent.click(
      screen.getByRole("combobox", { name: "Banco o institución (opcional)" }),
    )
    fireEvent.click(screen.getByRole("option", { name: "BancoEstado" }))
    fireEvent.change(screen.getByLabelText("Objetivo"), {
      target: { value: "500000" },
    })
    const monthly = screen.getByLabelText("Aporte mensual planificado")
    fireEvent.change(monthly, { target: { value: "50000" } })
    expect(monthly).toHaveValue("50.000")
    fireEvent.click(screen.getByRole("button", { name: "Crear meta" }))

    await waitFor(() =>
      expect(createSavingsGoal).toHaveBeenCalledWith({
        emoji: "💰",
        name: "Emergencias",
        bank: "BancoEstado",
        targetAmount: 500_000,
        plannedMonthlyAmount: 50_000,
      }),
    )
  })

  it("preserves a custom historical institution and the expected revision on edit", async () => {
    const editSavingsGoal = vi.fn().mockResolvedValue(goal)
    renderForm({ currentGoal: goal, useCases: service({ editSavingsGoal }) })

    expect(
      screen.getByRole("combobox", { name: "Banco o institución (opcional)" }),
    ).toHaveTextContent("Otro")
    expect(screen.getByLabelText("Otra institución")).toHaveValue(
      "Cooperativa histórica",
    )
    expect(screen.getByLabelText("Objetivo")).toHaveValue("1.500.000")
    expect(screen.getByLabelText("Aporte mensual planificado")).toHaveValue("50.000")
    expect(screen.getByRole("textbox", { name: "Emoji" })).toHaveValue("💰")
    fireEvent.change(screen.getByRole("textbox", { name: "Emoji" }), {
      target: { value: "✈️" },
    })
    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Viaje familiar" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }))

    await waitFor(() =>
      expect(editSavingsGoal).toHaveBeenCalledWith({
        goalId: GOAL_ID,
        expectedRevision: asRevision(4),
        emoji: "✈️",
        name: "Viaje familiar",
        bank: "Cooperativa histórica",
        targetAmount: 1_500_000,
        plannedMonthlyAmount: 50_000,
      }),
    )
  })
})

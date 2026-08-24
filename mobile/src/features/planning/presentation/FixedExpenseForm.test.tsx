import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { FixedExpenseInstance, FixedExpenseTemplate } from "@/domain/entities"
import {
  asEntityId,
  asPositiveClpAmount,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import type {
  FixedExpenseListItem,
  PlanningUseCasesPort,
} from "@/features/planning/application/planning-use-cases"
import { FixedExpenseForm } from "@/features/planning/presentation/FixedExpenseForm"

const NOW = asUtcTimestamp("2026-08-24T12:00:00.000Z")
const TEMPLATE_ID = asEntityId("c6d00000-0000-4000-8000-000000000001")
const INSTANCE_ID = asEntityId("c6d00000-0000-4000-8000-000000000002")
const PERIOD_ID = asEntityId("c6d00000-0000-4000-8000-000000000003")

const template: FixedExpenseTemplate = {
  id: TEMPLATE_ID,
  name: "Internet",
  referenceAmount: asPositiveClpAmount(30_000),
  status: "active",
  revision: asRevision(2),
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
  revision: asRevision(3),
  createdAt: NOW,
  updatedAt: NOW,
}

const item: FixedExpenseListItem = { template, currentInstance: instance }

function service(overrides: Partial<PlanningUseCasesPort> = {}) {
  return {
    createFixedExpense: vi.fn().mockResolvedValue(item),
    editFixedExpense: vi.fn().mockResolvedValue(item),
    updateCurrentPlannedAmount: vi.fn().mockResolvedValue(instance),
    ...overrides,
  } as unknown as PlanningUseCasesPort
}

describe("FixedExpenseForm C6D", () => {
  it("uses the shared sheet and CLP input when creating a template", async () => {
    const createFixedExpense = vi.fn().mockResolvedValue(item)
    render(
      <FixedExpenseForm
        editor={{ mode: "template" }}
        useCases={service({ createFixedExpense })}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const dialog = screen.getByRole("dialog")
    expect(dialog).toHaveClass(
      "max-h-[92dvh]",
      "overflow-y-auto",
      "pb-[calc(1rem+env(safe-area-inset-bottom))]",
    )
    expect(dialog.querySelector("form")?.querySelector(".grid-cols-2")).not.toBeInTheDocument()
    expect(document.querySelector("[autofocus]")).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Arriendo" },
    })
    const amount = screen.getByRole("textbox", { name: "Monto de referencia" })
    fireEvent.change(amount, { target: { value: "450000" } })
    expect(amount).toHaveValue("450.000")
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }))

    await waitFor(() =>
      expect(createFixedExpense).toHaveBeenCalledWith({
        name: "Arriendo",
        referenceAmount: 450_000,
      }),
    )
  })

  it("preserves template identity and revision when editing", async () => {
    const editFixedExpense = vi.fn().mockResolvedValue(item)
    render(
      <FixedExpenseForm
        editor={{ mode: "template", item }}
        useCases={service({ editFixedExpense })}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByLabelText("Monto de referencia")).toHaveValue("30.000")
    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Internet hogar" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }))

    await waitFor(() =>
      expect(editFixedExpense).toHaveBeenCalledWith({
        templateId: TEMPLATE_ID,
        expectedRevision: asRevision(2),
        name: "Internet hogar",
        referenceAmount: 30_000,
      }),
    )
  })

  it("updates only the current instance planned amount", async () => {
    const updateCurrentPlannedAmount = vi.fn().mockResolvedValue(instance)
    render(
      <FixedExpenseForm
        editor={{ mode: "instance", item }}
        useCases={service({ updateCurrentPlannedAmount })}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.queryByLabelText("Nombre")).not.toBeInTheDocument()
    const amount = screen.getByRole("textbox", { name: "Monto planificado" })
    expect(amount).toHaveValue("28.000")
    fireEvent.change(amount, { target: { value: "31000" } })
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }))

    await waitFor(() =>
      expect(updateCurrentPlannedAmount).toHaveBeenCalledWith(
        INSTANCE_ID,
        asRevision(3),
        31_000,
      ),
    )
  })
})

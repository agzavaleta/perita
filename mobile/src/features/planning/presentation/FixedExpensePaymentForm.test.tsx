import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { Account, FixedExpenseInstance, FixedExpenseTemplate } from "@/domain/entities"
import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asPositiveClpAmount,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import type { MovementUseCasesPort } from "@/features/movements/application/movement-use-cases"
import type { FixedExpenseListItem } from "@/features/planning/application/planning-use-cases"
import { FixedExpensePaymentForm } from "@/features/planning/presentation/FixedExpensePaymentForm"

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const NOW = asUtcTimestamp("2026-08-24T12:00:00.000Z")
const TEMPLATE_ID = asEntityId("c6d10000-0000-4000-8000-000000000001")
const INSTANCE_ID = asEntityId("c6d10000-0000-4000-8000-000000000002")
const PERIOD_ID = asEntityId("c6d10000-0000-4000-8000-000000000003")
const ACCOUNT_ID = asEntityId("c6d10000-0000-4000-8000-000000000004")

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

const account: Account = {
  id: ACCOUNT_ID,
  emoji: "💳",
  name: "Principal",
  bank: null,
  openingBalance: asClpAmount(100_000),
  currentBalance: asClpAmount(100_000),
  status: "active",
  deletedAt: null,
  balanceAtDeletion: null,
  revision: asRevision(1),
  createdAt: NOW,
  updatedAt: NOW,
}

const item: FixedExpenseListItem = { template, currentInstance: instance }

describe("FixedExpensePaymentForm C6D", () => {
  it("uses the shared sheet, prefills planned CLP, and preserves the payment payload", async () => {
    const registerFixedExpensePayment = vi.fn().mockResolvedValue({})
    const useCases = {
      getFormOptions: vi.fn().mockResolvedValue({
        accounts: [account],
        categories: [],
        currentDate: asCivilDate("2026-08-24"),
      }),
      registerFixedExpensePayment,
    } as unknown as MovementUseCasesPort
    render(
      <FixedExpensePaymentForm
        item={item}
        useCases={useCases}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const amount = await screen.findByRole("textbox", { name: "Monto" })
    const dialog = screen.getByRole("dialog")
    expect(dialog).toHaveClass(
      "max-h-[92dvh]",
      "data-[side=bottom]:overflow-y-auto",
      "data-[side=bottom]:pb-[calc(1rem+env(safe-area-inset-bottom))]",
    )
    expect(dialog.querySelector("form")?.querySelector(".grid-cols-2")).not.toBeInTheDocument()
    expect(document.querySelector("[autofocus]")).not.toBeInTheDocument()
    expect(amount).toHaveValue("28.000")
    fireEvent.click(screen.getByRole("button", { name: "Registrar pago" }))

    await waitFor(() =>
      expect(registerFixedExpensePayment).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        fixedExpenseInstanceId: INSTANCE_ID,
        operationDate: asCivilDate("2026-08-24"),
        amount: 28_000,
      }),
    )
  })
})

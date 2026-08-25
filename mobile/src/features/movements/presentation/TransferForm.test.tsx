import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { Account, SavingsGoal } from "@/domain/entities"
import type { Movement, TransferOperation } from "@/domain/operations"
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
  MovementListItem,
  MovementUseCasesPort,
  TransferFormOptions,
  TransferPreview,
  TransferDraft,
} from "@/features/movements/application/movement-use-cases"
import { TransferForm } from "@/features/movements/presentation/TransferForm"

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }))
vi.mock("sonner", () => ({ toast: { success: toastSuccess } }))

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => toastSuccess.mockClear())

const NOW = asUtcTimestamp("2026-08-24T12:00:00.000Z")
const TODAY = asCivilDate("2026-08-24")
const ACCOUNT_A = asEntityId("c6f00000-0000-4000-8000-000000000001")
const ACCOUNT_B = asEntityId("c6f00000-0000-4000-8000-000000000002")
const GOAL_A = asEntityId("c6f00000-0000-4000-8000-000000000003")
const GOAL_B = asEntityId("c6f00000-0000-4000-8000-000000000004")
const PERIOD_ID = asEntityId("c6f00000-0000-4000-8000-000000000005")
const OPERATION_ID = asEntityId("c6f00000-0000-4000-8000-000000000006")
const SOURCE_MOVEMENT_ID = asEntityId("c6f00000-0000-4000-8000-000000000007")
const DESTINATION_MOVEMENT_ID = asEntityId("c6f00000-0000-4000-8000-000000000008")

function account(id: typeof ACCOUNT_A, name: string): Account {
  return {
    id,
    emoji: "💳",
    name,
    bank: null,
    openingBalance: asClpAmount(100_000),
    currentBalance: asClpAmount(100_000),
    status: "active",
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function goal(id: typeof GOAL_A, name: string): SavingsGoal {
  return {
    id,
    emoji: "💰",
    name,
    bank: null,
    targetAmount: asPositiveClpAmount(500_000),
    openingBalance: asClpAmount(50_000),
    currentBalance: asClpAmount(50_000),
    plannedMonthlyAmount: asClpAmount(10_000),
    lifecycleStatus: "active",
    progressStatus: "in_progress",
    closedAt: null,
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

const options: TransferFormOptions = {
  accounts: [account(ACCOUNT_A, "Cuenta A"), account(ACCOUNT_B, "Cuenta B")],
  savingsGoals: [goal(GOAL_A, "Meta A"), goal(GOAL_B, "Meta B")],
  currentDate: TODAY,
}

const operation: TransferOperation = {
  id: OPERATION_ID,
  periodId: PERIOD_ID,
  type: "transfer",
  operationDate: TODAY,
  amount: asPositiveClpAmount(12_000),
  details: {
    sourceType: "account",
    sourceId: ACCOUNT_A,
    destinationType: "savings_goal",
    destinationId: GOAL_B,
    concept: "Ahorro",
    observation: "Transferencia editada",
  },
  status: "posted",
  voidedAt: null,
  voidReason: null,
  revision: asRevision(3),
  createdAt: NOW,
  updatedAt: NOW,
}

const sourceMovement: Movement = {
  id: SOURCE_MOVEMENT_ID,
  operationId: OPERATION_ID,
  periodId: PERIOD_ID,
  targetType: "account",
  targetId: ACCOUNT_A,
  effectType: "asset_balance",
  delta: asNonZeroClpDelta(-12_000),
  status: "posted",
  createdAt: NOW,
  updatedAt: NOW,
}

const destinationMovement: Movement = {
  id: DESTINATION_MOVEMENT_ID,
  operationId: OPERATION_ID,
  periodId: PERIOD_ID,
  targetType: "savings_goal",
  targetId: GOAL_B,
  effectType: "asset_balance",
  delta: asNonZeroClpDelta(12_000),
  status: "posted",
  createdAt: NOW,
  updatedAt: NOW,
}

const item: MovementListItem = {
  operation,
  movement: sourceMovement,
  movements: [sourceMovement, destinationMovement],
  kind: "transfer",
  title: "Ahorro",
  description: "Cuenta A → Meta B",
  accountName: "Cuenta A",
  signedAmount: 0,
}

function previewFor(input: TransferDraft): TransferPreview {
  const source = input.sourceType === "account"
    ? options.accounts.find(({ id }) => id === input.sourceId)!
    : options.savingsGoals.find(({ id }) => id === input.sourceId)!
  const destination = input.destinationType === "account"
    ? options.accounts.find(({ id }) => id === input.destinationId)!
    : options.savingsGoals.find(({ id }) => id === input.destinationId)!
  return {
    source: {
      name: source.name,
      currentBalance: source.currentBalance,
      resultingBalance: source.currentBalance - input.amount,
    },
    destination: {
      name: destination.name,
      currentBalance: destination.currentBalance,
      resultingBalance: destination.currentBalance + input.amount,
    },
    amount: input.amount,
    operationDate: input.operationDate,
  }
}

function service(overrides: Partial<MovementUseCasesPort> = {}) {
  return {
    previewTransfer: vi.fn((input: TransferDraft) => Promise.resolve(previewFor(input))),
    registerTransfer: vi.fn().mockResolvedValue(item),
    editTransfer: vi.fn().mockResolvedValue(item),
    ...overrides,
  } as unknown as MovementUseCasesPort
}

function renderForm({
  editing = false,
  useCases = service(),
}: {
  readonly editing?: boolean
  readonly useCases?: MovementUseCasesPort
} = {}) {
  render(
    <TransferForm
      editor={{ item: editing ? item : undefined }}
      options={options}
      useCases={useCases}
      onSaved={vi.fn()}
      onClose={vi.fn()}
    />,
  )
  return useCases
}

function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }))
  fireEvent.click(screen.getByRole("option", { name: option }))
}

async function submitAndExpect(
  configure: () => void,
  expected: {
    sourceType: "account" | "savings_goal"
    sourceId: typeof ACCOUNT_A
    destinationType: "account" | "savings_goal"
    destinationId: typeof ACCOUNT_A
  },
) {
  const registerTransfer = vi.fn().mockResolvedValue(item)
  renderForm({ useCases: service({ registerTransfer }) })
  configure()
  fireEvent.change(screen.getByRole("textbox", { name: "Monto" }), {
    target: { value: "10000" },
  })
  const form = screen.getByRole("button", { name: "Mover dinero" }).closest("form")
  if (!form) throw new Error("Transfer form not found")
  fireEvent.submit(form)

  expect(registerTransfer).not.toHaveBeenCalled()
  await screen.findByRole("alertdialog")
  fireEvent.click(screen.getByRole("button", { name: "Confirmar transferencia" }))

  await waitFor(() =>
    expect(registerTransfer).toHaveBeenCalledWith({
      ...expected,
      operationDate: TODAY,
      amount: 10_000,
      concept: "",
      observation: "",
    }),
  )
  expect(toastSuccess).toHaveBeenCalledWith("Transferencia realizada")
}

describe("TransferForm C6F", () => {
  it("uses the shared sheet, independent rows, optional labels, and CLP input", () => {
    renderForm()

    const dialog = screen.getByRole("dialog")
    const form = dialog.querySelector("form")
    expect(dialog).toHaveClass(
      "max-h-[92dvh]",
      "data-[side=bottom]:overflow-y-auto",
      "data-[side=bottom]:pb-[calc(1rem+env(safe-area-inset-bottom))]",
    )
    expect(form?.querySelector(".grid-cols-2")).not.toBeInTheDocument()
    expect(
      [...(form?.querySelectorAll("label") ?? [])].map((label) => label.textContent),
    ).toEqual([
      "Tipo de origen",
      "Fondo de origen",
      "Tipo de destino",
      "Fondo de destino",
      "Fecha",
      "Monto",
      "Concepto (opcional)",
      "Observación (opcional)",
    ])
    const amount = screen.getByRole("textbox", { name: "Monto" })
    fireEvent.change(amount, { target: { value: "1500000" } })
    expect(amount).toHaveValue("1.500.000")
    expect(document.querySelector("[autofocus]")).not.toBeInTheDocument()
    expect(amount).not.toHaveFocus()
  })

  it("preserves account to account transfers", async () => {
    await submitAndExpect(() => undefined, {
      sourceType: "account",
      sourceId: ACCOUNT_A,
      destinationType: "account",
      destinationId: ACCOUNT_B,
    })
  })

  it("preserves account to goal transfers", async () => {
    await submitAndExpect(() => choose("Tipo de destino", "Meta"), {
      sourceType: "account",
      sourceId: ACCOUNT_A,
      destinationType: "savings_goal",
      destinationId: GOAL_A,
    })
  })

  it("preserves goal to account transfers", async () => {
    await submitAndExpect(() => choose("Tipo de origen", "Meta"), {
      sourceType: "savings_goal",
      sourceId: GOAL_A,
      destinationType: "account",
      destinationId: ACCOUNT_B,
    })
  })

  it("preserves goal to goal transfers", async () => {
    await submitAndExpect(() => {
      choose("Tipo de origen", "Meta")
      choose("Tipo de destino", "Meta")
      choose("Fondo de destino", "Meta B")
    }, {
      sourceType: "savings_goal",
      sourceId: GOAL_A,
      destinationType: "savings_goal",
      destinationId: GOAL_B,
    })
  })

  it("keeps the same endpoint blocked", () => {
    const registerTransfer = vi.fn().mockResolvedValue(item)
    renderForm({ useCases: service({ registerTransfer }) })
    choose("Tipo de origen", "Meta")
    choose("Tipo de destino", "Meta")

    expect(screen.getByText("Elige otro destino")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Mover dinero" })).toBeDisabled()
    expect(registerTransfer).not.toHaveBeenCalled()
  })

  it("preserves operation identity, revision, and payload while editing", async () => {
    const editTransfer = vi.fn().mockResolvedValue(item)
    renderForm({ editing: true, useCases: service({ editTransfer }) })

    expect(screen.getByLabelText("Monto")).toHaveValue("12.000")
    fireEvent.change(screen.getByLabelText("Fecha"), {
      target: { value: "2026-08-23" },
    })
    fireEvent.change(screen.getByLabelText("Monto"), {
      target: { value: "18000" },
    })
    fireEvent.change(screen.getByLabelText("Concepto (opcional)"), {
      target: { value: "Ahorro actualizado" },
    })
    fireEvent.change(screen.getByLabelText("Observación (opcional)"), {
      target: { value: "Sin comisión" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Revisar cambios" }))
    await screen.findByRole("alertdialog")
    fireEvent.click(screen.getByRole("button", { name: "Confirmar transferencia" }))

    await waitFor(() =>
      expect(editTransfer).toHaveBeenCalledWith({
        operationId: OPERATION_ID,
        expectedRevision: asRevision(3),
        sourceType: "account",
        sourceId: ACCOUNT_A,
        destinationType: "savings_goal",
        destinationId: GOAL_B,
        operationDate: asCivilDate("2026-08-23"),
        amount: 18_000,
        concept: "Ahorro actualizado",
        observation: "Sin comisión",
      }),
    )
  })

  it("muestra el resumen y Volver no persiste", async () => {
    const registerTransfer = vi.fn().mockResolvedValue(item)
    renderForm({ useCases: service({ registerTransfer }) })
    fireEvent.change(screen.getByRole("textbox", { name: "Monto" }), {
      target: { value: "10000" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Mover dinero" }))

    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Cuenta A")
    expect(dialog).toHaveTextContent("Cuenta B")
    expect(dialog).toHaveTextContent("$10.000")
    expect(dialog).toHaveTextContent(TODAY)
    expect(dialog).toHaveTextContent("$100.000")
    expect(dialog).toHaveTextContent("$90.000")
    expect(dialog).toHaveTextContent("$110.000")
    fireEvent.click(screen.getByRole("button", { name: "Volver" }))
    expect(registerTransfer).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(screen.getByRole("textbox", { name: "Monto" })).toHaveValue("10.000")
  })

  it("no muestra éxito cuando falla la persistencia confirmada", async () => {
    const registerTransfer = vi.fn().mockRejectedValue(new Error("Conflicto"))
    renderForm({ useCases: service({ registerTransfer }) })
    fireEvent.change(screen.getByRole("textbox", { name: "Monto" }), {
      target: { value: "10000" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Mover dinero" }))
    await screen.findByRole("alertdialog")
    fireEvent.click(screen.getByRole("button", { name: "Confirmar transferencia" }))

    expect(await screen.findByText("Conflicto")).toBeInTheDocument()
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { Account, Debt } from "@/domain/entities"
import { deriveDebtProgress } from "@/domain/invariants"
import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asPositiveClpAmount,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import type {
  DebtDetail,
  DebtListItem,
  DebtUseCasesPort,
} from "@/features/planning/application/debt-use-cases"
import { DebtSection } from "@/features/planning/presentation/DebtSection"
import { toast } from "sonner"

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }))

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

const NOW = asUtcTimestamp("2026-08-24T12:00:00.000Z")
const DEBT_ID = asEntityId("c5b00000-0000-4000-8000-000000000001")
const ACCOUNT_ID = asEntityId("c6b00000-0000-4000-8000-000000000002")

const account: Account = {
  id: ACCOUNT_ID,
  emoji: "💳",
  name: "Cuenta principal",
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

function debt(overrides: Partial<Debt> = {}): Debt {
  return {
    id: DEBT_ID,
    name: "Crédito",
    totalAmount: asPositiveClpAmount(100_000),
    openingOutstanding: asClpAmount(100_000),
    outstandingAmount: asClpAmount(75_000),
    dueDate: null,
    monthlyPaymentAmount: asPositiveClpAmount(25_000),
    paymentDay: null,
    lifecycleStatus: "active",
    paymentStatus: "active",
    revision: asRevision(2),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function listItem(current = debt()): DebtListItem {
  return {
    debt: current,
    ...deriveDebtProgress(current),
    schedule: {
      remainingInstallments: 3,
      nextPaymentDate: null,
      estimatedEndDate: null,
    },
  }
}

function detail(current = debt()): DebtDetail {
  return {
    ...listItem(current),
    payments: [],
    adjustments: [],
    auditEvents: [],
    canDelete: false,
  }
}

function service({
  current = debt(),
  items = [listItem(current)],
  debtDetail = detail(current),
  ...overrides
}: {
  readonly current?: Debt
  readonly items?: readonly DebtListItem[]
  readonly debtDetail?: DebtDetail
} & Partial<DebtUseCasesPort> = {}): DebtUseCasesPort {
  return {
    listDebts: vi.fn().mockResolvedValue(items),
    getDebtDetail: vi.fn().mockResolvedValue(debtDetail),
    getPaymentFormOptions: vi.fn().mockResolvedValue({
      accounts: [account],
      currentDate: asCivilDate("2026-08-24"),
    }),
    createDebt: vi.fn().mockResolvedValue(current),
    editDebt: vi.fn().mockResolvedValue(current),
    adjustDebtTotal: vi.fn().mockResolvedValue(current),
    registerPayment: vi.fn(),
    editPayment: vi.fn(),
    voidPayment: vi.fn(),
    deleteDebt: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

async function openNewDebt(api: DebtUseCasesPort) {
  render(<DebtSection useCases={api} />)
  fireEvent.click(screen.getByRole("button", { name: "Nueva" }))
  return screen.findByRole("heading", { name: "Nueva deuda" })
}

async function openDebtDetail(api: DebtUseCasesPort) {
  render(<DebtSection useCases={api} />)
  await screen.findByText("Crédito")
  fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Crédito" }))
  return screen.findByRole("heading", { name: "Crédito" })
}

describe("DebtSection C5B", () => {
  it("creates with a required installment and null optional values", async () => {
    const createDebt = vi.fn().mockResolvedValue(debt())
    const api = service({ items: [], createDebt })
    await openNewDebt(api)

    expect(
      screen.getByRole("switch", { name: "Tiene fecha de vencimiento" }),
    ).not.toBeChecked()
    expect(screen.queryByLabelText("Fecha de vencimiento")).toBeNull()

    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Crédito personal" },
    })
    fireEvent.change(screen.getByLabelText("Total"), {
      target: { value: "100000" },
    })
    const monthly = screen.getByLabelText("Cuota mensual")
    expect(monthly).toBeRequired()
    fireEvent.change(monthly, { target: { value: "25000" } })
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }))

    await waitFor(() =>
      expect(createDebt).toHaveBeenCalledWith({
        name: "Crédito personal",
        totalAmount: 100_000,
        currentOutstandingAmount: null,
        dueDate: null,
        monthlyPaymentAmount: 25_000,
        paymentDay: null,
      }),
    )
  })

  it("creates with due date and payment day when provided", async () => {
    const createDebt = vi.fn().mockResolvedValue(debt())
    const api = service({ items: [], createDebt })
    await openNewDebt(api)

    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Crédito programado" },
    })
    fireEvent.change(screen.getByLabelText("Total"), {
      target: { value: "120000" },
    })
    fireEvent.click(
      screen.getByRole("switch", { name: "Tiene fecha de vencimiento" }),
    )
    expect(screen.getByLabelText("Fecha de vencimiento")).toHaveValue("")
    expect(screen.getByLabelText("Fecha de vencimiento")).toBeRequired()
    fireEvent.change(screen.getByLabelText("Fecha de vencimiento"), {
      target: { value: "2026-12-31" },
    })
    fireEvent.change(screen.getByLabelText("Cuota mensual"), {
      target: { value: "30000" },
    })
    fireEvent.change(screen.getByLabelText("Día de pago (opcional)"), {
      target: { value: "15" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }))

    await waitFor(() =>
      expect(createDebt).toHaveBeenCalledWith(
        expect.objectContaining({
          currentOutstandingAmount: null,
          dueDate: "2026-12-31",
          monthlyPaymentAmount: 30_000,
          paymentDay: 15,
        }),
      ),
    )
  })

  it("does not submit creation while the required installment is empty", async () => {
    const createDebt = vi.fn().mockResolvedValue(debt())
    const api = service({ items: [], createDebt })
    await openNewDebt(api)

    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Sin cuota" },
    })
    fireEvent.change(screen.getByLabelText("Total"), {
      target: { value: "100000" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }))

    expect(createDebt).not.toHaveBeenCalled()
  })

  it("creates with an optional current outstanding amount and blocks invalid ranges", async () => {
    const createDebt = vi.fn().mockResolvedValue(debt())
    const api = service({ items: [], createDebt })
    await openNewDebt(api)

    expect(
      screen.getByText("Úsalo si ya pagaste parte de esta deuda."),
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Crédito anterior" },
    })
    fireEvent.change(screen.getByLabelText("Total"), {
      target: { value: "1000000" },
    })
    fireEvent.change(
      screen.getByLabelText("Saldo pendiente actual (opcional)"),
      { target: { value: "1000001" } },
    )
    fireEvent.change(screen.getByLabelText("Cuota mensual"), {
      target: { value: "100000" },
    })
    expect(
      screen.getByText("El saldo pendiente no puede superar el total de la deuda."),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Guardar" })).toBeDisabled()

    fireEvent.change(
      screen.getByLabelText("Saldo pendiente actual (opcional)"),
      { target: { value: "600000" } },
    )
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }))
    await waitFor(() =>
      expect(createDebt).toHaveBeenCalledWith(
        expect.objectContaining({
          totalAmount: 1_000_000,
          currentOutstandingAmount: 600_000,
        }),
      ),
    )
  })

  it("prefills editing values and permits clearing due date and payment day", async () => {
    const current = debt({
      dueDate: asCivilDate("2026-12-31"),
      paymentDay: 15,
    })
    const editDebt = vi.fn().mockResolvedValue(current)
    const api = service({ current, debtDetail: detail(current), editDebt })
    await openDebtDetail(api)
    fireEvent.click(screen.getByRole("button", { name: "Editar" }))

    expect(
      screen.getByRole("switch", { name: "Tiene fecha de vencimiento" }),
    ).toBeChecked()
    expect(screen.getByLabelText("Fecha de vencimiento")).toHaveValue(
      "2026-12-31",
    )
    expect(screen.getByLabelText("Día de pago (opcional)")).toHaveValue(15)
    expect(
      screen.queryByLabelText("Saldo pendiente actual (opcional)"),
    ).toBeNull()
    fireEvent.click(
      screen.getByRole("switch", { name: "Tiene fecha de vencimiento" }),
    )
    expect(screen.queryByLabelText("Fecha de vencimiento")).toBeNull()
    fireEvent.change(screen.getByLabelText("Día de pago (opcional)"), {
      target: { value: "" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }))

    await waitFor(() =>
      expect(editDebt).toHaveBeenCalledWith({
        debtId: DEBT_ID,
        expectedRevision: asRevision(2),
        name: "Crédito",
        dueDate: null,
        monthlyPaymentAmount: 25_000,
        paymentDay: null,
      }),
    )
  })

  it("starts editing without a due date with the switch off", async () => {
    const current = debt({ dueDate: null })
    const api = service({ current, debtDetail: detail(current) })
    await openDebtDetail(api)
    fireEvent.click(screen.getByRole("button", { name: "Editar" }))

    expect(
      screen.getByRole("switch", { name: "Tiene fecha de vencimiento" }),
    ).not.toBeChecked()
    expect(screen.queryByLabelText("Fecha de vencimiento")).toBeNull()
  })

  it("shows eligible debt deletion, cancels without writing, and confirms once", async () => {
    const deleteDebt = vi.fn().mockResolvedValue(undefined)
    const current = debt()
    await openDebtDetail(service({
      current,
      debtDetail: { ...detail(current), canDelete: true },
      deleteDebt,
    }))

    fireEvent.click(screen.getByRole("button", { name: "Eliminar deuda" }))
    expect(screen.getByRole("heading", { name: "¿Eliminar deuda?" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
    expect(deleteDebt).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Eliminar deuda" }))
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }))
    await waitFor(() => expect(deleteDebt).toHaveBeenCalledOnce())
    expect(deleteDebt).toHaveBeenCalledWith(current.id, current.revision)
    expect(toast.success).toHaveBeenCalledWith("Deuda eliminada")
  })

  it("shows complete scheduled planning data in detail", async () => {
    const current = debt({
      dueDate: asCivilDate("2026-12-31"),
      paymentDay: 15,
    })
    const debtDetail: DebtDetail = {
      ...detail(current),
      schedule: {
        remainingInstallments: 3,
        nextPaymentDate: asCivilDate("2026-09-15"),
        estimatedEndDate: asCivilDate("2026-11-15"),
      },
    }
    await openDebtDetail(service({ current, debtDetail }))
    const dialog = screen.getByRole("dialog")

    expect(within(dialog).getAllByText("$25.000")).toHaveLength(2)
    expect(within(dialog).getByText("31-12-2026")).toBeInTheDocument()
    expect(within(dialog).getByText("Día 15")).toBeInTheDocument()
    expect(within(dialog).getByText("3")).toBeInTheDocument()
    expect(within(dialog).getByText("15-09-2026")).toBeInTheDocument()
    expect(within(dialog).getByText("15-11-2026")).toBeInTheDocument()
  })

  it("shows derived paid progress in the debt card and detail", async () => {
    const current = debt({
      totalAmount: asPositiveClpAmount(1_000_000),
      openingOutstanding: asClpAmount(600_000),
      outstandingAmount: asClpAmount(600_000),
    })
    const api = service({ current })
    render(<DebtSection useCases={api} />)

    expect(await screen.findByText("40% pagado")).toBeInTheDocument()
    expect(
      screen.getByRole("progressbar", { name: "Progreso de pago" }),
    ).toHaveAttribute("aria-valuenow", "40")
    fireEvent.click(
      screen.getByRole("button", { name: "Ver detalle de Crédito" }),
    )
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Total")).toBeInTheDocument()
    expect(within(dialog).getByText("Pagado")).toBeInTheDocument()
    expect(within(dialog).getByText("Pendiente")).toBeInTheDocument()
    expect(within(dialog).getByText("$1.000.000")).toBeInTheDocument()
    expect(within(dialog).getByText("$400.000")).toBeInTheDocument()
    expect(within(dialog).getByText("$600.000")).toBeInTheDocument()
    expect(within(dialog).getByText("40% pagado")).toBeInTheDocument()
  })

  it("shows unscheduled labels, remaining installments, and em dashes", async () => {
    const current = debt({ dueDate: null, paymentDay: null })
    const debtDetail: DebtDetail = {
      ...detail(current),
      schedule: {
        remainingInstallments: 3,
        nextPaymentDate: null,
        estimatedEndDate: null,
      },
    }
    await openDebtDetail(service({ current, debtDetail }))
    const dialog = screen.getByRole("dialog")

    expect(within(dialog).getByText("Sin vencimiento")).toBeInTheDocument()
    expect(within(dialog).getByText("Sin día definido")).toBeInTheDocument()
    expect(within(dialog).getByText("3")).toBeInTheDocument()
    expect(within(dialog).getAllByText("—")).toHaveLength(2)
  })

  it("renders overdue from paymentStatus even without a payment day", async () => {
    const overdue = debt({
      dueDate: asCivilDate("2026-08-20"),
      paymentDay: null,
      paymentStatus: "overdue",
    })
    render(<DebtSection useCases={service({ current: overdue })} />)

    expect(await screen.findByText("Atrasada")).toBeInTheDocument()
  })
})

describe("DebtSection C6B form infrastructure", () => {
  it("uses the shared form sheet and CLP inputs without field grids in DebtEditor", async () => {
    await openNewDebt(service({ items: [] }))

    const dialog = screen.getByRole("dialog")
    const form = dialog.querySelector("form")
    expect(dialog).toHaveAttribute("data-side", "bottom")
    expect(dialog).toHaveClass(
      "max-h-[92dvh]",
      "data-[side=bottom]:overflow-y-auto",
      "data-[side=bottom]:pb-[calc(1rem+env(safe-area-inset-bottom))]",
    )
    expect(form?.querySelector(".grid-cols-2")).not.toBeInTheDocument()

    const total = screen.getByRole("textbox", { name: "Total" })
    const monthly = screen.getByRole("textbox", { name: "Cuota mensual" })
    fireEvent.change(total, { target: { value: "1500000" } })
    fireEvent.change(monthly, { target: { value: "25000" } })
    expect(total).toHaveValue("1.500.000")
    expect(monthly).toHaveValue("25.000")
    expect(
      screen.getByRole("switch", { name: "Tiene fecha de vencimiento" }),
    ).not.toBeChecked()
    expect(screen.queryByLabelText("Fecha de vencimiento")).toBeNull()
    expect(screen.getByLabelText("Día de pago (opcional)")).toBeInTheDocument()
    expect(document.querySelector("[autofocus]")).not.toBeInTheDocument()
    expect(total).not.toHaveFocus()
  })

  it("normalizes PaymentEditor and preserves its payload", async () => {
    const registerPayment = vi.fn().mockResolvedValue({})
    const api = service({ registerPayment })
    await openDebtDetail(api)
    fireEvent.click(screen.getByRole("button", { name: "Registrar pago" }))

    const dialog = screen.getByRole("dialog")
    const form = dialog.querySelector("form")
    expect(dialog).toHaveClass(
      "data-[side=bottom]:pb-[calc(1rem+env(safe-area-inset-bottom))]",
    )
    expect(form?.querySelector(".grid-cols-2")).not.toBeInTheDocument()
    const amount = screen.getByRole("textbox", { name: "Monto" })
    fireEvent.change(amount, { target: { value: "25000" } })
    expect(amount).toHaveValue("25.000")
    fireEvent.change(screen.getByLabelText("Concepto (opcional)"), {
      target: { value: "Abono" },
    })
    fireEvent.change(screen.getByLabelText("Observación (opcional)"), {
      target: { value: "Pago mensual" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Guardar pago" }))

    await waitFor(() =>
      expect(registerPayment).toHaveBeenCalledWith({
        debtId: DEBT_ID,
        accountId: ACCOUNT_ID,
        operationDate: asCivilDate("2026-08-24"),
        amount: 25_000,
        concept: "Abono",
        observation: "Pago mensual",
      }),
    )
  })

  it("normalizes TotalEditor and preserves the total-adjustment payload", async () => {
    const adjustDebtTotal = vi.fn().mockResolvedValue(debt())
    const api = service({ adjustDebtTotal })
    await openDebtDetail(api)
    fireEvent.click(screen.getByRole("button", { name: "Ajustar total" }))

    const dialog = screen.getByRole("dialog")
    const form = dialog.querySelector("form")
    expect(dialog).toHaveClass(
      "data-[side=bottom]:pb-[calc(1rem+env(safe-area-inset-bottom))]",
    )
    expect(form?.querySelector(".grid-cols-2")).not.toBeInTheDocument()
    const total = screen.getByRole("textbox", { name: "Nuevo total" })
    fireEvent.change(total, { target: { value: "120000" } })
    expect(total).toHaveValue("120.000")
    fireEvent.click(screen.getByRole("button", { name: "Ajustar total" }))

    await waitFor(() =>
      expect(adjustDebtTotal).toHaveBeenCalledWith(
        DEBT_ID,
        asRevision(2),
        asCivilDate("2026-08-24"),
        120_000,
      ),
    )
  })
})

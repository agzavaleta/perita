import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { Account } from "@/domain/entities"
import type { BalanceAdjustmentOperation, Movement } from "@/domain/operations"
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
  AccountMovementHistoryItem,
  AccountUseCasesPort,
} from "@/features/accounts/application/account-use-cases"
import type { BalanceAdjustmentUseCasesPort } from "@/features/accounts/application/balance-adjustment-use-cases"
import { AccountsPage } from "@/features/accounts/presentation/AccountsPage"
import { toast } from "sonner"

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }))

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const account: Account = {
  id: asEntityId("20000000-0000-4000-8000-000000000001"),
  emoji: "💳",
  name: "Cuenta principal",
  bank: "Banco Estado",
  openingBalance: asClpAmount(0),
  currentBalance: asClpAmount(0),
  status: "active",
  deletedAt: null,
  balanceAtDeletion: null,
  revision: asRevision(1),
  createdAt: asUtcTimestamp("2026-08-21T12:00:00.000Z"),
  updatedAt: asUtcTimestamp("2026-08-21T12:00:00.000Z"),
}

const adjustmentOperation: BalanceAdjustmentOperation = {
  id: asEntityId("20000000-0000-4000-8000-000000000010"),
  periodId: asEntityId("20000000-0000-4000-8000-000000000011"),
  type: "balance_adjustment",
  operationDate: asCivilDate("2026-08-20"),
  amount: asPositiveClpAmount(25_000),
  details: { accountId: account.id, reason: "Conciliar con banco" },
  status: "posted",
  voidedAt: null,
  voidReason: null,
  revision: asRevision(1),
  createdAt: asUtcTimestamp("2026-08-20T12:00:00.000Z"),
  updatedAt: asUtcTimestamp("2026-08-20T12:00:00.000Z"),
}

const adjustmentMovement: Movement = {
  id: asEntityId("20000000-0000-4000-8000-000000000012"),
  operationId: adjustmentOperation.id,
  periodId: adjustmentOperation.periodId,
  targetType: "account",
  targetId: account.id,
  effectType: "asset_balance",
  delta: asNonZeroClpDelta(25_000),
  status: "posted",
  createdAt: adjustmentOperation.createdAt,
  updatedAt: adjustmentOperation.updatedAt,
}

const adjustmentHistory: AccountMovementHistoryItem = {
  operation: adjustmentOperation,
  movement: adjustmentMovement,
  title: "Ajuste de saldo",
  description: "Conciliar con banco",
  signedAmount: 25_000,
}

function service(overrides: Partial<AccountUseCasesPort> = {}): AccountUseCasesPort {
  return {
    listAccounts: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockResolvedValue(account),
    listRelatedMovements: vi.fn().mockResolvedValue([]),
    createAccount: vi.fn().mockResolvedValue(account),
    editAccount: vi.fn().mockResolvedValue(account),
    deactivateAccount: vi.fn().mockResolvedValue({ ...account, status: "inactive" }),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe("AccountsPage", () => {
  it("creates an account without exposing balance editing in the UI", async () => {
    const listAccounts = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([account])
    const createAccount = vi.fn().mockResolvedValue(account)
    const useCases = service({ listAccounts, createAccount })
    render(<AccountsPage useCases={useCases} />)

    expect(
      await screen.findByText("Aún no has agregado ninguna cuenta"),
    ).toBeInTheDocument()
    expect(screen.getByText("Consulta saldos y administra tus cuentas.")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Cuentas" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Nueva" }))

    expect(screen.getByText("La cuenta se creará activa y con saldo $0.")).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Emoji" })).toHaveValue("💳")
    expect(screen.getByRole("textbox", { name: "Emoji" })).toBeRequired()
    expect(screen.queryByLabelText(/saldo/i)).not.toBeInTheDocument()
    const dialog = screen.getByRole("dialog")
    expect(dialog).toHaveClass(
      "max-h-[92dvh]",
      "data-[side=bottom]:overflow-y-auto",
      "data-[side=bottom]:pb-[calc(1rem+env(safe-area-inset-bottom))]",
    )
    expect(document.querySelector("[autofocus]")).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Cuenta principal" },
    })
    fireEvent.click(
      screen.getByRole("combobox", { name: "Banco o institución (opcional)" }),
    )
    fireEvent.click(screen.getByRole("option", { name: "BancoEstado" }))
    fireEvent.click(screen.getByRole("button", { name: "Crear cuenta" }))

    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith({
        emoji: "💳",
        name: "Cuenta principal",
        bank: "BancoEstado",
      }),
    )
    expect(await screen.findByText("Saldo actual")).toBeInTheDocument()
  })

  it("creates with no institution and preserves a custom institution on edit", async () => {
    const createAccount = vi.fn().mockResolvedValue({ ...account, bank: null })
    const editAccount = vi.fn().mockResolvedValue(account)
    const listAccounts = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([account])
    const useCases = service({ listAccounts, createAccount, editAccount })
    const { unmount } = render(<AccountsPage useCases={useCases} />)

    await screen.findByText("Aún no has agregado ninguna cuenta")
    fireEvent.click(screen.getByRole("button", { name: "Nueva" }))
    expect(
      screen.getByRole("combobox", { name: "Banco o institución (opcional)" }),
    ).toHaveTextContent("Sin institución")
    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Sin banco" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Crear cuenta" }))
    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith({
        emoji: "💳",
        name: "Sin banco",
        bank: null,
      }),
    )

    unmount()
    render(
      <AccountsPage
        useCases={service({
          listAccounts: vi.fn().mockResolvedValue([account]),
          editAccount,
        })}
      />,
    )
    await screen.findByText("Cuenta principal")
    fireEvent.click(
      screen.getByRole("button", { name: "Ver detalle de Cuenta principal" }),
    )
    fireEvent.click(screen.getByRole("button", { name: "Editar" }))

    expect(
      screen.getByRole("combobox", { name: "Banco o institución (opcional)" }),
    ).toHaveTextContent("Otro")
    expect(screen.getByLabelText("Otra institución")).toHaveValue("Banco Estado")
    expect(screen.getByRole("textbox", { name: "Emoji" })).toHaveValue("💳")
    fireEvent.change(screen.getByRole("textbox", { name: "Emoji" }), {
      target: { value: "🏦" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }))

    await waitFor(() =>
      expect(editAccount).toHaveBeenCalledWith({
        accountId: account.id,
        expectedRevision: account.revision,
        emoji: "🏦",
        name: account.name,
        bank: "Banco Estado",
      }),
    )
  })

  it("shows account detail and the prepared empty movement structure", async () => {
    const useCases = service({ listAccounts: vi.fn().mockResolvedValue([account]) })
    render(<AccountsPage useCases={useCases} />)

    await screen.findByText("Cuenta principal")
    expect(
      screen.getByRole("img", { name: "Emoji de Cuenta principal" }),
    ).toHaveTextContent("💳")
    expect(document.querySelector(".lucide-landmark, .lucide-wallet-cards")).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "Ver detalle de Cuenta principal" }),
    )

    expect(screen.getByText("Saldo actual")).toBeInTheDocument()
    expect(
      screen.getAllByRole("img", { name: "Emoji de Cuenta principal" }),
    ).toHaveLength(1)
    expect(await screen.findByText("Aún no hay movimientos relacionados")).toBeInTheDocument()
    expect(screen.queryByText(/Fase 6/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Editar" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Eliminar cuenta" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Desactivar" })).toBeInTheDocument()
  })

  it("always offers logical deletion and explains that history is preserved", async () => {
    let resolveDelete!: () => void
    const accountWithBalance = {
      ...account,
      currentBalance: asClpAmount(25_000),
    }
    const listAccounts = vi
      .fn()
      .mockResolvedValueOnce([accountWithBalance])
      .mockResolvedValue([])
    const deleteAccount = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveDelete = resolve }),
    )
    const useCases = service({
      listAccounts,
      deleteAccount,
    })
    render(<AccountsPage useCases={useCases} />)

    await screen.findByText("Cuenta principal")
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Cuenta principal" }))
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar cuenta" }))
    expect(screen.getByRole("heading", { name: "¿Eliminar cuenta?" })).toBeInTheDocument()
    expect(screen.getByText(
      "La cuenta dejará de formar parte de tus saldos actuales, pero sus movimientos se conservarán en el historial.",
    )).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
    expect(deleteAccount).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Eliminar cuenta" }))
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }))
    expect(deleteAccount).toHaveBeenCalledOnce()
    expect(deleteAccount).toHaveBeenCalledWith({
      accountId: accountWithBalance.id,
      expectedRevision: accountWithBalance.revision,
    })
    expect(toast.success).not.toHaveBeenCalledWith("Cuenta eliminada")
    resolveDelete()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Cuenta eliminada"))
    await waitFor(() => expect(screen.queryByText("Cuenta principal")).not.toBeInTheDocument())
  })

  it("shows the real related adjustment history instead of only a counter", async () => {
    const useCases = service({
      listAccounts: vi.fn().mockResolvedValue([account]),
      listRelatedMovements: vi.fn().mockResolvedValue([adjustmentHistory]),
    })
    render(<AccountsPage useCases={useCases} />)

    await screen.findByText("Cuenta principal")
    fireEvent.click(
      screen.getByRole("button", { name: "Ver detalle de Cuenta principal" }),
    )

    expect(await screen.findByText("Ajuste de saldo")).toBeInTheDocument()
    expect(screen.getByText("Conciliar con banco")).toBeInTheDocument()
    expect(screen.getByText("20-08-2026")).toBeInTheDocument()
    expect(screen.getByText(/\+.*25\.000/)).toBeInTheDocument()
    expect(screen.queryByText(/1 movimiento relacionado/)).not.toBeInTheDocument()
    expect(screen.queryByText("Aún no hay movimientos relacionados")).not.toBeInTheDocument()
  })

  it("routes a post-setup balance correction through a traceable adjustment", async () => {
    const createAdjustment = vi.fn().mockResolvedValue({ account })
    const balanceAdjustmentUseCases: BalanceAdjustmentUseCasesPort = {
      getCurrentDate: () => "2026-08-21" as ReturnType<BalanceAdjustmentUseCasesPort["getCurrentDate"]>,
      createAdjustment,
    }
    render(
      <AccountsPage
        useCases={service({ listAccounts: vi.fn().mockResolvedValue([account]) })}
        balanceAdjustmentUseCases={balanceAdjustmentUseCases}
      />,
    )

    await screen.findByText("Cuenta principal")
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Cuenta principal" }))
    fireEvent.click(screen.getByRole("button", { name: "Ajustar saldo" }))
    expect(screen.getByText("El saldo no se edita directamente")).toBeInTheDocument()
    const dialog = screen.getByRole("dialog")
    expect(dialog).toHaveClass(
      "max-h-[92dvh]",
      "data-[side=bottom]:overflow-y-auto",
      "data-[side=bottom]:pb-[calc(1rem+env(safe-area-inset-bottom))]",
    )
    expect(screen.getByLabelText("Motivo")).toBeRequired()
    const balance = screen.getByRole("textbox", { name: "Saldo real" })
    fireEvent.change(balance, {
      target: { value: "50000" },
    })
    expect(balance).toHaveValue("50.000")
    fireEvent.change(screen.getByRole("textbox", { name: "Motivo" }), {
      target: { value: "Conciliar con banco" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Registrar ajuste" }))

    await waitFor(() => expect(createAdjustment).toHaveBeenCalledWith({
      accountId: account.id,
      expectedAccountRevision: account.revision,
      operationDate: "2026-08-21",
      targetBalance: 50_000,
      reason: "Conciliar con banco",
    }))
  })

  it("keeps an unchanged balance from being submitted", async () => {
    const createAdjustment = vi.fn()
    const balanceAdjustmentUseCases: BalanceAdjustmentUseCasesPort = {
      getCurrentDate: () => "2026-08-21" as ReturnType<BalanceAdjustmentUseCasesPort["getCurrentDate"]>,
      createAdjustment,
    }
    render(
      <AccountsPage
        useCases={service({ listAccounts: vi.fn().mockResolvedValue([account]) })}
        balanceAdjustmentUseCases={balanceAdjustmentUseCases}
      />,
    )

    await screen.findByText("Cuenta principal")
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Cuenta principal" }))
    fireEvent.click(screen.getByRole("button", { name: "Ajustar saldo" }))
    fireEvent.change(screen.getByLabelText("Motivo"), {
      target: { value: "Verificación" },
    })

    const submit = screen.getByRole("button", { name: "Registrar ajuste" })
    expect(submit).toBeDisabled()
    fireEvent.click(submit)
    expect(createAdjustment).not.toHaveBeenCalled()
    expect(document.querySelector("[autofocus]")).not.toBeInTheDocument()
  })
})

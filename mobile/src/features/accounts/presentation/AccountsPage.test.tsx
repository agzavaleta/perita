import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { Account } from "@/domain/entities"
import {
  asClpAmount,
  asEntityId,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import type { AccountUseCasesPort } from "@/features/accounts/application/account-use-cases"
import type { BalanceAdjustmentUseCasesPort } from "@/features/accounts/application/balance-adjustment-use-cases"
import { AccountsPage } from "@/features/accounts/presentation/AccountsPage"

const account: Account = {
  id: asEntityId("20000000-0000-4000-8000-000000000001"),
  name: "Cuenta principal",
  bank: "Banco Estado",
  openingBalance: asClpAmount(0),
  currentBalance: asClpAmount(0),
  status: "active",
  revision: asRevision(1),
  createdAt: asUtcTimestamp("2026-08-21T12:00:00.000Z"),
  updatedAt: asUtcTimestamp("2026-08-21T12:00:00.000Z"),
}

function service(overrides: Partial<AccountUseCasesPort> = {}): AccountUseCasesPort {
  return {
    listAccounts: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockResolvedValue(account),
    listRelatedMovements: vi.fn().mockResolvedValue([]),
    createAccount: vi.fn().mockResolvedValue(account),
    editAccount: vi.fn().mockResolvedValue(account),
    deactivateAccount: vi.fn().mockResolvedValue({ ...account, status: "inactive" }),
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
    fireEvent.click(screen.getByRole("button", { name: "Nueva" }))

    expect(screen.getByText("La cuenta se creará activa y con saldo $0.")).toBeInTheDocument()
    expect(screen.queryByLabelText(/saldo/i)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Cuenta principal" },
    })
    fireEvent.change(screen.getByLabelText("Banco o institución"), {
      target: { value: "Banco Estado" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Crear cuenta" }))

    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith({
        name: "Cuenta principal",
        bank: "Banco Estado",
      }),
    )
    expect(await screen.findByText("Saldo actual")).toBeInTheDocument()
  })

  it("shows account detail and the prepared empty movement structure", async () => {
    const useCases = service({ listAccounts: vi.fn().mockResolvedValue([account]) })
    render(<AccountsPage useCases={useCases} />)

    await screen.findByText("Cuenta principal")
    fireEvent.click(
      screen.getByRole("button", { name: "Ver detalle de Cuenta principal" }),
    )

    expect(screen.getByText("Saldo actual")).toBeInTheDocument()
    expect(await screen.findByText("Aún no hay movimientos relacionados")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Editar" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Desactivar" })).toBeInTheDocument()
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
    fireEvent.change(screen.getByRole("spinbutton", { name: "Saldo real CLP" }), {
      target: { value: "50000" },
    })
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
})

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { asPeriodKey } from "@/domain/primitives"
import type {
  SaveSetupDraftInput,
  SetupResult,
  SetupState,
  SetupUseCasesPort,
} from "@/features/setup/application/setup-use-cases"
import { SetupPage } from "@/features/setup/presentation/SetupPage"

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const NEW_STATE: SetupState = {
  status: "not_started",
  allowedPeriodKeys: [asPeriodKey("2026-08"), asPeriodKey("2026-07")],
  draft: null,
}

const RESUMABLE_STATE: SetupState = {
  status: "resumable",
  allowedPeriodKeys: [
    asPeriodKey("2026-08"),
    asPeriodKey("2026-07"),
    asPeriodKey("2025-03"),
  ],
  draft: {
    periodKey: "2025-03",
    salaryReferenceAmount: 1_200_000,
    variableExpenseBudgetAmount: 350_000,
    accounts: [{
      id: "stable-account-id",
      emoji: "💳",
      name: "Cuenta histórica",
      bank: "BancoEstado",
      openingBalance: 45_000,
    }],
  },
}

function service(completeSetup = vi.fn()) {
  const saveDraft = vi.fn(async (input: SaveSetupDraftInput) => ({
    ...input,
    accounts: input.accounts.map((account) => ({
      ...account,
      bank: account.bank ?? null,
      emoji: account.emoji?.trim() || "💳",
    })),
  }))
  const useCases = {
    getState: vi.fn(),
    saveDraft,
    deleteDraft: vi.fn(),
    completeSetup,
  } as unknown as SetupUseCasesPort
  return { useCases, saveDraft, completeSetup }
}

function renderSetup(
  state: SetupState = NEW_STATE,
  completeSetup = vi.fn(),
  onCompleted = vi.fn(),
) {
  const mocks = service(completeSetup)
  const view = render(
    <SetupPage
      state={state}
      useCases={mocks.useCases}
      onCompleted={onCompleted}
    />,
  )
  return { ...view, ...mocks, onCompleted }
}

describe("SetupPage reanudable", () => {
  it("renders the new setup fields vertically with separate salary and budget", () => {
    const { container } = renderSetup()

    const period = screen.getByLabelText("Período inicial")
    const salary = screen.getByLabelText("Sueldo de referencia")
    const budget = screen.getByLabelText(
      "Presupuesto para gastos variables (opcional)",
    )
    const name = screen.getByLabelText("Nombre")
    expect(period).toHaveValue("2026-08")
    expect(period).toHaveAttribute("max", "2026-08")
    expect(period).not.toHaveAttribute("min")
    expect(salary).toHaveValue("0")
    expect(budget).toHaveValue("0")
    expect(
      period.compareDocumentPosition(salary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      salary.compareDocumentPosition(budget) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      budget.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(container.querySelector("form")?.className).not.toContain("grid-cols-2")
  })

  it("persists salary and variable budget as separate values", async () => {
    const { saveDraft } = renderSetup()

    fireEvent.change(screen.getByLabelText("Sueldo de referencia"), {
      target: { value: "1500000" },
    })
    fireEvent.change(
      screen.getByLabelText("Presupuesto para gastos variables (opcional)"),
      { target: { value: "300000" } },
    )

    await waitFor(() =>
      expect(saveDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({
          salaryReferenceAmount: 1_500_000,
          variableExpenseBudgetAmount: 300_000,
        }),
      ),
    )
  })

  it("normalizes an empty optional budget to zero in the persisted draft", async () => {
    const { saveDraft } = renderSetup()

    fireEvent.change(
      screen.getByLabelText("Presupuesto para gastos variables (opcional)"),
      { target: { value: "" } },
    )

    await waitFor(() => expect(saveDraft).toHaveBeenCalled())
    expect(saveDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ variableExpenseBudgetAmount: 0 }),
    )
  })

  it("resumes period, separate amounts, institution and stable account id", () => {
    renderSetup(RESUMABLE_STATE)

    expect(screen.getByText("Continúa tu configuración")).toBeInTheDocument()
    expect(screen.getByLabelText("Período inicial")).toHaveValue("2025-03")
    expect(screen.getByLabelText("Sueldo de referencia")).toHaveValue("1.200.000")
    expect(
      screen.getByLabelText("Presupuesto para gastos variables (opcional)"),
    ).toHaveValue("350.000")
    expect(screen.getByLabelText("Nombre")).toHaveValue("Cuenta histórica")
    expect(screen.getByRole("combobox")).toHaveTextContent("BancoEstado")
    expect(screen.getByTestId("setup-account-stable-account-id")).toBeInTheDocument()
  })

  it("adds and removes an additional account without allowing removal of the last", async () => {
    const { saveDraft } = renderSetup()
    expect(screen.queryByRole("button", { name: /Eliminar cuenta/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Agregar cuenta" }))
    expect(screen.getByText("Cuenta 2")).toBeInTheDocument()
    expect(screen.getAllByLabelText("Nombre")).toHaveLength(2)
    await waitFor(() => expect(saveDraft).toHaveBeenCalled())
    expect(saveDraft.mock.calls.at(-1)?.[0].accounts).toHaveLength(2)

    fireEvent.click(screen.getByRole("button", { name: "Eliminar cuenta 2" }))
    expect(screen.queryByText("Cuenta 2")).not.toBeInTheDocument()
    expect(screen.getAllByLabelText("Nombre")).toHaveLength(1)
    expect(screen.queryByRole("button", { name: /Eliminar cuenta/ })).not.toBeInTheDocument()
    await waitFor(() =>
      expect(saveDraft.mock.calls.at(-1)?.[0].accounts).toHaveLength(1),
    )
  })

  it("persists canonical institution and account edits with the same temporary id", async () => {
    const { saveDraft } = renderSetup(RESUMABLE_STATE)
    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Cuenta diaria" },
    })
    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(screen.getByRole("option", { name: "Banco de Chile" }))

    await waitFor(() =>
      expect(saveDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({
          accounts: [expect.objectContaining({
            id: "stable-account-id",
            name: "Cuenta diaria",
            bank: "Banco de Chile",
          })],
        }),
      ),
    )
  })

  it("shows the contextual warning for a negative opening balance", async () => {
    const { saveDraft } = renderSetup()

    fireEvent.change(screen.getByLabelText("Saldo inicial (opcional)"), {
      target: { value: "-25000" },
    })

    expect(screen.getByText("Saldo inicial negativo")).toBeInTheDocument()
    expect(
      screen.getByText("Es una apertura excepcional permitida durante setup."),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(saveDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          accounts: [expect.objectContaining({ openingBalance: -25_000 })],
        }),
      ),
    )
  })

  it("does not autofocus or confirm financial data before the review step", async () => {
    const { saveDraft, completeSetup } = renderSetup()
    expect(document.activeElement).not.toBe(screen.getByLabelText("Período inicial"))
    expect(document.querySelector("[autofocus]")).toBeNull()

    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Principal" },
    })
    await waitFor(() => expect(saveDraft).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Comenzar a usar Perita" })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole("button", { name: "Comenzar a usar Perita" }))

    expect(
      await screen.findByRole("heading", { name: "Revisa tu configuración" }),
    ).toBeInTheDocument()
    expect(completeSetup).not.toHaveBeenCalled()
  })

  it("shows the complete plan and every account in the mandatory review", async () => {
    const state: SetupState = {
      ...RESUMABLE_STATE,
      draft: {
        ...RESUMABLE_STATE.draft!,
        accounts: [
          ...RESUMABLE_STATE.draft!.accounts,
          {
            id: "cash-account-id",
            emoji: "💳",
            name: "Billetera",
            bank: null,
            openingBalance: -10_000,
          },
        ],
      },
    }
    renderSetup(state)

    fireEvent.click(screen.getByRole("button", { name: "Comenzar a usar Perita" }))

    expect(await screen.findByText("marzo de 2025")).toBeInTheDocument()
    expect(screen.getByText("$1.200.000")).toBeInTheDocument()
    expect(screen.getByText("$350.000")).toBeInTheDocument()
    expect(screen.getByText("Cuenta histórica")).toBeInTheDocument()
    expect(screen.getByText("BancoEstado")).toBeInTheDocument()
    expect(screen.getByText("Billetera")).toBeInTheDocument()
    expect(screen.getByText("Sin institución")).toBeInTheDocument()
    expect(screen.getAllByText("💳")).toHaveLength(2)
    expect(screen.getByText("$-10.000")).toBeInTheDocument()
  })

  it("returns to editing without losing the reviewed draft", async () => {
    renderSetup(RESUMABLE_STATE)
    fireEvent.click(screen.getByRole("button", { name: "Comenzar a usar Perita" }))
    await screen.findByRole("heading", { name: "Revisa tu configuración" })

    fireEvent.click(screen.getByRole("button", { name: "Volver" }))

    expect(screen.getByLabelText("Nombre")).toHaveValue("Cuenta histórica")
    expect(screen.getByLabelText("Sueldo de referencia")).toHaveValue("1.200.000")
    expect(screen.getByRole("combobox")).toHaveTextContent("BancoEstado")
  })

  it("confirms exactly once with the normalized payload and reports success", async () => {
    const result = { warnings: [] } as unknown as SetupResult
    const completeSetup = vi.fn().mockResolvedValue(result)
    const onCompleted = vi.fn()
    renderSetup(RESUMABLE_STATE, completeSetup, onCompleted)
    fireEvent.click(screen.getByRole("button", { name: "Comenzar a usar Perita" }))
    await screen.findByRole("heading", { name: "Revisa tu configuración" })

    const confirmButton = screen.getByRole("button", {
      name: "Confirmar y comenzar",
    })
    fireEvent.click(confirmButton)
    fireEvent.click(confirmButton)

    await waitFor(() => expect(completeSetup).toHaveBeenCalledOnce())
    expect(completeSetup).toHaveBeenCalledWith({
      periodKey: "2025-03",
      salaryReferenceAmount: 1_200_000,
      variableExpenseBudgetAmount: 350_000,
      accounts: [{
        emoji: "💳",
        name: "Cuenta histórica",
        bank: "BancoEstado",
        openingBalance: 45_000,
      }],
    })
    expect(onCompleted).toHaveBeenCalledWith(result)
  })

  it("keeps the review and draft available when financial confirmation fails", async () => {
    const completeSetup = vi.fn().mockRejectedValue(new Error("Falló la confirmación"))
    const { saveDraft } = renderSetup(RESUMABLE_STATE, completeSetup)
    fireEvent.click(screen.getByRole("button", { name: "Comenzar a usar Perita" }))
    await screen.findByRole("heading", { name: "Revisa tu configuración" })
    const savesBeforeConfirmation = saveDraft.mock.calls.length

    fireEvent.click(screen.getByRole("button", { name: "Confirmar y comenzar" }))

    expect(await screen.findByText("Falló la confirmación")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Revisa tu configuración" })).toBeInTheDocument()
    expect(screen.getByText("Cuenta histórica")).toBeInTheDocument()
    expect(saveDraft).toHaveBeenCalledTimes(savesBeforeConfirmation)
    fireEvent.click(screen.getByRole("button", { name: "Volver" }))
    expect(screen.getByLabelText("Nombre")).toHaveValue("Cuenta histórica")
  })

  it("does not advance or confirm while an account name is empty", () => {
    const { completeSetup } = renderSetup()

    expect(screen.getByRole("button", { name: "Comenzar a usar Perita" })).toBeDisabled()
    expect(
      screen.queryByRole("heading", { name: "Revisa tu configuración" }),
    ).not.toBeInTheDocument()
    expect(completeSetup).not.toHaveBeenCalled()
  })
})

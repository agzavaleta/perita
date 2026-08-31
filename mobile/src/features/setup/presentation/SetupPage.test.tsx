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
  allowedPeriodKeys: [
    asPeriodKey("2026-08"),
    asPeriodKey("2026-07"),
    asPeriodKey("2026-09"),
  ],
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
    account: {
      id: "stable-account-id",
      emoji: "💳",
      name: "Cuenta histórica",
      bank: "BancoEstado",
      openingBalance: 45_000,
    },
  },
}

function service(completeSetup = vi.fn()) {
  const saveDraft = vi.fn(async (input: SaveSetupDraftInput) => ({
    ...input,
    account: {
      ...input.account,
      bank: input.account.bank ?? null,
      emoji: input.account.emoji?.trim() || "💳",
    },
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

describe("SetupPage", () => {
  it("shows the minimal single-screen setup in the approved order", () => {
    const { container } = renderSetup()
    const period = screen.getByLabelText("Mes inicial")
    const salary = screen.getByLabelText("Sueldo previsto")
    const name = screen.getByLabelText("Nombre de la cuenta")
    const institution = screen.getByLabelText("Banco o institución (opcional)")
    const balance = screen.getByLabelText("Saldo actual")

    expect(screen.getByRole("heading", { name: "Comienza en Perita" })).toBeInTheDocument()
    expect(screen.getByText(
      "Cuéntanos con cuánto partes y Perita preparará tu primer período.",
    )).toBeInTheDocument()
    expect(period).toHaveValue("2026-08")
    expect(period).toHaveAttribute("max", "2026-09")
    expect(salary).toHaveValue("0")
    expect(screen.getByRole("button", { name: "Comenzar" })).toBeDisabled()
    for (const [before, after] of [
      [period, salary],
      [salary, name],
      [name, institution],
      [institution, balance],
    ]) {
      expect(
        before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
    expect(screen.queryByLabelText(/Presupuesto para gastos variables/i)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Agregar cuenta" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Eliminar cuenta/ })).not.toBeInTheDocument()
    expect(screen.getAllByLabelText("Nombre de la cuenta")).toHaveLength(1)
    expect(container.querySelector("form")?.className).not.toContain("grid-cols-2")
  })

  it("resumes the single account and persists its edits", async () => {
    const { saveDraft } = renderSetup(RESUMABLE_STATE)
    expect(screen.getByLabelText("Mes inicial")).toHaveValue("2025-03")
    expect(screen.getByLabelText("Sueldo previsto")).toHaveValue("1.200.000")
    expect(screen.getByLabelText("Nombre de la cuenta")).toHaveValue("Cuenta histórica")
    expect(screen.getByRole("combobox")).toHaveTextContent("BancoEstado")
    expect(screen.getByLabelText("Saldo actual")).toHaveValue("45.000")

    fireEvent.change(screen.getByLabelText("Nombre de la cuenta"), {
      target: { value: "Cuenta diaria" },
    })
    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(screen.getByRole("option", { name: "Banco de Chile" }))

    await waitFor(() => expect(saveDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({
          id: "stable-account-id",
          name: "Cuenta diaria",
          bank: "Banco de Chile",
        }),
      }),
    ))
  })

  it("keeps the negative opening warning and draft support", async () => {
    const { saveDraft } = renderSetup()
    fireEvent.change(screen.getByLabelText("Saldo actual"), {
      target: { value: "-25000" },
    })

    expect(screen.getByText("Saldo inicial negativo")).toBeInTheDocument()
    expect(screen.getByText(
      "Es una apertura excepcional permitida durante setup.",
    )).toBeInTheDocument()
    await waitFor(() => expect(saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ openingBalance: -25_000 }),
      }),
    ))
  })

  it("completes directly and calls onCompleted without a review step", async () => {
    const result = { warnings: [] } as unknown as SetupResult
    const completeSetup = vi.fn().mockResolvedValue(result)
    const onCompleted = vi.fn()
    const { saveDraft } = renderSetup(NEW_STATE, completeSetup, onCompleted)
    expect(document.querySelector("[autofocus]")).toBeNull()

    fireEvent.change(screen.getByLabelText("Nombre de la cuenta"), {
      target: { value: "Principal" },
    })
    await waitFor(() => expect(saveDraft).toHaveBeenCalled())
    const submit = screen.getByRole("button", { name: "Comenzar" })
    await waitFor(() => expect(submit).toBeEnabled())
    fireEvent.click(submit)

    await waitFor(() => expect(completeSetup).toHaveBeenCalledOnce())
    expect(Math.max(...saveDraft.mock.invocationCallOrder)).toBeLessThan(
      completeSetup.mock.invocationCallOrder[0]!,
    )
    expect(completeSetup).toHaveBeenCalledWith({
      periodKey: "2026-08",
      salaryReferenceAmount: 0,
      account: {
        emoji: "💳",
        name: "Principal",
        bank: null,
        openingBalance: 0,
      },
    })
    expect(screen.queryByText(/Revisa tu configuración/i)).not.toBeInTheDocument()
    expect(onCompleted).toHaveBeenCalledWith(result)
  })

  it("protects direct completion against a double submit", async () => {
    const result = { warnings: [] } as unknown as SetupResult
    const completeSetup = vi.fn().mockResolvedValue(result)
    const onCompleted = vi.fn()
    renderSetup(RESUMABLE_STATE, completeSetup, onCompleted)
    const submit = screen.getByRole("button", { name: "Comenzar" })
    fireEvent.click(submit)
    fireEvent.click(submit)

    await waitFor(() => expect(completeSetup).toHaveBeenCalledOnce())
    expect(completeSetup).toHaveBeenCalledWith({
      periodKey: "2025-03",
      salaryReferenceAmount: 1_200_000,
      account: {
        emoji: "💳",
        name: "Cuenta histórica",
        bank: "BancoEstado",
        openingBalance: 45_000,
      },
    })
    expect(onCompleted).toHaveBeenCalledWith(result)
  })

  it("keeps the form available when direct completion fails", async () => {
    const completeSetup = vi.fn().mockRejectedValue(new Error("Falló la confirmación"))
    renderSetup(RESUMABLE_STATE, completeSetup)
    fireEvent.click(screen.getByRole("button", { name: "Comenzar" }))

    expect(await screen.findByText("Falló la confirmación")).toBeInTheDocument()
    expect(screen.getByLabelText("Nombre de la cuenta")).toHaveValue("Cuenta histórica")
  })
})

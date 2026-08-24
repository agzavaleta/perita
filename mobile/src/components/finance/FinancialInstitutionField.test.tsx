import { fireEvent, render, screen } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { FinancialInstitutionField } from "@/components/finance/FinancialInstitutionField"
import { FINANCIAL_INSTITUTIONS } from "@/lib/financial-institutions"

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

function chooseOption(name: string) {
  fireEvent.click(screen.getByRole("combobox"))
  fireEvent.click(screen.getByRole("option", { name }))
}

describe("FinancialInstitutionField", () => {
  it("shows the empty optional state for a null value", () => {
    render(
      <FinancialInstitutionField value={null} onValueChange={vi.fn()} />,
    )

    expect(screen.getByRole("combobox")).toHaveTextContent("Sin institución")
    expect(screen.queryByLabelText("Otra institución")).not.toBeInTheDocument()
  })

  it("renders the central catalog in its declared order", () => {
    render(
      <FinancialInstitutionField value={null} onValueChange={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole("combobox"))
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Sin institución",
      ...FINANCIAL_INSTITUTIONS,
    ])
    expect(screen.queryByRole("option", { name: "Banco Security" })).not.toBeInTheDocument()
  })

  it.each(["BancoEstado", "Efectivo"])(
    "emits the canonical catalog value for %s",
    (institution) => {
      const onValueChange = vi.fn()
      render(
        <FinancialInstitutionField
          value={null}
          onValueChange={onValueChange}
        />,
      )

      chooseOption(institution)

      expect(onValueChange).toHaveBeenCalledWith(institution)
    },
  )

  it("opens a manual second row for Otro and emits trimmed text", () => {
    const onValueChange = vi.fn()
    render(
      <FinancialInstitutionField
        value={null}
        onValueChange={onValueChange}
      />,
    )

    chooseOption("Otro")
    expect(onValueChange).toHaveBeenCalledWith(null)
    const manualInput = screen.getByLabelText("Otra institución")
    expect(manualInput).not.toHaveFocus()

    fireEvent.change(manualInput, {
      target: { value: "  Caja Vecina  " },
    })
    expect(onValueChange).toHaveBeenLastCalledWith("Caja Vecina")
    fireEvent.change(manualInput, { target: { value: "   " } })
    expect(onValueChange).toHaveBeenLastCalledWith(null)
  })

  it("preserves a preexisting custom value in Otro mode", () => {
    render(
      <FinancialInstitutionField
        value="Cooperativa histórica"
        onValueChange={vi.fn()}
      />,
    )

    expect(screen.getByRole("combobox")).toHaveTextContent("Otro")
    expect(screen.getByLabelText("Otra institución")).toHaveValue(
      "Cooperativa histórica",
    )
  })

  it("replaces a custom value when a catalog bank is selected", () => {
    const onValueChange = vi.fn()
    render(
      <FinancialInstitutionField
        value="Cooperativa histórica"
        onValueChange={onValueChange}
      />,
    )

    chooseOption("Banco de Chile")

    expect(onValueChange).toHaveBeenCalledWith("Banco de Chile")
  })

  it("disables both the select and the custom input", () => {
    render(
      <FinancialInstitutionField
        disabled
        id="institution"
        value="Cooperativa histórica"
        onValueChange={vi.fn()}
      />,
    )

    expect(screen.getByRole("combobox")).toBeDisabled()
    expect(screen.getByLabelText("Otra institución")).toBeDisabled()
    expect(screen.getByRole("combobox")).toHaveAttribute("id", "institution")
  })
})

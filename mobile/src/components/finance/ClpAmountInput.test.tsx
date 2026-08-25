import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ClpAmountInput } from "@/components/finance/ClpAmountInput"

function ControlledAmount({
  initialValue = null,
  allowNegative = false,
}: {
  readonly initialValue?: number | null
  readonly allowNegative?: boolean
}) {
  const [value, setValue] = useState<number | null>(initialValue)
  return (
    <>
      <ClpAmountInput
        aria-label="Monto controlado"
        value={value}
        onValueChange={setValue}
        allowNegative={allowNegative}
      />
      <output aria-label="Valor emitido">{value ?? "vacío"}</output>
    </>
  )
}

describe("ClpAmountInput", () => {
  it("renders a controlled formatted value with normal input props", () => {
    render(
      <ClpAmountInput
        id="amount"
        aria-label="Monto"
        aria-invalid="true"
        disabled
        placeholder="0"
        value={1_500_000}
        onValueChange={vi.fn()}
      />,
    )

    const input = screen.getByLabelText("Monto")
    expect(input).toHaveValue("1.500.000")
    expect(input).toHaveAttribute("inputmode", "numeric")
    expect(input).toBeDisabled()
    expect(input).toHaveAttribute("aria-invalid", "true")
  })

  it("supports character-by-character entry and formats only on blur", () => {
    render(<ControlledAmount />)
    const input = screen.getByLabelText("Monto controlado")

    fireEvent.focus(input)
    for (const text of ["7", "70", "700", "7000", "70000"]) {
      fireEvent.change(input, { target: { value: text } })
      expect(input).toHaveValue(text)
      expect(screen.getByLabelText("Valor emitido")).toHaveTextContent(text)
    }

    fireEvent.blur(input)
    expect(input).toHaveValue("70.000")
  })

  it("supports step-by-step backspace until empty", () => {
    render(<ControlledAmount initialValue={70_000} />)
    const input = screen.getByLabelText("Monto controlado")

    fireEvent.focus(input)
    expect(input).toHaveValue("70000")
    for (const text of ["7000", "700", "70", "7", ""]) {
      fireEvent.change(input, { target: { value: text } })
      expect(input).toHaveValue(text)
    }
    expect(screen.getByLabelText("Valor emitido")).toHaveTextContent("vacío")
    fireEvent.blur(input)
    expect(input).toHaveValue("")
  })

  it("normalizes pasted grouping while focused and restores it on blur", () => {
    render(<ControlledAmount />)
    const input = screen.getByLabelText("Monto controlado")

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "1.500.000" } })
    expect(input).toHaveValue("1500000")
    expect(screen.getByLabelText("Valor emitido")).toHaveTextContent("1500000")
    fireEvent.blur(input)
    expect(input).toHaveValue("1.500.000")
  })

  it("supports a transient sign and progressive negative entry", () => {
    render(<ControlledAmount allowNegative />)
    const input = screen.getByLabelText("Monto controlado")

    expect(input).toHaveAttribute("inputmode", "decimal")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "-" } })
    expect(input).toHaveValue("-")
    expect(screen.getByLabelText("Valor emitido")).toHaveTextContent("vacío")

    for (const text of ["-7", "-70", "-700", "-7000"]) {
      fireEvent.change(input, { target: { value: text } })
      expect(input).toHaveValue(text)
    }
    expect(screen.getByLabelText("Valor emitido")).toHaveTextContent("-7000")
    fireEvent.blur(input)
    expect(input).toHaveValue("-7.000")
  })

  it("ignores invalid characters without corrupting the draft", () => {
    render(<ControlledAmount />)
    const input = screen.getByLabelText("Monto controlado")

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "7000" } })
    fireEvent.change(input, { target: { value: "7000a" } })
    expect(input).toHaveValue("7000")
    expect(screen.getByLabelText("Valor emitido")).toHaveTextContent("7000")
  })
})

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

  it("formats thousands live during character-by-character entry", () => {
    render(<ControlledAmount />)
    const input = screen.getByLabelText("Monto controlado")

    fireEvent.focus(input)
    for (const [digit, formatted, emitted] of [
      ["7", "7", "7"],
      ["0", "70", "70"],
      ["0", "700", "700"],
      ["0", "7.000", "7000"],
      ["0", "70.000", "70000"],
      ["0", "700.000", "700000"],
      ["0", "7.000.000", "7000000"],
    ]) {
      const nextText = `${(input as HTMLInputElement).value}${digit}`
      fireEvent.change(input, {
        target: { value: nextText, selectionStart: nextText.length },
      })
      expect(input).toHaveValue(formatted)
      expect(screen.getByLabelText("Valor emitido")).toHaveTextContent(emitted)
    }

    fireEvent.blur(input)
    expect(input).toHaveValue("7.000.000")
  })

  it("supports step-by-step backspace until empty", () => {
    render(<ControlledAmount initialValue={70_000} />)
    const input = screen.getByLabelText("Monto controlado")

    fireEvent.focus(input)
    expect(input).toHaveValue("70.000")
    for (const formatted of ["7.000", "700", "70", "7", ""]) {
      const nextText = (input as HTMLInputElement).value.slice(0, -1)
      fireEvent.change(input, {
        target: { value: nextText, selectionStart: nextText.length },
      })
      expect(input).toHaveValue(formatted)
    }
    expect(screen.getByLabelText("Valor emitido")).toHaveTextContent("vacío")
    fireEvent.blur(input)
    expect(input).toHaveValue("")
  })

  it.each(["1500000", "1.500.000"])(
    "normalizes pasted value %s immediately",
    (pasted) => {
    render(<ControlledAmount />)
    const input = screen.getByLabelText("Monto controlado")

    fireEvent.focus(input)
      fireEvent.change(input, {
        target: { value: pasted, selectionStart: pasted.length },
      })
    expect(input).toHaveValue("1.500.000")
    expect(screen.getByLabelText("Valor emitido")).toHaveTextContent("1500000")
    fireEvent.blur(input)
    expect(input).toHaveValue("1.500.000")
    },
  )

  it("replaces and edits an existing formatted amount", () => {
    render(<ControlledAmount initialValue={790_000} />)
    const input = screen.getByLabelText("Monto controlado")

    fireEvent.focus(input)
    expect(input).toHaveValue("790.000")
    fireEvent.change(input, {
      target: { value: "850000", selectionStart: 6 },
    })
    expect(input).toHaveValue("850.000")
    expect(screen.getByLabelText("Valor emitido")).toHaveTextContent("850000")

    fireEvent.change(input, {
      target: { value: "8590.000", selectionStart: 3 },
    })
    expect(input).toHaveValue("8.590.000")
    expect((input as HTMLInputElement).selectionStart).toBe(4)
  })

  it("supports a transient sign and progressive negative entry", () => {
    render(<ControlledAmount allowNegative />)
    const input = screen.getByLabelText("Monto controlado")

    expect(input).toHaveAttribute("inputmode", "decimal")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "-" } })
    expect(input).toHaveValue("-")
    expect(screen.getByLabelText("Valor emitido")).toHaveTextContent("vacío")

    for (const [text, formatted] of [
      ["-7", "-7"],
      ["-70", "-70"],
      ["-700", "-700"],
      ["-7000", "-7.000"],
    ]) {
      fireEvent.change(input, {
        target: { value: text, selectionStart: text.length },
      })
      expect(input).toHaveValue(formatted)
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
    expect(input).toHaveValue("7.000")
    expect(screen.getByLabelText("Valor emitido")).toHaveTextContent("7000")
  })
})

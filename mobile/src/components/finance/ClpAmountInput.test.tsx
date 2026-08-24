import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ClpAmountInput } from "@/components/finance/ClpAmountInput"

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

  it("emits normalized integers and empty values without emitting invalid text", () => {
    const onValueChange = vi.fn()
    const { rerender } = render(
      <ClpAmountInput
        aria-label="Monto"
        value={null}
        onValueChange={onValueChange}
      />,
    )
    const input = screen.getByLabelText("Monto")

    fireEvent.change(input, { target: { value: "1500000" } })
    fireEvent.change(input, { target: { value: "abc" } })
    expect(onValueChange.mock.calls).toEqual([[1_500_000]])

    rerender(
      <ClpAmountInput
        aria-label="Monto"
        value={1_500_000}
        onValueChange={onValueChange}
      />,
    )
    fireEvent.change(input, { target: { value: "" } })

    expect(onValueChange.mock.calls).toEqual([[1_500_000], [null]])
  })

  it("supports a transient sign and negative integer mode", () => {
    const onValueChange = vi.fn()
    render(
      <ClpAmountInput
        allowNegative
        aria-label="Ajuste"
        value={null}
        onValueChange={onValueChange}
      />,
    )
    const input = screen.getByLabelText("Ajuste")

    expect(input).toHaveAttribute("inputmode", "text")
    fireEvent.change(input, { target: { value: "-" } })
    expect(input).toHaveValue("-")
    expect(onValueChange).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: "-1000" } })
    expect(onValueChange).toHaveBeenCalledWith(-1_000)
  })
})

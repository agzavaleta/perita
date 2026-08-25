import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { FormSheetContent } from "@/components/forms/FormSheetContent"
import { Sheet, SheetTitle } from "@/components/ui/sheet"

describe("FormSheetContent", () => {
  it("renders the mobile bottom form pattern with children and close control", () => {
    render(
      <Sheet open>
        <FormSheetContent className="test-form-sheet max-h-[80dvh]">
          <SheetTitle>Formulario de prueba</SheetTitle>
          <p>Contenido conservado</p>
        </FormSheetContent>
      </Sheet>,
    )

    const content = screen.getByRole("dialog")
    expect(content).toHaveAttribute("data-side", "bottom")
    expect(content).toHaveClass(
      "mx-auto",
      "w-full",
      "max-w-[430px]",
      "data-[side=bottom]:max-w-full",
      "data-[side=bottom]:min-w-0",
      "data-[side=bottom]:overflow-x-hidden",
      "data-[side=bottom]:overflow-y-auto",
      "data-[side=bottom]:overscroll-x-none",
      "rounded-t-xl",
      "data-[side=bottom]:pb-[calc(1rem+env(safe-area-inset-bottom))]",
      "test-form-sheet",
      "max-h-[80dvh]",
    )
    expect(content).not.toHaveClass("max-h-[92dvh]")
    expect(screen.getByText("Contenido conservado")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeInTheDocument()
  })

  it("prevents Radix initial autofocus and preserves the consumer callback", async () => {
    const onOpenAutoFocus = vi.fn()
    render(
      <Sheet open>
        <FormSheetContent onOpenAutoFocus={onOpenAutoFocus}>
          <SheetTitle>Sin autofocus</SheetTitle>
          <input aria-label="Campo inicial" />
        </FormSheetContent>
      </Sheet>,
    )

    await waitFor(() => expect(onOpenAutoFocus).toHaveBeenCalledOnce())
    expect(onOpenAutoFocus.mock.calls[0]?.[0].defaultPrevented).toBe(true)
    expect(screen.getByLabelText("Campo inicial")).not.toHaveFocus()
  })
})

import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"

import { Button } from "@/components/ui/button"
import { useUnsavedChangesGuard } from "@/components/forms/useUnsavedChangesGuard"

function Harness({ dirty = false, saving = false, onClose = vi.fn() }) {
  const [value, setValue] = useState("")
  const guard = useUnsavedChangesGuard({ dirty: dirty || Boolean(value), saving, onClose })
  return (
    <>
      <input aria-label="Nombre" value={value} onChange={(event) => setValue(event.target.value)} />
      <Button onClick={guard.requestClose}>Cancelar</Button>
      {guard.confirmation}
    </>
  )
}

describe("useUnsavedChangesGuard", () => {
  it("cierra de inmediato si el formulario está limpio", () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByText("¿Descartar cambios?")).not.toBeInTheDocument()
  })

  it("permite seguir editando o descartar un formulario modificado", () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Cambio" } })
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
    expect(screen.getByText("¿Descartar cambios?")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Seguir editando" }))
    expect(screen.getByDisplayValue("Cambio")).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
    fireEvent.click(screen.getByRole("button", { name: "Descartar cambios" }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("impide cerrar mientras guarda", () => {
    const onClose = vi.fn()
    render(<Harness dirty saving onClose={onClose} />)
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByText("¿Descartar cambios?")).not.toBeInTheDocument()
  })
})

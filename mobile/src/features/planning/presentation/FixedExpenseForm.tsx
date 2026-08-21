import { useState, type FormEvent } from "react"
import { CalendarClock } from "lucide-react"

import { ErrorMessage } from "@/components/states/ErrorMessage"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type {
  FixedExpenseListItem,
  PlanningUseCasesPort,
} from "@/features/planning/application/planning-use-cases"

export interface FixedExpenseEditor {
  readonly item?: FixedExpenseListItem
  readonly mode: "template" | "instance"
}

function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No fue posible guardar el gasto fijo."
}

export function FixedExpenseForm({
  editor,
  useCases,
  onSaved,
  onClose,
}: {
  readonly editor: FixedExpenseEditor
  readonly useCases: PlanningUseCasesPort
  readonly onSaved: () => void
  readonly onClose: () => void
}) {
  const instanceMode = editor.mode === "instance"
  const [name, setName] = useState(editor.item?.template.name ?? "")
  const [amount, setAmount] = useState(
    String(
      instanceMode
        ? (editor.item?.currentInstance?.plannedAmount ?? "")
        : (editor.item?.template.referenceAmount ?? ""),
    ),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (instanceMode) {
        const instance = editor.item?.currentInstance
        if (!instance) throw new Error("No existe planificación para este período.")
        await useCases.updateCurrentPlannedAmount(
          instance.id,
          instance.revision,
          Number(amount),
        )
      } else if (editor.item) {
        await useCases.editFixedExpense({
          templateId: editor.item.template.id,
          expectedRevision: editor.item.template.revision,
          name,
          referenceAmount: Number(amount),
        })
      } else {
        await useCases.createFixedExpense({
          name,
          referenceAmount: Number(amount),
        })
      }
      onSaved()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setSaving(false)
    }
  }

  const creating = !editor.item
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-[430px] overflow-y-auto rounded-t-xl pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader>
          <SheetTitle>
            {instanceMode
              ? "Plan del período"
              : creating
                ? "Nuevo gasto fijo"
                : "Editar gasto fijo"}
          </SheetTitle>
          <SheetDescription>
            {instanceMode
              ? "Este monto solo modifica la instancia del período abierto."
              : "Es información de planificación; no programa cobros ni crea operaciones."}
          </SheetDescription>
        </SheetHeader>
        <form className="space-y-4 px-4" onSubmit={submit}>
          {!instanceMode ? (
            <div className="space-y-2">
              <Label htmlFor="fixed-name">Nombre</Label>
              <Input
                id="fixed-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ej. Arriendo"
                disabled={saving}
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="fixed-amount">
              {instanceMode ? "Monto planificado CLP" : "Monto de referencia CLP"}
            </Label>
            <Input
              id="fixed-amount"
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0"
              disabled={saving}
            />
          </div>
          {error ? (
            <ErrorMessage title="No se pudo guardar" description={error} />
          ) : null}
          <SheetFooter className="px-0">
            <Button type="submit" size="lg" className="h-11" disabled={saving}>
              <CalendarClock aria-hidden="true" />
              {saving ? "Guardando…" : "Guardar"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-11"
              onClick={onClose}
              disabled={saving}
            >
              Cancelar
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

import { useState, type FormEvent } from "react"
import { CalendarClock } from "lucide-react"

import { ClpAmountInput } from "@/components/finance/ClpAmountInput"
import { FormSheetContent } from "@/components/forms/FormSheetContent"
import { useUnsavedChangesGuard } from "@/components/forms/useUnsavedChangesGuard"
import { ErrorMessage } from "@/components/states/ErrorMessage"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type {
  FixedExpenseListItem,
  PlanningUseCasesPort,
} from "@/features/planning/application/planning-use-cases"
import { toast } from "sonner"

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
  const [amount, setAmount] = useState<number | null>(
    instanceMode
      ? (editor.item?.currentInstance?.plannedAmount ?? null)
      : (editor.item?.template.referenceAmount ?? null),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const initialAmount = instanceMode
    ? (editor.item?.currentInstance?.plannedAmount ?? null)
    : (editor.item?.template.referenceAmount ?? null)
  const dirty =
    name !== (editor.item?.template.name ?? "") || amount !== initialAmount
  const guard = useUnsavedChangesGuard({ dirty, saving, onClose })

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
          amount ?? 0,
        )
      } else if (editor.item) {
        await useCases.editFixedExpense({
          templateId: editor.item.template.id,
          expectedRevision: editor.item.template.revision,
          name,
          referenceAmount: amount ?? 0,
        })
      } else {
        await useCases.createFixedExpense({
          name,
          referenceAmount: amount ?? 0,
        })
      }
      toast.success(editor.item ? "Cambios guardados" : "Gasto fijo creado")
      onSaved()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setSaving(false)
    }
  }

  const creating = !editor.item
  return (
    <>
    <Sheet open onOpenChange={(open) => !open && guard.requestClose()}>
      <FormSheetContent>
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
              {instanceMode ? "Monto planificado" : "Monto de referencia"}
            </Label>
            <ClpAmountInput
              id="fixed-amount"
              value={amount}
              onValueChange={setAmount}
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
              onClick={guard.requestClose}
              disabled={saving}
            >
              Cancelar
            </Button>
          </SheetFooter>
        </form>
      </FormSheetContent>
    </Sheet>
    {guard.confirmation}
    </>
  )
}

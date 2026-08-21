import { useState, type FormEvent } from "react"
import { PiggyBank } from "lucide-react"

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
import type { SavingsGoal } from "@/domain/entities"
import type { PlanningUseCasesPort } from "@/features/planning/application/planning-use-cases"

function message(error: unknown) {
  return error instanceof Error ? error.message : "No fue posible guardar la meta."
}

export function SavingsGoalForm({
  goal,
  useCases,
  onSaved,
  onClose,
}: {
  readonly goal?: SavingsGoal
  readonly useCases: PlanningUseCasesPort
  readonly onSaved: (goal: SavingsGoal) => void
  readonly onClose: () => void
}) {
  const [name, setName] = useState(goal?.name ?? "")
  const [bank, setBank] = useState(goal?.bank ?? "")
  const [targetAmount, setTargetAmount] = useState(
    goal ? String(goal.targetAmount) : "",
  )
  const [plannedMonthlyAmount, setPlannedMonthlyAmount] = useState(
    goal ? String(goal.plannedMonthlyAmount) : "0",
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const draft = {
        name,
        bank,
        targetAmount: Number(targetAmount),
        plannedMonthlyAmount: Number(plannedMonthlyAmount),
      }
      const saved = goal
        ? await useCases.editSavingsGoal({
            ...draft,
            goalId: goal.id,
            expectedRevision: goal.revision,
          })
        : await useCases.createSavingsGoal(draft)
      onSaved(saved)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-[430px] overflow-y-auto rounded-t-xl pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader>
          <SheetTitle>{goal ? "Editar meta" : "Nueva meta"}</SheetTitle>
          <SheetDescription>
            Las metas nuevas comienzan con saldo $0. Los aportes se hacen con
            Mover dinero.
          </SheetDescription>
        </SheetHeader>
        <form className="space-y-4 px-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="goal-name">Nombre</Label>
            <Input
              id="goal-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ej. Viaje"
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="goal-bank">Banco o institución</Label>
            <Input
              id="goal-bank"
              value={bank}
              onChange={(event) => setBank(event.target.value)}
              placeholder="Opcional"
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="goal-target">Objetivo CLP</Label>
            <Input
              id="goal-target"
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={targetAmount}
              onChange={(event) => setTargetAmount(event.target.value)}
              placeholder="0"
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="goal-monthly">Aporte mensual planificado</Label>
            <Input
              id="goal-monthly"
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              value={plannedMonthlyAmount}
              onChange={(event) => setPlannedMonthlyAmount(event.target.value)}
              disabled={saving}
            />
          </div>
          {error ? (
            <ErrorMessage title="No se pudo guardar" description={error} />
          ) : null}
          <SheetFooter className="px-0">
            <Button type="submit" size="lg" className="h-11" disabled={saving}>
              <PiggyBank aria-hidden="true" />
              {saving ? "Guardando…" : goal ? "Guardar cambios" : "Crear meta"}
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

import { useState, type FormEvent } from "react"
import { PiggyBank } from "lucide-react"

import { ClpAmountInput } from "@/components/finance/ClpAmountInput"
import { FinancialInstitutionField } from "@/components/finance/FinancialInstitutionField"
import { FormSheetContent } from "@/components/forms/FormSheetContent"
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
  const [emoji, setEmoji] = useState(goal?.emoji ?? "💰")
  const [name, setName] = useState(goal?.name ?? "")
  const [bank, setBank] = useState<string | null>(goal?.bank ?? null)
  const [targetAmount, setTargetAmount] = useState<number | null>(
    goal?.targetAmount ?? null,
  )
  const [plannedMonthlyAmount, setPlannedMonthlyAmount] = useState<number | null>(
    goal?.plannedMonthlyAmount ?? 0,
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const draft = {
        emoji,
        name,
        bank,
        targetAmount: targetAmount ?? 0,
        plannedMonthlyAmount: plannedMonthlyAmount ?? 0,
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
      <FormSheetContent>
        <SheetHeader>
          <SheetTitle>{goal ? "Editar meta" : "Nueva meta"}</SheetTitle>
          <SheetDescription>
            Las metas nuevas comienzan con saldo $0. Los aportes se hacen con
            Mover dinero.
          </SheetDescription>
        </SheetHeader>
        <form className="space-y-4 px-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="goal-emoji">Emoji</Label>
            <Input
              id="goal-emoji"
              required
              autoComplete="off"
              value={emoji}
              onChange={(event) => setEmoji(event.target.value)}
              disabled={saving}
            />
          </div>
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
            <Label htmlFor="goal-bank">Banco o institución (opcional)</Label>
            <FinancialInstitutionField
              id="goal-bank"
              value={bank}
              onValueChange={setBank}
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="goal-target">Objetivo</Label>
            <ClpAmountInput
              id="goal-target"
              required
              value={targetAmount}
              onValueChange={setTargetAmount}
              placeholder="0"
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="goal-monthly">Aporte mensual planificado</Label>
            <ClpAmountInput
              id="goal-monthly"
              value={plannedMonthlyAmount}
              onValueChange={setPlannedMonthlyAmount}
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
      </FormSheetContent>
    </Sheet>
  )
}

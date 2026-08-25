import { useState, type FormEvent } from "react"
import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react"

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
import { Textarea } from "@/components/ui/textarea"
import type { SavingsGoal } from "@/domain/entities"
import type {
  SavingsDepositOperation,
  SavingsWithdrawalOperation,
} from "@/domain/operations"
import type { CivilDate } from "@/domain/primitives"
import type {
  MovementUseCasesPort,
  SavingsMovementResult,
} from "@/features/movements/application/movement-use-cases"
import { toast } from "sonner"

export type SavingsMovementMode = "deposit" | "withdrawal"

function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No fue posible registrar el movimiento de ahorro."
}

function formatClp(value: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(value)
}

export function SavingsMovementForm({
  goal,
  mode,
  operation,
  useCases,
  onSaved,
  onClose,
}: {
  readonly goal: SavingsGoal
  readonly mode: SavingsMovementMode
  readonly operation?: SavingsDepositOperation | SavingsWithdrawalOperation
  readonly useCases: MovementUseCasesPort
  readonly onSaved: (result: SavingsMovementResult) => void
  readonly onClose: () => void
}) {
  const currentDate = useCases.getCurrentDate()
  const [amount, setAmount] = useState<number | null>(operation?.amount ?? null)
  const [operationDate, setOperationDate] = useState<string>(
    operation?.operationDate ?? currentDate,
  )
  const [concept, setConcept] = useState(operation?.details.concept ?? "")
  const [observation, setObservation] = useState(
    operation?.details.observation ?? "",
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isWithdrawal = mode === "withdrawal"
  const isEditing = operation !== undefined
  const previousDelta = operation
    ? operation.type === "savings_deposit"
      ? operation.amount
      : -operation.amount
    : 0
  const nextDelta = amount === null ? 0 : isWithdrawal ? -amount : amount
  const exceedsBalance =
    amount !== null && goal.currentBalance - previousDelta + nextDelta < 0
  const dirty =
    amount !== (operation?.amount ?? null) ||
    operationDate !== (operation?.operationDate ?? currentDate) ||
    concept !== (operation?.details.concept ?? "") ||
    observation !== (operation?.details.observation ?? "")
  const guard = useUnsavedChangesGuard({ dirty, saving, onClose })

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const draft = {
        amount: amount ?? 0,
        operationDate: operationDate as CivilDate,
        concept,
        observation,
      }
      const result = operation
        ? await useCases.editSavingsMovement({
            ...draft,
            operationId: operation.id,
            expectedRevision: operation.revision,
          })
        : isWithdrawal
          ? await useCases.registerSavingsWithdrawal({ ...draft, goalId: goal.id })
          : await useCases.registerSavingsDeposit({ ...draft, goalId: goal.id })
      toast.success(
        isEditing
          ? "Cambios guardados"
          : isWithdrawal
            ? "Retiro registrado"
            : "Depósito registrado",
      )
      onSaved(result)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
    <Sheet open onOpenChange={(open) => !open && guard.requestClose()}>
      <FormSheetContent>
        <SheetHeader>
          <SheetTitle>
            {isEditing
              ? isWithdrawal
                ? "Editar retiro"
                : "Editar depósito"
              : isWithdrawal
                ? `Retirar de ${goal.name}`
                : `Depositar en ${goal.name}`}
          </SheetTitle>
          <SheetDescription>
            {isWithdrawal
              ? `Saldo disponible: ${formatClp(goal.currentBalance)}`
              : "Registra ahorro disponible que no proviene de otra cuenta de Perita."}
          </SheetDescription>
        </SheetHeader>
        <form className="space-y-4 px-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="savings-movement-amount">Monto</Label>
            <ClpAmountInput
              id="savings-movement-amount"
              required
              value={amount}
              onValueChange={setAmount}
              placeholder="0"
              disabled={saving}
              aria-invalid={exceedsBalance || undefined}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="savings-movement-date">Fecha</Label>
            <Input
              id="savings-movement-date"
              type="date"
              required
              max={currentDate}
              value={operationDate}
              onChange={(event) => setOperationDate(event.target.value)}
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="savings-movement-concept">Concepto (opcional)</Label>
            <Input
              id="savings-movement-concept"
              value={concept}
              onChange={(event) => setConcept(event.target.value)}
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="savings-movement-observation">
              Observación (opcional)
            </Label>
            <Textarea
              id="savings-movement-observation"
              value={observation}
              onChange={(event) => setObservation(event.target.value)}
              disabled={saving}
            />
          </div>
          {exceedsBalance ? (
            <ErrorMessage
              title="Saldo insuficiente"
              description="El retiro no puede superar el saldo disponible de la meta."
            />
          ) : null}
          {error ? (
            <ErrorMessage
              title={isEditing ? "No se pudo guardar" : "No se pudo registrar"}
              description={error}
            />
          ) : null}
          <SheetFooter className="px-0">
            <Button
              type="submit"
              size="lg"
              className="h-11"
              disabled={
                saving ||
                amount === null ||
                amount <= 0 ||
                !operationDate ||
                exceedsBalance
              }
            >
              {isWithdrawal ? (
                <ArrowUpFromLine aria-hidden="true" />
              ) : (
                <ArrowDownToLine aria-hidden="true" />
              )}
              {saving
                ? isEditing
                  ? "Guardando…"
                  : "Registrando…"
                : isEditing
                  ? "Guardar cambios"
                  : isWithdrawal
                    ? "Retirar"
                    : "Depositar"}
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

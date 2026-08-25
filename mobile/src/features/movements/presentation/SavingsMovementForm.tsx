import { useState, type FormEvent } from "react"
import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react"

import { ClpAmountInput } from "@/components/finance/ClpAmountInput"
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
import { Textarea } from "@/components/ui/textarea"
import type { SavingsGoal } from "@/domain/entities"
import type { CivilDate } from "@/domain/primitives"
import type {
  MovementUseCasesPort,
  SavingsMovementResult,
} from "@/features/movements/application/movement-use-cases"

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
  useCases,
  onSaved,
  onClose,
}: {
  readonly goal: SavingsGoal
  readonly mode: SavingsMovementMode
  readonly useCases: MovementUseCasesPort
  readonly onSaved: (result: SavingsMovementResult) => void
  readonly onClose: () => void
}) {
  const currentDate = useCases.getCurrentDate()
  const [amount, setAmount] = useState<number | null>(null)
  const [operationDate, setOperationDate] = useState<string>(currentDate)
  const [concept, setConcept] = useState("")
  const [observation, setObservation] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isWithdrawal = mode === "withdrawal"
  const exceedsBalance =
    isWithdrawal && amount !== null && amount > goal.currentBalance

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const draft = {
        goalId: goal.id,
        amount: amount ?? 0,
        operationDate: operationDate as CivilDate,
        concept,
        observation,
      }
      const result = isWithdrawal
        ? await useCases.registerSavingsWithdrawal(draft)
        : await useCases.registerSavingsDeposit(draft)
      onSaved(result)
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
          <SheetTitle>
            {isWithdrawal ? `Retirar de ${goal.name}` : `Depositar en ${goal.name}`}
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
            <ErrorMessage title="No se pudo registrar" description={error} />
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
                ? "Registrando…"
                : isWithdrawal
                  ? "Retirar"
                  : "Depositar"}
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

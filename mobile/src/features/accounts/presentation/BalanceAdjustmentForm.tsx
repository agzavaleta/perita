import { useState, type FormEvent } from "react"
import { Scale } from "lucide-react"

import { ClpAmountInput } from "@/components/finance/ClpAmountInput"
import { FormSheetContent } from "@/components/forms/FormSheetContent"
import { ErrorMessage } from "@/components/states/ErrorMessage"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import type { Account } from "@/domain/entities"
import type { CivilDate } from "@/domain/primitives"
import type {
  BalanceAdjustmentResult,
  BalanceAdjustmentUseCasesPort,
} from "@/features/accounts/application/balance-adjustment-use-cases"

function message(error: unknown) {
  return error instanceof Error ? error.message : "No fue posible ajustar el saldo."
}

export function BalanceAdjustmentForm({
  account,
  useCases,
  onSaved,
  onClose,
}: {
  readonly account: Account
  readonly useCases: BalanceAdjustmentUseCasesPort
  readonly onSaved: (result: BalanceAdjustmentResult) => void
  readonly onClose: () => void
}) {
  const currentDate = useCases.getCurrentDate()
  const [targetBalance, setTargetBalance] = useState<number | null>(
    account.currentBalance,
  )
  const [operationDate, setOperationDate] = useState<string>(currentDate)
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      onSaved(await useCases.createAdjustment({
        accountId: account.id,
        expectedAccountRevision: account.revision,
        operationDate: operationDate as CivilDate,
        targetBalance: targetBalance ?? 0,
        reason,
      }))
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
          <SheetTitle>Ajustar saldo</SheetTitle>
          <SheetDescription>
            Indica el saldo real de {account.name}. Perita registrará la diferencia como un ajuste trazable.
          </SheetDescription>
        </SheetHeader>
        <form className="space-y-4 px-4" onSubmit={submit}>
          <Alert>
            <Scale aria-hidden="true" />
            <AlertTitle>El saldo no se edita directamente</AlertTitle>
            <AlertDescription>
              Se creará una operación financiera con su movimiento e historial asociado.
            </AlertDescription>
          </Alert>
          <div className="space-y-2">
            <Label htmlFor="adjustment-balance">Saldo real</Label>
            <ClpAmountInput
              id="adjustment-balance"
              value={targetBalance}
              onValueChange={setTargetBalance}
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="adjustment-date">Fecha</Label>
            <Input
              id="adjustment-date"
              type="date"
              value={operationDate}
              max={currentDate}
              onChange={(event) => setOperationDate(event.target.value)}
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="adjustment-reason">Motivo</Label>
            <Input
              id="adjustment-reason"
              required
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ej. Conciliar con saldo bancario"
              disabled={saving}
            />
          </div>
          {error ? <ErrorMessage title="No se pudo ajustar" description={error} /> : null}
          <SheetFooter className="px-0">
            <Button
              type="submit"
              size="lg"
              className="h-11"
              disabled={
                saving ||
                !reason.trim() ||
                !operationDate ||
                targetBalance === null ||
                targetBalance === account.currentBalance
              }
            >
              <Scale aria-hidden="true" />
              {saving ? "Guardando…" : "Registrar ajuste"}
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

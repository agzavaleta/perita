import { useEffect, useState, type FormEvent } from "react"
import { CircleDollarSign } from "lucide-react"

import { ErrorMessage } from "@/components/states/ErrorMessage"
import { LoadingState } from "@/components/states/LoadingState"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { CivilDate, EntityId } from "@/domain/primitives"
import type { MovementUseCasesPort } from "@/features/movements/application/movement-use-cases"
import type { FixedExpenseListItem } from "@/features/planning/application/planning-use-cases"

function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No fue posible registrar el pago."
}

export function FixedExpensePaymentForm({
  item,
  useCases,
  onSaved,
  onClose,
}: {
  readonly item: FixedExpenseListItem
  readonly useCases: MovementUseCasesPort
  readonly onSaved: () => void
  readonly onClose: () => void
}) {
  const instance = item.currentInstance
  const [accounts, setAccounts] = useState<
    Awaited<ReturnType<MovementUseCasesPort["getFormOptions"]>>["accounts"]
  >([])
  const [currentDate, setCurrentDate] = useState<string>("")
  const [accountId, setAccountId] = useState<string>("")
  const [operationDate, setOperationDate] = useState<string>("")
  const [amount, setAmount] = useState(
    instance ? String(instance.plannedAmount) : "",
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void useCases
      .getFormOptions()
      .then((options) => {
        if (!active) return
        setAccounts(options.accounts)
        setCurrentDate(options.currentDate)
        setOperationDate(options.currentDate)
        setAccountId(options.accounts[0]?.id ?? "")
        setLoading(false)
      })
      .catch((cause) => {
        if (!active) return
        setError(message(cause))
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [useCases])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!instance) return
    setSaving(true)
    setError(null)
    try {
      await useCases.registerFixedExpensePayment({
        accountId: accountId as EntityId,
        fixedExpenseInstanceId: instance.id,
        operationDate: operationDate as CivilDate,
        amount: Number(amount),
      })
      onSaved()
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
          <SheetTitle>Registrar pago</SheetTitle>
          <SheetDescription>
            {item.template.name}. El pago afectará la cuenta seleccionada y el
            resumen del período.
          </SheetDescription>
        </SheetHeader>
        {loading ? (
          <div className="px-4">
            <LoadingState label="Cargando cuentas" />
          </div>
        ) : (
          <form className="space-y-4 px-4" onSubmit={submit}>
            <div className="space-y-2">
              <Label>Cuenta</Label>
              <Select
                value={accountId}
                onValueChange={setAccountId}
                disabled={saving || accounts.length === 0}
              >
                <SelectTrigger className="w-full" aria-label="Cuenta">
                  <SelectValue placeholder="Selecciona una cuenta" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="fixed-payment-date">Fecha</Label>
                <Input
                  id="fixed-payment-date"
                  type="date"
                  value={operationDate}
                  max={currentDate}
                  onChange={(event) => setOperationDate(event.target.value)}
                  disabled={saving}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fixed-payment-amount">Monto CLP</Label>
                <Input
                  id="fixed-payment-amount"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  disabled={saving}
                />
              </div>
            </div>
            {accounts.length === 0 ? (
              <ErrorMessage
                title="No hay cuentas activas"
                description="Crea una cuenta activa antes de registrar el pago."
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
                disabled={saving || !accountId || !operationDate || !amount}
              >
                <CircleDollarSign aria-hidden="true" />
                {saving ? "Registrando…" : "Registrar pago"}
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
        )}
      </SheetContent>
    </Sheet>
  )
}

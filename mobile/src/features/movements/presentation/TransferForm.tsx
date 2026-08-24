import { useState, type FormEvent } from "react"
import { ArrowRightLeft, Landmark, PiggyBank } from "lucide-react"

import { ClpAmountInput } from "@/components/finance/ClpAmountInput"
import { FormSheetContent } from "@/components/forms/FormSheetContent"
import { ErrorMessage } from "@/components/states/ErrorMessage"
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
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import type { TransferEndpointType } from "@/domain/operations"
import type { EntityId } from "@/domain/primitives"
import type {
  MovementListItem,
  MovementUseCasesPort,
  TransferFormOptions,
} from "@/features/movements/application/movement-use-cases"

export interface TransferEditor {
  readonly item?: MovementListItem
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No fue posible mover el dinero."
}

export function TransferForm({
  editor,
  options,
  useCases,
  onSaved,
  onClose,
}: {
  readonly editor: TransferEditor
  readonly options: TransferFormOptions
  readonly useCases: MovementUseCasesPort
  readonly onSaved: (item: MovementListItem) => void
  readonly onClose: () => void
}) {
  const operation =
    editor.item?.operation.type === "transfer"
      ? editor.item.operation
      : undefined
  const initialSourceType =
    operation?.details.sourceType ??
    (options.accounts.length > 0 ? "account" : "savings_goal")
  const initialDestinationType =
    operation?.details.destinationType ??
    (options.accounts.length > 1 ? "account" : "savings_goal")
  const [sourceType, setSourceType] =
    useState<TransferEndpointType>(initialSourceType)
  const [destinationType, setDestinationType] =
    useState<TransferEndpointType>(initialDestinationType)
  const [sourceId, setSourceId] = useState(
    operation?.details.sourceId ?? options.accounts[0]?.id ?? options.savingsGoals[0]?.id ?? "",
  )
  const [destinationId, setDestinationId] = useState(
    operation?.details.destinationId ??
      options.accounts.find(({ id }) => id !== sourceId)?.id ??
      options.savingsGoals.find(({ id }) => id !== sourceId)?.id ??
      "",
  )
  const [operationDate, setOperationDate] = useState(
    operation?.operationDate ?? options.currentDate,
  )
  const [amount, setAmount] = useState<number | null>(operation?.amount ?? null)
  const [concept, setConcept] = useState(operation?.details.concept ?? "")
  const [observation, setObservation] = useState(
    operation?.details.observation ?? "",
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editing = operation !== undefined

  function funds(type: TransferEndpointType) {
    return type === "account" ? options.accounts : options.savingsGoals
  }

  function changeSourceType(type: TransferEndpointType) {
    setSourceType(type)
    setSourceId(funds(type)[0]?.id ?? "")
  }

  function changeDestinationType(type: TransferEndpointType) {
    setDestinationType(type)
    setDestinationId(funds(type)[0]?.id ?? "")
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const draft = {
        sourceType,
        sourceId: sourceId as EntityId,
        destinationType,
        destinationId: destinationId as EntityId,
        operationDate,
        amount: amount ?? 0,
        concept,
        observation,
      }
      const item = editing
        ? await useCases.editTransfer({
            ...draft,
            operationId: operation.id,
            expectedRevision: operation.revision,
          })
        : await useCases.registerTransfer(draft)
      onSaved(item)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  const sameEndpoint =
    sourceType === destinationType && sourceId === destinationId
  const hasEnoughFunds = options.accounts.length + options.savingsGoals.length >= 2

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <FormSheetContent>
        <SheetHeader>
          <SheetTitle>{editing ? "Editar movimiento" : "Mover dinero"}</SheetTitle>
          <SheetDescription>
            Mueve fondos dentro de Perita sin cambiar tu patrimonio total.
          </SheetDescription>
        </SheetHeader>
        <form className="space-y-4 px-4" onSubmit={submit}>
          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-center text-xs font-medium text-muted-foreground">
              <span>Origen</span>
              <ArrowRightLeft aria-hidden="true" className="size-4 text-brand" />
              <span>Destino</span>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Tipo de origen</Label>
            <Select
              value={sourceType}
              onValueChange={(value) =>
                changeSourceType(value as TransferEndpointType)
              }
              disabled={saving}
            >
              <SelectTrigger className="w-full" aria-label="Tipo de origen">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="account">
                  <Landmark aria-hidden="true" /> Cuenta
                </SelectItem>
                <SelectItem value="savings_goal">
                  <PiggyBank aria-hidden="true" /> Meta
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Fondo de origen</Label>
            <Select
              value={sourceId}
              onValueChange={(value) => {
                if (value) setSourceId(value as EntityId)
              }}
              disabled={saving}
            >
              <SelectTrigger className="w-full" aria-label="Fondo de origen">
                <SelectValue placeholder="Selecciona" />
              </SelectTrigger>
              <SelectContent>
                {funds(sourceType).map((fund) => (
                  <SelectItem key={fund.id} value={fund.id}>
                    {fund.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Tipo de destino</Label>
            <Select
              value={destinationType}
              onValueChange={(value) =>
                changeDestinationType(value as TransferEndpointType)
              }
              disabled={saving}
            >
              <SelectTrigger className="w-full" aria-label="Tipo de destino">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="account">
                  <Landmark aria-hidden="true" /> Cuenta
                </SelectItem>
                <SelectItem value="savings_goal">
                  <PiggyBank aria-hidden="true" /> Meta
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Fondo de destino</Label>
            <Select
              value={destinationId}
              onValueChange={(value) => {
                if (value) setDestinationId(value as EntityId)
              }}
              disabled={saving}
            >
              <SelectTrigger className="w-full" aria-label="Fondo de destino">
                <SelectValue placeholder="Selecciona" />
              </SelectTrigger>
              <SelectContent>
                {funds(destinationType).map((fund) => (
                  <SelectItem
                    key={fund.id}
                    value={fund.id}
                    disabled={sourceType === destinationType && sourceId === fund.id}
                  >
                    {fund.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="transfer-date">Fecha</Label>
            <Input
              id="transfer-date"
              type="date"
              value={operationDate}
              max={options.currentDate}
              onChange={(event) =>
                setOperationDate(event.target.value as typeof operationDate)
              }
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="transfer-amount">Monto</Label>
            <ClpAmountInput
              id="transfer-amount"
              value={amount}
              onValueChange={setAmount}
              placeholder="0"
              disabled={saving}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="transfer-concept">Concepto (opcional)</Label>
            <Input
              id="transfer-concept"
              value={concept}
              onChange={(event) => setConcept(event.target.value)}
              placeholder="Opcional"
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="transfer-observation">Observación (opcional)</Label>
            <Textarea
              id="transfer-observation"
              value={observation}
              onChange={(event) => setObservation(event.target.value)}
              placeholder="Opcional"
              disabled={saving}
            />
          </div>

          {!hasEnoughFunds ? (
            <ErrorMessage
              title="Faltan fondos disponibles"
              description="Necesitas al menos dos cuentas o metas activas para mover dinero."
            />
          ) : sameEndpoint ? (
            <ErrorMessage
              title="Elige otro destino"
              description="El origen y el destino deben ser distintos."
            />
          ) : null}
          {error ? (
            <ErrorMessage title="No se pudo mover el dinero" description={error} />
          ) : null}

          <SheetFooter className="px-0">
            <Button
              type="submit"
              size="lg"
              className="h-11"
              disabled={
                saving ||
                !sourceId ||
                !destinationId ||
                sameEndpoint ||
                !hasEnoughFunds
              }
            >
              <ArrowRightLeft aria-hidden="true" />
              {saving ? "Moviendo…" : editing ? "Guardar cambios" : "Mover dinero"}
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

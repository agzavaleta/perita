import { useState, type FormEvent } from "react"

import type { EntityId } from "@/domain/primitives"
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
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import type {
  MovementFormOptions,
  MovementKind,
  MovementListItem,
  MovementUseCasesPort,
} from "@/features/movements/application/movement-use-cases"

export interface MovementEditor {
  readonly kind: Exclude<MovementKind, "transfer">
  readonly item?: MovementListItem
}

function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No fue posible guardar el movimiento."
}

export function MovementForm({
  editor,
  options,
  useCases,
  onSaved,
  onClose,
}: {
  readonly editor: MovementEditor
  readonly options: MovementFormOptions
  readonly useCases: MovementUseCasesPort
  readonly onSaved: (item: MovementListItem) => void
  readonly onClose: () => void
}) {
  const candidate = editor.item?.operation
  const operation = candidate?.type === "transfer" ? undefined : candidate
  const variableDetails = operation?.type === "variable_expense" ? operation.details : null
  const fixedDetails = operation?.type === "fixed_expense_payment" ? operation.details : null
  const incomeDetails = operation?.type === "additional_income" ? operation.details : null
  const [incomeType, setIncomeType] = useState<"salary" | "additional">(
    operation?.type === "salary_receipt" ? "salary" : "additional",
  )
  const [accountId, setAccountId] = useState<string>(
    operation ? operation.details.accountId : (options.accounts[0]?.id ?? ""),
  )
  const [categoryId, setCategoryId] = useState<string>(
    variableDetails?.categoryId ??
      options.categories.find(({ status }) => status === "active")?.id ??
      "",
  )
  const [operationDate, setOperationDate] = useState(
    operation?.operationDate ?? options.currentDate,
  )
  const [amount, setAmount] = useState(operation ? String(operation.amount) : "")
  const [concept, setConcept] = useState(
    variableDetails?.concept ?? incomeDetails?.concept ?? "",
  )
  const [observation, setObservation] = useState(
    variableDetails?.observation ?? incomeDetails?.observation ?? "",
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editing = operation !== undefined
  const salary = editor.kind === "income" && incomeType === "salary"

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const numericAmount = Number(amount)
      let item: MovementListItem
      if (editing) {
        item = await useCases.editMovement({
          operationId: operation.id,
          expectedRevision: operation.revision,
          accountId: accountId as EntityId,
          operationDate,
          amount: numericAmount,
          concept: salary ? undefined : concept,
          observation: salary ? undefined : observation,
          categoryId:
            operation.type === "variable_expense"
              ? (categoryId as EntityId)
              : undefined,
        })
      } else if (editor.kind === "income") {
        item = await useCases.registerIncome({
          incomeType,
          accountId: accountId as EntityId,
          operationDate,
          amount: numericAmount,
          concept: salary ? undefined : concept,
          observation: salary ? undefined : observation,
        })
      } else {
        item = await useCases.registerExpense({
          accountId: accountId as EntityId,
          categoryId: categoryId as EntityId,
          operationDate,
          amount: numericAmount,
          concept,
          observation,
        })
      }
      onSaved(item)
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
          <SheetTitle>
            {editing
              ? `Editar ${editor.kind === "income" ? "ingreso" : "gasto"}`
              : `Registrar ${editor.kind === "income" ? "ingreso" : "gasto"}`}
          </SheetTitle>
          <SheetDescription>
            El saldo se actualizará mediante las reglas financieras del dominio.
          </SheetDescription>
        </SheetHeader>
        <form className="space-y-4 px-4" onSubmit={submit}>
          {editor.kind === "income" && (
            <div className="space-y-2">
              <Label>Tipo de ingreso</Label>
              <Select
                value={incomeType}
                onValueChange={(value) =>
                  setIncomeType(value as "salary" | "additional")
                }
                disabled={editing || saving}
              >
                <SelectTrigger className="w-full" aria-label="Tipo de ingreso">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="additional">Ingreso adicional</SelectItem>
                  <SelectItem value="salary">Sueldo recibido</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label>Cuenta</Label>
            <Select
              value={accountId}
              onValueChange={setAccountId}
              disabled={saving || options.accounts.length === 0}
            >
              <SelectTrigger className="w-full" aria-label="Cuenta">
                <SelectValue placeholder="Selecciona una cuenta" />
              </SelectTrigger>
              <SelectContent>
                {options.accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {editor.kind === "expense" && !fixedDetails ? (
            <div className="space-y-2">
              <Label>Categoría</Label>
              <Select
                value={categoryId}
                onValueChange={setCategoryId}
                disabled={saving || options.categories.length === 0}
              >
                <SelectTrigger className="w-full" aria-label="Categoría">
                  <SelectValue placeholder="Selecciona una categoría" />
                </SelectTrigger>
                <SelectContent>
                  {options.categories.map((category) => (
                    <SelectItem
                      key={category.id}
                      value={category.id}
                      disabled={
                        category.status === "inactive" &&
                        category.id !== variableDetails?.categoryId
                      }
                    >
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="movement-date">Fecha</Label>
              <Input
                id="movement-date"
                type="date"
                value={operationDate}
                max={options.currentDate}
                onChange={(event) => setOperationDate(event.target.value as typeof operationDate)}
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="movement-amount">Monto CLP</Label>
              <Input
                id="movement-amount"
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
          </div>
          {!salary && !fixedDetails ? (
            <div className="space-y-2">
              <Label htmlFor="movement-concept">
                {editor.kind === "expense" ? "Concepto" : "Descripción"}
              </Label>
              <Input
                id="movement-concept"
                value={concept}
                onChange={(event) => setConcept(event.target.value)}
                placeholder={editor.kind === "expense" ? "Ej. Almuerzo" : "Ej. Freelance"}
                disabled={saving}
              />
            </div>
          ) : null}
          {!salary && !fixedDetails ? (
            <div className="space-y-2">
              <Label htmlFor="movement-observation">Observación</Label>
              <Textarea
                id="movement-observation"
                value={observation}
                onChange={(event) => setObservation(event.target.value)}
                placeholder="Opcional"
                disabled={saving}
              />
            </div>
          ) : null}
          {options.accounts.length === 0 && (
            <ErrorMessage
              title="No hay cuentas activas"
              description="Activa o crea una cuenta antes de registrar movimientos."
            />
          )}
          {editor.kind === "expense" &&
            !options.categories.some(({ status }) => status === "active") &&
            !variableDetails &&
            !fixedDetails ? (
            <ErrorMessage
              title="No hay categorías"
              description="Se necesita una categoría activa para registrar un gasto."
            />
          ) : null}
          {error && <ErrorMessage title="No se pudo guardar" description={error} />}
          <SheetFooter className="px-0">
            <Button
              type="submit"
              size="lg"
              className="h-11"
              disabled={
                saving ||
                !accountId ||
                (editor.kind === "expense" && !fixedDetails && !categoryId)
              }
            >
              {saving ? "Guardando…" : editing ? "Guardar cambios" : "Registrar"}
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

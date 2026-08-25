import { useEffect, useState, type FormEvent } from "react"
import {
  CalendarDays,
  ChevronRight,
  CircleOff,
  HandCoins,
  History,
  Pencil,
  Plus,
  ReceiptText,
} from "lucide-react"

import { ClpAmountInput } from "@/components/finance/ClpAmountInput"
import { FormSheetContent } from "@/components/forms/FormSheetContent"
import { useUnsavedChangesGuard } from "@/components/forms/useUnsavedChangesGuard"
import { EmptyState } from "@/components/states/EmptyState"
import { ErrorMessage } from "@/components/states/ErrorMessage"
import { LoadingState } from "@/components/states/LoadingState"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
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
import { Switch } from "@/components/ui/switch"
import type { Debt } from "@/domain/entities"
import type { CivilDate, EntityId } from "@/domain/primitives"
import type {
  DebtDetail,
  DebtFormOptions,
  DebtListItem,
  DebtPaymentItem,
  DebtUseCasesPort,
} from "@/features/planning/application/debt-use-cases"
import { toast } from "sonner"

function formatClp(value: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(value)
}

function formatDate(value: string | null) {
  if (!value) return "—"
  const [year, month, day] = value.split("-")
  return `${day}-${month}-${year}`
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "No fue posible completar la acción."
}

function statusLabel(debt: Debt) {
  if (debt.paymentStatus === "paid") return "Pagada"
  if (debt.paymentStatus === "overdue") return "Atrasada"
  return "Activa"
}

function DebtProgressBar({
  progressPercent,
}: {
  readonly progressPercent: number
}) {
  const label = `${new Intl.NumberFormat("es-CL", {
    maximumFractionDigits: 0,
  }).format(progressPercent)}% pagado`
  return (
    <div className="space-y-1.5">
      <div
        role="progressbar"
        aria-label="Progreso de pago"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-brand transition-[width]"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function DebtEditor({
  debt,
  useCases,
  onSaved,
  onClose,
}: {
  readonly debt?: Debt
  readonly useCases: DebtUseCasesPort
  readonly onSaved: () => void
  readonly onClose: () => void
}) {
  const [name, setName] = useState(debt?.name ?? "")
  const [total, setTotal] = useState<number | null>(debt?.totalAmount ?? null)
  const [currentOutstanding, setCurrentOutstanding] = useState<number | null>(null)
  const [monthly, setMonthly] = useState<number | null>(
    debt?.monthlyPaymentAmount ?? null,
  )
  const [dueDate, setDueDate] = useState(debt?.dueDate ?? "")
  const [hasDueDate, setHasDueDate] = useState(debt?.dueDate != null)
  const [day, setDay] = useState(
    debt?.paymentDay !== null && debt?.paymentDay !== undefined
      ? String(debt.paymentDay)
      : "",
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentOutstandingError =
    !debt && currentOutstanding !== null
      ? currentOutstanding <= 0
        ? "El saldo pendiente debe ser mayor que cero."
        : total !== null && currentOutstanding > total
          ? "El saldo pendiente no puede superar el total de la deuda."
          : null
      : null
  const initialDay =
    debt?.paymentDay !== null && debt?.paymentDay !== undefined
      ? String(debt.paymentDay)
      : ""
  const dirty =
    name !== (debt?.name ?? "") ||
    total !== (debt?.totalAmount ?? null) ||
    currentOutstanding !== null ||
    monthly !== (debt?.monthlyPaymentAmount ?? null) ||
    dueDate !== (debt?.dueDate ?? "") ||
    hasDueDate !== (debt?.dueDate != null) ||
    day !== initialDay
  const guard = useUnsavedChangesGuard({ dirty, saving, onClose })

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (debt) {
        await useCases.editDebt({
          debtId: debt.id,
          expectedRevision: debt.revision,
          name,
          dueDate: hasDueDate && dueDate ? dueDate as CivilDate : null,
          monthlyPaymentAmount: monthly ?? 0,
          paymentDay: day === "" ? null : Number(day),
        })
      } else {
        await useCases.createDebt({
          name,
          totalAmount: total ?? 0,
          currentOutstandingAmount: currentOutstanding,
          dueDate: hasDueDate && dueDate ? dueDate as CivilDate : null,
          monthlyPaymentAmount: monthly ?? 0,
          paymentDay: day === "" ? null : Number(day),
        })
      }
      toast.success(debt ? "Deuda actualizada" : "Deuda creada")
      onSaved()
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
          <SheetTitle>{debt ? "Editar deuda" : "Nueva deuda"}</SheetTitle>
          <SheetDescription>
            {debt
              ? "Actualiza los datos de planificación de la deuda."
              : "La deuda comienza activa y con el total completamente pendiente."}
          </SheetDescription>
        </SheetHeader>
        <form className="space-y-4 px-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="debt-name">Nombre</Label>
            <Input id="debt-name" value={name} onChange={(event) => setName(event.target.value)} disabled={saving} />
          </div>
          {!debt ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="debt-total">Total</Label>
                <ClpAmountInput id="debt-total" value={total} onValueChange={setTotal} disabled={saving} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="debt-current-outstanding">
                  Saldo pendiente actual (opcional)
                </Label>
                <ClpAmountInput
                  id="debt-current-outstanding"
                  value={currentOutstanding}
                  onValueChange={setCurrentOutstanding}
                  disabled={saving}
                  aria-invalid={currentOutstandingError ? true : undefined}
                  aria-describedby="debt-current-outstanding-help"
                />
                <p
                  id="debt-current-outstanding-help"
                  className={currentOutstandingError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
                >
                  {currentOutstandingError ?? "Úsalo si ya pagaste parte de esta deuda."}
                </p>
              </div>
            </>
          ) : null}
          <div className="space-y-3">
            <div className="flex min-h-11 items-center justify-between gap-3">
              <Label htmlFor="debt-has-due-date">Tiene fecha de vencimiento</Label>
              <Switch
                id="debt-has-due-date"
                checked={hasDueDate}
                onCheckedChange={(checked) => {
                  setHasDueDate(checked)
                  if (!checked) setDueDate("")
                }}
                disabled={saving}
              />
            </div>
            {hasDueDate ? (
              <div className="space-y-2">
                <Label htmlFor="debt-due-date">Fecha de vencimiento</Label>
                <Input
                  id="debt-due-date"
                  type="date"
                  required
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                  disabled={saving}
                />
              </div>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="debt-monthly">Cuota mensual</Label>
            <ClpAmountInput id="debt-monthly" required value={monthly} onValueChange={setMonthly} disabled={saving} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="debt-day">Día de pago (opcional)</Label>
            <Input id="debt-day" type="number" inputMode="numeric" min="1" max="31" step="1" value={day} onChange={(event) => setDay(event.target.value)} disabled={saving} />
          </div>
          {error ? <ErrorMessage title="No se pudo guardar" description={error} /> : null}
          <SheetFooter className="px-0">
            <Button type="submit" size="lg" className="h-11" disabled={saving || currentOutstandingError !== null}>
              <ReceiptText aria-hidden="true" /> {saving ? "Guardando…" : "Guardar"}
            </Button>
            <Button type="button" variant="outline" size="lg" className="h-11" onClick={guard.requestClose} disabled={saving}>Cancelar</Button>
          </SheetFooter>
        </form>
      </FormSheetContent>
    </Sheet>
    {guard.confirmation}
    </>
  )
}

function PaymentEditor({
  debt,
  payment,
  options,
  useCases,
  onSaved,
  onClose,
}: {
  readonly debt: Debt
  readonly payment?: DebtPaymentItem
  readonly options: DebtFormOptions
  readonly useCases: DebtUseCasesPort
  readonly onSaved: () => void
  readonly onClose: () => void
}) {
  const operation = payment?.operation
  const [accountId, setAccountId] = useState<string>(operation?.details.accountId ?? options.accounts[0]?.id ?? "")
  const [date, setDate] = useState<string>(operation?.operationDate ?? options.currentDate)
  const [amount, setAmount] = useState<number | null>(operation?.amount ?? null)
  const [concept, setConcept] = useState(operation?.details.concept ?? "")
  const [observation, setObservation] = useState(operation?.details.observation ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty =
    accountId !== (operation?.details.accountId ?? options.accounts[0]?.id ?? "") ||
    date !== (operation?.operationDate ?? options.currentDate) ||
    amount !== (operation?.amount ?? null) ||
    concept !== (operation?.details.concept ?? "") ||
    observation !== (operation?.details.observation ?? "")
  const guard = useUnsavedChangesGuard({ dirty, saving, onClose })

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const draft = {
        debtId: debt.id,
        accountId: accountId as EntityId,
        operationDate: date as CivilDate,
        amount: amount ?? 0,
        concept,
        observation,
      }
      if (operation) {
        await useCases.editPayment({
          ...draft,
          operationId: operation.id,
          expectedRevision: operation.revision,
        })
      } else {
        await useCases.registerPayment(draft)
      }
      toast.success(operation ? "Cambios guardados" : "Pago registrado")
      onSaved()
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
          <SheetTitle>{operation ? "Editar pago" : "Registrar pago"}</SheetTitle>
          <SheetDescription>El pago reduce la cuenta y el saldo pendiente en una sola transacción.</SheetDescription>
        </SheetHeader>
        <form className="space-y-4 px-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label>Cuenta</Label>
            <Select value={accountId} onValueChange={setAccountId} disabled={saving || options.accounts.length === 0}>
              <SelectTrigger className="w-full" aria-label="Cuenta para el pago"><SelectValue placeholder="Selecciona una cuenta" /></SelectTrigger>
              <SelectContent>{options.accounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="debt-payment-date">Fecha</Label>
            <Input id="debt-payment-date" type="date" max={options.currentDate} value={date} onChange={(event) => setDate(event.target.value)} disabled={saving} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="debt-payment-amount">Monto</Label>
            <ClpAmountInput id="debt-payment-amount" value={amount} onValueChange={setAmount} disabled={saving} />
          </div>
          <div className="space-y-2"><Label htmlFor="debt-payment-concept">Concepto (opcional)</Label><Input id="debt-payment-concept" value={concept} onChange={(event) => setConcept(event.target.value)} disabled={saving} /></div>
          <div className="space-y-2"><Label htmlFor="debt-payment-observation">Observación (opcional)</Label><Textarea id="debt-payment-observation" value={observation} onChange={(event) => setObservation(event.target.value)} disabled={saving} /></div>
          {error ? <ErrorMessage title="No se pudo guardar el pago" description={error} /> : null}
          <SheetFooter className="px-0">
            <Button type="submit" size="lg" className="h-11" disabled={saving || !accountId}><HandCoins aria-hidden="true" /> {saving ? "Guardando…" : "Guardar pago"}</Button>
            <Button type="button" variant="outline" size="lg" className="h-11" onClick={guard.requestClose} disabled={saving}>Cancelar</Button>
          </SheetFooter>
        </form>
      </FormSheetContent>
    </Sheet>
    {guard.confirmation}
    </>
  )
}

function TotalEditor({ debt, currentDate, useCases, onSaved, onClose }: {
  readonly debt: Debt
  readonly currentDate: CivilDate
  readonly useCases: DebtUseCasesPort
  readonly onSaved: () => void
  readonly onClose: () => void
}) {
  const [total, setTotal] = useState<number | null>(debt.totalAmount)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guard = useUnsavedChangesGuard({
    dirty: total !== debt.totalAmount,
    saving,
    onClose,
  })
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await useCases.adjustDebtTotal(debt.id, debt.revision, currentDate, total ?? 0)
      toast.success("Cambios guardados")
      onSaved()
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
        <SheetHeader><SheetTitle>Ajustar total</SheetTitle><SheetDescription>Se conservarán los pagos vigentes y el saldo pendiente se recalculará.</SheetDescription></SheetHeader>
        <form className="space-y-4 px-4" onSubmit={submit}>
          <div className="space-y-2"><Label htmlFor="debt-new-total">Nuevo total</Label><ClpAmountInput id="debt-new-total" value={total} onValueChange={setTotal} disabled={saving} /></div>
          {error ? <ErrorMessage title="No se pudo ajustar" description={error} /> : null}
          <SheetFooter className="px-0"><Button type="submit" size="lg" disabled={saving}>{saving ? "Guardando…" : "Ajustar total"}</Button><Button type="button" variant="outline" size="lg" onClick={guard.requestClose} disabled={saving}>Cancelar</Button></SheetFooter>
        </form>
      </FormSheetContent>
    </Sheet>
    {guard.confirmation}
    </>
  )
}

export function DebtSection({ useCases }: { readonly useCases: DebtUseCasesPort | null }) {
  const [items, setItems] = useState<DebtListItem[]>([])
  const [detail, setDetail] = useState<DebtDetail | null>(null)
  const [options, setOptions] = useState<DebtFormOptions | null>(null)
  const [editor, setEditor] = useState<Debt | "new" | null>(null)
  const [paymentEditor, setPaymentEditor] = useState<DebtPaymentItem | "new" | null>(null)
  const [totalEditor, setTotalEditor] = useState(false)
  const [voidTarget, setVoidTarget] = useState<DebtPaymentItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!useCases) return
    let active = true
    void Promise.all([useCases.listDebts(), useCases.getPaymentFormOptions()])
      .then(([nextItems, nextOptions]) => {
        if (active) {
          setItems(nextItems)
          setOptions(nextOptions)
          setLoading(false)
        }
      })
      .catch((cause) => {
        if (active) {
          setError(message(cause))
          setLoading(false)
        }
      })
    return () => { active = false }
  }, [refreshKey, useCases])

  async function open(item: DebtListItem) {
    if (!useCases) return
    setError(null)
    try { setDetail(await useCases.getDebtDetail(item.debt.id)) } catch (cause) { setError(message(cause)) }
  }

  function saved() {
    setEditor(null)
    setPaymentEditor(null)
    setTotalEditor(false)
    setDetail(null)
    setError(null)
    setRefreshKey((value) => value + 1)
  }

  async function confirmVoid() {
    if (!useCases || !voidTarget) return
    try {
      await useCases.voidPayment(voidTarget.operation.id, voidTarget.operation.revision)
      toast.success("Pago anulado")
      saved()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setVoidTarget(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div><h2 className="text-lg font-semibold">Deudas</h2><p className="text-sm text-muted-foreground">Saldo y pagos bajo control.</p></div>
        <Button type="button" size="lg" onClick={() => setEditor("new")} disabled={!useCases}><Plus aria-hidden="true" /> Nueva</Button>
      </div>
      {error ? <ErrorMessage title="No se pudo completar la acción" description={error} /> : null}
      {loading && useCases ? <LoadingState label="Cargando deudas" /> : items.length === 0 ? <EmptyState title="Aún no tienes deudas" description="Registra una deuda para planificar y controlar sus pagos." /> : (
        <div className="space-y-3">
          {items.map((item) => (
            <Card key={item.debt.id} className={item.debt.paymentStatus === "paid" ? "opacity-65" : undefined}>
              <CardHeader className="flex-row items-center justify-between"><div><CardTitle>{item.debt.name}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{item.schedule.remainingInstallments ?? 0} cuota(s) estimada(s)</p></div><Badge variant={item.debt.paymentStatus === "overdue" ? "destructive" : "secondary"}>{statusLabel(item.debt)}</Badge></CardHeader>
              <CardContent className="space-y-3"><div className="flex items-end justify-between gap-3"><div><p className="text-xs text-muted-foreground">Saldo pendiente</p><p className="money-figure text-xl font-semibold">{formatClp(item.debt.outstandingAmount)}</p></div><Button type="button" variant="ghost" size="icon-lg" aria-label={`Ver detalle de ${item.debt.name}`} onClick={() => void open(item)}><ChevronRight aria-hidden="true" /></Button></div><DebtProgressBar progressPercent={item.progressPercent} /></CardContent>
            </Card>
          ))}
        </div>
      )}

      {editor && useCases ? <DebtEditor key={editor === "new" ? "new" : editor.id} debt={editor === "new" ? undefined : editor} useCases={useCases} onSaved={saved} onClose={() => setEditor(null)} /> : null}
      {detail && !editor && !paymentEditor && !totalEditor ? (
        <Sheet open onOpenChange={(openState) => !openState && setDetail(null)}>
          <SheetContent side="bottom" className="mx-auto max-h-[92dvh] w-full max-w-[430px] rounded-t-xl">
            <SheetHeader><SheetTitle>{detail.debt.name}</SheetTitle><SheetDescription>{statusLabel(detail.debt)} · total {formatClp(detail.debt.totalAmount)}</SheetDescription></SheetHeader>
            <div className="space-y-4 px-4">
              <Card>
                <CardContent className="space-y-3 pt-1">
                  <dl className="grid grid-cols-1 gap-3 text-sm min-[360px]:grid-cols-2">
                    <div><dt className="text-xs text-muted-foreground">Total</dt><dd className="money-figure text-lg font-semibold">{formatClp(detail.debt.totalAmount)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Pagado</dt><dd className="money-figure text-lg font-semibold">{formatClp(detail.paidAmount)}</dd></div>
                    <div className="min-[360px]:col-span-2"><dt className="text-xs text-muted-foreground">Pendiente</dt><dd className="money-figure text-2xl font-semibold">{formatClp(detail.debt.outstandingAmount)}</dd></div>
                  </dl>
                  <DebtProgressBar progressPercent={detail.progressPercent} />
                  <Separator />
                  <dl className="grid grid-cols-1 gap-3 text-sm min-[360px]:grid-cols-2">
                    <div>
                      <dt className="text-xs text-muted-foreground">Cuota mensual</dt>
                      <dd className="font-medium">{formatClp(detail.debt.monthlyPaymentAmount)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Cuotas restantes</dt>
                      <dd className="font-medium">{detail.schedule.remainingInstallments}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Fecha de vencimiento</dt>
                      <dd className="font-medium">
                        {detail.debt.dueDate
                          ? formatDate(detail.debt.dueDate)
                          : "Sin vencimiento"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Día de pago</dt>
                      <dd className="font-medium">
                        {detail.debt.paymentDay !== null
                          ? `Día ${detail.debt.paymentDay}`
                          : "Sin día definido"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Próximo pago</dt>
                      <dd className="font-medium">{formatDate(detail.schedule.nextPaymentDate)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Término estimado</dt>
                      <dd className="font-medium">{formatDate(detail.schedule.estimatedEndDate)}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
              {detail.debt.paymentStatus !== "paid" ? <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2"><Button type="button" onClick={() => setPaymentEditor("new")}><HandCoins aria-hidden="true" /> Registrar pago</Button><Button type="button" variant="outline" onClick={() => setEditor(detail.debt)}><Pencil aria-hidden="true" /> Editar</Button><Button type="button" variant="outline" className="min-[360px]:col-span-2" onClick={() => setTotalEditor(true)}><ReceiptText aria-hidden="true" /> Ajustar total</Button></div> : null}
              <div className="space-y-2"><div className="flex items-center gap-2"><History aria-hidden="true" className="size-4" /><h3 className="font-semibold">Pagos e historial</h3></div>{detail.payments.length === 0 ? <EmptyState title="Sin pagos registrados" description="Los pagos aparecerán aquí con sus revisiones." /> : detail.payments.map((item) => <Card key={item.operation.id} className={item.operation.status === "voided" ? "opacity-60" : undefined}><CardContent className="space-y-2 pt-1"><div className="flex items-start justify-between gap-3"><div><p className="font-medium">{item.operation.details.concept ?? "Pago de deuda"}</p><p className="text-xs text-muted-foreground">{formatDate(item.operation.operationDate)} · {item.accountName}</p></div><p className="money-figure font-semibold">{formatClp(item.operation.amount)}</p></div><div className="flex items-center justify-between"><Badge variant="outline">{item.operation.status === "posted" ? "Vigente" : "Anulado"}</Badge><span className="text-xs text-muted-foreground">Rev. {item.operation.revision} · {item.revisions.length} cambio(s)</span></div>{item.operation.status === "posted" ? <div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={() => setPaymentEditor(item)}><Pencil aria-hidden="true" /> Editar</Button><Button type="button" size="sm" variant="destructive" onClick={() => setVoidTarget(item)}><CircleOff aria-hidden="true" /> Anular</Button></div> : null}</CardContent></Card>)}</div>
              {detail.adjustments.length > 0 || detail.auditEvents.length > 0 ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><CalendarDays aria-hidden="true" className="size-4" /> {detail.adjustments.length} ajuste(s) de total · {detail.auditEvents.length} revisión(es) de ficha</p> : null}
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
      {detail && paymentEditor && options && useCases ? <PaymentEditor key={paymentEditor === "new" ? "new" : paymentEditor.operation.id} debt={detail.debt} payment={paymentEditor === "new" ? undefined : paymentEditor} options={options} useCases={useCases} onSaved={saved} onClose={() => setPaymentEditor(null)} /> : null}
      {detail && totalEditor && options && useCases ? <TotalEditor debt={detail.debt} currentDate={options.currentDate} useCases={useCases} onSaved={saved} onClose={() => setTotalEditor(false)} /> : null}
      <AlertDialog open={voidTarget !== null} onOpenChange={(openState) => !openState && setVoidTarget(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogMedia><CircleOff /></AlertDialogMedia><AlertDialogTitle>Anular pago</AlertDialogTitle><AlertDialogDescription>Se restaurarán atómicamente el saldo de la cuenta y el saldo pendiente de la deuda.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void confirmVoid()}>Anular pago</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </div>
  )
}

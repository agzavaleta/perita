import { useEffect, useState } from "react"
import {
  Archive,
  CalendarCheck,
  ChevronRight,
  History,
  LockKeyhole,
  TriangleAlert,
} from "lucide-react"

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
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { PeriodSnapshot } from "@/domain/periods"
import type { PeriodKey } from "@/domain/primitives"
import type {
  MonthlyClosePreview,
  MonthlyCloseUseCasesPort,
  MonthlyHistoryItem,
} from "@/features/planning/application/monthly-close-use-cases"

function formatClp(value: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(value)
}

function formatMonth(periodKey: PeriodKey) {
  const [year, month] = periodKey.split("-").map(Number)
  const value = new Intl.DateTimeFormat("es-CL", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)))
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-CL", {
    dateStyle: "medium",
    timeZone: "America/Santiago",
  }).format(new Date(value))
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "No fue posible completar la acción."
}

const noop = () => undefined

function HistoryDetail({
  snapshot,
  onClose,
}: {
  readonly snapshot: PeriodSnapshot
  readonly onClose: () => void
}) {
  const { totals } = snapshot.data
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-[430px] overflow-y-auto rounded-t-xl pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader>
          <SheetTitle>{formatMonth(snapshot.periodKey)}</SheetTitle>
          <SheetDescription>
            Cerrado el {formatDate(snapshot.closedAt)}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-3 text-sm">
            <LockKeyhole aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p>
              Archivo inmutable validado con SHA-256. Sus cifras provienen del
              snapshot del cierre, no de los datos actuales.
            </p>
          </div>
          <Card>
            <CardContent className="space-y-4 pt-1">
              <div>
                <p className="text-xs text-muted-foreground">Disponible del mes</p>
                <p className="money-figure text-3xl font-semibold">
                  {formatClp(totals.availableAmount)}
                </p>
              </div>
              <Separator />
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><p className="text-xs text-muted-foreground">Ingresos</p><p className="money-figure font-semibold">{formatClp(totals.totalIncomeAmount)}</p></div>
                <div><p className="text-xs text-muted-foreground">Gastos variables</p><p className="money-figure font-semibold">{formatClp(totals.variableExpenseAmount)}</p></div>
                <div><p className="text-xs text-muted-foreground">Gastos fijos pagados</p><p className="money-figure font-semibold">{formatClp(totals.fixedExpensePaidAmount)}</p></div>
                <div><p className="text-xs text-muted-foreground">Gastos fijos impagos</p><p className="money-figure font-semibold">{formatClp(totals.fixedExpenseUnpaidAmount)}</p></div>
                <div><p className="text-xs text-muted-foreground">Pagos de deuda</p><p className="money-figure font-semibold">{formatClp(totals.debtPaymentAmount)}</p></div>
                <div><p className="text-xs text-muted-foreground">Ahorro neto</p><p className="money-figure font-semibold">{formatClp(totals.netSavingsAmount)}</p></div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">Contenido archivado</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 text-sm">
              <p>{snapshot.data.operations.length} operaciones</p>
              <p>{snapshot.data.movements.length} movimientos</p>
              <p>{snapshot.data.fixedExpenses.length} gastos fijos</p>
              <p>{snapshot.data.auditEvents.length} auditorías</p>
            </CardContent>
          </Card>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function MonthlyCloseSection({
  useCases,
  onClosed = noop,
}: {
  readonly useCases: MonthlyCloseUseCasesPort | null
  readonly onClosed?: () => void
}) {
  const [preview, setPreview] = useState<MonthlyClosePreview | null>(null)
  const [history, setHistory] = useState<MonthlyHistoryItem[]>([])
  const [historyDetail, setHistoryDetail] = useState<PeriodSnapshot | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [closing, setClosing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!useCases) return
    let active = true
    void Promise.all([
      useCases.getClosePreview(),
      useCases.listMonthlyHistory(),
    ])
      .then(([nextPreview, nextHistory]) => {
        if (active) {
          setPreview(nextPreview)
          setHistory(nextHistory)
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

  async function closeMonth() {
    if (!useCases) return
    setClosing(true)
    setError(null)
    try {
      await useCases.closeCurrentPeriod()
      setConfirming(false)
      setRefreshKey((value) => value + 1)
      onClosed()
    } catch (cause) {
      setError(message(cause))
      setConfirming(false)
    } finally {
      setClosing(false)
    }
  }

  async function openHistory(periodKey: PeriodKey) {
    if (!useCases) return
    setError(null)
    try {
      setHistoryDetail(await useCases.getMonthlyHistoryDetail(periodKey))
    } catch (cause) {
      setError(message(cause))
    }
  }

  if (loading && useCases) return <LoadingState label="Preparando cierre mensual" />

  return (
    <div className="space-y-6">
      {error ? <ErrorMessage title="No se pudo completar la acción" description={error} /> : null}
      <div className="space-y-3">
        <div><h2 className="text-lg font-semibold">Cierre mensual</h2><p className="text-sm text-muted-foreground">Sella el mes y continúa con el período siguiente.</p></div>
        {preview ? (
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div><CardTitle>{formatMonth(preview.period.periodKey)}</CardTitle><p className="mt-1 text-xs text-muted-foreground">Continuará en {formatMonth(preview.nextPeriodKey)}</p></div>
              <Badge variant={preview.blockers.length === 0 ? "secondary" : "destructive"}>{preview.blockers.length === 0 ? "Listo" : "Bloqueado"}</Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm"><div><p className="text-xs text-muted-foreground">Ingresos</p><p className="money-figure font-semibold">{formatClp(preview.summary.totalIncomeAmount)}</p></div><div><p className="text-xs text-muted-foreground">Disponible</p><p className="money-figure font-semibold">{formatClp(preview.summary.availableAmount)}</p></div></div>
              {preview.pendingFixedExpenses > 0 ? <p className="text-sm text-muted-foreground">{preview.pendingFixedExpenses} gasto(s) fijo(s) pendiente(s) quedarán como impagos en el archivo.</p> : null}
              {preview.blockers.length > 0 ? <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">{preview.blockers.map((blocker) => <p key={blocker} className="flex gap-2 text-sm"><TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />{blocker}</p>)}</div> : null}
              <Button type="button" size="lg" className="w-full" disabled={preview.blockers.length > 0 || closing} onClick={() => setConfirming(true)}><CalendarCheck aria-hidden="true" /> Cerrar {formatMonth(preview.period.periodKey)}</Button>
            </CardContent>
          </Card>
        ) : <EmptyState title="Cierre no disponible" description="Completa la configuración financiera y asegúrate de tener un período abierto." />}
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2"><History aria-hidden="true" className="size-5" /><h2 className="text-lg font-semibold">Historial</h2></div>
        {history.length === 0 ? <EmptyState title="Aún no hay meses cerrados" description="Cada cierre guardará aquí un snapshot histórico inmutable." /> : history.map((item) => <Card key={item.snapshotId}><CardContent className="flex items-center justify-between gap-3 pt-1"><div className="flex min-w-0 items-center gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Archive aria-hidden="true" className="size-5" /></div><div className="min-w-0"><p className="font-semibold">{formatMonth(item.periodKey)}</p><p className="truncate text-xs text-muted-foreground">Disponible {formatClp(item.totals.availableAmount)}</p></div></div><Button type="button" variant="ghost" size="icon-lg" aria-label={`Ver historial de ${formatMonth(item.periodKey)}`} onClick={() => void openHistory(item.periodKey)}><ChevronRight aria-hidden="true" /></Button></CardContent></Card>)}
      </div>

      {historyDetail ? <HistoryDetail snapshot={historyDetail} onClose={() => setHistoryDetail(null)} /> : null}
      <AlertDialog open={confirming} onOpenChange={(open) => !open && !closing && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogMedia><CalendarCheck /></AlertDialogMedia><AlertDialogTitle>Confirmar cierre mensual</AlertDialogTitle><AlertDialogDescription>Se archivará el período actual, los gastos fijos pendientes quedarán impagos y se abrirá el mes siguiente. El snapshot cerrado no podrá editarse.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={closing}>Cancelar</AlertDialogCancel><AlertDialogAction disabled={closing} onClick={() => void closeMonth()}>{closing ? "Cerrando…" : "Cerrar y continuar"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

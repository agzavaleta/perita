import { useEffect, useState } from "react"
import {
  BadgeDollarSign,
  CalendarDays,
  ChartNoAxesCombined,
  CircleDollarSign,
  HandCoins,
  PiggyBank,
  Plus,
  WalletCards,
  Clock3,
} from "lucide-react"

import type { AppSection } from "@/app/navigation"
import { EmptyState } from "@/components/states/EmptyState"
import { ErrorMessage } from "@/components/states/ErrorMessage"
import { LoadingState } from "@/components/states/LoadingState"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import {
  createHomeModule,
  type HomeModule,
} from "@/features/home/application/bootstrap"
import type {
  HomeDashboard,
  HomeUseCasesPort,
} from "@/features/home/application/home-use-cases"

interface HomePageProps {
  readonly useCases?: HomeUseCasesPort
  readonly onNavigate?: (section: AppSection) => void
}

const noop = () => undefined
const HOME_CARD_TITLE_CLASS =
  "text-money-label font-medium uppercase tracking-wide text-muted-foreground"
const HOME_SUMMARY_AMOUNT_CLASS =
  "money-figure mt-1 text-money-primary font-semibold text-foreground"
const HOME_SUMMARY_ICON_CLASS =
  "grid size-11 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand"
const HOME_SECTION_ICON_CLASS = "size-5 text-muted-foreground"

function formatClp(value: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(value)
}

function formatMonth(value: string) {
  const [year, month] = value.split("-").map(Number)
  const label = new Intl.DateTimeFormat("es-CL", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)))
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function formatCivilDate(value: string | null) {
  if (!value) return "Sin próximo pago"
  const [year, month, day] = value.split("-")
  return `Próximo pago ${day}-${month}-${year}`
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "No fue posible cargar Inicio."
}

function HomeHeading({ periodKey }: { readonly periodKey: string }) {
  return (
    <div className="flex flex-col items-start gap-2 min-[430px]:flex-row min-[430px]:justify-between min-[430px]:gap-3">
      <div>
        <h1 id="home-title" className="type-page-title">Inicio</h1>
        <p className="mt-1 whitespace-nowrap text-sm text-muted-foreground">Tu panorama financiero de un vistazo.</p>
      </div>
      <Badge variant="secondary" className="shrink-0">
        <CalendarDays aria-hidden="true" /> Abierto ·{" "}
        <span>{formatMonth(periodKey)}</span>
      </Badge>
    </div>
  )
}

export function HomePage({
  useCases: injectedUseCases,
  onNavigate = noop,
}: HomePageProps) {
  const [module, setModule] = useState<HomeModule | null>(null)
  const useCases = injectedUseCases ?? module?.useCases ?? null
  const [dashboard, setDashboard] = useState<HomeDashboard | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (injectedUseCases) return
    let active = true
    let createdModule: HomeModule | null = null
    void createHomeModule()
      .then((nextModule) => {
        createdModule = nextModule
        if (active) setModule(nextModule)
        else nextModule.dispose()
      })
      .catch((cause) => {
        if (active) setError(message(cause))
      })
    return () => {
      active = false
      createdModule?.dispose()
    }
  }, [injectedUseCases])

  useEffect(() => {
    if (!useCases) return
    let active = true
    void useCases
      .getDashboard()
      .then((nextDashboard) => {
        if (active) setDashboard(nextDashboard)
      })
      .catch((cause) => {
        if (active) setError(message(cause))
      })
    return () => { active = false }
  }, [useCases])

  if (error) {
    return (
      <section className="space-y-section py-section" aria-labelledby="home-title">
        <h1 id="home-title" className="type-page-title">Inicio</h1>
        <ErrorMessage title="No se pudo cargar Inicio" description={error} />
      </section>
    )
  }
  if (!dashboard) {
    return (
      <section className="space-y-section py-section" aria-labelledby="home-title">
        <h1 id="home-title" className="type-page-title">Inicio</h1>
        <LoadingState label="Cargando Inicio" />
      </section>
    )
  }

  const { summary } = dashboard
  if (dashboard.isEmpty) {
    return (
      <section className="space-y-6 py-section" aria-labelledby="home-title">
        <HomeHeading periodKey={dashboard.period.periodKey} />
        <EmptyState
          title="Tu Inicio está listo"
          description="Crea tu primera cuenta para comenzar a registrar movimientos."
        />
        <Button type="button" size="lg" className="w-full" onClick={() => onNavigate("accounts")}>
          <Plus aria-hidden="true" /> Crear cuenta
        </Button>
      </section>
    )
  }
  return (
    <section className="space-y-6 py-section" aria-labelledby="home-title">
      <HomeHeading periodKey={dashboard.period.periodKey} />

      <Card className="rounded-surface ring-border">
        <CardContent className="flex items-start justify-between gap-4 pt-1">
          <div className="min-w-0 flex-1">
            <h2 className={HOME_CARD_TITLE_CLASS}>Patrimonio neto</h2>
            <p className={HOME_SUMMARY_AMOUNT_CLASS}>{formatClp(dashboard.netWorth)}</p>
          </div>
          <div className={HOME_SUMMARY_ICON_CLASS}>
            <BadgeDollarSign aria-hidden="true" className="size-5" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-start justify-between gap-4 pt-1">
          <div className="min-w-0 flex-1">
            <h2 className={HOME_CARD_TITLE_CLASS}>Total en metas</h2>
            <p className={HOME_SUMMARY_AMOUNT_CLASS}>{formatClp(dashboard.totalSavingsBalance)}</p>
          </div>
          <div className={HOME_SUMMARY_ICON_CLASS}>
            <PiggyBank aria-hidden="true" className="size-5" />
          </div>
        </CardContent>
      </Card>

      <Card className="border-brand/25">
        <CardContent className="flex items-start justify-between gap-4 pt-1">
          <div className="min-w-0 flex-1">
            <h2 className={HOME_CARD_TITLE_CLASS}>Saldo disponible</h2>
            <p className={HOME_SUMMARY_AMOUNT_CLASS}>{formatClp(summary.availableAmount)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Después de gastos, deuda y ahorro del período.</p>
            <dl className="mt-4 grid grid-cols-2 gap-4 border-t pt-3">
              <div className="space-y-1">
                <dt className="text-money-label text-muted-foreground">Ingresos del período</dt>
                <dd className="money-figure text-money-secondary font-medium">{formatClp(summary.totalIncomeAmount)}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-money-label text-muted-foreground">Gastos del período</dt>
                <dd className="money-figure text-money-secondary font-medium">{formatClp(dashboard.periodExpenseAmount)}</dd>
              </div>
            </dl>
          </div>
          <div className={HOME_SUMMARY_ICON_CLASS}>
            <CircleDollarSign aria-hidden="true" className="size-5" />
          </div>
        </CardContent>
      </Card>

      {summary.plannedSalaryAmount > 0 && summary.receivedSalaryAmount === 0 ? (
        <Alert>
          <Clock3 aria-hidden="true" />
          <AlertTitle>Sueldo pendiente de recepción</AlertTitle>
          <AlertDescription>
            El período contempla {formatClp(summary.plannedSalaryAmount)}, pero todavía no existe un sueldo recibido vigente.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ChartNoAxesCombined aria-hidden="true" className={HOME_SECTION_ICON_CLASS} />
            <h2 className={HOME_CARD_TITLE_CLASS}>Así va tu mes</h2>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <section aria-label="Gastado este mes" className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">Gastado este mes</p>
              {dashboard.expenseToIncomePercent !== null ? (
                <span className="text-sm font-semibold tabular-nums">
                  {dashboard.expenseToIncomePercent}%
                </span>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground tabular-nums">
              {formatClp(dashboard.periodExpenseAmount)} de {formatClp(summary.totalIncomeAmount)}
            </p>
            {dashboard.expenseToIncomePercent !== null ? (
              <div
                role="progressbar"
                aria-label="Gasto respecto de ingresos"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.min(dashboard.expenseToIncomePercent, 100)}
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-destructive"
                  style={{ width: `${Math.min(dashboard.expenseToIncomePercent, 100)}%` }}
                />
              </div>
            ) : null}
          </section>

          <section
            aria-label={summary.netSavingsAmount >= 0 ? "Ahorro del período" : "Retirado de metas"}
            className="flex items-end justify-between gap-3 border-t pt-4"
          >
            <div>
              <p className="text-sm font-medium">
                {summary.netSavingsAmount >= 0 ? "Ahorro del período" : "Retirado de metas"}
              </p>
              <p className="money-figure mt-1 text-lg font-semibold">
                {formatClp(Math.abs(summary.netSavingsAmount))}
              </p>
            </div>
            {dashboard.savingsToIncomePercent !== null ? (
              <span className="text-right text-sm font-semibold tabular-nums">
                {dashboard.savingsToIncomePercent}% de los ingresos
              </span>
            ) : null}
          </section>
        </CardContent>
      </Card>

      {dashboard.relevantGoals.length > 0 ? (
        <Card>
          <CardHeader><div className="flex items-center gap-2"><PiggyBank aria-hidden="true" className={HOME_SECTION_ICON_CLASS} /><h2 className={HOME_CARD_TITLE_CLASS}>Metas de ahorro</h2></div></CardHeader>
          <CardContent className="space-y-4">
            {dashboard.relevantGoals.map(({ goal, progressPercent }) => (
              <div key={goal.id} className="space-y-2">
                <div className="flex items-center justify-between gap-3 text-sm"><span className="truncate font-medium">{goal.name}</span><span className="money-figure shrink-0">{formatClp(goal.currentBalance)}</span></div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Progreso</span>
                  <span className="font-medium tabular-nums">{progressPercent}%</span>
                </div>
                <div role="progressbar" aria-label={`Progreso de ${goal.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent} className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-brand" style={{ width: `${progressPercent}%` }} /></div>
              </div>
            ))}
            <div className="border-t pt-4">
              <p className="text-sm font-medium text-muted-foreground">Total ahorrado</p>
              <p className="money-figure mt-1 text-2xl font-semibold">{formatClp(dashboard.totalSavingsBalance)}</p>
              {summary.netSavingsAmount > 0 ? (
                <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                  <span className="text-muted-foreground">Ahorrado este período</span>
                  <span className="money-figure font-semibold text-primary">{formatClp(summary.netSavingsAmount)}</span>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2"><WalletCards aria-hidden="true" className={HOME_SECTION_ICON_CLASS} /><h2 className={HOME_CARD_TITLE_CLASS}>Cuentas</h2></div>
        </CardHeader>
        <CardContent className="space-y-3">
          {dashboard.accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay cuentas activas.</p>
          ) : dashboard.accounts.map((account, index) => (
            <div key={account.id}>
              {index > 0 ? <Separator className="mb-3" /> : null}
              <div className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0"><p className="truncate font-medium">{account.name}</p><p className="truncate text-xs text-muted-foreground">{account.bank ?? "Sin institución"}</p></div>
                <p className="money-figure shrink-0 font-semibold">{formatClp(account.currentBalance)}</p>
              </div>
            </div>
          ))}
          <div className="flex justify-between border-t pt-3 text-sm"><span className="text-muted-foreground">Total en cuentas</span><span className="money-figure font-semibold">{formatClp(dashboard.totalAccountBalance)}</span></div>
        </CardContent>
      </Card>

      {dashboard.activeDebts.length > 0 ? (
        <Card>
          <CardHeader><div className="flex items-center gap-2"><HandCoins aria-hidden="true" className={HOME_SECTION_ICON_CLASS} /><h2 className={HOME_CARD_TITLE_CLASS}>Deudas</h2></div></CardHeader>
          <CardContent className="space-y-3">
            {dashboard.activeDebts.map(
              ({ debt, schedule, progressPercent }, index) => (
                <div key={debt.id} className="space-y-2">
                  {index > 0 ? <Separator className="mb-3" /> : null}
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{debt.name}</p><p className="text-xs text-muted-foreground">{formatCivilDate(schedule.nextPaymentDate)}</p></div><div className="text-right"><p className="money-figure text-sm font-semibold">{formatClp(debt.outstandingAmount)}</p>{debt.paymentStatus === "overdue" ? <Badge variant="destructive" className="mt-1">Atrasada</Badge> : null}</div></div>
                  <div
                    role="progressbar"
                    aria-label={`Progreso de deuda ${debt.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progressPercent}
                    className="h-2 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                </div>
              ),
            )}
          </CardContent>
        </Card>
      ) : null}

    </section>
  )
}

import { useEffect, useState } from "react"
import {
  ArrowRight,
  CalendarDays,
  CircleDollarSign,
  HandCoins,
  PiggyBank,
  Plus,
  Target,
  WalletCards,
  Clock3,
} from "lucide-react"

import type { AppSection } from "@/app/navigation"
import { FinancialSummary } from "@/components/finance/FinancialSummary"
import { EmptyState } from "@/components/states/EmptyState"
import { ErrorMessage } from "@/components/states/ErrorMessage"
import { LoadingState } from "@/components/states/LoadingState"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
  readonly onRegisterIncome?: () => void
}

const noop = () => undefined

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
    <div className="flex flex-col items-start gap-2 min-[360px]:flex-row min-[360px]:justify-between min-[360px]:gap-3">
      <div>
        <h1 id="home-title" className="type-page-title">Inicio</h1>
        <p className="mt-1 text-sm text-muted-foreground">Tu panorama financiero de un vistazo.</p>
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
  onRegisterIncome = noop,
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
  const activeAccountCount = dashboard.accounts.length
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

      <FinancialSummary
        title="Tu dinero"
        amountLabel="Saldo total"
        amount={formatClp(dashboard.totalBalance)}
        items={[
          { label: "Ingresos del período", value: formatClp(summary.totalIncomeAmount) },
          { label: "Gastos del período", value: formatClp(dashboard.periodExpenseAmount) },
        ]}
      />

      {summary.plannedSalaryAmount > 0 && summary.receivedSalaryAmount === 0 ? (
        <Alert>
          <Clock3 aria-hidden="true" />
          <AlertTitle>Sueldo pendiente de recepción</AlertTitle>
          <AlertDescription>
            El período contempla {formatClp(summary.plannedSalaryAmount)}, pero todavía no existe un sueldo recibido vigente.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="border-brand/25">
        <CardContent className="flex items-center justify-between gap-4 pt-1">
          <div>
            <p className="text-money-label font-medium uppercase tracking-wide text-muted-foreground">Saldo disponible</p>
            <p className="money-figure mt-1 text-2xl font-semibold">{formatClp(summary.availableAmount)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Después de gastos, deuda y ahorro del período.</p>
          </div>
          <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
            <CircleDollarSign aria-hidden="true" className="size-5" />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2">
        {activeAccountCount > 0 && summary.totalIncomeAmount === 0 ? (
          <Button type="button" size="lg" onClick={onRegisterIncome}>
            <Plus aria-hidden="true" /> Registrar ingreso
          </Button>
        ) : (
          <Button type="button" size="lg" variant="outline" onClick={() => onNavigate("movements")}>
            Ver movimientos <ArrowRight aria-hidden="true" />
          </Button>
        )}
        <Button type="button" size="lg" variant="outline" onClick={() => onNavigate("planning")}>
          Planificar <ArrowRight aria-hidden="true" />
        </Button>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2"><WalletCards aria-hidden="true" className="size-5 text-muted-foreground" /><CardTitle className="text-base">Cuentas</CardTitle></div>
          <Button type="button" variant="ghost" size="sm" onClick={() => onNavigate("accounts")}>Ver todas</Button>
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

      {dashboard.relevantGoals.length > 0 ? (
        <Card>
          <CardHeader><div className="flex items-center gap-2"><PiggyBank aria-hidden="true" className="size-5 text-muted-foreground" /><CardTitle className="text-base">Metas relevantes</CardTitle></div></CardHeader>
          <CardContent className="space-y-4">
            {dashboard.relevantGoals.map(({ goal, progressPercent }) => (
              <div key={goal.id} className="space-y-2">
                <div className="flex items-center justify-between gap-3 text-sm"><span className="truncate font-medium">{goal.name}</span><span className="money-figure shrink-0">{formatClp(goal.currentBalance)}</span></div>
                <div role="progressbar" aria-label={`Progreso de ${goal.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent} className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-brand" style={{ width: `${progressPercent}%` }} /></div>
              </div>
            ))}
            <div className="flex justify-between border-t pt-3 text-sm"><span className="text-muted-foreground">Total ahorrado</span><span className="money-figure font-semibold">{formatClp(dashboard.totalSavingsBalance)}</span></div>
          </CardContent>
        </Card>
      ) : null}

      {dashboard.relevantDebts.length > 0 ? (
        <Card>
          <CardHeader><div className="flex items-center gap-2"><HandCoins aria-hidden="true" className="size-5 text-muted-foreground" /><CardTitle className="text-base">Deudas relevantes</CardTitle></div></CardHeader>
          <CardContent className="space-y-3">
            {dashboard.relevantDebts.map(({ debt, schedule }, index) => (
              <div key={debt.id}>
                {index > 0 ? <Separator className="mb-3" /> : null}
                <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{debt.name}</p><p className="text-xs text-muted-foreground">{formatCivilDate(schedule.nextPaymentDate)}</p></div><div className="text-right"><p className="money-figure text-sm font-semibold">{formatClp(debt.outstandingAmount)}</p>{debt.paymentStatus === "overdue" ? <Badge variant="destructive" className="mt-1">Atrasada</Badge> : null}</div></div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {dashboard.relevantGoals.length === 0 && dashboard.relevantDebts.length === 0 ? (
        <Button type="button" variant="outline" className="w-full" onClick={() => onNavigate("planning")}>
          <Target aria-hidden="true" /> Crear una meta o deuda
        </Button>
      ) : null}
    </section>
  )
}

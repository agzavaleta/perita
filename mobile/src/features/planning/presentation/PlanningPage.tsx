import { lazy, Suspense, useEffect, useState } from "react"
import {
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  CalendarCheck,
  CalendarClock,
  ChevronRight,
  CircleDollarSign,
  CircleOff,
  Pencil,
  PiggyBank,
  Plus,
  ReceiptText,
  Trash2,
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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { SavingsGoal } from "@/domain/entities"
import type {
  Operation,
  SavingsDepositOperation,
  SavingsWithdrawalOperation,
} from "@/domain/operations"
import type { EntityId } from "@/domain/primitives"
import type { MovementUseCasesPort } from "@/features/movements/application/movement-use-cases"
import {
  SavingsMovementForm,
  type SavingsMovementMode,
} from "@/features/movements/presentation/SavingsMovementForm"
import {
  createPlanningModule,
  type PlanningModule,
} from "@/features/planning/application/bootstrap"
import type {
  FixedExpenseListItem,
  PlanningUseCasesPort,
  SavingsGoalDetail,
} from "@/features/planning/application/planning-use-cases"
import type { DebtUseCasesPort } from "@/features/planning/application/debt-use-cases"
import type { MonthlyCloseUseCasesPort } from "@/features/planning/application/monthly-close-use-cases"
import { savingsGoalProgressPercent } from "@/features/planning/application/planning-use-cases"
import {
  FixedExpenseForm,
  type FixedExpenseEditor,
} from "@/features/planning/presentation/FixedExpenseForm"
import { FixedExpensePaymentForm } from "@/features/planning/presentation/FixedExpensePaymentForm"
import { SavingsGoalForm } from "@/features/planning/presentation/SavingsGoalForm"
import { toast } from "sonner"

interface PlanningPageProps {
  readonly useCases?: PlanningUseCasesPort
  readonly movementUseCases?: MovementUseCasesPort
  readonly debtUseCases?: DebtUseCasesPort
  readonly monthlyCloseUseCases?: MonthlyCloseUseCasesPort
  readonly onMoveMoney?: () => void
}

const noop = () => undefined

const DebtSection = lazy(() =>
  import("@/features/planning/presentation/DebtSection").then((module) => ({
    default: module.DebtSection,
  })),
)
const MonthlyCloseSection = lazy(() =>
  import("@/features/planning/presentation/MonthlyCloseSection").then((module) => ({
    default: module.MonthlyCloseSection,
  })),
)

function formatClp(value: number, signed = false) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
    signDisplay: signed ? "always" : "auto",
  }).format(value)
}

function formatDate(value: string) {
  const [year, month, day] = value.split("-")
  return `${day}-${month}-${year}`
}

function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No fue posible completar la acción."
}

function savingsMovementTitle(operation: Operation) {
  switch (operation.type) {
    case "savings_deposit":
      return "Depósito"
    case "savings_withdrawal":
      return "Retiro"
    case "transfer":
      return "Mover dinero"
    case "balance_adjustment":
      return "Ajuste de saldo"
    default:
      return "Movimiento"
  }
}

function savingsMovementConcept(operation: Operation) {
  switch (operation.type) {
    case "savings_deposit":
    case "savings_withdrawal":
    case "transfer":
      return operation.details.concept
    case "balance_adjustment":
      return operation.details.reason
    default:
      return null
  }
}

type EditableSavingsOperation =
  | SavingsDepositOperation
  | SavingsWithdrawalOperation

function isEditableSavingsOperation(
  operation: Operation,
): operation is EditableSavingsOperation {
  return (
    operation.type === "savings_deposit" ||
    operation.type === "savings_withdrawal"
  )
}

function Progress({ goal }: { readonly goal: SavingsGoal }) {
  const percent = savingsGoalProgressPercent(goal)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{formatClp(goal.currentBalance)}</span>
        <span>{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={`Progreso de ${goal.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-brand transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-right text-xs text-muted-foreground">
        Objetivo {formatClp(goal.targetAmount)}
      </p>
    </div>
  )
}

function GoalCard({
  goal,
  onOpen,
}: {
  readonly goal: SavingsGoal
  readonly onOpen: () => void
}) {
  return (
    <Card className={goal.lifecycleStatus === "closed" ? "opacity-65" : undefined}>
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-2xl"
            role="img"
            aria-label={`Emoji de ${goal.name}`}
          >
            {goal.emoji}
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate">{goal.name}</CardTitle>
            <CardDescription className="truncate">
              {goal.bank ?? "Sin institución"}
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <Badge variant={goal.lifecycleStatus === "active" ? "secondary" : "outline"}>
            {goal.lifecycleStatus === "active" ? "Activa" : "Cerrada"}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <Progress goal={goal} />
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            aria-label={`Ver detalle de ${goal.name}`}
            onClick={onOpen}
          >
            <ChevronRight aria-hidden="true" className="size-5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function FixedExpenseCard({
  item,
  onOpen,
}: {
  readonly item: FixedExpenseListItem
  readonly onOpen: () => void
}) {
  const { template, currentInstance } = item
  return (
    <Card className={template.status === "inactive" ? "opacity-65" : undefined}>
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <CalendarClock aria-hidden="true" className="size-5" />
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate">{template.name}</CardTitle>
            <CardDescription>
              Referencia {formatClp(template.referenceAmount)}
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <Badge variant={template.status === "active" ? "secondary" : "outline"}>
            {template.status === "active" ? "Activo" : "Inactivo"}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">Plan del período</p>
          <p className="money-figure text-lg font-semibold">
            {currentInstance ? formatClp(currentInstance.plannedAmount) : "Sin instancia"}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-label={`Ver detalle de ${template.name}`}
          onClick={onOpen}
        >
          <ChevronRight aria-hidden="true" className="size-5" />
        </Button>
      </CardContent>
    </Card>
  )
}

function GoalDetailSheet({
  detail,
  onClose,
  onEdit,
  onDeposit,
  onWithdraw,
  onMoveMoney,
  onRequestClose,
  onRequestDelete,
  openPeriodId,
  onEditSavingsMovement,
  onVoidSavingsMovement,
}: {
  readonly detail: SavingsGoalDetail
  readonly onClose: () => void
  readonly onEdit: () => void
  readonly onDeposit: () => void
  readonly onWithdraw: () => void
  readonly onMoveMoney: () => void
  readonly onRequestClose: () => void
  readonly onRequestDelete: () => void
  readonly openPeriodId: EntityId | null
  readonly onEditSavingsMovement: (operation: EditableSavingsOperation) => void
  readonly onVoidSavingsMovement: (operation: EditableSavingsOperation) => void
}) {
  const { goal } = detail
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-[430px] rounded-t-xl"
      >
        <SheetHeader>
          <SheetTitle className="flex min-w-0 items-center gap-2">
            <span role="img" aria-label={`Emoji de ${goal.name}`}>
              {goal.emoji}
            </span>
            <span className="min-w-0 break-words">{goal.name}</span>
          </SheetTitle>
          <SheetDescription>
            {goal.lifecycleStatus === "active" ? "Meta activa" : "Meta cerrada"}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <Card>
            <CardContent className="space-y-4 pt-1">
              <Progress goal={goal} />
              <Separator />
              <dl className="grid grid-cols-1 gap-3 text-sm min-[360px]:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Saldo</dt>
                  <dd className="money-figure font-semibold">
                    {formatClp(goal.currentBalance)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Aporte mensual</dt>
                  <dd>{formatClp(goal.plannedMonthlyAmount)}</dd>
                </div>
                <div className="min-[360px]:col-span-2">
                  <dt className="text-muted-foreground">Banco o institución</dt>
                  <dd>{goal.bank ?? "Sin institución"}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          {goal.lifecycleStatus === "active" ? (
            <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
              <Button type="button" size="lg" onClick={onDeposit}>
                <ArrowDownToLine aria-hidden="true" /> Depositar
              </Button>
              <Button type="button" variant="outline" size="lg" onClick={onWithdraw}>
                <ArrowUpFromLine aria-hidden="true" /> Retirar
              </Button>
              <Button type="button" variant="outline" size="lg" onClick={onMoveMoney}>
                <ArrowRightLeft aria-hidden="true" /> Mover dinero
              </Button>
              <Button type="button" variant="outline" size="lg" onClick={onEdit}>
                <Pencil aria-hidden="true" /> Editar
              </Button>
            </div>
          ) : null}

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Movimientos relacionados</h3>
            {detail.relatedMovements.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aún no hay aportes o retiros para esta meta.
              </p>
            ) : (
              detail.relatedMovements.map(({ operation, movement }) => {
                const canChange =
                  goal.lifecycleStatus === "active" &&
                  isEditableSavingsOperation(operation) &&
                  operation.status === "posted" &&
                  operation.periodId === openPeriodId
                const title = savingsMovementTitle(operation)
                return (
                <div
                  key={movement.id}
                  className="space-y-2 border-b py-2 text-sm last:border-b-0"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p>{title}</p>
                      {savingsMovementConcept(operation) ? (
                        <p className="text-xs text-muted-foreground">
                          {savingsMovementConcept(operation)}
                        </p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        {formatDate(operation.operationDate)}
                        {operation.status === "voided" ? " · Anulado" : ""}
                      </p>
                    </div>
                    <p className="money-figure font-medium">
                      {formatClp(movement.delta, true)}
                    </p>
                  </div>
                  {canChange ? (
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Editar ${title.toLowerCase()}`}
                        onClick={() => onEditSavingsMovement(operation)}
                      >
                        <Pencil aria-hidden="true" /> Editar
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Anular ${title.toLowerCase()}`}
                        onClick={() => onVoidSavingsMovement(operation)}
                      >
                        <Trash2 aria-hidden="true" /> Anular
                      </Button>
                    </div>
                  ) : null}
                </div>
                )
              })
            )}
          </div>

          {goal.lifecycleStatus === "active" ? (
            detail.canDelete ? (
              <Button
                type="button"
                variant="destructive"
                className="w-full"
                onClick={onRequestDelete}
              >
                <Trash2 aria-hidden="true" /> Eliminar meta
              </Button>
            ) : goal.currentBalance === 0 ? (
              <Button
                type="button"
                variant="destructive"
                className="w-full"
                onClick={onRequestClose}
              >
                <CircleOff aria-hidden="true" /> Cerrar meta
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                Para cerrar esta meta, primero mueve todo su saldo a otro fondo.
              </p>
            )
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function FixedExpenseDetailSheet({
  item,
  onClose,
  onEditTemplate,
  onEditPlan,
  onPay,
  onDeactivate,
}: {
  readonly item: FixedExpenseListItem
  readonly onClose: () => void
  readonly onEditTemplate: () => void
  readonly onEditPlan: () => void
  readonly onPay?: () => void
  readonly onDeactivate: () => void
}) {
  const { template, currentInstance } = item
  const instanceStatus =
    currentInstance?.status === "paid"
      ? "Pagado"
      : currentInstance?.status === "unpaid"
        ? "No pagado"
        : "Pendiente"
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-[430px] rounded-t-xl"
      >
        <SheetHeader>
          <SheetTitle>{template.name}</SheetTitle>
          <SheetDescription>
            Gasto fijo {template.status === "active" ? "activo" : "inactivo"}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <Card>
            <CardContent className="space-y-3 pt-1">
              <dl className="grid grid-cols-1 gap-3 text-sm min-[360px]:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Referencia</dt>
                  <dd className="money-figure font-semibold">
                    {formatClp(template.referenceAmount)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Plan del período</dt>
                  <dd className="money-figure font-semibold">
                    {currentInstance
                      ? formatClp(currentInstance.plannedAmount)
                      : "Sin instancia"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Estado del período</dt>
                  <dd>{currentInstance ? instanceStatus : "No disponible"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Revisión</dt>
                  <dd>{template.revision}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">
            Esta información no programa pagos ni genera movimientos automáticamente.
          </p>
          <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
            {template.status === "active" ? (
              <Button type="button" variant="outline" size="lg" onClick={onEditTemplate}>
                <Pencil aria-hidden="true" /> Editar referencia
              </Button>
            ) : null}
            {currentInstance?.status === "pending" ? (
              <Button type="button" variant="outline" size="lg" onClick={onEditPlan}>
                <CalendarClock aria-hidden="true" /> Editar período
              </Button>
            ) : null}
          </div>
          {currentInstance?.status === "pending" && onPay ? (
            <Button type="button" className="w-full" onClick={onPay}>
              <CircleDollarSign aria-hidden="true" /> Registrar pago
            </Button>
          ) : null}
          {template.status === "active" ? (
            <Button
              type="button"
              variant="destructive"
              className="w-full"
              onClick={onDeactivate}
            >
              <CircleOff aria-hidden="true" /> Desactivar gasto fijo
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function PlanningPage({
  useCases: injectedUseCases,
  movementUseCases: injectedMovementUseCases,
  debtUseCases: injectedDebtUseCases,
  monthlyCloseUseCases: injectedMonthlyCloseUseCases,
  onMoveMoney = noop,
}: PlanningPageProps) {
  const [module, setModule] = useState<PlanningModule | null>(null)
  const useCases = injectedUseCases ?? module?.useCases ?? null
  const movementUseCases =
    injectedMovementUseCases ?? module?.movementUseCases ?? null
  const debtUseCases = injectedDebtUseCases ?? module?.debtUseCases ?? null
  const monthlyCloseUseCases =
    injectedMonthlyCloseUseCases ?? module?.monthlyCloseUseCases ?? null
  const [goals, setGoals] = useState<SavingsGoal[]>([])
  const [fixedExpenses, setFixedExpenses] = useState<FixedExpenseListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [goalEditor, setGoalEditor] = useState<SavingsGoal | "new" | null>(null)
  const [goalDetail, setGoalDetail] = useState<SavingsGoalDetail | null>(null)
  const [savingsMovementTarget, setSavingsMovementTarget] = useState<{
    readonly goal: SavingsGoal
    readonly mode: SavingsMovementMode
    readonly operation?: EditableSavingsOperation
  } | null>(null)
  const [openPeriodId, setOpenPeriodId] = useState<EntityId | null>(null)
  const [voidSavingsTarget, setVoidSavingsTarget] = useState<{
    readonly goal: SavingsGoal
    readonly operation: EditableSavingsOperation
  } | null>(null)
  const [voidingSavings, setVoidingSavings] = useState(false)
  const [voidSavingsError, setVoidSavingsError] = useState<string | null>(null)
  const [closeTarget, setCloseTarget] = useState<SavingsGoal | null>(null)
  const [deleteGoalTarget, setDeleteGoalTarget] = useState<SavingsGoal | null>(null)
  const [fixedEditor, setFixedEditor] = useState<FixedExpenseEditor | null>(null)
  const [fixedDetail, setFixedDetail] = useState<FixedExpenseListItem | null>(null)
  const [fixedPaymentTarget, setFixedPaymentTarget] =
    useState<FixedExpenseListItem | null>(null)
  const [deactivateTarget, setDeactivateTarget] =
    useState<FixedExpenseListItem | null>(null)

  useEffect(() => {
    if (injectedUseCases) return
    let active = true
    let createdModule: PlanningModule | null = null
    void createPlanningModule()
      .then((nextModule) => {
        createdModule = nextModule
        if (active) setModule(nextModule)
        else nextModule.dispose()
      })
      .catch((cause) => {
        if (active) {
          setError(message(cause))
          setLoading(false)
        }
      })
    return () => {
      active = false
      createdModule?.dispose()
    }
  }, [injectedUseCases])

  useEffect(() => {
    if (!useCases) return
    let active = true
    void Promise.all([
      useCases.listSavingsGoals(),
      useCases.listFixedExpenses(),
    ])
      .then(([nextGoals, nextFixedExpenses]) => {
        if (active) {
          setGoals(nextGoals)
          setFixedExpenses(nextFixedExpenses)
          setLoading(false)
        }
      })
      .catch((cause) => {
        if (active) {
          setError(message(cause))
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [refreshKey, useCases])

  useEffect(() => {
    if (!movementUseCases) return
    let active = true
    void movementUseCases
      .getOpenPeriodId()
      .then((periodId) => {
        if (active) setOpenPeriodId(periodId)
      })
      .catch((cause) => {
        if (active) setError(message(cause))
      })
    return () => {
      active = false
    }
  }, [movementUseCases, refreshKey])

  function saved() {
    setError(null)
    setGoalEditor(null)
    setGoalDetail(null)
    setSavingsMovementTarget(null)
    setFixedEditor(null)
    setFixedDetail(null)
    setFixedPaymentTarget(null)
    setRefreshKey((value) => value + 1)
  }

  async function openGoal(goal: SavingsGoal) {
    if (!useCases) return
    setError(null)
    try {
      setGoalDetail(await useCases.getSavingsGoalDetail(goal.id))
    } catch (cause) {
      setError(message(cause))
    }
  }

  async function refreshGoalAfterSavingsMovement(goalId: SavingsGoal["id"]) {
    if (!useCases) return
    setSavingsMovementTarget(null)
    setRefreshKey((value) => value + 1)
    try {
      setGoalDetail(await useCases.getSavingsGoalDetail(goalId))
    } catch (cause) {
      setError(message(cause))
    }
  }

  async function confirmCloseGoal() {
    if (!useCases || !closeTarget) return
    try {
      await useCases.closeSavingsGoal(closeTarget.id, closeTarget.revision)
      toast.success("Meta cerrada")
      saved()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setCloseTarget(null)
    }
  }

  async function confirmDeleteGoal() {
    if (!useCases || !deleteGoalTarget) return
    try {
      await useCases.deleteSavingsGoal(
        deleteGoalTarget.id,
        deleteGoalTarget.revision,
      )
      toast.success("Meta eliminada")
      saved()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setDeleteGoalTarget(null)
    }
  }

  async function confirmVoidSavingsMovement() {
    if (!movementUseCases || !voidSavingsTarget || voidingSavings) return
    setVoidingSavings(true)
    setError(null)
    setVoidSavingsError(null)
    try {
      await movementUseCases.voidSavingsMovement({
        operationId: voidSavingsTarget.operation.id,
        expectedRevision: voidSavingsTarget.operation.revision,
      })
      toast.success("Movimiento anulado")
      const goalId = voidSavingsTarget.goal.id
      setVoidSavingsTarget(null)
      await refreshGoalAfterSavingsMovement(goalId)
    } catch (cause) {
      setVoidSavingsError(message(cause))
    } finally {
      setVoidingSavings(false)
    }
  }

  async function confirmDeactivate() {
    if (!useCases || !deactivateTarget) return
    try {
      await useCases.deactivateFixedExpense(
        deactivateTarget.template.id,
        deactivateTarget.template.revision,
      )
      toast.success("Gasto fijo desactivado")
      saved()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setDeactivateTarget(null)
    }
  }

  return (
    <section className="space-y-section py-section" aria-labelledby="planning-title">
      <div>
        <h1 id="planning-title" className="type-page-title">Planificar</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Metas, gastos fijos, deudas y cierre del período.
        </p>
      </div>

      {error ? (
        <ErrorMessage title="No se pudo completar la acción" description={error} />
      ) : null}

      <Tabs defaultValue="goals">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="goals">
            <PiggyBank aria-hidden="true" /> Metas
          </TabsTrigger>
          <TabsTrigger value="fixed">
            <CalendarClock aria-hidden="true" /> Fijos
          </TabsTrigger>
          <TabsTrigger value="debts">
            <ReceiptText aria-hidden="true" /> Deudas
          </TabsTrigger>
          <TabsTrigger value="close">
            <CalendarCheck aria-hidden="true" /> Cierre
          </TabsTrigger>
        </TabsList>

        <TabsContent value="goals" className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Metas de ahorro</h2>
              <p className="text-sm text-muted-foreground">Ahorra con un objetivo claro.</p>
            </div>
            <Button
              type="button"
              size="lg"
              onClick={() => setGoalEditor("new")}
              disabled={!useCases}
            >
              <Plus aria-hidden="true" /> Nueva
            </Button>
          </div>
          {loading ? (
            <LoadingState label="Cargando planificación" />
          ) : goals.length === 0 ? (
            <EmptyState
              title="Aún no tienes metas"
              description="Crea una meta para comenzar a registrar tu ahorro."
            />
          ) : (
            <div className="space-y-3">
              {goals.map((goal) => (
                <GoalCard key={goal.id} goal={goal} onOpen={() => void openGoal(goal)} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="fixed" className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Gastos fijos</h2>
              <p className="text-sm text-muted-foreground">Referencias persistentes del mes.</p>
            </div>
            <Button
              type="button"
              size="lg"
              onClick={() => setFixedEditor({ mode: "template" })}
              disabled={!useCases}
            >
              <Plus aria-hidden="true" /> Nuevo
            </Button>
          </div>
          {loading ? (
            <LoadingState label="Cargando gastos fijos" />
          ) : fixedExpenses.length === 0 ? (
            <EmptyState
              title="Aún no tienes gastos fijos"
              description="Agrega referencias de planificación sin automatizar pagos."
            />
          ) : (
            <div className="space-y-3">
              {fixedExpenses.map((item) => (
                <FixedExpenseCard
                  key={item.template.id}
                  item={item}
                  onOpen={() => setFixedDetail(item)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="debts">
          <Suspense fallback={<LoadingState label="Cargando deudas" />}>
            <DebtSection useCases={debtUseCases} />
          </Suspense>
        </TabsContent>

        <TabsContent value="close">
          <Suspense fallback={<LoadingState label="Cargando cierre mensual" />}>
            <MonthlyCloseSection
              useCases={monthlyCloseUseCases}
              onClosed={() => setRefreshKey((value) => value + 1)}
            />
          </Suspense>
        </TabsContent>
      </Tabs>

      {goalEditor && useCases ? (
        <SavingsGoalForm
          key={goalEditor === "new" ? "new-goal" : goalEditor.id}
          goal={goalEditor === "new" ? undefined : goalEditor}
          useCases={useCases}
          onSaved={saved}
          onClose={() => setGoalEditor(null)}
        />
      ) : null}
      {goalDetail && !goalEditor ? (
        <GoalDetailSheet
          detail={goalDetail}
          onClose={() => setGoalDetail(null)}
          onEdit={() => {
            setGoalEditor(goalDetail.goal)
            setGoalDetail(null)
          }}
          onDeposit={() => {
            setSavingsMovementTarget({ goal: goalDetail.goal, mode: "deposit" })
            setGoalDetail(null)
          }}
          onWithdraw={() => {
            setSavingsMovementTarget({ goal: goalDetail.goal, mode: "withdrawal" })
            setGoalDetail(null)
          }}
          onMoveMoney={() => {
            setGoalDetail(null)
            onMoveMoney()
          }}
          onRequestClose={() => setCloseTarget(goalDetail.goal)}
          onRequestDelete={() => setDeleteGoalTarget(goalDetail.goal)}
          openPeriodId={openPeriodId}
          onEditSavingsMovement={(operation) => {
            setSavingsMovementTarget({
              goal: goalDetail.goal,
              mode:
                operation.type === "savings_deposit" ? "deposit" : "withdrawal",
              operation,
            })
            setGoalDetail(null)
          }}
          onVoidSavingsMovement={(operation) => {
            setVoidSavingsError(null)
            setVoidSavingsTarget({ goal: goalDetail.goal, operation })
          }}
        />
      ) : null}
      {savingsMovementTarget && movementUseCases ? (
        <SavingsMovementForm
          key={`${savingsMovementTarget.mode}-${savingsMovementTarget.goal.id}`}
          goal={savingsMovementTarget.goal}
          mode={savingsMovementTarget.mode}
          operation={savingsMovementTarget.operation}
          useCases={movementUseCases}
          onSaved={() => {
            void refreshGoalAfterSavingsMovement(savingsMovementTarget.goal.id)
          }}
          onClose={() => {
            const goal = savingsMovementTarget.goal
            setSavingsMovementTarget(null)
            void openGoal(goal)
          }}
        />
      ) : null}

      {voidSavingsTarget ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !voidingSavings) setVoidSavingsTarget(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <Trash2 aria-hidden="true" />
              </AlertDialogMedia>
              <AlertDialogTitle>
                {voidSavingsTarget.operation.type === "savings_deposit"
                  ? "Anular depósito"
                  : "Anular retiro"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                Se revertirá su impacto en el saldo de la meta. Esta acción quedará
                registrada en el historial.
              </AlertDialogDescription>
              {voidSavingsError ? (
                <ErrorMessage
                  title="No se pudo anular"
                  description={voidSavingsError}
                />
              ) : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={voidingSavings}>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                disabled={voidingSavings}
                onClick={(event) => {
                  event.preventDefault()
                  void confirmVoidSavingsMovement()
                }}
              >
                {voidingSavings ? "Anulando…" : "Anular movimiento"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

      {fixedEditor && useCases ? (
        <FixedExpenseForm
          key={`${fixedEditor.mode}-${fixedEditor.item?.template.id ?? "new"}`}
          editor={fixedEditor}
          useCases={useCases}
          onSaved={saved}
          onClose={() => setFixedEditor(null)}
        />
      ) : null}
      {fixedDetail && !fixedEditor ? (
        <FixedExpenseDetailSheet
          item={fixedDetail}
          onClose={() => setFixedDetail(null)}
          onEditTemplate={() => {
            setFixedEditor({ item: fixedDetail, mode: "template" })
            setFixedDetail(null)
          }}
          onEditPlan={() => {
            setFixedEditor({ item: fixedDetail, mode: "instance" })
            setFixedDetail(null)
          }}
          onPay={
            movementUseCases
              ? () => {
                  setFixedPaymentTarget(fixedDetail)
                  setFixedDetail(null)
                }
              : undefined
          }
          onDeactivate={() => setDeactivateTarget(fixedDetail)}
        />
      ) : null}
      {fixedPaymentTarget && movementUseCases ? (
        <FixedExpensePaymentForm
          item={fixedPaymentTarget}
          useCases={movementUseCases}
          onSaved={saved}
          onClose={() => setFixedPaymentTarget(null)}
        />
      ) : null}

      <AlertDialog
        open={closeTarget !== null}
        onOpenChange={(open) => !open && setCloseTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia><CircleOff /></AlertDialogMedia>
            <AlertDialogTitle>Cerrar meta</AlertDialogTitle>
            <AlertDialogDescription>
              La meta quedará histórica y no podrá reabrirse ni editarse.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmCloseGoal()}>
              Cerrar meta
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteGoalTarget !== null}
        onOpenChange={(open) => !open && setDeleteGoalTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia><Trash2 aria-hidden="true" /></AlertDialogMedia>
            <AlertDialogTitle>¿Eliminar meta?</AlertDialogTitle>
            <AlertDialogDescription>
              Se eliminará definitivamente porque todavía no tiene actividad financiera.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void confirmDeleteGoal()}
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deactivateTarget !== null}
        onOpenChange={(open) => !open && setDeactivateTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia><CircleOff /></AlertDialogMedia>
            <AlertDialogTitle>Desactivar gasto fijo</AlertDialogTitle>
            <AlertDialogDescription>
              La instancia del período conservará su nombre, monto y estado actuales.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDeactivate()}>
              Desactivar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

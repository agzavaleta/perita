import { useDeferredValue, useEffect, useState } from "react"
import {
  ArrowDownLeft,
  ArrowRightLeft,
  ArrowUpRight,
  ChevronRight,
  Pencil,
  PiggyBank,
  Plus,
  Scale,
  Search,
  SlidersHorizontal,
  Undo2,
} from "lucide-react"

import type { EntityId } from "@/domain/primitives"
import type {
  SavingsDepositOperation,
  SavingsWithdrawalOperation,
} from "@/domain/operations"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  createMovementModule,
  type MovementModule,
} from "@/features/movements/application/bootstrap"
import type {
  MovementDetail,
  MovementFormOptions,
  MovementKind,
  MovementListKind,
  MovementListItem,
  MovementUseCasesPort,
  TransferFormOptions,
} from "@/features/movements/application/movement-use-cases"
import {
  MovementForm,
  type MovementEditor,
} from "@/features/movements/presentation/MovementForm"
import {
  SavingsMovementForm,
  type SavingsMovementMode,
} from "@/features/movements/presentation/SavingsMovementForm"
import {
  TransferForm,
  type TransferEditor,
} from "@/features/movements/presentation/TransferForm"
import { cn } from "@/lib/utils"

interface MovementsPageProps {
  readonly useCases?: MovementUseCasesPort
  readonly initialComposer?: MovementKind | null
  readonly onInitialComposerClose?: () => void
  readonly onManageCategories?: () => void
}

function formatClp(value: number, signed = true) {
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

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No fue posible completar la acción."
}

type SavingsOperation = SavingsDepositOperation | SavingsWithdrawalOperation

function isSavingsOperation(
  operation: MovementListItem["operation"],
): operation is SavingsOperation {
  return (
    operation.type === "savings_deposit" ||
    operation.type === "savings_withdrawal"
  )
}

function targetsGoal(item: MovementListItem) {
  return (
    item.kind === "savings" ||
    (item.operation.type === "balance_adjustment" &&
      "goalId" in item.operation.details)
  )
}

function MovementCard({
  item,
  onOpen,
}: {
  readonly item: MovementListItem
  readonly onOpen: () => void
}) {
  const Icon =
    item.kind === "transfer"
      ? ArrowRightLeft
      : item.kind === "savings"
        ? PiggyBank
      : item.kind === "adjustment"
        ? Scale
      : item.kind === "income"
        ? ArrowDownLeft
        : ArrowUpRight
  return (
    <Card
      className={cn(item.operation.status === "voided" && "opacity-60")}
    >
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Icon aria-hidden="true" className="size-5" />
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate">{item.title}</CardTitle>
            <CardDescription className="truncate">
              {item.accountName} · {formatDate(item.operation.operationDate)}
            </CardDescription>
          </div>
        </div>
        <CardAction>
          {item.operation.status === "voided" && (
            <Badge variant="outline">Anulado</Badge>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        {item.description ? (
          <p className="text-sm text-muted-foreground">{item.description}</p>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <p
            className={cn(
              "money-figure text-lg font-semibold",
              item.operation.status === "voided" && "line-through",
            )}
          >
            {formatClp(
              item.kind === "transfer" ? item.operation.amount : item.signedAmount,
              item.kind !== "transfer",
            )}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            aria-label={`Ver detalle de ${item.title}`}
            onClick={onOpen}
          >
            <ChevronRight aria-hidden="true" className="size-5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function MovementDetailSheet({
  detail,
  onClose,
  onEdit,
  onVoid,
  canChange,
}: {
  readonly detail: MovementDetail
  readonly onClose: () => void
  readonly onEdit: () => void
  readonly onVoid: () => void
  readonly canChange: boolean
}) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[90dvh] w-full max-w-[430px] rounded-t-xl"
      >
        <SheetHeader>
          <SheetTitle>{detail.title}</SheetTitle>
          <SheetDescription>
            {detail.kind === "transfer"
              ? "Movimiento interno"
              : detail.kind === "savings"
                ? "Ahorro"
              : detail.kind === "adjustment"
                ? "Ajuste"
              : detail.kind === "income"
                ? "Ingreso"
                : "Gasto"} · {detail.accountName}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <Card>
            <CardContent className="space-y-3 pt-1">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {detail.kind === "transfer" ? "Monto" : "Impacto"}
                  </p>
                  <p className="money-figure text-2xl font-semibold">
                    {formatClp(
                      detail.kind === "transfer"
                        ? detail.operation.amount
                        : detail.signedAmount,
                      detail.kind !== "transfer",
                    )}
                  </p>
                </div>
                <Badge
                  variant={
                    detail.operation.status === "posted" ? "secondary" : "outline"
                  }
                >
                  {detail.operation.status === "posted" ? "Vigente" : "Anulado"}
                </Badge>
              </div>
              <Separator />
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Fecha</dt>
                  <dd>{formatDate(detail.operation.operationDate)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Revisión</dt>
                  <dd>{detail.operation.revision}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-muted-foreground">
                    {detail.kind === "transfer"
                      ? "Recorrido"
                      : targetsGoal(detail)
                        ? "Meta"
                        : "Cuenta"}
                  </dt>
                  <dd>{detail.accountName}</dd>
                </div>
                {detail.description && (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">Detalle</dt>
                    <dd>{detail.description}</dd>
                  </div>
                )}
                {detail.operation.status === "voided" && detail.operation.voidReason && (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">Motivo de anulación</dt>
                    <dd>{detail.operation.voidReason}</dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>
          <p className="text-sm text-muted-foreground">
            {detail.revisions.length === 0
              ? "Sin cambios anteriores."
              : `${detail.revisions.length} revisiones históricas conservadas.`}
          </p>
          {detail.operation.status === "posted" && canChange && (
            <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
              <Button type="button" variant="outline" size="lg" onClick={onEdit}>
                <Pencil aria-hidden="true" />
                Editar
              </Button>
              <Button type="button" variant="destructive" size="lg" onClick={onVoid}>
                <Undo2 aria-hidden="true" />
                Anular
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function MovementsPage({
  useCases: injectedUseCases,
  initialComposer = null,
  onInitialComposerClose,
  onManageCategories,
}: MovementsPageProps) {
  const [module, setModule] = useState<MovementModule | null>(null)
  const useCases = injectedUseCases ?? module?.useCases ?? null
  const [options, setOptions] = useState<MovementFormOptions | null>(null)
  const [transferOptions, setTransferOptions] =
    useState<TransferFormOptions | null>(null)
  const [items, setItems] = useState<MovementListItem[]>([])
  const [hasAny, setHasAny] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)
  const [kind, setKind] = useState<"all" | MovementListKind>("all")
  const [status, setStatus] = useState<"all" | "posted" | "voided">("all")
  const [accountId, setAccountId] = useState<"all" | EntityId>("all")
  const [editor, setEditor] = useState<MovementEditor | null>(null)
  const [transferEditor, setTransferEditor] = useState<TransferEditor | null>(null)
  const [savingsEditor, setSavingsEditor] = useState<{
    readonly goal: TransferFormOptions["savingsGoals"][number]
    readonly operation: SavingsOperation
    readonly mode: SavingsMovementMode
  } | null>(null)
  const [detail, setDetail] = useState<MovementDetail | null>(null)
  const [voidTarget, setVoidTarget] = useState<MovementDetail | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const activeEditor =
    initialComposer && initialComposer !== "transfer"
      ? { kind: initialComposer }
      : editor
  const activeTransferEditor =
    initialComposer === "transfer" ? {} : transferEditor
  const detailSavingsOperation =
    detail && isSavingsOperation(detail.operation) ? detail.operation : null
  const detailSavingsGoal = detailSavingsOperation
    ? transferOptions?.savingsGoals.find(
        (goal) => goal.id === detailSavingsOperation.details.goalId,
      ) ?? null
    : null

  useEffect(() => {
    if (injectedUseCases) return
    let active = true
    let createdModule: MovementModule | null = null
    void createMovementModule()
      .then((nextModule) => {
        createdModule = nextModule
        if (active) setModule(nextModule)
        else nextModule.dispose()
      })
      .catch((cause) => {
        if (active) {
          setError(errorMessage(cause))
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
      useCases.getFormOptions(),
      useCases.getTransferFormOptions(),
      useCases.listMovements(),
    ])
      .then(([nextOptions, nextTransferOptions, allItems]) => {
        if (active) {
          setOptions(nextOptions)
          setTransferOptions(nextTransferOptions)
          setHasAny(allItems.length > 0)
        }
      })
      .catch((cause) => active && setError(errorMessage(cause)))
    return () => {
      active = false
    }
  }, [refreshKey, useCases])

  useEffect(() => {
    if (!useCases) return
    let active = true
    void useCases
      .listMovements({
        query: deferredQuery,
        kind,
        status,
        accountId,
      })
      .then((records) => {
        if (active) {
          setItems(records)
          setLoading(false)
        }
      })
      .catch((cause) => {
        if (active) {
          setError(errorMessage(cause))
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [accountId, deferredQuery, kind, refreshKey, status, useCases])

  function closeEditor() {
    setEditor(null)
    setTransferEditor(null)
    setSavingsEditor(null)
    onInitialComposerClose?.()
  }

  function saved() {
    closeEditor()
    setDetail(null)
    setRefreshKey((value) => value + 1)
  }

  async function openDetail(item: MovementListItem) {
    if (!useCases) return
    setError(null)
    try {
      setDetail(await useCases.getMovementDetail(item.operation.id))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function confirmVoid() {
    if (!useCases || !voidTarget) return
    setError(null)
    try {
      if (isSavingsOperation(voidTarget.operation)) {
        await useCases.voidSavingsMovement({
          operationId: voidTarget.operation.id,
          expectedRevision: voidTarget.operation.revision,
          reason: "Anulado desde la interfaz",
        })
      } else {
        await useCases.voidMovement({
          operationId: voidTarget.operation.id,
          expectedRevision: voidTarget.operation.revision,
          reason: "Anulado desde la interfaz",
        })
      }
      setDetail(null)
      setRefreshKey((value) => value + 1)
    } catch (cause) {
      setDetail(null)
      setError(errorMessage(cause))
    } finally {
      setVoidTarget(null)
    }
  }

  return (
    <section className="space-y-section py-section" aria-labelledby="movements-title">
      <div className="flex flex-col items-stretch gap-3 min-[360px]:flex-row min-[360px]:items-center min-[360px]:justify-between">
        <div>
          <h1 id="movements-title" className="type-page-title">
            Movimientos
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Ingresos, gastos, ahorro, ajustes y movimientos internos del período abierto.
          </p>
        </div>
        <Button
          type="button"
          size="lg"
          onClick={() => setEditor({ kind: "expense" })}
          disabled={!useCases || !options}
          className="self-end"
        >
          <Plus aria-hidden="true" />
          Gasto
        </Button>
      </div>

      <Card size="sm">
        <CardContent className="space-y-3">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Buscar movimientos"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por título, cuenta, meta, motivo o categoría"
              className="pl-8"
            />
          </div>
          <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
            <div>
              <Label className="sr-only">Tipo</Label>
              <Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}>
                <SelectTrigger className="w-full" aria-label="Tipo de movimiento">
                  <SlidersHorizontal aria-hidden="true" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="income">Ingresos</SelectItem>
                  <SelectItem value="expense">Gastos</SelectItem>
                  <SelectItem value="savings">Ahorro</SelectItem>
                  <SelectItem value="adjustment">Ajustes</SelectItem>
                  <SelectItem value="transfer">Movimientos internos</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="sr-only">Estado</Label>
              <Select
                value={status}
                onValueChange={(value) => setStatus(value as typeof status)}
              >
                <SelectTrigger className="w-full" aria-label="Estado del movimiento">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todo estado</SelectItem>
                  <SelectItem value="posted">Vigentes</SelectItem>
                  <SelectItem value="voided">Anulados</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {options && options.accounts.length > 1 && (
            <Select
              value={accountId}
              onValueChange={(value) => setAccountId(value as typeof accountId)}
            >
              <SelectTrigger className="w-full" aria-label="Filtrar por cuenta">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas las cuentas</SelectItem>
                {options.accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </CardContent>
      </Card>

      {error && <ErrorMessage title="No se pudo completar la acción" description={error} />}
      {loading ? (
        <LoadingState label="Cargando movimientos" />
      ) : items.length === 0 ? (
        <EmptyState
          title={hasAny ? "Sin resultados" : "Aún no has registrado movimientos"}
          description={
            hasAny
              ? "No se encontraron movimientos que coincidan con los filtros."
              : "Registra un ingreso, gasto, ahorro, ajuste o movimiento interno para comenzar."
          }
        />
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <MovementCard
              key={item.operation.id}
              item={item}
              onOpen={() => void openDetail(item)}
            />
          ))}
        </div>
      )}

      {activeEditor && options && useCases && (
        <MovementForm
          key={activeEditor.item?.operation.id ?? activeEditor.kind}
          editor={activeEditor}
          options={options}
          useCases={useCases}
          onSaved={saved}
          onClose={closeEditor}
          onManageCategories={onManageCategories}
        />
      )}
      {activeTransferEditor && transferOptions && useCases && (
        <TransferForm
          key={activeTransferEditor.item?.operation.id ?? "transfer"}
          editor={activeTransferEditor}
          options={transferOptions}
          useCases={useCases}
          onSaved={saved}
          onClose={closeEditor}
        />
      )}
      {savingsEditor && useCases && (
        <SavingsMovementForm
          key={savingsEditor.operation.id}
          goal={savingsEditor.goal}
          mode={savingsEditor.mode}
          operation={savingsEditor.operation}
          useCases={useCases}
          onSaved={saved}
          onClose={closeEditor}
        />
      )}
      {detail && !activeEditor && !activeTransferEditor && !savingsEditor && (
        <MovementDetailSheet
          detail={detail}
          canChange={
            detail.kind !== "adjustment" &&
            (detailSavingsOperation === null || detailSavingsGoal !== null)
          }
          onClose={() => setDetail(null)}
          onEdit={() => {
            if (detail.kind === "transfer") {
              setTransferEditor({ item: detail })
            } else if (isSavingsOperation(detail.operation)) {
              const operation = detail.operation
              const goal = transferOptions?.savingsGoals.find(
                (candidate) => candidate.id === operation.details.goalId,
              )
              if (goal) {
                setSavingsEditor({
                  goal,
                  operation,
                  mode:
                    operation.type === "savings_deposit" ? "deposit" : "withdrawal",
                })
              }
            } else if (detail.kind === "income" || detail.kind === "expense") {
              setEditor({ kind: detail.kind, item: detail })
            }
            setDetail(null)
          }}
          onVoid={() => setVoidTarget(detail)}
        />
      )}

      <AlertDialog
        open={voidTarget !== null}
        onOpenChange={(open) => !open && setVoidTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Undo2 />
            </AlertDialogMedia>
            <AlertDialogTitle>Anular movimiento</AlertDialogTitle>
            <AlertDialogDescription>
              Se revertirá su impacto en el saldo y se conservará el historial.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void confirmVoid()}
            >
              Anular movimiento
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

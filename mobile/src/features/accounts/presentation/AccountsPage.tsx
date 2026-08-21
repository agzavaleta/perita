import { useCallback, useEffect, useState, type FormEvent } from "react"
import {
  ChevronRight,
  History,
  Landmark,
  Pencil,
  Plus,
  PowerOff,
  Scale,
  WalletCards,
} from "lucide-react"

import type { Account } from "@/domain/entities"
import { MoneyAmount } from "@/components/finance/MoneyAmount"
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  type AccountUseCasesPort,
} from "@/features/accounts/application/account-use-cases"
import {
  createAccountModule,
  type AccountModule,
} from "@/features/accounts/application/bootstrap"
import type { BalanceAdjustmentUseCasesPort } from "@/features/accounts/application/balance-adjustment-use-cases"
import { BalanceAdjustmentForm } from "@/features/accounts/presentation/BalanceAdjustmentForm"

type EditorState =
  | { readonly mode: "create" }
  | { readonly mode: "edit"; readonly account: Account }
  | null

interface AccountsPageProps {
  readonly useCases?: AccountUseCasesPort
  readonly balanceAdjustmentUseCases?: BalanceAdjustmentUseCasesPort
}

function formatClp(value: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(value)
}

function accountErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No fue posible completar la acción sobre la cuenta."
}

function AccountStatusBadge({ status }: Pick<Account, "status">) {
  return (
    <Badge variant={status === "active" ? "secondary" : "outline"}>
      {status === "active" ? "Activa" : "Inactiva"}
    </Badge>
  )
}

function AccountCard({
  account,
  onOpen,
}: {
  readonly account: Account
  readonly onOpen: () => void
}) {
  return (
    <Card className={account.status === "inactive" ? "opacity-75" : undefined}>
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            {account.bank ? (
              <Landmark aria-hidden="true" className="size-5" />
            ) : (
              <WalletCards aria-hidden="true" className="size-5" />
            )}
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate">{account.name}</CardTitle>
            <CardDescription className="truncate">
              {account.bank ?? "Sin institución"}
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <AccountStatusBadge status={account.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex items-end justify-between gap-3">
        <MoneyAmount label="Saldo" value={formatClp(account.currentBalance)} />
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-label={`Ver detalle de ${account.name}`}
          onClick={onOpen}
        >
          <ChevronRight aria-hidden="true" className="size-5" />
        </Button>
      </CardContent>
    </Card>
  )
}

function AccountEditor({
  editor,
  useCases,
  onSaved,
  onClose,
}: {
  readonly editor: Exclude<EditorState, null>
  readonly useCases: AccountUseCasesPort
  readonly onSaved: (account: Account) => void
  readonly onClose: () => void
}) {
  const editing = editor.mode === "edit"
  const [name, setName] = useState(editing ? editor.account.name : "")
  const [bank, setBank] = useState(editing ? (editor.account.bank ?? "") : "")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const account = editing
        ? await useCases.editAccount({
            accountId: editor.account.id,
            expectedRevision: editor.account.revision,
            name,
            bank,
          })
        : await useCases.createAccount({ name, bank })
      onSaved(account)
    } catch (cause) {
      setError(accountErrorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[90dvh] w-full max-w-[430px] overflow-y-auto rounded-t-xl pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader>
          <SheetTitle>{editing ? "Editar cuenta" : "Nueva cuenta"}</SheetTitle>
          <SheetDescription>
            {editing
              ? "Puedes cambiar el nombre y la institución."
              : "La cuenta se creará activa y con saldo $0."}
          </SheetDescription>
        </SheetHeader>
        <form className="space-y-4 px-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="account-name">Nombre</Label>
            <Input
              id="account-name"
              autoFocus
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ej. Cuenta principal"
              maxLength={80}
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account-bank">Banco o institución</Label>
            <Input
              id="account-bank"
              autoComplete="organization"
              value={bank}
              onChange={(event) => setBank(event.target.value)}
              placeholder="Opcional"
              maxLength={80}
              disabled={saving}
            />
          </div>
          {error && (
            <ErrorMessage title="No se pudo guardar" description={error} />
          )}
          <SheetFooter className="px-0">
            <Button type="submit" size="lg" className="h-11" disabled={saving}>
              {saving ? "Guardando…" : editing ? "Guardar cambios" : "Crear cuenta"}
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

function AccountDetail({
  account,
  useCases,
  onClose,
  onEdit,
  onRequestStatusChange,
  onAdjust,
}: {
  readonly account: Account
  readonly useCases: AccountUseCasesPort
  readonly onClose: () => void
  readonly onEdit: () => void
  readonly onRequestStatusChange: () => void
  readonly onAdjust?: () => void
}) {
  const [movementCount, setMovementCount] = useState<number | "error" | null>(null)

  useEffect(() => {
    let active = true
    void useCases
      .listRelatedMovements(account.id)
      .then((movements) => {
        if (active) setMovementCount(movements.length)
      })
      .catch(() => {
        if (active) setMovementCount("error")
      })
    return () => {
      active = false
    }
  }, [account.id, useCases])

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[90dvh] w-full max-w-[430px] overflow-y-auto rounded-t-xl pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader>
          <SheetTitle>{account.name}</SheetTitle>
          <SheetDescription>{account.bank ?? "Sin institución"}</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <Card>
            <CardContent className="flex items-start justify-between gap-3 pt-1">
              <MoneyAmount
                label="Saldo actual"
                value={formatClp(account.currentBalance)}
              />
              <AccountStatusBadge status={account.status} />
            </CardContent>
          </Card>
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" size="lg" onClick={onEdit}>
              <Pencil aria-hidden="true" />
              Editar
            </Button>
            {account.status === "active" ? (
              <Button
                type="button"
                variant="destructive"
                size="lg"
                onClick={onRequestStatusChange}
                disabled={account.currentBalance !== 0}
              >
                <PowerOff aria-hidden="true" /> Desactivar
              </Button>
            ) : null}
          </div>
          {account.status === "active" && onAdjust ? (
            <Button type="button" variant="outline" className="w-full" onClick={onAdjust}>
              <Scale aria-hidden="true" /> Ajustar saldo
            </Button>
          ) : null}
          <section aria-labelledby="account-movements-title">
            <h3 id="account-movements-title" className="type-section-title mb-2">
              Movimientos relacionados
            </h3>
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center py-6 text-center">
                <History
                  aria-hidden="true"
                  className="size-6 text-muted-foreground"
                />
                <p className="mt-2 font-medium">
                  {movementCount === null
                    ? "Cargando movimientos…"
                    : movementCount === "error"
                      ? "No fue posible cargar los movimientos"
                      : movementCount === 0
                      ? "Aún no hay movimientos relacionados"
                      : `${movementCount} movimientos relacionados`}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  El historial completo se habilitará en la Fase 6.
                </p>
              </CardContent>
            </Card>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function AccountsPage({
  useCases: injectedUseCases,
  balanceAdjustmentUseCases: injectedBalanceAdjustmentUseCases,
}: AccountsPageProps) {
  const [module, setModule] = useState<AccountModule | null>(null)
  const useCases = injectedUseCases ?? module?.useCases ?? null
  const balanceAdjustmentUseCases =
    injectedBalanceAdjustmentUseCases ?? module?.balanceAdjustmentUseCases ?? null
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState>(null)
  const [selected, setSelected] = useState<Account | null>(null)
  const [statusTarget, setStatusTarget] = useState<Account | null>(null)
  const [adjustmentTarget, setAdjustmentTarget] = useState<Account | null>(null)

  useEffect(() => {
    if (injectedUseCases) return
    let active = true
    let createdModule: AccountModule | null = null
    void createAccountModule()
      .then((nextModule) => {
        createdModule = nextModule
        if (active) setModule(nextModule)
        else nextModule.dispose()
      })
      .catch((cause) => {
        if (active) {
          setError(accountErrorMessage(cause))
          setLoading(false)
        }
      })
    return () => {
      active = false
      createdModule?.dispose()
    }
  }, [injectedUseCases])

  const loadAccounts = useCallback(async () => {
    if (!useCases) return
    setLoading(true)
    setError(null)
    try {
      setAccounts(await useCases.listAccounts())
    } catch (cause) {
      setError(accountErrorMessage(cause))
      setSelected(null)
    } finally {
      setLoading(false)
    }
  }, [useCases])

  useEffect(() => {
    if (!useCases) return
    let active = true
    void useCases
      .listAccounts()
      .then((records) => {
        if (active) {
          setAccounts(records)
          setLoading(false)
        }
      })
      .catch((cause) => {
        if (active) {
          setError(accountErrorMessage(cause))
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [useCases])

  async function saved(account: Account) {
    setEditor(null)
    setSelected(account)
    await loadAccounts()
  }

  async function changeStatus() {
    if (!statusTarget || !useCases) return
    setError(null)
    try {
      const account = await useCases.deactivateAccount({
        accountId: statusTarget.id,
        expectedRevision: statusTarget.revision,
      })
      setSelected(account)
      await loadAccounts()
    } catch (cause) {
      setError(accountErrorMessage(cause))
      setSelected(null)
    } finally {
      setStatusTarget(null)
    }
  }

  return (
    <section className="space-y-section py-section" aria-labelledby="accounts-title">
      <div className="flex flex-col items-stretch gap-3 min-[360px]:flex-row min-[360px]:items-center min-[360px]:justify-between">
        <div>
          <h1 id="accounts-title" className="type-page-title">
            Cuentas
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Consulta saldos y administra tus cuentas.
          </p>
        </div>
        <Button
          type="button"
          size="lg"
          onClick={() => setEditor({ mode: "create" })}
          disabled={!useCases}
          className="self-end"
        >
          <Plus aria-hidden="true" />
          Nueva
        </Button>
      </div>

      {error && <ErrorMessage title="No se pudo completar la acción" description={error} />}
      {loading ? (
        <LoadingState label="Cargando cuentas" />
      ) : accounts.length === 0 ? (
        <EmptyState
          title="Aún no has agregado ninguna cuenta"
          description="Crea una cuenta para comenzar. Su saldo inicial será $0."
        />
      ) : (
        <div className="space-y-3">
          {accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              onOpen={() => setSelected(account)}
            />
          ))}
        </div>
      )}

      {editor && useCases && (
        <AccountEditor
          key={editor.mode === "edit" ? editor.account.id : "create"}
          editor={editor}
          useCases={useCases}
          onSaved={saved}
          onClose={() => setEditor(null)}
        />
      )}
      {selected && !editor && useCases && (
        <AccountDetail
          account={selected}
          useCases={useCases}
          onClose={() => setSelected(null)}
          onEdit={() => {
            setEditor({ mode: "edit", account: selected })
            setSelected(null)
          }}
          onRequestStatusChange={() => setStatusTarget(selected)}
          onAdjust={
            balanceAdjustmentUseCases
              ? () => {
                  setAdjustmentTarget(selected)
                  setSelected(null)
                }
              : undefined
          }
        />
      )}
      {adjustmentTarget && balanceAdjustmentUseCases ? (
        <BalanceAdjustmentForm
          account={adjustmentTarget}
          useCases={balanceAdjustmentUseCases}
          onSaved={({ account }) => {
            setAdjustmentTarget(null)
            setSelected(account)
            void loadAccounts()
          }}
          onClose={() => setAdjustmentTarget(null)}
        />
      ) : null}

      <AlertDialog
        open={statusTarget !== null}
        onOpenChange={(open) => !open && setStatusTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <PowerOff />
            </AlertDialogMedia>
            <AlertDialogTitle>
              Desactivar cuenta
            </AlertDialogTitle>
            <AlertDialogDescription>
              Solo se puede desactivar con saldo $0. El historial se conservará.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void changeStatus()}
            >
              Confirmar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

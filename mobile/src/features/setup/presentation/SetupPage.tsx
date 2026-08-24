import { useRef, useState, type FormEvent } from "react"
import { AlertTriangle, Landmark, Plus, Sparkles, Trash2 } from "lucide-react"

import { ClpAmountInput } from "@/components/finance/ClpAmountInput"
import { FinancialInstitutionField } from "@/components/finance/FinancialInstitutionField"
import { EmptyState } from "@/components/states/EmptyState"
import { ErrorMessage } from "@/components/states/ErrorMessage"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type {
  CompleteSetupInput,
  SaveSetupDraftInput,
  SetupResult,
  SetupState,
  SetupUseCasesPort,
} from "@/features/setup/application/setup-use-cases"

interface EditableAccount {
  readonly id: string
  readonly emoji: string
  readonly name: string
  readonly bank: string | null
  readonly openingBalance: number | null
}

interface EditableSetupDraft {
  readonly periodKey: string
  readonly salaryReferenceAmount: number | null
  readonly variableExpenseBudgetAmount: number | null
  readonly accounts: readonly EditableAccount[]
}

function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No fue posible guardar el borrador de configuración."
}

function periodLabel(periodKey: string) {
  const [year, month] = periodKey.split("-").map(Number)
  return new Intl.DateTimeFormat("es-CL", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)))
}

function formatClp(value: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(value)
}

function newAccount(): EditableAccount {
  return {
    id: globalThis.crypto.randomUUID(),
    emoji: "💳",
    name: "",
    bank: null,
    openingBalance: null,
  }
}

function initialDraft(state: SetupState): EditableSetupDraft {
  if (state.draft) {
    return {
      periodKey: state.draft.periodKey,
      salaryReferenceAmount: state.draft.salaryReferenceAmount,
      variableExpenseBudgetAmount: state.draft.variableExpenseBudgetAmount,
      accounts: state.draft.accounts.length > 0
        ? state.draft.accounts.map((account) => ({ ...account }))
        : [newAccount()],
    }
  }
  return {
    periodKey: state.allowedPeriodKeys[0] ?? "",
    salaryReferenceAmount: 0,
    variableExpenseBudgetAmount: 0,
    accounts: [newAccount()],
  }
}

function persistedDraft(draft: EditableSetupDraft): SaveSetupDraftInput {
  return {
    periodKey: draft.periodKey,
    salaryReferenceAmount: draft.salaryReferenceAmount ?? 0,
    variableExpenseBudgetAmount: draft.variableExpenseBudgetAmount ?? 0,
    accounts: draft.accounts.map((account) => ({
      ...account,
      openingBalance: account.openingBalance ?? 0,
    })),
  }
}

function confirmationInput(draft: EditableSetupDraft): CompleteSetupInput {
  return {
    periodKey: draft.periodKey,
    salaryReferenceAmount: draft.salaryReferenceAmount ?? 0,
    variableExpenseBudgetAmount: draft.variableExpenseBudgetAmount ?? 0,
    accounts: draft.accounts.map((account) => ({
      name: account.name,
      bank: account.bank,
      openingBalance: account.openingBalance ?? 0,
      emoji: account.emoji,
    })),
  }
}

export function SetupPage({
  state,
  useCases,
  onCompleted,
}: {
  readonly state: SetupState
  readonly useCases: SetupUseCasesPort
  readonly onCompleted: (result: SetupResult) => void
}) {
  const [draft, setDraft] = useState(() => initialDraft(state))
  const [savingDraft, setSavingDraft] = useState(false)
  const [step, setStep] = useState<"form" | "review">("form")
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const pendingSaveCount = useRef(0)
  const confirmingRef = useRef(false)
  const validAccounts = draft.accounts.length > 0 && draft.accounts.every(
    ({ name }) => name.trim().length > 0,
  )
  const canReview = draft.periodKey.length > 0 && validAccounts

  function queueDraftSave(nextDraft: EditableSetupDraft) {
    pendingSaveCount.current += 1
    setSavingDraft(true)
    const save = saveQueue.current.then(async () => {
      await useCases.saveDraft(persistedDraft(nextDraft))
    })
    saveQueue.current = save.then(
      () => undefined,
      () => undefined,
    )
    void save.then(
      () => undefined,
      (cause) => {
        setError(message(cause))
      },
    ).finally(() => {
      pendingSaveCount.current -= 1
      if (pendingSaveCount.current === 0) setSavingDraft(false)
    })
    return save
  }

  function updateDraft(nextDraft: EditableSetupDraft) {
    setDraft(nextDraft)
    setStep("form")
    setError(null)
    void queueDraftSave(nextDraft)
  }

  function updateAccount(
    accountId: string,
    changes: Partial<EditableAccount>,
  ) {
    updateDraft({
      ...draft,
      accounts: draft.accounts.map((account) =>
        account.id === accountId ? { ...account, ...changes } : account,
      ),
    })
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canReview) return
    setError(null)
    try {
      await queueDraftSave(draft)
      setStep("review")
    } catch {
      // queueDraftSave already exposes the persistence error in the form.
    }
  }

  async function confirmSetup() {
    if (confirmingRef.current) return
    confirmingRef.current = true
    setConfirming(true)
    setError(null)
    try {
      const result = await useCases.completeSetup(confirmationInput(draft))
      onCompleted(result)
    } catch (cause) {
      setError(message(cause))
    } finally {
      confirmingRef.current = false
      setConfirming(false)
    }
  }

  if (state.status === "incomplete") {
    return (
      <section className="space-y-6 py-section" aria-labelledby="setup-title">
        <h1 id="setup-title" className="type-page-title">Inicio</h1>
        <ErrorMessage
          title="Configuración incompleta"
          description="Perita bloqueó la operación normal porque encontró una instalación parcial. Restaura un respaldo válido o elimina los datos desde una herramienta de recuperación."
        />
      </section>
    )
  }

  if (step === "review") {
    return (
      <section className="space-y-6 py-section" aria-labelledby="setup-review-title">
        <div>
          <h1 id="setup-review-title" className="type-page-title">
            Revisa tu configuración
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Confirma que estos datos representan tu punto de partida.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Plan inicial</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-4 text-sm">
              <div>
                <dt className="text-muted-foreground">Período inicial</dt>
                <dd className="mt-1 font-medium capitalize">
                  {periodLabel(draft.periodKey)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Sueldo de referencia</dt>
                <dd className="money-figure mt-1 font-semibold">
                  {formatClp(draft.salaryReferenceAmount ?? 0)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  Presupuesto para gastos variables
                </dt>
                <dd className="money-figure mt-1 font-semibold">
                  {formatClp(draft.variableExpenseBudgetAmount ?? 0)}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <div className="space-y-3" aria-labelledby="setup-review-accounts">
          <h2 id="setup-review-accounts" className="type-section-title">
            Cuentas
          </h2>
          {draft.accounts.map((account) => (
            <Card key={account.id}>
              <CardContent className="space-y-3 pt-1">
                <div className="flex items-start gap-3">
                  <span className="text-2xl" aria-hidden="true">{account.emoji}</span>
                  <div className="min-w-0">
                    <p className="break-words font-semibold">{account.name.trim()}</p>
                    <p className="break-words text-sm text-muted-foreground">
                      {account.bank ?? "Sin institución"}
                    </p>
                  </div>
                </div>
                <div className="border-t pt-3">
                  <p className="text-xs text-muted-foreground">Saldo inicial</p>
                  <p className="money-figure mt-1 font-semibold">
                    {formatClp(account.openingBalance ?? 0)}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {error ? (
          <ErrorMessage title="No se pudo completar la configuración" description={error} />
        ) : null}

        <div className="space-y-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={confirming}
            onClick={() => {
              setError(null)
              setStep("form")
            }}
          >
            Volver
          </Button>
          <Button
            type="button"
            size="lg"
            className="w-full"
            disabled={confirming}
            onClick={() => void confirmSetup()}
          >
            {confirming ? "Confirmando…" : "Confirmar y comenzar"}
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-6 py-section" aria-labelledby="setup-title">
      <div>
        <h1 id="setup-title" className="type-page-title">Inicio</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Prepara la base financiera de Perita.
        </p>
      </div>

      <EmptyState
        title={state.status === "resumable" ? "Continúa tu configuración" : "Comencemos con lo esencial"}
        description="Define el período y tus cuentas. Los saldos iniciales quedarán como apertura, no como movimientos."
      />

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Sparkles aria-hidden="true" className="size-5 text-brand" />
            <CardTitle>Configuración inicial</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={submit}>
            <div className="space-y-2">
              <Label htmlFor="setup-period">Período inicial</Label>
              <Input
                id="setup-period"
                type="month"
                required
                max={state.allowedPeriodKeys[0]}
                value={draft.periodKey}
                onChange={(event) => updateDraft({
                  ...draft,
                  periodKey: event.currentTarget.value,
                })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="setup-salary">Sueldo de referencia</Label>
              <ClpAmountInput
                id="setup-salary"
                value={draft.salaryReferenceAmount}
                onValueChange={(value) => updateDraft({
                  ...draft,
                  salaryReferenceAmount: value,
                })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="setup-budget">
                Presupuesto para gastos variables (opcional)
              </Label>
              <ClpAmountInput
                id="setup-budget"
                value={draft.variableExpenseBudgetAmount}
                onValueChange={(value) => updateDraft({
                  ...draft,
                  variableExpenseBudgetAmount: value,
                })}
              />
            </div>

            <div className="space-y-4 border-t pt-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Landmark aria-hidden="true" className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold">Cuentas</h2>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => updateDraft({
                    ...draft,
                    accounts: [...draft.accounts, newAccount()],
                  })}
                >
                  <Plus aria-hidden="true" />
                  Agregar cuenta
                </Button>
              </div>

              {draft.accounts.map((account, index) => {
                const accountNumber = index + 1
                return (
                  <Card key={account.id} data-testid={`setup-account-${account.id}`}>
                    <CardHeader>
                      <div className="flex items-center justify-between gap-3">
                        <CardTitle>Cuenta {accountNumber}</CardTitle>
                        {index > 0 ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Eliminar cuenta ${accountNumber}`}
                            onClick={() => updateDraft({
                              ...draft,
                              accounts: draft.accounts.filter(({ id }) => id !== account.id),
                            })}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        ) : null}
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor={`setup-account-name-${account.id}`}>Nombre</Label>
                        <Input
                          id={`setup-account-name-${account.id}`}
                          value={account.name}
                          onChange={(event) => updateAccount(account.id, {
                            name: event.currentTarget.value,
                          })}
                          placeholder="Ej. Cuenta principal"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor={`setup-account-bank-${account.id}`}>
                          Banco o institución (opcional)
                        </Label>
                        <FinancialInstitutionField
                          id={`setup-account-bank-${account.id}`}
                          value={account.bank}
                          onValueChange={(value) => updateAccount(account.id, {
                            bank: value,
                          })}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor={`setup-account-balance-${account.id}`}>
                          Saldo inicial (opcional)
                        </Label>
                        <ClpAmountInput
                          id={`setup-account-balance-${account.id}`}
                          allowNegative
                          value={account.openingBalance}
                          onValueChange={(value) => updateAccount(account.id, {
                            openingBalance: value,
                          })}
                        />
                      </div>

                      {account.openingBalance !== null && account.openingBalance < 0 ? (
                        <Alert>
                          <AlertTriangle aria-hidden="true" />
                          <AlertTitle>Saldo inicial negativo</AlertTitle>
                          <AlertDescription>
                            Es una apertura excepcional permitida durante setup.
                          </AlertDescription>
                        </Alert>
                      ) : null}
                    </CardContent>
                  </Card>
                )
              })}
            </div>

            {error ? (
              <ErrorMessage title="No se pudo guardar el borrador" description={error} />
            ) : null}
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={!canReview || savingDraft}
            >
              {savingDraft ? "Guardando…" : "Comenzar a usar Perita"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </section>
  )
}

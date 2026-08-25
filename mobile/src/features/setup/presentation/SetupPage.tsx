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
    : "No fue posible completar la configuración."
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
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const confirmingRef = useRef(false)
  const validAccounts = draft.accounts.length > 0 && draft.accounts.every(
    ({ name }) => name.trim().length > 0,
  )
  const canSubmit = draft.periodKey.length > 0 && validAccounts

  function queueDraftSave(nextDraft: EditableSetupDraft) {
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
    )
    return save
  }

  function updateDraft(nextDraft: EditableSetupDraft) {
    setDraft(nextDraft)
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
    if (!canSubmit || confirmingRef.current) return
    confirmingRef.current = true
    setConfirming(true)
    setError(null)
    try {
      await queueDraftSave(draft)
      const result = await useCases.completeSetup(confirmationInput(draft))
      confirmingRef.current = false
      setConfirming(false)
      onCompleted(result)
    } catch (cause) {
      setError(message(cause))
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
              <ErrorMessage title="No se pudo completar la configuración" description={error} />
            ) : null}
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={!canSubmit || confirming}
            >
              {confirming ? "Completando…" : "Comenzar a usar Perita"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </section>
  )
}

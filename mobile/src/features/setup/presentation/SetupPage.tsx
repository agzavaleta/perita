import { useRef, useState, type FormEvent } from "react"
import { AlertTriangle } from "lucide-react"

import { ClpAmountInput } from "@/components/finance/ClpAmountInput"
import { FinancialInstitutionField } from "@/components/finance/FinancialInstitutionField"
import { ErrorMessage } from "@/components/states/ErrorMessage"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
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
  readonly account: EditableAccount
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
      account: { ...state.draft.account },
    }
  }
  return {
    periodKey: state.allowedPeriodKeys[0] ?? "",
    salaryReferenceAmount: 0,
    account: newAccount(),
  }
}

function maximumAllowedPeriodKey(state: SetupState) {
  return state.allowedPeriodKeys.reduce<string | undefined>(
    (maximum, periodKey) =>
      maximum === undefined || periodKey > maximum ? periodKey : maximum,
    undefined,
  )
}

function persistedDraft(draft: EditableSetupDraft): SaveSetupDraftInput {
  return {
    periodKey: draft.periodKey,
    salaryReferenceAmount: draft.salaryReferenceAmount ?? 0,
    account: {
      ...draft.account,
      openingBalance: draft.account.openingBalance ?? 0,
    },
  }
}

function confirmationInput(draft: EditableSetupDraft): CompleteSetupInput {
  return {
    periodKey: draft.periodKey,
    salaryReferenceAmount: draft.salaryReferenceAmount ?? 0,
    account: {
      name: draft.account.name,
      bank: draft.account.bank,
      openingBalance: draft.account.openingBalance ?? 0,
      emoji: draft.account.emoji,
    },
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
  const canSubmit =
    draft.periodKey.length > 0 && draft.account.name.trim().length > 0

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

  function updateAccount(changes: Partial<EditableAccount>) {
    updateDraft({
      ...draft,
      account: { ...draft.account, ...changes },
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
        <h1 id="setup-title" className="type-page-title">Comienza en Perita</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cuéntanos con cuánto partes y Perita preparará tu primer período.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form className="space-y-5" onSubmit={submit}>
            <div className="space-y-2">
              <Label htmlFor="setup-period">Mes inicial</Label>
              <Input
                id="setup-period"
                type="month"
                required
                max={maximumAllowedPeriodKey(state)}
                value={draft.periodKey}
                onChange={(event) => updateDraft({
                  ...draft,
                  periodKey: event.currentTarget.value,
                })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="setup-salary">Sueldo previsto</Label>
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
              <Label htmlFor={`setup-account-name-${draft.account.id}`}>
                Nombre de la cuenta
              </Label>
              <Input
                id={`setup-account-name-${draft.account.id}`}
                value={draft.account.name}
                onChange={(event) => updateAccount({
                  name: event.currentTarget.value,
                })}
                placeholder="Ej. Cuenta principal"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`setup-account-bank-${draft.account.id}`}>
                Banco o institución (opcional)
              </Label>
              <FinancialInstitutionField
                id={`setup-account-bank-${draft.account.id}`}
                value={draft.account.bank}
                onValueChange={(value) => updateAccount({ bank: value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`setup-account-balance-${draft.account.id}`}>
                Saldo actual
              </Label>
              <ClpAmountInput
                id={`setup-account-balance-${draft.account.id}`}
                allowNegative
                value={draft.account.openingBalance}
                onValueChange={(value) => updateAccount({ openingBalance: value })}
              />
            </div>

            {draft.account.openingBalance !== null && draft.account.openingBalance < 0 ? (
              <Alert>
                <AlertTriangle aria-hidden="true" />
                <AlertTitle>Saldo inicial negativo</AlertTitle>
                <AlertDescription>
                  Es una apertura excepcional permitida durante setup.
                </AlertDescription>
              </Alert>
            ) : null}

            {error ? (
              <ErrorMessage title="No se pudo completar la configuración" description={error} />
            ) : null}
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={!canSubmit || confirming}
            >
              {confirming ? "Comenzando…" : "Comenzar"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </section>
  )
}

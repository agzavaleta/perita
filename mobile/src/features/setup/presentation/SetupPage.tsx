import { useState, type FormEvent } from "react"
import { AlertTriangle, Landmark, Sparkles } from "lucide-react"

import { EmptyState } from "@/components/states/EmptyState"
import { ErrorMessage } from "@/components/states/ErrorMessage"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  SetupResult,
  SetupState,
  SetupUseCasesPort,
} from "@/features/setup/application/setup-use-cases"

function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No fue posible completar la configuración inicial."
}

function periodLabel(periodKey: string) {
  const [year, month] = periodKey.split("-").map(Number)
  return new Intl.DateTimeFormat("es-CL", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)))
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
  const [periodKey, setPeriodKey] = useState(state.allowedPeriodKeys[0])
  const [salary, setSalary] = useState("0")
  const [budget, setBudget] = useState("0")
  const [accountName, setAccountName] = useState("")
  const [bank, setBank] = useState("")
  const [openingBalance, setOpeningBalance] = useState("0")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const negativeOpening = Number(openingBalance) < 0

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const result = await useCases.completeSetup({
        periodKey,
        salaryReferenceAmount: Number(salary),
        plannedSalaryAmount: Number(budget),
        accounts: [{
          name: accountName,
          bank,
          openingBalance: Number(openingBalance),
        }],
      })
      onCompleted(result)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-6 py-section" aria-labelledby="setup-title">
      <div>
        <h1 id="setup-title" className="type-page-title">Inicio</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Prepara la base financiera de Perita.
        </p>
      </div>

      {state.status === "incomplete" ? (
        <ErrorMessage
          title="Configuración incompleta"
          description="Perita bloqueó la operación normal porque encontró una instalación parcial. Restaura un respaldo válido o elimina los datos desde una herramienta de recuperación."
        />
      ) : (
        <>
          <EmptyState
            title="Comencemos con lo esencial"
            description="Define el período y tu primera cuenta. Los saldos iniciales quedarán como apertura, no como movimientos."
          />
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Sparkles aria-hidden="true" className="size-5 text-brand" />
                <CardTitle>Configuración inicial</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={submit}>
                <div className="space-y-2">
                  <Label>Período inicial</Label>
                  <Select
                    value={periodKey}
                    onValueChange={(value) => setPeriodKey(value as typeof periodKey)}
                    disabled={saving}
                  >
                    <SelectTrigger className="w-full" aria-label="Período inicial">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {state.allowedPeriodKeys.map((key) => (
                        <SelectItem key={key} value={key}>
                          {periodLabel(key)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="setup-salary">Sueldo de referencia</Label>
                    <Input
                      id="setup-salary"
                      type="number"
                      inputMode="numeric"
                      min="0"
                      step="1"
                      value={salary}
                      onChange={(event) => setSalary(event.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="setup-budget">Presupuesto del período</Label>
                    <Input
                      id="setup-budget"
                      type="number"
                      inputMode="numeric"
                      min="0"
                      step="1"
                      value={budget}
                      onChange={(event) => setBudget(event.target.value)}
                      disabled={saving}
                    />
                  </div>
                </div>
                <div className="border-t pt-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Landmark aria-hidden="true" className="size-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold">Primera cuenta</h2>
                  </div>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="setup-account-name">Nombre</Label>
                      <Input
                        id="setup-account-name"
                        value={accountName}
                        onChange={(event) => setAccountName(event.target.value)}
                        placeholder="Ej. Cuenta principal"
                        disabled={saving}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="setup-bank">Banco o institución</Label>
                      <Input
                        id="setup-bank"
                        value={bank}
                        onChange={(event) => setBank(event.target.value)}
                        placeholder="Opcional"
                        disabled={saving}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="setup-opening-balance">Saldo inicial CLP</Label>
                      <Input
                        id="setup-opening-balance"
                        type="number"
                        inputMode="numeric"
                        step="1"
                        value={openingBalance}
                        onChange={(event) => setOpeningBalance(event.target.value)}
                        disabled={saving}
                      />
                    </div>
                  </div>
                </div>
                {negativeOpening ? (
                  <Alert>
                    <AlertTriangle aria-hidden="true" />
                    <AlertTitle>Saldo inicial negativo</AlertTitle>
                    <AlertDescription>
                      Se conservará como apertura excepcional del setup. Las correcciones posteriores deberán dejar un saldo no negativo y quedarán trazadas.
                    </AlertDescription>
                  </Alert>
                ) : null}
                {error ? <ErrorMessage title="No se pudo configurar" description={error} /> : null}
                <Button
                  type="submit"
                  size="lg"
                  className="w-full"
                  disabled={saving || !accountName.trim()}
                >
                  {saving ? "Configurando…" : "Comenzar a usar Perita"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </>
      )}
    </section>
  )
}

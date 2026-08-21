import { useEffect, useRef, useState } from "react"
import {
  CircleAlert,
  Database,
  Download,
  Info,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react"

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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { ErrorMessage } from "@/components/states/ErrorMessage"
import { LoadingState } from "@/components/states/LoadingState"
import { DOMAIN_VERSION } from "@/domain/constants"
import { createSettingsModule, type SettingsModule } from "@/features/settings/application/bootstrap"
import type { PeritaBackup } from "@/features/settings/application/backup"
import type { SettingsUseCasesPort } from "@/features/settings/application/settings-use-cases"

interface SettingsPageProps {
  readonly useCases?: SettingsUseCasesPort
}

type Notice = { readonly kind: "success" | "error"; readonly text: string } | null

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "No fue posible completar la acción."
}

function saveJsonFile(backup: PeritaBackup, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function backupFilename(prefix = "perita-v1.1.0") {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.json`
}

export function SettingsPage({ useCases: injectedUseCases }: SettingsPageProps) {
  const [module, setModule] = useState<SettingsModule | null>(null)
  const useCases = injectedUseCases ?? module?.useCases ?? null
  const [salary, setSalary] = useState("0")
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [lastBackup, setLastBackup] = useState<PeritaBackup | null>(null)
  const [importCandidate, setImportCandidate] = useState<unknown>(null)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [confirmation, setConfirmation] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (injectedUseCases) return
    let active = true
    let created: SettingsModule | null = null
    void createSettingsModule().then((next) => {
      created = next
      if (active) setModule(next)
      else next.dispose()
    }).catch((error) => {
      if (active) setNotice({ kind: "error", text: errorMessage(error) })
    })
    return () => { active = false; created?.dispose() }
  }, [injectedUseCases])

  useEffect(() => {
    if (!useCases) return
    let active = true
    void useCases.getSettings().then((settings) => {
      if (!active) return
      setSalary(String(settings?.salaryReferenceAmount ?? 0))
      setLoaded(true)
    }).catch((error) => {
      if (active) setNotice({ kind: "error", text: errorMessage(error) })
    })
    return () => { active = false }
  }, [useCases])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setNotice(null)
    try { await action() } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) })
    } finally { setBusy(false) }
  }

  function download(backup: PeritaBackup, filename: string) {
    try { saveJsonFile(backup, filename) } catch {
      // The generated backup remains available for tests or restricted webviews.
    }
  }

  async function exportData() {
    if (!useCases) return
    await run(async () => {
      const backup = await useCases.exportBackup()
      download(backup, backupFilename())
      setLastBackup(backup)
      setNotice({ kind: "success", text: "Respaldo generado. Verifica que el archivo se haya guardado." })
    })
  }

  async function selectImport(file: File | undefined) {
    if (!file || !useCases) return
    await run(async () => {
      const value = await file.text()
      const validation = await useCases.validateBackup(value)
      if (validation.status !== "valid") throw new Error(validation.errors[0])
      const preventive = await useCases.exportBackup()
      download(preventive, backupFilename("perita-pre-restauracion"))
      setImportCandidate(validation.backup)
      setRestoreOpen(true)
    })
    if (fileInput.current) fileInput.current.value = ""
  }

  async function restoreData() {
    if (!useCases || !importCandidate) return
    setRestoreOpen(false)
    await run(async () => {
      await useCases.restoreBackup(importCandidate)
      setNotice({ kind: "success", text: "Respaldo restaurado y validado correctamente." })
      setImportCandidate(null)
      setLoaded(false)
      const settings = await useCases.getSettings()
      setSalary(String(settings?.salaryReferenceAmount ?? 0))
      setLoaded(true)
    })
  }

  async function deleteData() {
    if (!useCases || !lastBackup) return
    setDeleteOpen(false)
    await run(async () => {
      await useCases.deleteAllData(lastBackup, confirmation)
      setSalary("0")
      setConfirmation("")
      setLastBackup(null)
      setNotice({ kind: "success", text: "Todos los datos de Perita Mobile fueron eliminados." })
    })
  }

  if (!loaded && !notice) {
    return <section className="space-y-section py-section"><h1 className="type-page-title">Configuración</h1><LoadingState label="Cargando configuración" /></section>
  }

  return (
    <section className="space-y-6 py-section" aria-labelledby="settings-title">
      <div>
        <h1 id="settings-title" className="type-page-title">Configuración</h1>
        <p className="mt-1 text-sm text-muted-foreground">Preferencias, respaldo y administración de tus datos.</p>
      </div>

      {notice?.kind === "error" ? <ErrorMessage title="No se pudo completar la acción" description={notice.text} /> : null}
      {notice?.kind === "success" ? <div role="status" className="rounded-surface border bg-surface-subtle p-card text-sm"><ShieldCheck className="mr-2 inline size-4" aria-hidden="true" />{notice.text}</div> : null}

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Settings2 className="size-4" aria-hidden="true" />Configuración general</CardTitle><CardDescription>El sueldo mensual de referencia permitido por V1.1.0.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2"><Label htmlFor="salary">Sueldo mensual (CLP)</Label><Input id="salary" inputMode="numeric" type="number" min="0" step="1" value={salary} onChange={(event) => setSalary(event.target.value)} /></div>
          <Button className="w-full" disabled={busy || !useCases} onClick={() => void run(async () => {
            const next = await useCases!.updateReferenceSalary(Number(salary))
            setSalary(String(next.salaryReferenceAmount))
            setNotice({ kind: "success", text: "Configuración guardada." })
          })}><Save aria-hidden="true" />Guardar</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Database className="size-4" aria-hidden="true" />Respaldo y restauración</CardTitle><CardDescription>Archivo externo completo V1.1.0. Exportar no cambia tus datos.</CardDescription></CardHeader>
        <CardContent className="grid gap-3">
          <Button variant="outline" disabled={busy || !useCases} onClick={() => void exportData()}><Download aria-hidden="true" />Exportar respaldo</Button>
          <Button variant="outline" disabled={busy || !useCases} onClick={() => fileInput.current?.click()}><Upload aria-hidden="true" />Importar respaldo</Button>
          <input ref={fileInput} className="sr-only" type="file" accept="application/json,.json" aria-label="Seleccionar respaldo" onChange={(event) => void selectImport(event.target.files?.[0])} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-destructive"><Trash2 className="size-4" aria-hidden="true" />Eliminación definitiva</CardTitle><CardDescription>No existe papelera ni deshacer. Primero debes guardar un respaldo externo válido.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2"><Label htmlFor="delete-confirmation">Escribe ELIMINAR</Label><Input id="delete-confirmation" autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div>
          <Button variant="destructive" className="w-full" disabled={busy || confirmation !== "ELIMINAR" || !lastBackup} onClick={() => setDeleteOpen(true)}><Trash2 aria-hidden="true" />Eliminar definitivamente</Button>
          {!lastBackup ? <p className="text-xs text-muted-foreground">Exporta un respaldo en esta sesión para habilitar esta acción.</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Info className="size-4" aria-hidden="true" />Información de la aplicación</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Aplicación</span><span className="font-medium">Perita Mobile</span></div><Separator />
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Contrato de datos</span><Badge variant="secondary">v{DOMAIN_VERSION}</Badge></div><Separator />
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Moneda y zona</span><span className="font-medium">CLP · Chile</span></div>
        </CardContent>
      </Card>

      <AlertDialog open={restoreOpen} onOpenChange={setRestoreOpen}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogMedia><RotateCcw aria-hidden="true" /></AlertDialogMedia><AlertDialogTitle>Restaurar respaldo</AlertDialogTitle><AlertDialogDescription>Se descargó un respaldo preventivo del estado actual. Confirma que quedó guardado antes de reemplazar completamente la base. No se mezclarán datos.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void restoreData()}>Respaldo guardado; restaurar</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogMedia><CircleAlert aria-hidden="true" /></AlertDialogMedia><AlertDialogTitle>Eliminación definitiva</AlertDialogTitle><AlertDialogDescription>Se eliminarán todos los datos de Perita Mobile. Solo podrás recuperarlos importando el respaldo externo.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void deleteData()}>Eliminar definitivamente</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

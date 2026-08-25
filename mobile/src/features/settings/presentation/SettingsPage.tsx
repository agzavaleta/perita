import { useEffect, useRef, useState, type FormEvent } from "react"
import {
  CircleAlert,
  Database,
  Download,
  FolderCog,
  Info,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
  Upload,
} from "lucide-react"

import { ClpAmountInput } from "@/components/finance/ClpAmountInput"
import { FormSheetContent } from "@/components/forms/FormSheetContent"
import { useUnsavedChangesGuard } from "@/components/forms/useUnsavedChangesGuard"
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { DOMAIN_VERSION } from "@/domain/constants"
import type { Category } from "@/domain/entities"
import { createSettingsModule, type SettingsModule } from "@/features/settings/application/bootstrap"
import type { PeritaBackup } from "@/features/settings/application/backup"
import type { CategoryUseCasesPort } from "@/features/settings/application/category-use-cases"
import type { SettingsUseCasesPort } from "@/features/settings/application/settings-use-cases"
import { toast } from "sonner"

interface SettingsPageProps {
  readonly useCases?: SettingsUseCasesPort
  readonly categoryUseCases?: CategoryUseCasesPort
}

type Notice = { readonly kind: "error"; readonly text: string } | null

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

type CategoryEditor = { readonly kind: "create" } | {
  readonly kind: "rename"
  readonly category: Category
}

export function SettingsPage({
  useCases: injectedUseCases,
  categoryUseCases: injectedCategoryUseCases,
}: SettingsPageProps) {
  const [module, setModule] = useState<SettingsModule | null>(null)
  const useCases = injectedUseCases ?? module?.useCases ?? null
  const categoryUseCases = injectedCategoryUseCases ?? module?.categoryUseCases ?? null
  const [salary, setSalary] = useState<number | null>(0)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [lastBackup, setLastBackup] = useState<PeritaBackup | null>(null)
  const [importCandidate, setImportCandidate] = useState<unknown>(null)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [confirmation, setConfirmation] = useState("")
  const [categories, setCategories] = useState<Category[]>([])
  const [categoriesLoaded, setCategoriesLoaded] = useState(false)
  const [categoryError, setCategoryError] = useState<string | null>(null)
  const [categoryEditor, setCategoryEditor] = useState<CategoryEditor | null>(null)
  const [categoryName, setCategoryName] = useState("")
  const [categoryFormError, setCategoryFormError] = useState<string | null>(null)
  const [categoryBusy, setCategoryBusy] = useState(false)
  const [deactivateTarget, setDeactivateTarget] = useState<Category | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const categoryInitialName =
    categoryEditor?.kind === "rename" ? categoryEditor.category.name : ""
  const categoryGuard = useUnsavedChangesGuard({
    dirty: categoryEditor !== null && categoryName !== categoryInitialName,
    saving: categoryBusy,
    onClose: () => setCategoryEditor(null),
  })

  useEffect(() => {
    if (injectedUseCases || injectedCategoryUseCases) return
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
  }, [injectedCategoryUseCases, injectedUseCases])

  useEffect(() => {
    if (!useCases) return
    let active = true
    void useCases.getSettings().then((settings) => {
      if (!active) return
      setSalary(settings?.salaryReferenceAmount ?? 0)
      setLoaded(true)
    }).catch((error) => {
      if (active) setNotice({ kind: "error", text: errorMessage(error) })
    })
    return () => { active = false }
  }, [useCases])

  useEffect(() => {
    if (!categoryUseCases) return
    let active = true
    void categoryUseCases.listCategories().then((items) => {
      if (!active) return
      setCategories(items)
      setCategoriesLoaded(true)
    }).catch((error) => {
      if (!active) return
      setCategoryError(errorMessage(error))
      setCategoriesLoaded(true)
    })
    return () => { active = false }
  }, [categoryUseCases])

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
      toast.success("Respaldo exportado")
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
      toast.success("Respaldo restaurado")
      setImportCandidate(null)
      setLoaded(false)
      const settings = await useCases.getSettings()
      setSalary(settings?.salaryReferenceAmount ?? 0)
      setLoaded(true)
    })
  }

  async function deleteData() {
    if (!useCases || !lastBackup) return
    setDeleteOpen(false)
    await run(async () => {
      await useCases.deleteAllData(lastBackup, confirmation)
      setSalary(0)
      setConfirmation("")
      setLastBackup(null)
      toast.success("Datos eliminados")
    })
  }

  function openCategoryEditor(editor: CategoryEditor) {
    setCategoryName(editor.kind === "rename" ? editor.category.name : "")
    setCategoryFormError(null)
    setCategoryEditor(editor)
  }

  async function saveCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!categoryUseCases || !categoryEditor || categoryBusy) return
    setCategoryBusy(true)
    setCategoryFormError(null)
    try {
      const saved = categoryEditor.kind === "create"
        ? await categoryUseCases.createCategory(categoryName)
        : await categoryUseCases.renameCategory(
            categoryEditor.category.id,
            categoryEditor.category.revision,
            categoryName,
          )
      setCategories((current) => categoryEditor.kind === "create"
        ? [...current, saved]
        : current.map((category) => category.id === saved.id ? saved : category))
      setCategoryEditor(null)
      setCategoryName("")
      toast.success(categoryEditor.kind === "create" ? "Categoría creada" : "Categoría actualizada")
    } catch (error) {
      setCategoryFormError(errorMessage(error))
    } finally {
      setCategoryBusy(false)
    }
  }

  async function deactivateCategory() {
    if (!categoryUseCases || !deactivateTarget || categoryBusy) return
    const target = deactivateTarget
    setCategoryBusy(true)
    setCategoryError(null)
    try {
      const saved = await categoryUseCases.deactivateCategory(
        target.id,
        target.revision,
      )
      setCategories((current) =>
        current.map((category) => category.id === saved.id ? saved : category),
      )
      setDeactivateTarget(null)
      toast.success("Categoría desactivada")
    } catch (error) {
      setCategoryError(errorMessage(error))
    } finally {
      setCategoryBusy(false)
    }
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

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Settings2 className="size-4" aria-hidden="true" />Configuración general</CardTitle><CardDescription>El sueldo mensual de referencia permitido por V1.1.0.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2"><Label htmlFor="salary">Sueldo mensual (CLP)</Label><ClpAmountInput id="salary" value={salary} onValueChange={setSalary} /></div>
          <Button className="w-full" disabled={busy || !useCases} onClick={() => void run(async () => {
            const next = await useCases!.updateReferenceSalary(salary ?? 0)
            setSalary(next.salaryReferenceAmount)
            toast.success("Configuración guardada")
          })}><Save aria-hidden="true" />Guardar</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                <FolderCog className="size-4" aria-hidden="true" />Categorías
              </CardTitle>
              <CardDescription>Organiza tus gastos variables.</CardDescription>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={!categoryUseCases || categoryBusy}
              onClick={() => openCategoryEditor({ kind: "create" })}
            >
              <Plus aria-hidden="true" />Nueva categoría
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {categoryError ? (
            <ErrorMessage title="No se pudieron cargar las categorías" description={categoryError} />
          ) : !categoriesLoaded ? (
            <LoadingState label="Cargando categorías" />
          ) : categories.length === 0 ? (
            <EmptyState title="No hay categorías" description="Crea una categoría para organizar tus gastos variables." />
          ) : (
            <div className="space-y-2" aria-label="Listado de categorías">
              {categories.map((category) => (
                <div
                  key={category.id}
                  className="flex min-w-0 items-center gap-2 rounded-surface border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{category.name}</p>
                    <Badge
                      className="mt-1"
                      variant={category.status === "active" ? "secondary" : "outline"}
                    >
                      {category.status === "active" ? "Activa" : "Inactiva"}
                    </Badge>
                  </div>
                  {category.status === "active" ? (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={categoryBusy}
                        aria-label={`Editar ${category.name}`}
                        onClick={() => openCategoryEditor({ kind: "rename", category })}
                      >
                        <Pencil aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={categoryBusy}
                        aria-label={`Desactivar ${category.name}`}
                        onClick={() => setDeactivateTarget(category)}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
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

      <Sheet
        open={categoryEditor !== null}
        onOpenChange={(open) => {
          if (!open) categoryGuard.requestClose()
        }}
      >
        <FormSheetContent>
          <SheetHeader>
            <SheetTitle>
              {categoryEditor?.kind === "rename" ? "Editar categoría" : "Nueva categoría"}
            </SheetTitle>
            <SheetDescription>
              {categoryEditor?.kind === "rename"
                ? "Actualiza el nombre usado para organizar gastos variables."
                : "Agrega una categoría para tus próximos gastos variables."}
            </SheetDescription>
          </SheetHeader>
          <form onSubmit={(event) => void saveCategory(event)}>
            <div className="space-y-2 px-4">
              <Label htmlFor="category-name">Nombre</Label>
              <Input
                id="category-name"
                required
                value={categoryName}
                disabled={categoryBusy}
                aria-invalid={categoryFormError ? true : undefined}
                onChange={(event) => setCategoryName(event.target.value)}
              />
              {categoryFormError ? (
                <p className="text-sm text-destructive" role="alert">{categoryFormError}</p>
              ) : null}
            </div>
            <SheetFooter>
              <Button type="submit" disabled={categoryBusy || !categoryName.trim()}>
                <Save aria-hidden="true" />
                {categoryBusy ? "Guardando…" : "Guardar categoría"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={categoryBusy}
                onClick={categoryGuard.requestClose}
              >
                Cancelar
              </Button>
            </SheetFooter>
          </form>
        </FormSheetContent>
      </Sheet>
      {categoryGuard.confirmation}

      <AlertDialog
        open={deactivateTarget !== null}
        onOpenChange={(open) => {
          if (!open && !categoryBusy) setDeactivateTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia><CircleAlert aria-hidden="true" /></AlertDialogMedia>
            <AlertDialogTitle>Desactivar categoría</AlertDialogTitle>
            <AlertDialogDescription>
              Ya no estará disponible para nuevos gastos. Los gastos históricos conservarán esta categoría.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={categoryBusy}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={categoryBusy}
              onClick={(event) => {
                event.preventDefault()
                void deactivateCategory()
              }}
            >
              {categoryBusy ? "Desactivando…" : "Desactivar categoría"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={restoreOpen} onOpenChange={setRestoreOpen}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogMedia><RotateCcw aria-hidden="true" /></AlertDialogMedia><AlertDialogTitle>Restaurar respaldo</AlertDialogTitle><AlertDialogDescription>Se descargó un respaldo preventivo del estado actual. Confirma que quedó guardado antes de reemplazar completamente la base. No se mezclarán datos.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void restoreData()}>Respaldo guardado; restaurar</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogMedia><CircleAlert aria-hidden="true" /></AlertDialogMedia><AlertDialogTitle>Eliminación definitiva</AlertDialogTitle><AlertDialogDescription>Se eliminarán todos los datos de Perita Mobile. Solo podrás recuperarlos importando el respaldo externo.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void deleteData()}>Eliminar definitivamente</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

import { useCallback, useState } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

export function useUnsavedChangesGuard({
  dirty,
  saving,
  onClose,
}: {
  readonly dirty: boolean
  readonly saving: boolean
  readonly onClose: () => void
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  const requestClose = useCallback(() => {
    if (saving) return
    if (dirty) {
      setConfirmingDiscard(true)
      return
    }
    onClose()
  }, [dirty, onClose, saving])

  const confirmation = (
    <AlertDialog
      open={confirmingDiscard}
      onOpenChange={(open) => !saving && setConfirmingDiscard(open)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>¿Descartar cambios?</AlertDialogTitle>
          <AlertDialogDescription>
            Los cambios que hiciste no se guardarán.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Seguir editando</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={saving}
            onClick={() => {
              setConfirmingDiscard(false)
              onClose()
            }}
          >
            Descartar cambios
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { requestClose, confirmation }
}

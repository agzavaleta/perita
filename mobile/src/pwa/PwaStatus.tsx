import { useEffect, useState } from "react"
import { Download, RefreshCw, Wifi, WifiOff, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { PwaController, type PwaState } from "@/pwa/pwa-controller"

const INITIAL_STATE: PwaState = {
  canInstall: false,
  iosInstallHint: false,
  offline: false,
  offlineReady: false,
  updateAvailable: false,
}

export function PwaStatus() {
  const [controller] = useState(() => new PwaController())
  const [state, setState] = useState(INITIAL_STATE)

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState)
    void controller.start().catch(() => undefined)
    return () => {
      unsubscribe()
      controller.dispose()
    }
  }, [controller])

  if (state.updateAvailable) {
    return (
      <aside className="flex flex-wrap items-center gap-3 border-b bg-brand-soft px-4 py-2 text-sm" aria-live="polite">
        <RefreshCw className="size-4 shrink-0 text-brand" aria-hidden="true" />
        <p className="min-w-0 flex-1">Hay una nueva versión de Perita.</p>
        <div className="grid w-full grid-cols-2 gap-2 min-[400px]:flex min-[400px]:w-auto">
          <Button size="sm" variant="ghost" onClick={() => controller.dismissUpdate()}>Después</Button>
          <Button size="sm" onClick={() => void controller.acceptUpdate()}>Actualizar ahora</Button>
        </div>
      </aside>
    )
  }

  if (state.offline) {
    return (
      <aside className="flex items-center gap-2 border-b bg-muted px-4 py-2 text-sm" role="status">
        <WifiOff className="size-4" aria-hidden="true" />
        Sin conexión · tus datos locales siguen disponibles
      </aside>
    )
  }

  if (state.canInstall) {
    return (
      <aside className="flex items-center gap-3 border-b bg-surface-subtle px-4 py-2 text-sm" aria-live="polite">
        <Download className="size-4 shrink-0 text-brand" aria-hidden="true" />
        <p className="min-w-0 flex-1">Instala Perita para abrirla como app.</p>
        <Button size="sm" onClick={() => void controller.install()}>Instalar</Button>
        <Button size="icon-sm" variant="ghost" aria-label="Cerrar aviso de instalación" onClick={() => controller.dismissInstall()}><X aria-hidden="true" /></Button>
      </aside>
    )
  }

  if (state.iosInstallHint) {
    return (
      <aside className="flex items-center gap-3 border-b bg-surface-subtle px-4 py-2 text-sm" aria-live="polite">
        <Download className="size-4 shrink-0 text-brand" aria-hidden="true" />
        <p className="min-w-0 flex-1">En iPhone o iPad: Compartir → Agregar a inicio.</p>
        <Button size="icon-sm" variant="ghost" aria-label="Cerrar aviso de instalación" onClick={() => controller.dismissInstall()}><X aria-hidden="true" /></Button>
      </aside>
    )
  }

  if (state.offlineReady) {
    return (
      <aside className="flex items-center gap-3 border-b bg-surface-subtle px-4 py-2 text-sm" role="status">
        <Wifi className="size-4 shrink-0 text-brand" aria-hidden="true" />
        <p className="min-w-0 flex-1">Perita está lista para usarse offline.</p>
        <Button size="icon-sm" variant="ghost" aria-label="Cerrar aviso" onClick={() => controller.dismissOfflineReady()}><X aria-hidden="true" /></Button>
      </aside>
    )
  }

  return null
}

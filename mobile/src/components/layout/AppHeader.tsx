import { Settings } from "lucide-react"

import type { AppSection } from "@/app/navigation"
import { Button } from "@/components/ui/button"

type AppHeaderProps = {
  activeSection: AppSection
  onOpenSettings: () => void
}

const SECTION_TITLES: Record<AppSection, string> = {
  home: "Inicio",
  accounts: "Cuentas",
  planning: "Planificar",
  movements: "Movimientos",
  settings: "Configuración",
}

export function AppHeader({ activeSection, onOpenSettings }: AppHeaderProps) {
  return (
    <header className="shrink-0 border-b bg-background pt-[env(safe-area-inset-top)]">
      <div className="flex h-14 items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <img
            src="/apple-touch-icon-v2.png"
            alt=""
            className="size-8 shrink-0 rounded-lg"
          />
          <h1 className="text-lg font-semibold tracking-tight">
            {SECTION_TITLES[activeSection]}
          </h1>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-label="Configuración"
          onClick={onOpenSettings}
        >
          <Settings aria-hidden="true" className="size-5" />
        </Button>
      </div>
    </header>
  )
}

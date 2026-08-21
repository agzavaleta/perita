import { Settings } from "lucide-react"

import { Button } from "@/components/ui/button"

type AppHeaderProps = {
  onOpenSettings: () => void
}

export function AppHeader({ onOpenSettings }: AppHeaderProps) {
  return (
    <header className="shrink-0 border-b bg-background pt-[env(safe-area-inset-top)]">
      <div className="flex h-14 items-center justify-between px-4">
        <p className="text-lg font-semibold tracking-tight">Perita</p>
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

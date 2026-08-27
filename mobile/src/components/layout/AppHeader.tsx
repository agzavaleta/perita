import { Search, Settings, SlidersHorizontal, X } from "lucide-react"

import type { AppSection } from "@/app/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export type MovementHeaderControls = {
  readonly query: string
  readonly searchOpen: boolean
  readonly filtersOpen: boolean
  readonly onQueryChange: (query: string) => void
  readonly onSearchOpenChange: (open: boolean) => void
  readonly onFiltersOpenChange: (open: boolean) => void
}

type AppHeaderProps = {
  activeSection: AppSection
  movementControls?: MovementHeaderControls
  onOpenSettings: () => void
}

const SECTION_TITLES: Record<AppSection, string> = {
  home: "Inicio",
  accounts: "Cuentas",
  planning: "Planificar",
  movements: "Movimientos",
  settings: "Configuración",
}

export function AppHeader({
  activeSection,
  movementControls,
  onOpenSettings,
}: AppHeaderProps) {
  const movementActions = activeSection === "movements" ? movementControls : undefined

  function closeSearch() {
    if (!movementControls) return
    movementControls.onQueryChange("")
    movementControls.onSearchOpenChange(false)
  }

  return (
    <header className="shrink-0 overflow-x-hidden border-b bg-background pt-[env(safe-area-inset-top)]">
      <div className="flex h-14 min-w-0 items-center justify-between gap-2 px-4">
        {movementActions?.searchOpen ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <img
              src="/apple-touch-icon-v2.png"
              alt=""
              className="size-8 shrink-0 rounded-lg"
            />
            <div className="relative min-w-0 flex-1">
              <Search
                aria-hidden="true"
                className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                autoFocus
                aria-label="Buscar movimientos"
                value={movementActions.query}
                onChange={(event) => movementActions.onQueryChange(event.target.value)}
                placeholder="Buscar movimientos"
                className="h-10 min-w-0 pl-9"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label="Cerrar búsqueda"
              onClick={closeSearch}
            >
              <X aria-hidden="true" className="size-5" />
            </Button>
          </div>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <img
                src="/apple-touch-icon-v2.png"
                alt=""
                className="size-8 shrink-0 rounded-lg"
              />
              <h1 className="truncate text-lg font-semibold tracking-tight">
                {SECTION_TITLES[activeSection]}
              </h1>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {movementActions ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-lg"
                    aria-label="Buscar"
                    onClick={() => movementActions.onSearchOpenChange(true)}
                  >
                    <Search aria-hidden="true" className="size-5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-lg"
                    aria-label="Filtros"
                    aria-expanded={movementActions.filtersOpen}
                    onClick={() => movementActions.onFiltersOpenChange(true)}
                  >
                    <SlidersHorizontal aria-hidden="true" className="size-5" />
                  </Button>
                </>
              ) : null}
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
          </>
        )}
      </div>
    </header>
  )
}

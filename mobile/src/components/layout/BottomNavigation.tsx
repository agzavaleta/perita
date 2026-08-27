import {
  CalendarCheck2,
  House,
  Plus,
  ReceiptText,
  WalletCards,
  type LucideIcon,
} from "lucide-react"

import type { AppSection } from "@/app/navigation"
import type { QuickAction } from "@/app/quick-actions"
import { QuickActionsSheet } from "@/components/layout/QuickActionsSheet"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type NavigationItem = {
  section: Exclude<AppSection, "settings">
  label: string
  icon: LucideIcon
}

const navigationItems: NavigationItem[] = [
  { section: "home", label: "Inicio", icon: House },
  { section: "accounts", label: "Cuentas", icon: WalletCards },
  { section: "planning", label: "Planificar", icon: CalendarCheck2 },
  { section: "movements", label: "Movimientos", icon: ReceiptText },
]

type NavigationButtonProps = NavigationItem & {
  active: boolean
  onSelect: (section: AppSection) => void
}

function NavigationButton({
  section,
  label,
  icon: Icon,
  active,
  onSelect,
}: NavigationButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(section)}
      className={cn(
        "h-14 min-w-0 flex-col gap-1 rounded-none px-0.5 text-[0.625rem] text-muted-foreground min-[360px]:px-1 min-[360px]:text-[0.6875rem]",
        active && "text-brand hover:text-brand",
      )}
    >
      <Icon aria-hidden="true" className="size-5" />
      <span className="max-w-full whitespace-nowrap">{label}</span>
    </Button>
  )
}

type BottomNavigationProps = {
  activeSection: AppSection
  onNavigate: (section: AppSection) => void
  onQuickAction: (action: QuickAction) => void
}

export function BottomNavigation({
  activeSection,
  onNavigate,
  onQuickAction,
}: BottomNavigationProps) {
  const [home, accounts, planning, movements] = navigationItems

  return (
    <nav
      aria-label="Navegación principal"
      className="bottom-navigation fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-[430px] border-t bg-card pb-[env(safe-area-inset-bottom)]"
    >
      <div className="grid h-16 grid-cols-5 items-end">
        <NavigationButton
          {...home}
          active={activeSection === home.section}
          onSelect={onNavigate}
        />
        <NavigationButton
          {...accounts}
          active={activeSection === accounts.section}
          onSelect={onNavigate}
        />
        <QuickActionsSheet onSelect={onQuickAction}>
          <Button
            type="button"
            size="icon-lg"
            aria-label="Agregar movimiento"
            className="-mt-4 size-14 rounded-full bg-brand text-brand-foreground shadow-md hover:bg-brand/90"
          >
            <Plus aria-hidden="true" className="size-6" />
          </Button>
        </QuickActionsSheet>
        <NavigationButton
          {...planning}
          active={activeSection === planning.section}
          onSelect={onNavigate}
        />
        <NavigationButton
          {...movements}
          active={activeSection === movements.section}
          onSelect={onNavigate}
        />
      </div>
    </nav>
  )
}

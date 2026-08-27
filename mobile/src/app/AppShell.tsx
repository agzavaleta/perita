import { useEffect, type ReactNode } from "react"

import type { AppSection } from "@/app/navigation"
import type { QuickAction } from "@/app/quick-actions"
import {
  AppHeader,
  type MovementHeaderControls,
} from "@/components/layout/AppHeader"
import { BottomNavigation } from "@/components/layout/BottomNavigation"
import { installIosViewportRecovery } from "@/lib/ios-viewport-recovery"
import { PwaStatus } from "@/pwa/PwaStatus"

type AppShellProps = {
  activeSection: AppSection
  children: ReactNode
  movementControls: MovementHeaderControls
  onNavigate: (section: AppSection) => void
  onOpenSettings: () => void
  onQuickAction: (action: QuickAction) => void
}

export function AppShell({
  activeSection,
  children,
  movementControls,
  onNavigate,
  onOpenSettings,
  onQuickAction,
}: AppShellProps) {
  useEffect(() => installIosViewportRecovery(), [])

  return (
    <div className="app-shell mx-auto flex min-h-0 w-full max-w-[430px] flex-col overflow-hidden border-x bg-background shadow-sm">
      <AppHeader
        activeSection={activeSection}
        movementControls={movementControls}
        onOpenSettings={onOpenSettings}
      />
      <PwaStatus />
      <main
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] scroll-pb-[calc(6rem+env(safe-area-inset-bottom))]"
      >
        {children}
      </main>
      <BottomNavigation
        activeSection={activeSection}
        onNavigate={onNavigate}
        onQuickAction={onQuickAction}
      />
    </div>
  )
}

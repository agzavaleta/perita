import type { ReactNode } from "react"

import type { AppSection } from "@/app/navigation"
import type { QuickAction } from "@/app/quick-actions"
import { AppHeader } from "@/components/layout/AppHeader"
import { BottomNavigation } from "@/components/layout/BottomNavigation"
import { PwaStatus } from "@/pwa/PwaStatus"

type AppShellProps = {
  activeSection: AppSection
  children: ReactNode
  onNavigate: (section: AppSection) => void
  onOpenSettings: () => void
  onQuickAction: (action: QuickAction) => void
}

export function AppShell({
  activeSection,
  children,
  onNavigate,
  onOpenSettings,
  onQuickAction,
}: AppShellProps) {
  return (
    <div className="app-shell mx-auto flex w-full max-w-[430px] flex-col overflow-hidden border-x bg-background shadow-sm">
      <AppHeader onOpenSettings={onOpenSettings} />
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

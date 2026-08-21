import { lazy, Suspense, useEffect, useState } from "react"

import { AppShell } from "@/app/AppShell"
import type { AppSection } from "@/app/navigation"
import type { QuickAction } from "@/app/quick-actions"
import { HomePage } from "@/features/home/presentation/HomePage"
import { LoadingState } from "@/components/states/LoadingState"
import { ErrorMessage } from "@/components/states/ErrorMessage"
import {
  createSetupModule,
  type SetupModule,
} from "@/features/setup/application/bootstrap"
import type {
  SetupState,
  SetupUseCasesPort,
} from "@/features/setup/application/setup-use-cases"
import { SetupPage } from "@/features/setup/presentation/SetupPage"

const AccountsPage = lazy(() =>
  import("@/features/accounts/presentation/AccountsPage").then((module) => ({
    default: module.AccountsPage,
  })),
)
const MovementsPage = lazy(() =>
  import("@/features/movements/presentation/MovementsPage").then((module) => ({
    default: module.MovementsPage,
  })),
)
const PlanningPage = lazy(() =>
  import("@/features/planning/presentation/PlanningPage").then((module) => ({
    default: module.PlanningPage,
  })),
)
const SettingsPage = lazy(() =>
  import("@/features/settings/presentation/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
)

function AppContent({
  section,
  quickAction,
  onQuickActionClose,
  onMoveMoney,
  onNavigate,
  onRegisterIncome,
}: {
  section: AppSection
  quickAction: QuickAction | null
  onQuickActionClose: () => void
  onMoveMoney: () => void
  onNavigate: (section: AppSection) => void
  onRegisterIncome: () => void
}) {
  let content

  if (section === "home") {
    content = (
      <HomePage
        onNavigate={onNavigate}
        onRegisterIncome={onRegisterIncome}
      />
    )
  } else if (section === "accounts") {
    content = <AccountsPage />
  } else if (section === "movements") {
    content = (
      <MovementsPage
        initialComposer={quickAction}
        onInitialComposerClose={onQuickActionClose}
      />
    )
  } else if (section === "planning") {
    content = <PlanningPage onMoveMoney={onMoveMoney} />
  } else {
    content = <SettingsPage />
  }

  return <Suspense fallback={<LoadingState label="Cargando sección" />}>{content}</Suspense>
}

export function App({ setupUseCases: injectedSetupUseCases }: {
  readonly setupUseCases?: SetupUseCasesPort
} = {}) {
  const [activeSection, setActiveSection] = useState<AppSection>("home")
  const [quickAction, setQuickAction] = useState<
    QuickAction | null
  >(null)
  const [setupModule, setSetupModule] = useState<SetupModule | null>(null)
  const setupUseCases = injectedSetupUseCases ?? setupModule?.useCases ?? null
  const [setupState, setSetupState] = useState<SetupState | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)

  useEffect(() => {
    if (injectedSetupUseCases) return
    let active = true
    let createdModule: SetupModule | null = null
    void createSetupModule()
      .then((module) => {
        createdModule = module
        if (active) setSetupModule(module)
        else module.dispose()
      })
      .catch((cause) => {
        if (active) setSetupError(cause instanceof Error ? cause.message : "No fue posible abrir Perita.")
      })
    return () => {
      active = false
      createdModule?.dispose()
    }
  }, [injectedSetupUseCases])

  useEffect(() => {
    if (!setupUseCases) return
    let active = true
    void setupUseCases
      .getState()
      .then((state) => {
        if (active) setSetupState(state)
      })
      .catch((cause) => {
        if (active) setSetupError(cause instanceof Error ? cause.message : "No fue posible validar la configuración.")
      })
    return () => {
      active = false
    }
  }, [setupUseCases])

  function openQuickAction(action: QuickAction) {
    setQuickAction(action)
    setActiveSection("movements")
  }

  function navigate(section: AppSection) {
    setQuickAction(null)
    setActiveSection(section)
  }

  if (setupError || !setupState || !setupUseCases) {
    return (
      <div className="mx-auto flex h-dvh w-full max-w-[430px] flex-col overflow-hidden border-x bg-background shadow-sm">
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] scroll-pb-8">
          <section className="space-y-section py-section" aria-labelledby="setup-loading-title">
            <h1 id="setup-loading-title" className="type-page-title">Inicio</h1>
            {setupError ? (
              <ErrorMessage title="No se pudo abrir Perita" description={setupError} />
            ) : (
              <LoadingState label="Validando configuración" />
            )}
          </section>
        </main>
      </div>
    )
  }

  if (setupState.status !== "completed") {
    return (
      <div className="mx-auto flex h-dvh w-full max-w-[430px] flex-col overflow-hidden border-x bg-background shadow-sm">
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] scroll-pb-8">
          <SetupPage
            state={setupState}
            useCases={setupUseCases}
            onCompleted={() => setSetupState({
              ...setupState,
              status: "completed",
            })}
          />
        </main>
      </div>
    )
  }

  return (
    <AppShell
      activeSection={activeSection}
      onNavigate={navigate}
      onOpenSettings={() => navigate("settings")}
      onQuickAction={openQuickAction}
    >
      <AppContent
        section={activeSection}
        quickAction={quickAction}
        onQuickActionClose={() => setQuickAction(null)}
        onMoveMoney={() => openQuickAction("transfer")}
        onNavigate={navigate}
        onRegisterIncome={() => openQuickAction("income")}
      />
    </AppShell>
  )
}

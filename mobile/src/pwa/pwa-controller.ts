export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>
}

export interface PwaState {
  readonly canInstall: boolean
  readonly iosInstallHint: boolean
  readonly offline: boolean
  readonly offlineReady: boolean
  readonly updateAvailable: boolean
}

interface ServiceWorkerContainerPort extends EventTarget {
  readonly controller: ServiceWorker | null
  readonly ready: Promise<ServiceWorkerRegistration>
  register(
    scriptURL: string | URL,
    options?: RegistrationOptions,
  ): Promise<ServiceWorkerRegistration>
}

interface PwaControllerOptions {
  readonly serviceWorker?: ServiceWorkerContainerPort
  readonly windowTarget?: Window
  readonly documentTarget?: Document
  readonly reload?: () => void
  readonly updateIntervalMs?: number
}

type Listener = (state: PwaState) => void

const INITIAL_STATE: PwaState = {
  canInstall: false,
  iosInstallHint: false,
  offline: false,
  offlineReady: false,
  updateAvailable: false,
}

export class PwaController {
  private readonly serviceWorker: ServiceWorkerContainerPort | undefined
  private readonly windowTarget: Window | undefined
  private readonly documentTarget: Document | undefined
  private readonly reload: () => void
  private readonly updateIntervalMs: number
  private readonly listeners = new Set<Listener>()
  private state: PwaState = INITIAL_STATE
  private registration: ServiceWorkerRegistration | null = null
  private installPrompt: InstallPromptEvent | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private acceptingUpdate = false
  private controllerChanged = false
  private reloaded = false
  private started = false
  private generation = 0
  private hadController: boolean

  constructor(options: PwaControllerOptions = {}) {
    this.windowTarget = options.windowTarget ?? (typeof window === "undefined" ? undefined : window)
    this.documentTarget = options.documentTarget ?? (typeof document === "undefined" ? undefined : document)
    this.serviceWorker = options.serviceWorker ?? (
      typeof navigator === "undefined" || !("serviceWorker" in navigator)
        ? undefined
        : navigator.serviceWorker
    )
    this.reload = options.reload ?? (() => this.windowTarget?.location.reload())
    this.updateIntervalMs = options.updateIntervalMs ?? 60 * 60 * 1000
    this.hadController = Boolean(this.serviceWorker?.controller)
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  async start() {
    if (this.started) return
    this.started = true
    const generation = ++this.generation
    const online = typeof navigator === "undefined" ? true : navigator.onLine
    const userAgent = this.windowTarget?.navigator.userAgent ?? ""
    const ios = /iPad|iPhone|iPod/.test(userAgent)
    const standalone = this.windowTarget?.matchMedia?.("(display-mode: standalone)").matches ||
      Boolean((this.windowTarget?.navigator as Navigator & { standalone?: boolean } | undefined)?.standalone)
    this.setState({ offline: !online, iosInstallHint: ios && !standalone })
    this.windowTarget?.addEventListener("online", this.handleOnline)
    this.windowTarget?.addEventListener("offline", this.handleOffline)
    this.windowTarget?.addEventListener("beforeinstallprompt", this.handleInstallPrompt)
    this.windowTarget?.addEventListener("appinstalled", this.handleInstalled)
    this.serviceWorker?.addEventListener("controllerchange", this.handleControllerChange)
    this.documentTarget?.addEventListener("visibilitychange", this.handleVisibilityChange)

    if (!this.serviceWorker) return
    this.registration = await this.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    })
    if (!this.started || generation !== this.generation) return
    this.watchRegistration(this.registration)
    if (this.registration.waiting) this.setState({ updateAvailable: true })
    void this.serviceWorker.ready.then(() => this.setState({ offlineReady: true }))
    this.interval = setInterval(() => void this.checkForUpdate(), this.updateIntervalMs)
  }

  dispose() {
    this.started = false
    this.generation += 1
    this.windowTarget?.removeEventListener("online", this.handleOnline)
    this.windowTarget?.removeEventListener("offline", this.handleOffline)
    this.windowTarget?.removeEventListener("beforeinstallprompt", this.handleInstallPrompt)
    this.windowTarget?.removeEventListener("appinstalled", this.handleInstalled)
    this.serviceWorker?.removeEventListener("controllerchange", this.handleControllerChange)
    this.documentTarget?.removeEventListener("visibilitychange", this.handleVisibilityChange)
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    this.listeners.clear()
  }

  dismissUpdate() {
    this.setState({ updateAvailable: false })
  }

  dismissOfflineReady() {
    this.setState({ offlineReady: false })
  }

  dismissInstall() {
    this.installPrompt = null
    this.setState({ canInstall: false, iosInstallHint: false })
  }

  async install() {
    const prompt = this.installPrompt
    if (!prompt) return false
    await prompt.prompt()
    const choice = await prompt.userChoice
    this.installPrompt = null
    this.setState({ canInstall: false })
    return choice.outcome === "accepted"
  }

  async acceptUpdate() {
    this.acceptingUpdate = true
    if (this.controllerChanged) {
      this.reloadOnce()
      return
    }
    const registration = this.registration
    if (!registration) return
    if (!registration.waiting) await registration.update()
    registration.waiting?.postMessage({ type: "SKIP_WAITING" })
  }

  private setState(patch: Partial<PwaState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener(this.state))
  }

  private watchRegistration(registration: ServiceWorkerRegistration) {
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing
      if (!installing) return
      installing.addEventListener("statechange", () => {
        if (installing.state !== "installed" || !this.serviceWorker?.controller) return
        this.setState({ updateAvailable: true })
        if (this.acceptingUpdate) registration.waiting?.postMessage({ type: "SKIP_WAITING" })
      })
    })
  }

  private checkForUpdate() {
    return this.registration?.update().catch(() => undefined)
  }

  private reloadOnce() {
    if (this.reloaded) return
    this.reloaded = true
    this.reload()
  }

  private readonly handleOnline = () => {
    this.setState({ offline: false })
    void this.checkForUpdate()
  }

  private readonly handleOffline = () => this.setState({ offline: true })

  private readonly handleVisibilityChange = () => {
    if (this.documentTarget?.visibilityState === "visible") void this.checkForUpdate()
  }

  private readonly handleInstallPrompt = (event: Event) => {
    const promptEvent = event as InstallPromptEvent
    promptEvent.preventDefault()
    this.installPrompt = promptEvent
    this.setState({ canInstall: true, iosInstallHint: false })
  }

  private readonly handleInstalled = () => this.dismissInstall()

  private readonly handleControllerChange = () => {
    if (!this.hadController && !this.acceptingUpdate) {
      this.hadController = true
      return
    }
    this.hadController = true
    this.controllerChanged = true
    if (this.acceptingUpdate) this.reloadOnce()
    else this.setState({ updateAvailable: true })
  }
}

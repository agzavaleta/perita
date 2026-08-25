type NavigatorWithStandalone = Navigator & {
  readonly standalone?: boolean
}

type RecoveryOptions = {
  readonly document?: Document
  readonly enabled?: boolean
  readonly window?: Window
}

function isEditableElement(value: EventTarget | null): value is HTMLElement {
  if (!(value instanceof HTMLElement)) {
    return false
  }

  if (value instanceof HTMLInputElement) {
    return !value.disabled && !value.readOnly && value.type !== "hidden"
  }

  if (value instanceof HTMLTextAreaElement) {
    return !value.disabled && !value.readOnly
  }

  if (value instanceof HTMLSelectElement) {
    return !value.disabled
  }

  return value.isContentEditable
}

export function isIosStandalone(windowObject: Window = window): boolean {
  const navigator = windowObject.navigator as NavigatorWithStandalone
  const isIosDevice =
    /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  const isStandalone =
    navigator.standalone === true ||
    windowObject.matchMedia?.("(display-mode: standalone)").matches === true

  return isIosDevice && isStandalone
}

export function installIosViewportRecovery({
  document: documentObject = document,
  enabled,
  window: windowObject = window,
}: RecoveryOptions = {}): () => void {
  const visualViewport = windowObject.visualViewport

  if (!(enabled ?? isIosStandalone(windowObject)) || !visualViewport) {
    return () => undefined
  }

  let keyboardSessionActive = false
  let firstAnimationFrame: number | null = null
  let secondAnimationFrame: number | null = null

  const cancelScheduledRecovery = () => {
    if (firstAnimationFrame !== null) {
      windowObject.cancelAnimationFrame(firstAnimationFrame)
      firstAnimationFrame = null
    }
    if (secondAnimationFrame !== null) {
      windowObject.cancelAnimationFrame(secondAnimationFrame)
      secondAnimationFrame = null
    }
  }

  const scheduleRecovery = () => {
    cancelScheduledRecovery()
    const mainContent = documentObject.getElementById("main-content")
    const preservedMainScrollTop = mainContent?.scrollTop ?? 0

    firstAnimationFrame = windowObject.requestAnimationFrame(() => {
      firstAnimationFrame = null
      secondAnimationFrame = windowObject.requestAnimationFrame(() => {
        secondAnimationFrame = null

        if (isEditableElement(documentObject.activeElement)) {
          return
        }

        const currentMainContent = documentObject.getElementById("main-content")
        const mainScrollTop = currentMainContent?.scrollTop ?? preservedMainScrollTop

        documentObject.documentElement.scrollTop = 0
        documentObject.body.scrollTop = 0
        windowObject.scrollTo(0, 0)

        if (currentMainContent) {
          currentMainContent.scrollTop = mainScrollTop
        }

        keyboardSessionActive = false
      })
    })
  }

  const handleFocusIn = (event: FocusEvent) => {
    if (isEditableElement(event.target)) {
      keyboardSessionActive = true
      cancelScheduledRecovery()
    }
  }

  const handleFocusOut = (event: FocusEvent) => {
    if (keyboardSessionActive && isEditableElement(event.target)) {
      scheduleRecovery()
    }
  }

  const handleViewportResize = () => {
    if (keyboardSessionActive && !isEditableElement(documentObject.activeElement)) {
      scheduleRecovery()
    }
  }

  documentObject.addEventListener("focusin", handleFocusIn)
  documentObject.addEventListener("focusout", handleFocusOut)
  visualViewport.addEventListener("resize", handleViewportResize)

  return () => {
    cancelScheduledRecovery()
    documentObject.removeEventListener("focusin", handleFocusIn)
    documentObject.removeEventListener("focusout", handleFocusOut)
    visualViewport.removeEventListener("resize", handleViewportResize)
  }
}

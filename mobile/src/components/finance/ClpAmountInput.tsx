import * as React from "react"

import { Input } from "@/components/ui/input"
import {
  formatClpInputValue,
  normalizeEditableClpText,
} from "@/lib/money"

export interface ClpAmountInputProps extends Omit<
  React.ComponentProps<typeof Input>,
  "defaultValue" | "inputMode" | "onChange" | "type" | "value"
> {
  readonly value: number | null
  readonly onValueChange: (value: number | null) => void
  readonly allowNegative?: boolean
}

export function ClpAmountInput({
  value,
  onValueChange,
  allowNegative = false,
  onBlur,
  onFocus,
  ref: forwardedRef,
  className,
  ...props
}: ClpAmountInputProps) {
  const [focused, setFocused] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const [caretVersion, setCaretVersion] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const pendingCaret = React.useRef<number | null>(null)

  const visibleValue = focused
    ? draft
    : formatClpInputValue(value, { allowNegative })

  React.useLayoutEffect(() => {
    const caret = pendingCaret.current
    if (caret === null || !focused) return
    pendingCaret.current = null
    inputRef.current?.setSelectionRange(caret, caret)
  }, [caretVersion, draft, focused])

  function caretAfterDigits(
    text: string,
    digitCount: number,
    rawCaret: number,
  ) {
    if (digitCount === 0) {
      return text.startsWith("-") && rawCaret > 0 ? 1 : 0
    }
    let seen = 0
    for (let index = 0; index < text.length; index += 1) {
      if (/\d/.test(text[index] ?? "")) seen += 1
      if (seen === digitCount) return index + 1
    }
    return text.length
  }

  function setInputRef(node: HTMLInputElement | null) {
    inputRef.current = node
    if (typeof forwardedRef === "function") forwardedRef(node)
    else if (forwardedRef) forwardedRef.current = node
  }

  return (
    <div className="relative w-full">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-base md:text-sm"
      >
        $
      </span>
      <Input
        {...props}
        ref={setInputRef}
        className={`!pl-9${className ? ` ${className}` : ""}`}
        type="text"
        inputMode={allowNegative ? "decimal" : "numeric"}
        pattern={allowNegative ? "-?[0-9.]*" : "[0-9.]*"}
        value={visibleValue}
        onFocus={(event) => {
          setDraft(formatClpInputValue(value, { allowNegative }))
          setFocused(true)
          onFocus?.(event)
        }}
        onChange={(event) => {
          const rawText = event.currentTarget.value
          const rawCaret = event.currentTarget.selectionStart ?? rawText.length
          const result = normalizeEditableClpText(rawText, {
            allowNegative,
          })
          if (!result.valid) return
          const digitsBeforeCaret = rawText
            .slice(0, rawCaret)
            .replace(/\D/g, "").length
          if (result.text === "-") {
            pendingCaret.current = 1
            setDraft("-")
            setCaretVersion((current) => current + 1)
            return
          }
          pendingCaret.current = caretAfterDigits(
            result.text,
            digitsBeforeCaret,
            rawCaret,
          )
          setDraft(result.text)
          setCaretVersion((current) => current + 1)
          onValueChange(result.value)
        }}
        onBlur={(event) => {
          setFocused(false)
          setDraft("")
          onBlur?.(event)
        }}
      />
    </div>
  )
}

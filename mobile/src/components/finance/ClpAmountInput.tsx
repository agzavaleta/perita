import * as React from "react"

import { Input } from "@/components/ui/input"
import {
  formatClpInputValue,
  parseClpInputText,
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
  ...props
}: ClpAmountInputProps) {
  const [focused, setFocused] = React.useState(false)
  const [draft, setDraft] = React.useState("")

  const visibleValue = focused
    ? draft
    : formatClpInputValue(value, { allowNegative })

  return (
    <Input
      {...props}
      type="text"
      inputMode={allowNegative ? "decimal" : "numeric"}
      pattern={allowNegative ? "-?[0-9.]*" : "[0-9.]*"}
      value={visibleValue}
      onFocus={(event) => {
        setDraft(value === null ? "" : String(value))
        setFocused(true)
        onFocus?.(event)
      }}
      onChange={(event) => {
        const result = parseClpInputText(event.currentTarget.value, {
          allowNegative,
        })
        if (!result.valid) return
        if (result.text === "-") {
          setDraft("-")
          return
        }
        setDraft(result.value === null ? "" : String(result.value))
        onValueChange(result.value)
      }}
      onBlur={(event) => {
        setFocused(false)
        setDraft("")
        onBlur?.(event)
      }}
    />
  )
}

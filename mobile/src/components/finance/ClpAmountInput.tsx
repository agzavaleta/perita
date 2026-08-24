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
  ...props
}: ClpAmountInputProps) {
  const [negativeDraft, setNegativeDraft] = React.useState(false)

  const visibleValue = negativeDraft && value === null && allowNegative
    ? "-"
    : formatClpInputValue(value, { allowNegative })

  return (
    <Input
      {...props}
      type="text"
      inputMode={allowNegative ? "text" : "numeric"}
      pattern={allowNegative ? "-?[0-9.]*" : "[0-9.]*"}
      value={visibleValue}
      onChange={(event) => {
        const result = parseClpInputText(event.currentTarget.value, {
          allowNegative,
        })
        if (!result.valid) return
        const isNegativeDraft = result.text === "-"
        setNegativeDraft(isNegativeDraft)
        if (!isNegativeDraft) onValueChange(result.value)
      }}
      onBlur={(event) => {
        setNegativeDraft(false)
        onBlur?.(event)
      }}
    />
  )
}

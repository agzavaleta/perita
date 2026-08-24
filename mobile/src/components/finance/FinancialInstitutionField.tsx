import * as React from "react"

import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  CUSTOM_FINANCIAL_INSTITUTION,
  isStandardFinancialInstitution,
  STANDARD_FINANCIAL_INSTITUTIONS,
} from "@/lib/financial-institutions"

const EMPTY_VALUE = "__perita_no_institution__"
const CUSTOM_VALUE = "__perita_custom_institution__"

export interface FinancialInstitutionFieldProps {
  readonly value: string | null
  readonly onValueChange: (value: string | null) => void
  readonly disabled?: boolean
  readonly id?: string
}

export function FinancialInstitutionField({
  value,
  onValueChange,
  disabled = false,
  id,
}: FinancialInstitutionFieldProps) {
  const [manualMode, setManualMode] = React.useState(false)
  const [manualDraft, setManualDraft] = React.useState("")
  const hasCustomValue = value !== null && !isStandardFinancialInstitution(value)
  const showManualInput = hasCustomValue || (manualMode && value === null)
  const selectValue = showManualInput
    ? CUSTOM_VALUE
    : value ?? EMPTY_VALUE
  const manualValue = hasCustomValue ? value : manualDraft

  return (
    <div className="grid w-full gap-2">
      <Select
        value={selectValue}
        disabled={disabled}
        onValueChange={(nextValue) => {
          if (nextValue === EMPTY_VALUE) {
            setManualMode(false)
            setManualDraft("")
            onValueChange(null)
            return
          }
          if (nextValue === CUSTOM_VALUE) {
            setManualMode(true)
            setManualDraft("")
            onValueChange(null)
            return
          }
          if (isStandardFinancialInstitution(nextValue)) {
            setManualMode(false)
            setManualDraft("")
            onValueChange(nextValue)
          }
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={EMPTY_VALUE}>Sin institución</SelectItem>
          {STANDARD_FINANCIAL_INSTITUTIONS.map((institution) => (
            <SelectItem key={institution} value={institution}>
              {institution}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_VALUE}>
            {CUSTOM_FINANCIAL_INSTITUTION}
          </SelectItem>
        </SelectContent>
      </Select>

      {showManualInput ? (
        <Input
          id={id ? `${id}-custom` : undefined}
          aria-label="Otra institución"
          disabled={disabled}
          placeholder="Escribe la institución"
          value={manualValue}
          onChange={(event) => {
            const nextDraft = event.currentTarget.value
            setManualMode(true)
            setManualDraft(nextDraft)
            onValueChange(nextDraft.trim() || null)
          }}
        />
      ) : null}
    </div>
  )
}

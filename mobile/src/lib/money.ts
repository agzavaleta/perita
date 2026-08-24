export interface ClpInputOptions {
  readonly allowNegative?: boolean
}

export type ClpInputParseResult =
  | {
      readonly valid: true
      readonly value: number | null
      readonly text: string
    }
  | {
      readonly valid: false
      readonly value: null
      readonly text: ""
    }

const CLP_FORMATTER = new Intl.NumberFormat("es-CL", {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
  useGrouping: true,
})

export function formatClpInputValue(
  value: number | null,
  { allowNegative = false }: ClpInputOptions = {},
): string {
  if (value === null) return ""
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new RangeError("CLP input values must be valid integer amounts")
  }
  return CLP_FORMATTER.format(Object.is(value, -0) ? 0 : value)
}

export function parseClpInputText(
  input: string,
  { allowNegative = false }: ClpInputOptions = {},
): ClpInputParseResult {
  if (input === "") return { valid: true, value: null, text: "" }
  if (input === "-" && allowNegative) {
    return { valid: true, value: null, text: "-" }
  }

  const sign = input.startsWith("-") ? "-" : ""
  if (sign && !allowNegative) return { valid: false, value: null, text: "" }
  const unsigned = sign ? input.slice(1) : input
  const isPlainInteger = /^\d+$/.test(unsigned)
  const isGroupedInteger = /^\d{1,3}(?:\.\d{3})+$/.test(unsigned)
  if (!isPlainInteger && !isGroupedInteger) {
    return { valid: false, value: null, text: "" }
  }

  const digits = unsigned.replaceAll(".", "")
  const value = Number(`${sign}${digits}`)
  if (!Number.isSafeInteger(value)) {
    return { valid: false, value: null, text: "" }
  }

  return {
    valid: true,
    value,
    text: formatClpInputValue(value, { allowNegative }),
  }
}

export const FINANCIAL_INSTITUTIONS = [
  "BancoEstado",
  "Banco de Chile",
  "Banco Santander",
  "BCI",
  "Scotiabank Chile",
  "Itaú",
  "Banco BICE",
  "Banco Falabella",
  "Banco Ripley",
  "Banco Consorcio",
  "Banco Internacional",
  "Tanner Banco Digital",
  "Tenpo Bank Chile",
  "Coopeuch",
  "MACH",
  "Mercado Pago",
  "Efectivo",
  "Otro",
] as const

export type FinancialInstitution = typeof FINANCIAL_INSTITUTIONS[number]

export const CUSTOM_FINANCIAL_INSTITUTION = "Otro" as const

export const STANDARD_FINANCIAL_INSTITUTIONS = FINANCIAL_INSTITUTIONS.filter(
  (institution) => institution !== CUSTOM_FINANCIAL_INSTITUTION,
)

export function isStandardFinancialInstitution(
  value: string,
): value is Exclude<FinancialInstitution, typeof CUSTOM_FINANCIAL_INSTITUTION> {
  return STANDARD_FINANCIAL_INSTITUTIONS.some(
    (institution) => institution === value,
  )
}

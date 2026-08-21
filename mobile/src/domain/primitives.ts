declare const domainBrand: unique symbol
declare const clpBrand: unique symbol
declare const positiveClpBrand: unique symbol
declare const nonZeroDeltaBrand: unique symbol

type Brand<T, Name extends string> = T & {
  readonly [domainBrand]: Name
}

export type EntityId = Brand<string, "EntityId">
export type CivilDate = Brand<string, "CivilDate">
export type PeriodKey = Brand<string, "PeriodKey">
export type UtcTimestamp = Brand<string, "UtcTimestamp">
export type ClpAmount = number & { readonly [clpBrand]: "CLP" }
export type PositiveClpAmount = ClpAmount & {
  readonly [positiveClpBrand]: true
}
export type NonZeroClpDelta = ClpAmount & {
  readonly [nonZeroDeltaBrand]: true
}
export type Revision = Brand<number, "Revision">

export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export interface MutableEntityRecord {
  readonly id: EntityId
  readonly revision: Revision
  readonly createdAt: UtcTimestamp
  readonly updatedAt: UtcTimestamp
}

export interface ClpOptions {
  readonly allowZero?: boolean
  readonly allowNegative?: boolean
}

export class DomainContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DomainContractError"
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CIVIL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const PERIOD_KEY_PATTERN = /^(\d{4})-(\d{2})$/

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

export function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

export function asEntityId(value: string): EntityId {
  if (!UUID_PATTERN.test(value)) {
    throw new DomainContractError("EntityId must be a canonical UUID")
  }
  return value.toLowerCase() as EntityId
}

export function asCivilDate(value: string): CivilDate {
  const match = CIVIL_DATE_PATTERN.exec(value)
  if (!match) {
    throw new DomainContractError("CivilDate must use YYYY-MM-DD")
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new DomainContractError("CivilDate is not a valid calendar date")
  }
  return value as CivilDate
}

export function asPeriodKey(value: string): PeriodKey {
  const match = PERIOD_KEY_PATTERN.exec(value)
  if (!match) {
    throw new DomainContractError("PeriodKey must use YYYY-MM")
  }
  const year = Number(match[1])
  const month = Number(match[2])
  if (year < 1 || year > 9999 || month < 1 || month > 12) {
    throw new DomainContractError("PeriodKey is outside the supported calendar")
  }
  return value as PeriodKey
}

export function asUtcTimestamp(value: string): UtcTimestamp {
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new DomainContractError("UtcTimestamp must be a valid UTC ISO instant")
  }
  return value as UtcTimestamp
}

export function asClpAmount(
  value: number,
  { allowZero = true, allowNegative = false }: ClpOptions = {},
): ClpAmount {
  if (!Number.isSafeInteger(value)) {
    throw new DomainContractError("CLP amounts must be safe integers")
  }
  if (!allowZero && value === 0) {
    throw new DomainContractError("CLP amount must not be zero")
  }
  if (!allowNegative && value < 0) {
    throw new DomainContractError("CLP amount must not be negative")
  }
  return value as ClpAmount
}

export function asPositiveClpAmount(value: number): PositiveClpAmount {
  return asClpAmount(value, {
    allowZero: false,
    allowNegative: false,
  }) as PositiveClpAmount
}

export function asNonZeroClpDelta(value: number): NonZeroClpDelta {
  return asClpAmount(value, {
    allowZero: false,
    allowNegative: true,
  }) as NonZeroClpDelta
}

export function asRevision(value: number): Revision {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainContractError("Revision must be a positive safe integer")
  }
  return value as Revision
}

export function periodFromCivilDate(value: CivilDate): PeriodKey {
  return value.slice(0, 7) as PeriodKey
}

export function nextPeriod(value: PeriodKey): PeriodKey {
  const [year, month] = value.split("-").map(Number)
  if (year === 9999 && month === 12) {
    throw new DomainContractError("PeriodKey has no representable successor")
  }
  return (month === 12
    ? `${String(year + 1).padStart(4, "0")}-01`
    : `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`) as PeriodKey
}

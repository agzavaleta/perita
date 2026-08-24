import { DOMAIN_VERSION, CHILE_TIME_ZONE } from "@/domain/constants"
import type { PeritaDataSnapshot } from "@/domain/data-snapshot"
import {
  assertAccountInvariant,
  assertAuditEventInvariant,
  assertDebtInvariant,
  assertFixedExpenseInstanceInvariant,
  assertFixedExpenseTemplateInvariant,
  assertOperationMovementInvariant,
  assertOperationRevisionInvariant,
  assertSavingsGoalInvariant,
} from "@/domain/invariants"
import {
  deriveMonthlySummary,
  reconcileMonthlyBalances,
} from "@/domain/monthly-close"
import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asNonZeroClpDelta,
  asPeriodKey,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import type { DataAdministrationRepository } from "@/data/repositories"
import { canonicalJson, sha256 } from "@/lib/integrity"

export const BACKUP_DOCUMENT_TYPE = "perita-backup" as const
export const BACKUP_FORMAT_VERSION = "1.0.0" as const
export const BACKUP_CANONICALIZATION = "perita-stable-json-v1" as const

const DATA_FIELDS = [
  "financialSettings", "periods", "periodOpenings", "accounts", "savingsGoals",
  "debts", "categories", "fixedExpenseTemplates", "fixedExpenseInstances",
  "operations", "movements", "operationRevisions", "auditEvents", "periodSnapshots",
] as const satisfies readonly (keyof PeritaDataSnapshot)[]

const TOP_LEVEL_FIELDS = [
  "documentType", "backupFormatVersion", "schemaVersion", "appVersion", "exportedAt",
  "timezone", "dataRevision", "data", "integrity",
] as const

export interface PeritaBackup {
  readonly documentType: typeof BACKUP_DOCUMENT_TYPE
  readonly backupFormatVersion: typeof BACKUP_FORMAT_VERSION
  readonly schemaVersion: typeof DOMAIN_VERSION
  readonly appVersion: typeof DOMAIN_VERSION
  readonly exportedAt: string
  readonly timezone: typeof CHILE_TIME_ZONE
  readonly dataRevision: number
  readonly data: PeritaDataSnapshot
  readonly integrity: {
    readonly algorithm: "SHA-256"
    readonly canonicalization: typeof BACKUP_CANONICALIZATION
    readonly payloadHash: string
  }
}

export type BackupValidation =
  | { readonly status: "valid"; readonly backup: PeritaBackup; readonly errors: readonly [] }
  | { readonly status: "invalid" | "incompatible"; readonly backup: null; readonly errors: readonly string[] }

export class BackupError extends Error {
  readonly code: "backup_invalid" | "backup_incompatible" | "restore_failed" | "backup_required" | "confirmation_invalid"

  constructor(
    code: "backup_invalid" | "backup_incompatible" | "restore_failed" | "backup_required" | "confirmation_invalid",
    message: string,
  ) {
    super(message)
    this.name = "BackupError"
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]) {
  return Object.keys(value).toSorted().join("|") === [...fields].toSorted().join("|")
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function payloadWithoutIntegrity(backup: PeritaBackup) {
  const { integrity: _integrity, ...payload } = backup
  return payload
}

function withMissingDefault<T extends object, K extends string, V>(
  record: T,
  field: K,
  value: V,
): T & Record<K, V> {
  return Object.hasOwn(record, field)
    ? record as T & Record<K, V>
    : { ...record, [field]: value } as T & Record<K, V>
}

function normalizeLegacyData(data: PeritaDataSnapshot): PeritaDataSnapshot {
  return {
    ...data,
    periods: data.periods.map((period) =>
      withMissingDefault(period, "variableExpenseBudgetAmount", asClpAmount(0)),
    ),
    accounts: data.accounts.map((account) =>
      withMissingDefault(account, "emoji", "💳"),
    ),
    savingsGoals: data.savingsGoals.map((goal) =>
      withMissingDefault(goal, "emoji", "💰"),
    ),
  }
}

function keyFor(store: keyof PeritaDataSnapshot, record: unknown) {
  if (!isRecord(record)) return undefined
  return store === "financialSettings" ? record.key : record.id
}

function validateRecords(data: PeritaDataSnapshot) {
  for (const field of DATA_FIELDS) {
    const seen = new Set<string>()
    for (const record of data[field]) {
      const key = keyFor(field, record)
      if (typeof key !== "string" || seen.has(key)) throw new Error(`${field} contiene claves inválidas o duplicadas.`)
      if (field !== "financialSettings") asEntityId(key)
      seen.add(key)
    }
  }

  if (data.financialSettings.length > 1) throw new Error("La configuración financiera está duplicada.")
  for (const settings of data.financialSettings) {
    if (settings.key !== "current" || settings.currency !== "CLP" || settings.timezone !== CHILE_TIME_ZONE) {
      throw new Error("La configuración financiera no es compatible.")
    }
    asClpAmount(settings.salaryReferenceAmount)
    asRevision(settings.revision)
    asUtcTimestamp(settings.createdAt)
    asUtcTimestamp(settings.updatedAt)
  }
  data.accounts.forEach(assertAccountInvariant)
  data.savingsGoals.forEach(assertSavingsGoalInvariant)
  data.debts.forEach(assertDebtInvariant)
  data.fixedExpenseTemplates.forEach(assertFixedExpenseTemplateInvariant)
  data.fixedExpenseInstances.forEach(assertFixedExpenseInstanceInvariant)
  data.operationRevisions.forEach(assertOperationRevisionInvariant)
  data.auditEvents.forEach(assertAuditEventInvariant)

  for (const record of [
    ...data.accounts, ...data.savingsGoals, ...data.debts, ...data.categories,
    ...data.fixedExpenseTemplates, ...data.fixedExpenseInstances, ...data.operations,
  ]) {
    asRevision(record.revision)
    asUtcTimestamp(record.createdAt)
    asUtcTimestamp(record.updatedAt)
  }
  for (const period of data.periods) {
    asPeriodKey(period.periodKey)
    asClpAmount(period.plannedSalaryAmount)
    asClpAmount(period.variableExpenseBudgetAmount)
    asRevision(period.revision)
    asUtcTimestamp(period.openedAt)
    if (period.status === "closed") asUtcTimestamp(period.closedAt)
    else if (period.status !== "open" || period.closedAt !== null || period.snapshotId !== null) throw new Error("El respaldo contiene un período inválido.")
  }
  for (const opening of data.periodOpenings) asClpAmount(opening.openingAmount, { allowNegative: opening.targetType === "account" })
  for (const operation of data.operations) asCivilDate(operation.operationDate)
  for (const movement of data.movements) {
    asNonZeroClpDelta(movement.delta)
    asUtcTimestamp(movement.createdAt)
    asUtcTimestamp(movement.updatedAt)
  }

  const periods = new Set(data.periods.map((record) => record.id))
  const operations = new Set(data.operations.map((record) => record.id))
  const targets = {
    account: new Set(data.accounts.map((record) => record.id)),
    savings_goal: new Set(data.savingsGoals.map((record) => record.id)),
    debt: new Set(data.debts.map((record) => record.id)),
  }
  if (data.operations.some((record) => !periods.has(record.periodId)) || data.movements.some((record) => !periods.has(record.periodId) || !targets[record.targetType].has(record.targetId))) {
    throw new Error("El respaldo contiene relaciones financieras inexistentes.")
  }
  if (data.periodOpenings.some((record) => !periods.has(record.periodId) || !targets[record.targetType].has(record.targetId))) {
    throw new Error("El respaldo contiene aperturas sin período o destino.")
  }
  const templates = new Set(data.fixedExpenseTemplates.map((record) => record.id))
  if (data.fixedExpenseInstances.some((record) => !periods.has(record.periodId) || !templates.has(record.templateId))) {
    throw new Error("El respaldo contiene gastos fijos sin plantilla o período.")
  }
  if (data.operationRevisions.some((record) => !operations.has(record.operationId) || !periods.has(record.periodId))) {
    throw new Error("El respaldo contiene revisiones sin operación.")
  }

  const movementsByOperation = new Map<string, typeof data.movements>()
  for (const operation of data.operations) {
    const movements = data.movements.filter((item) => item.operationId === operation.id)
    movementsByOperation.set(operation.id, movements)
    assertOperationMovementInvariant(operation, movements)
  }
  if (data.movements.some((movement) => !movementsByOperation.has(movement.operationId))) {
    throw new Error("El respaldo contiene movimientos sin operación.")
  }
}

function dataRevision(data: PeritaDataSnapshot) {
  let revision = 0
  for (const values of Object.values(data)) {
    for (const value of values) {
      if (isRecord(value) && Number.isSafeInteger(value.revision)) revision = Math.max(revision, value.revision as number)
      if (isRecord(value) && Number.isSafeInteger(value.revisionNumber)) revision = Math.max(revision, value.revisionNumber as number)
    }
  }
  return revision
}

async function validateDerivedIntegrity(data: PeritaDataSnapshot) {
  const openPeriods = data.periods.filter(({ status }) => status === "open")
  if (openPeriods.length > 1) {
    throw new Error("El respaldo contiene más de un período abierto.")
  }
  for (const period of openPeriods) {
    reconcileMonthlyBalances({
      periodId: period.id,
      accounts: data.accounts,
      savingsGoals: data.savingsGoals,
      debts: data.debts,
      operations: data.operations,
      movements: data.movements,
      periodOpenings: data.periodOpenings,
    })
    deriveMonthlySummary({
      period,
      operations: data.operations,
      movements: data.movements,
      fixedExpenseInstances: data.fixedExpenseInstances,
    })
  }

  const snapshots = new Map(data.periodSnapshots.map((snapshot) => [snapshot.id, snapshot]))
  for (const period of data.periods) {
    if (period.status === "open") continue
    const snapshot = snapshots.get(period.snapshotId)
    if (
      !snapshot ||
      snapshot.periodId !== period.id ||
      snapshot.periodKey !== period.periodKey
    ) {
      throw new Error("Un período cerrado no coincide con su snapshot histórico.")
    }
  }
  for (const snapshot of data.periodSnapshots) {
    const period = data.periods.find(({ id }) => id === snapshot.periodId)
    if (
      !period ||
      period.status !== "closed" ||
      period.snapshotId !== snapshot.id ||
      period.closedAt !== snapshot.closedAt ||
      snapshot.schemaVersion !== DOMAIN_VERSION ||
      snapshot.snapshotKind !== "canonical" ||
      snapshot.integrity.algorithm !== "SHA-256"
    ) {
      throw new Error("El respaldo contiene un snapshot histórico inválido.")
    }
    const { integrity, ...payload } = snapshot
    const actualHash = await sha256(canonicalJson(payload))
    if (actualHash !== integrity.payloadHash.toLowerCase()) {
      throw new Error("La integridad de un mes histórico no coincide.")
    }
    if (!isRecord(snapshot.data.periodPlan)) {
      throw new Error("El plan de un mes histórico es inválido.")
    }
    asClpAmount(snapshot.data.periodPlan.plannedSalaryAmount)
    asClpAmount(
      Object.hasOwn(snapshot.data.periodPlan, "variableExpenseBudgetAmount")
        ? snapshot.data.periodPlan.variableExpenseBudgetAmount
        : 0,
    )
    if (
      snapshot.data.operations.some(({ periodId }) => periodId !== period.id) ||
      snapshot.data.movements.some(({ periodId }) => periodId !== period.id) ||
      snapshot.data.fixedExpenses.some(({ periodId }) => periodId !== period.id) ||
      snapshot.data.periodOpenings.some(({ periodId }) => periodId !== period.id)
    ) {
      throw new Error("Un snapshot histórico mezcla datos de otros períodos.")
    }
    for (const operation of snapshot.data.operations) {
      assertOperationMovementInvariant(
        operation,
        snapshot.data.movements.filter(({ operationId }) => operationId === operation.id),
      )
    }
    const historicalSummary = deriveMonthlySummary({
      period,
      operations: snapshot.data.operations,
      movements: snapshot.data.movements,
      fixedExpenseInstances: snapshot.data.fixedExpenses,
    })
    if (canonicalJson(historicalSummary) !== canonicalJson(snapshot.data.totals)) {
      throw new Error("Los totales de un mes histórico no son reproducibles.")
    }
  }
}

export class BackupService {
  private readonly repository: DataAdministrationRepository
  private readonly now: () => string

  constructor(
    repository: DataAdministrationRepository,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.repository = repository
    this.now = now
  }

  async exportBackup(): Promise<PeritaBackup> {
    const data = clone(await this.repository.readSnapshot())
    const exportedAt = this.now()
    asUtcTimestamp(exportedAt)
    const payload = {
      documentType: BACKUP_DOCUMENT_TYPE,
      backupFormatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: DOMAIN_VERSION,
      appVersion: DOMAIN_VERSION,
      exportedAt,
      timezone: CHILE_TIME_ZONE,
      dataRevision: dataRevision(data),
      data,
    } as const
    return clone({
      ...payload,
      integrity: {
        algorithm: "SHA-256",
        canonicalization: BACKUP_CANONICALIZATION,
        payloadHash: await sha256(canonicalJson(payload)),
      },
    })
  }

  async validateBackup(input: unknown): Promise<BackupValidation> {
    let parsed: unknown
    try {
      parsed = typeof input === "string" ? JSON.parse(input) : clone(input)
    } catch {
      return { status: "invalid", backup: null, errors: ["El archivo no contiene JSON válido."] }
    }
    if (!isRecord(parsed) || !hasExactFields(parsed, TOP_LEVEL_FIELDS)) {
      return { status: "invalid", backup: null, errors: ["El respaldo está incompleto o contiene campos no admitidos."] }
    }
    if (parsed.documentType !== BACKUP_DOCUMENT_TYPE || parsed.backupFormatVersion !== BACKUP_FORMAT_VERSION || parsed.schemaVersion !== DOMAIN_VERSION || parsed.appVersion !== DOMAIN_VERSION) {
      return { status: "incompatible", backup: null, errors: ["El respaldo pertenece a una versión incompatible."] }
    }
    if (!isRecord(parsed.data) || !hasExactFields(parsed.data, DATA_FIELDS)) {
      return { status: "invalid", backup: null, errors: ["Las colecciones del respaldo son inválidas."] }
    }
    const parsedData = parsed.data
    if (!DATA_FIELDS.every((field) => Array.isArray(parsedData[field]))) {
      return { status: "invalid", backup: null, errors: ["Las colecciones del respaldo son inválidas."] }
    }
    if (!isRecord(parsed.integrity) || parsed.integrity.algorithm !== "SHA-256" || parsed.integrity.canonicalization !== BACKUP_CANONICALIZATION || typeof parsed.integrity.payloadHash !== "string") {
      return { status: "incompatible", backup: null, errors: ["El mecanismo de integridad no es compatible."] }
    }
    try {
      asUtcTimestamp(String(parsed.exportedAt))
      if (parsed.timezone !== CHILE_TIME_ZONE || !Number.isSafeInteger(parsed.dataRevision) || (parsed.dataRevision as number) < 0) throw new Error()
      const backup = parsed as unknown as PeritaBackup
      const actualHash = await sha256(canonicalJson(payloadWithoutIntegrity(backup)))
      if (actualHash !== backup.integrity.payloadHash.toLowerCase()) throw new Error("La firma de integridad no coincide.")
      const normalizedBackup: PeritaBackup = {
        ...backup,
        data: normalizeLegacyData(clone(backup.data)),
      }
      validateRecords(normalizedBackup.data)
      if (normalizedBackup.dataRevision !== dataRevision(normalizedBackup.data)) {
        throw new Error("La revisión declarada no coincide con los datos del respaldo.")
      }
      await validateDerivedIntegrity(normalizedBackup.data)
      return { status: "valid", backup: clone(normalizedBackup), errors: [] }
    } catch (error) {
      return { status: "invalid", backup: null, errors: [error instanceof Error && error.message ? error.message : "El respaldo no es válido."] }
    }
  }

  async restoreBackup(input: unknown) {
    const target = await this.validateBackup(input)
    if (target.status !== "valid") throw new BackupError(target.status === "incompatible" ? "backup_incompatible" : "backup_invalid", target.errors[0])
    const preventive = await this.exportBackup()
    try {
      await this.repository.replaceSnapshot(target.backup.data, preventive.data)
    } catch (cause) {
      throw new BackupError("restore_failed", cause instanceof Error ? cause.message : "La restauración falló; los datos actuales no cambiaron.")
    }
    return { restored: true as const, preventiveBackup: preventive }
  }

  async deleteAllData(externalBackup: unknown, confirmation: string) {
    if (!externalBackup) throw new BackupError("backup_required", "Primero genera y guarda un respaldo completo.")
    if (confirmation !== "ELIMINAR") throw new BackupError("confirmation_invalid", "Escribe ELIMINAR exactamente.")
    const validation = await this.validateBackup(externalBackup)
    if (validation.status !== "valid") throw new BackupError("backup_invalid", "La eliminación requiere un respaldo V1.1.0 válido.")
    await this.repository.clearAll()
    return { deleted: true as const }
  }
}

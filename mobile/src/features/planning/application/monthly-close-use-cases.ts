import type { AuditEvent } from "@/domain/audit"
import type {
  Account,
  Debt,
  FixedExpenseInstance,
  SavingsGoal,
} from "@/domain/entities"
import {
  deriveMonthlySummary,
  financialTargetKey,
  reconcileMonthlyBalances,
} from "@/domain/monthly-close"
import type {
  MonthlySummary,
  Period,
  PeriodOpening,
  PeriodSnapshot,
} from "@/domain/periods"
import {
  asEntityId,
  asRevision,
  asUtcTimestamp,
  nextPeriod,
  type EntityId,
  type PeriodKey,
  type UtcTimestamp,
} from "@/domain/primitives"
import { assertAuditEventInvariant } from "@/domain/invariants"
import { PersistenceError } from "@/data/errors"
import type {
  MonthlyCloseSource,
  PeritaRepositories,
} from "@/data/repositories"
import { canonicalJson, sha256 } from "@/lib/integrity"

export interface MonthlyClosePreview {
  readonly period: Period
  readonly summary: MonthlySummary
  readonly pendingFixedExpenses: number
  readonly nextPeriodKey: PeriodKey
  readonly blockers: readonly string[]
}

export interface MonthlyCloseResult {
  readonly closedPeriod: Period
  readonly snapshot: PeriodSnapshot
  readonly nextPeriod: Period
}

export interface MonthlyHistoryItem {
  readonly periodKey: PeriodKey
  readonly closedAt: UtcTimestamp
  readonly totals: MonthlySummary
  readonly snapshotId: EntityId
}

export interface MonthlyCloseUseCasesPort {
  getClosePreview(): Promise<MonthlyClosePreview>
  closeCurrentPeriod(): Promise<MonthlyCloseResult>
  listMonthlyHistory(): Promise<MonthlyHistoryItem[]>
  getMonthlyHistoryDetail(periodKey: PeriodKey): Promise<PeriodSnapshot>
}

export type MonthlyCloseErrorCode =
  | "no_settings"
  | "no_open_period"
  | "multiple_open_periods"
  | "next_period_exists"
  | "salary_not_received"
  | "invalid_fixed_expenses"
  | "snapshot_exists"
  | "balance_mismatch"
  | "revision_conflict"
  | "history_not_found"
  | "snapshot_integrity"

export class MonthlyCloseError extends Error {
  readonly code: MonthlyCloseErrorCode

  constructor(code: MonthlyCloseErrorCode, message: string) {
    super(message)
    this.name = "MonthlyCloseError"
    this.code = code
  }
}

interface Options {
  readonly now?: () => UtcTimestamp
  readonly createId?: () => EntityId
  readonly hash?: (value: string) => Promise<string>
}

function defaultNow() {
  return asUtcTimestamp(new Date().toISOString())
}

function defaultCreateId() {
  return asEntityId(globalThis.crypto.randomUUID())
}

export class MonthlyCloseUseCases implements MonthlyCloseUseCasesPort {
  private readonly repositories: PeritaRepositories
  private readonly now: () => UtcTimestamp
  private readonly createId: () => EntityId
  private readonly hash: (value: string) => Promise<string>

  constructor(
    repositories: PeritaRepositories,
    options: Options = {},
  ) {
    this.repositories = repositories
    this.now = options.now ?? defaultNow
    this.createId = options.createId ?? defaultCreateId
    this.hash = options.hash ?? sha256
  }

  async getClosePreview() {
    const source = await this.loadSource()
    const period = this.requireOpenPeriod(source.periods)
    const currentInstances = source.fixedExpenseInstances.filter(
      ({ periodId }) => periodId === period.id,
    )
    const summary = this.summary(period, source, currentInstances)
    const blockers = this.previewBlockers(period, source, currentInstances, summary)
    const nextKey = nextPeriod(period.periodKey)
    if (source.periods.some(({ periodKey }) => periodKey === nextKey)) {
      blockers.push("El período siguiente ya existe.")
    }
    if (source.periodSnapshots.some(({ periodId }) => periodId === period.id) || period.snapshotId) {
      blockers.push("El período ya tiene un cierre histórico.")
    }
    try {
      const reconciled = reconcileMonthlyBalances({
        periodId: period.id,
        accounts: source.accounts,
        savingsGoals: source.savingsGoals,
        debts: source.debts,
        operations: source.operations,
        movements: source.movements,
        periodOpenings: source.periodOpenings,
      })
      if (
        this.continuingTargets(source).some(
          ({ targetType, targetId }) =>
            !(financialTargetKey(targetType, targetId) in reconciled.closingBalances),
        )
      ) {
        blockers.push("Un fondo vigente no tiene apertura en el período actual.")
      }
    } catch {
      blockers.push("Los saldos no concuerdan con sus aperturas y movimientos.")
    }
    return {
      period,
      summary,
      pendingFixedExpenses: currentInstances.filter(({ status }) => status === "pending").length,
      nextPeriodKey: nextKey,
      blockers,
    }
  }

  async closeCurrentPeriod() {
    const source = await this.loadSource()
    const period = this.requireOpenPeriod(source.periods)
    const nextPeriodKey = nextPeriod(period.periodKey)
    if (source.periods.some(({ periodKey }) => periodKey === nextPeriodKey)) {
      throw new MonthlyCloseError("next_period_exists", "El período siguiente ya existe.")
    }
    if (source.periodSnapshots.some(({ periodId }) => periodId === period.id) || period.snapshotId) {
      throw new MonthlyCloseError("snapshot_exists", "El período ya tiene un cierre histórico.")
    }
    const currentInstances = source.fixedExpenseInstances.filter(
      ({ periodId }) => periodId === period.id,
    )
    const summary = this.summary(period, source, currentInstances)
    const blockers = this.previewBlockers(period, source, currentInstances, summary)
    if (blockers.length > 0) {
      const salaryBlocked = period.plannedSalaryAmount > 0 && summary.receivedSalaryAmount === 0
      throw new MonthlyCloseError(
        salaryBlocked ? "salary_not_received" : "invalid_fixed_expenses",
        blockers[0] ?? "El período no se puede cerrar.",
      )
    }

    let reconciled: ReturnType<typeof reconcileMonthlyBalances>
    try {
      reconciled = reconcileMonthlyBalances({
        periodId: period.id,
        accounts: source.accounts,
        savingsGoals: source.savingsGoals,
        debts: source.debts,
        operations: source.operations,
        movements: source.movements,
        periodOpenings: source.periodOpenings,
      })
    } catch {
      throw new MonthlyCloseError(
        "balance_mismatch",
        "Los saldos no concuerdan con sus aperturas y movimientos.",
      )
    }

    const occurredAt = this.now()
    const snapshotId = this.createId()
    const nextPeriodId = this.createId()
    const closedPeriod: Period = {
      ...period,
      status: "closed",
      closedAt: occurredAt,
      snapshotId,
      revision: asRevision(Number(period.revision) + 1),
    }
    const nextPeriodRecord: Period = {
      id: nextPeriodId,
      periodKey: nextPeriodKey,
      plannedSalaryAmount: source.financialSettings.salaryReferenceAmount,
      openedAt: occurredAt,
      status: "open",
      closedAt: null,
      snapshotId: null,
      revision: asRevision(1),
    }

    const finalizedInstances: FixedExpenseInstance[] = currentInstances.flatMap(
      (instance) =>
        instance.status === "pending"
          ? [{
              ...instance,
              status: "unpaid" as const,
              activePaymentOperationId: null,
              revision: asRevision(Number(instance.revision) + 1),
              updatedAt: occurredAt,
            }]
          : [],
    )
    const finalizedMap = new Map(finalizedInstances.map((instance) => [instance.id, instance]))
    const snapshotInstances = currentInstances.map(
      (instance) => finalizedMap.get(instance.id) ?? instance,
    )
    const nextOpenings = this.continuingTargets(source)
      .map(({ targetType, targetId, openingAmount }) => {
        const key = financialTargetKey(targetType, targetId)
        if (!(key in reconciled.closingBalances)) {
          throw new MonthlyCloseError(
            "balance_mismatch",
            "Un fondo vigente no tiene apertura en el período que se cierra.",
          )
        }
        return {
          id: this.createId(),
          periodId: nextPeriodId,
          targetType,
          targetId,
          openingAmount,
        } satisfies PeriodOpening
      })
    const activeTemplates = source.fixedExpenseTemplates.filter(
      ({ status }) => status === "active",
    )
    const nextInstances: FixedExpenseInstance[] = activeTemplates.map((template) => ({
      id: this.createId(),
      periodId: nextPeriodId,
      templateId: template.id,
      nameSnapshot: template.name,
      plannedAmount: template.referenceAmount,
      status: "pending",
      activePaymentOperationId: null,
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }))

    const closeAudit = this.changedAudit(
      "period",
      period.id,
      "closed",
      period,
      closedPeriod,
      period.id,
      occurredAt,
    )
    const finalizedAudits = finalizedInstances.map((instance) => {
      const previous = currentInstances.find(({ id }) => id === instance.id)
      if (!previous) throw new MonthlyCloseError("invalid_fixed_expenses", "Gasto fijo inconsistente.")
      return this.changedAudit(
        "fixed_expense_instance",
        instance.id,
        "updated",
        previous,
        instance,
        period.id,
        occurredAt,
      )
    })
    const nextPeriodAudit = this.createdAudit(
      "period",
      nextPeriodId,
      nextPeriodRecord,
      nextPeriodId,
      occurredAt,
    )
    const nextInstanceAudits = nextInstances.map((instance) =>
      this.createdAudit(
        "fixed_expense_instance",
        instance.id,
        instance,
        nextPeriodId,
        occurredAt,
      ),
    )

    const snapshotPayload: Omit<PeriodSnapshot, "integrity"> = {
      id: snapshotId,
      periodId: period.id,
      periodKey: period.periodKey,
      schemaVersion: "1.1.0",
      snapshotKind: "canonical",
      closedAt: occurredAt,
      data: {
        periodPlan: { plannedSalaryAmount: period.plannedSalaryAmount },
        operations: source.operations.filter(({ periodId }) => periodId === period.id),
        movements: source.movements.filter(({ periodId }) => periodId === period.id),
        fixedExpenses: snapshotInstances,
        periodOpenings: source.periodOpenings.filter(({ periodId }) => periodId === period.id),
        auditEvents: [
          ...source.auditEvents.filter(({ periodId }) => periodId === period.id),
          closeAudit,
          ...finalizedAudits,
        ],
        entitySnapshots: {
          accounts: source.accounts,
          savingsGoals: source.savingsGoals,
          debts: source.debts,
          categories: source.categories,
        },
        openingBalances: reconciled.openingBalances,
        closingBalances: reconciled.closingBalances,
        totals: summary,
        warnings: [],
      },
    }
    const payloadHash = (await this.hash(canonicalJson(snapshotPayload))).toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(payloadHash)) {
      throw new MonthlyCloseError(
        "snapshot_integrity",
        "No fue posible generar la integridad SHA-256 del cierre.",
      )
    }
    const periodSnapshot: PeriodSnapshot = {
      ...snapshotPayload,
      integrity: {
        algorithm: "SHA-256",
        payloadHash,
      },
    }
    const allAudits = [
      closeAudit,
      ...finalizedAudits,
      nextPeriodAudit,
      ...nextInstanceAudits,
    ]

    try {
      await this.repositories.monthlyClose.commit({
        expected: source,
        closedPeriod,
        periodSnapshot,
        finalizedFixedExpenseInstances: finalizedInstances,
        nextPeriod: nextPeriodRecord,
        nextPeriodOpenings: nextOpenings,
        nextFixedExpenseInstances: nextInstances,
        auditEvents: allAudits,
      })
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "conflict") {
        throw new MonthlyCloseError(
          "revision_conflict",
          "Los datos cambiaron durante el cierre; vuelve a revisarlos.",
        )
      }
      throw error
    }
    return { closedPeriod, snapshot: periodSnapshot, nextPeriod: nextPeriodRecord }
  }

  async listMonthlyHistory() {
    return (await this.repositories.periodSnapshots.getAll())
      .map((snapshot) => ({
        periodKey: snapshot.periodKey,
        closedAt: snapshot.closedAt,
        totals: snapshot.data.totals,
        snapshotId: snapshot.id,
      }))
      .toSorted((left, right) => right.periodKey.localeCompare(left.periodKey))
  }

  async getMonthlyHistoryDetail(periodKey: PeriodKey) {
    const snapshot = await this.repositories.periodSnapshots.getByPeriodKey(periodKey)
    if (!snapshot) {
      throw new MonthlyCloseError("history_not_found", "El mes histórico no existe.")
    }
    const { integrity, ...payload } = snapshot
    const actualHash = await this.hash(canonicalJson(payload))
    if (integrity.algorithm !== "SHA-256" || actualHash !== integrity.payloadHash) {
      throw new MonthlyCloseError(
        "snapshot_integrity",
        "El archivo histórico no supera la validación de integridad.",
      )
    }
    return snapshot
  }

  private async loadSource(): Promise<MonthlyCloseSource> {
    const [
      financialSettings,
      periods,
      accounts,
      savingsGoals,
      debts,
      categories,
      fixedExpenseTemplates,
      fixedExpenseInstances,
      operations,
      movements,
      periodOpenings,
      auditEvents,
      periodSnapshots,
    ] = await Promise.all([
      this.repositories.financialSettings.get("current"),
      this.repositories.periods.getAll(),
      this.repositories.accounts.getAll(),
      this.repositories.savingsGoals.getAll(),
      this.repositories.debts.getAll(),
      this.repositories.categories.getAll(),
      this.repositories.fixedExpenseTemplates.getAll(),
      this.repositories.fixedExpenseInstances.getAll(),
      this.repositories.operations.getAll(),
      this.repositories.movements.getAll(),
      this.repositories.periodOpenings.getAll(),
      this.repositories.auditEvents.getAll(),
      this.repositories.periodSnapshots.getAll(),
    ])
    if (!financialSettings) {
      throw new MonthlyCloseError(
        "no_settings",
        "Debes completar la configuración financiera antes de cerrar el mes.",
      )
    }
    return {
      financialSettings,
      periods,
      accounts,
      savingsGoals,
      debts,
      categories,
      fixedExpenseTemplates,
      fixedExpenseInstances,
      operations,
      movements,
      periodOpenings,
      auditEvents,
      periodSnapshots,
    }
  }

  private requireOpenPeriod(periods: readonly Period[]) {
    const open = periods.filter(({ status }) => status === "open")
    if (open.length === 0) {
      throw new MonthlyCloseError("no_open_period", "No existe un período abierto.")
    }
    if (open.length !== 1 || !open[0]) {
      throw new MonthlyCloseError(
        "multiple_open_periods",
        "Debe existir exactamente un período abierto.",
      )
    }
    return open[0]
  }

  private summary(
    period: Period,
    source: MonthlyCloseSource,
    instances: readonly FixedExpenseInstance[],
  ) {
    try {
      return deriveMonthlySummary({
        period,
        operations: source.operations,
        movements: source.movements,
        fixedExpenseInstances: instances,
      })
    } catch {
      throw new MonthlyCloseError(
        "invalid_fixed_expenses",
        "Las operaciones o gastos fijos del período son inconsistentes.",
      )
    }
  }

  private previewBlockers(
    period: Period,
    source: MonthlyCloseSource,
    instances: readonly FixedExpenseInstance[],
    summary: MonthlySummary,
  ) {
    const blockers: string[] = []
    if (period.plannedSalaryAmount > 0 && summary.receivedSalaryAmount === 0) {
      blockers.push("Registra el sueldo planificado antes de cerrar el período.")
    }
    if (instances.some(({ status }) => status === "unpaid")) {
      blockers.push("Un período abierto no puede contener gastos fijos ya marcados impagos.")
    }
    const templateIds = new Set(source.fixedExpenseTemplates.map(({ id }) => id))
    if (instances.some(({ templateId }) => !templateIds.has(templateId))) {
      blockers.push("Existe un gasto fijo sin su referencia persistente.")
    }
    return blockers
  }

  private continuingTargets(source: MonthlyCloseSource) {
    return [
      ...source.accounts
        .filter(({ status }) => status === "active")
        .map((account) => this.continuingAccount(account)),
      ...source.savingsGoals
        .filter(({ lifecycleStatus }) => lifecycleStatus === "active")
        .map((goal) => this.continuingGoal(goal)),
      ...source.debts
        .filter(
          ({ lifecycleStatus, outstandingAmount }) =>
            lifecycleStatus === "active" && outstandingAmount > 0,
        )
        .map((debt) => this.continuingDebt(debt)),
    ]
  }

  private continuingAccount(account: Account) {
    return {
      targetType: "account" as const,
      targetId: account.id,
      openingAmount: account.currentBalance,
    }
  }

  private continuingGoal(goal: SavingsGoal) {
    return {
      targetType: "savings_goal" as const,
      targetId: goal.id,
      openingAmount: goal.currentBalance,
    }
  }

  private continuingDebt(debt: Debt) {
    return {
      targetType: "debt" as const,
      targetId: debt.id,
      openingAmount: debt.outstandingAmount,
    }
  }

  private createdAudit(
    subjectType: "period" | "fixed_expense_instance",
    subjectId: EntityId,
    nextValue: Period | FixedExpenseInstance,
    periodId: EntityId,
    occurredAt: UtcTimestamp,
  ) {
    return assertAuditEventInvariant({
      id: this.createId(),
      periodId,
      subjectType,
      subjectId,
      action: "created",
      commandType: "period.close-and-open-next",
      previousRevision: null,
      nextRevision: nextValue.revision,
      previousValue: null,
      nextValue,
      reason: null,
      occurredAt,
    })
  }

  private changedAudit(
    subjectType: "period" | "fixed_expense_instance",
    subjectId: EntityId,
    action: "closed" | "updated",
    previousValue: Period | FixedExpenseInstance,
    nextValue: Period | FixedExpenseInstance,
    periodId: EntityId,
    occurredAt: UtcTimestamp,
  ) {
    return assertAuditEventInvariant({
      id: this.createId(),
      periodId,
      subjectType,
      subjectId,
      action,
      commandType: "period.close-and-open-next",
      previousRevision: previousValue.revision,
      nextRevision: nextValue.revision,
      previousValue,
      nextValue,
      reason: null,
      occurredAt,
    } as AuditEvent)
  }
}

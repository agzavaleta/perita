import type { AuditEvent } from "@/domain/audit"
import { CHILE_TIME_ZONE, CURRENCY } from "@/domain/constants"
import type { Account, FinancialSettings } from "@/domain/entities"
import {
  assertAccountInvariant,
  assertAuditEventInvariant,
  assertInitialBalancePolicy,
} from "@/domain/invariants"
import type { Period, PeriodOpening } from "@/domain/periods"
import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asPeriodKey,
  asRevision,
  asUtcTimestamp,
  type CivilDate,
  type EntityId,
  type PeriodKey,
  type UtcTimestamp,
} from "@/domain/primitives"
import type { PeritaRepositories } from "@/data/repositories"
import type {
  SetupDraft,
  SetupDraftAccount,
  SetupDraftStore,
} from "@/features/setup/data/setup-draft-store"

export type SetupStatus = "not_started" | "resumable" | "incomplete" | "completed"

export interface SetupAccountDraft {
  readonly id?: string
  readonly name: string
  readonly bank?: string | null
  readonly openingBalance: number
  readonly emoji?: string
}

export interface CompleteSetupInput {
  readonly periodKey: string
  readonly salaryReferenceAmount: number
  readonly variableExpenseBudgetAmount: number
  readonly accounts: readonly SetupAccountDraft[]
}

export interface SaveSetupDraftInput {
  readonly periodKey: string
  readonly salaryReferenceAmount: number
  readonly variableExpenseBudgetAmount: number
  readonly accounts: readonly {
    readonly id: string
    readonly name: string
    readonly bank?: string | null
    readonly openingBalance: number
    readonly emoji?: string
  }[]
}

export interface SetupWarning {
  readonly code: "negative_opening_balance"
  readonly accountId: EntityId
  readonly openingBalance: number
}

export interface SetupState {
  readonly status: SetupStatus
  readonly allowedPeriodKeys: readonly PeriodKey[]
  readonly draft: SetupDraft | null
}

export interface SetupResult {
  readonly financialSettings: FinancialSettings
  readonly period: Period
  readonly accounts: readonly Account[]
  readonly periodOpenings: readonly PeriodOpening[]
  readonly warnings: readonly SetupWarning[]
}

export interface SetupUseCasesPort {
  getState(): Promise<SetupState>
  saveDraft(draft: SaveSetupDraftInput): Promise<SetupDraft>
  deleteDraft(): Promise<void>
  completeSetup(input: CompleteSetupInput): Promise<SetupResult>
}

export class SetupUseCaseError extends Error {
  readonly code:
    | "already_completed"
    | "incomplete_installation"
    | "invalid_period"
    | "invalid_amount"
    | "invalid_account"
    | "persistence_conflict"

  constructor(code: SetupUseCaseError["code"], message: string) {
    super(message)
    this.name = "SetupUseCaseError"
    this.code = code
  }
}

interface Options {
  readonly now?: () => UtcTimestamp
  readonly today?: () => CivilDate
  readonly createId?: () => EntityId
  readonly draftStore?: SetupDraftStore
}

function transientDraftStore(): SetupDraftStore {
  let draft: SetupDraft | null = null
  return {
    read: async () => draft,
    save: async (next) => {
      draft = next
    },
    clear: async () => {
      draft = null
    },
    close() {},
  }
}

function defaultNow() {
  return asUtcTimestamp(new Date().toISOString())
}

function defaultToday() {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: CHILE_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  )
  return asCivilDate(`${values.year}-${values.month}-${values.day}`)
}

function previousPeriodKey(current: PeriodKey) {
  const [year, month] = current.split("-").map(Number)
  const previousMonth = month === 1 ? 12 : month - 1
  const previousYear = month === 1 ? year - 1 : year
  return asPeriodKey(`${previousYear}-${String(previousMonth).padStart(2, "0")}`)
}

function nonnegativeAmount(value: number, label: string) {
  try {
    return asClpAmount(value)
  } catch {
    throw new SetupUseCaseError(
      "invalid_amount",
      `${label} debe ser un entero CLP igual o mayor que cero.`,
    )
  }
}

function requiredName(value: string) {
  const name = value.trim()
  if (!name) {
    throw new SetupUseCaseError("invalid_account", "El nombre de la cuenta es obligatorio.")
  }
  return name
}

export class SetupUseCases implements SetupUseCasesPort {
  private readonly repositories: PeritaRepositories
  private readonly now: () => UtcTimestamp
  private readonly today: () => CivilDate
  private readonly createId: () => EntityId
  private readonly draftStore: SetupDraftStore

  constructor(repositories: PeritaRepositories, options: Options = {}) {
    this.repositories = repositories
    this.now = options.now ?? defaultNow
    this.today = options.today ?? defaultToday
    this.createId = options.createId ?? (() => asEntityId(globalThis.crypto.randomUUID()))
    this.draftStore = options.draftStore ?? transientDraftStore()
  }

  async getState(): Promise<SetupState> {
    const data = await this.repositories.administration.readSnapshot()
    const suggestedPeriodKeys = this.suggestedPeriodKeys()
    const empty = Object.values(data).every((records) => records.length === 0)
    if (empty) {
      const draft = await this.draftStore.read()
      const allowedPeriodKeys = draft && !suggestedPeriodKeys.includes(asPeriodKey(draft.periodKey))
        ? [...suggestedPeriodKeys, asPeriodKey(draft.periodKey)]
        : suggestedPeriodKeys
      return {
        status: draft ? "resumable" : "not_started",
        allowedPeriodKeys,
        draft,
      }
    }

    const openPeriods = data.periods.filter(({ status }) => status === "open")
    const period = openPeriods[0]
    const settings = data.financialSettings[0]
    const openings = new Map(
      data.periodOpenings
        .filter(
          ({ targetType, periodId }) =>
            targetType === "account" && periodId === period?.id,
        )
        .map((opening) => [opening.targetId, opening]),
    )
    const coherent =
      data.financialSettings.length === 1 &&
      settings?.key === "current" &&
      openPeriods.length === 1 &&
      data.accounts.length > 0 &&
      data.accounts.filter(({ status }) => status === "active").every((account) => {
        const opening = openings.get(account.id)
        return (
          account.status === "active" &&
          opening?.periodId === period?.id &&
          opening.openingAmount === account.openingBalance
        )
      })
    return {
      status: coherent ? "completed" : "incomplete",
      allowedPeriodKeys: suggestedPeriodKeys,
      draft: null,
    }
  }

  async saveDraft(input: SaveSetupDraftInput): Promise<SetupDraft> {
    const state = await this.getState()
    if (state.status === "completed") {
      throw new SetupUseCaseError("already_completed", "La configuración inicial ya fue completada.")
    }
    if (state.status === "incomplete") {
      throw new SetupUseCaseError(
        "incomplete_installation",
        "La instalación contiene una configuración parcial y no puede operar.",
      )
    }
    const draft: SetupDraft = {
      periodKey: this.validateInitialPeriod(input.periodKey),
      salaryReferenceAmount: nonnegativeAmount(
        input.salaryReferenceAmount,
        "El sueldo de referencia",
      ),
      variableExpenseBudgetAmount: nonnegativeAmount(
        input.variableExpenseBudgetAmount,
        "El presupuesto variable del período",
      ),
      accounts: input.accounts.map((account): SetupDraftAccount => {
        const draftId = account.id
        let openingBalance
        try {
          openingBalance = asClpAmount(account.openingBalance, {
            allowNegative: true,
          })
        } catch {
          throw new SetupUseCaseError(
            "invalid_amount",
            "El saldo inicial debe ser un entero CLP.",
          )
        }
        if (!draftId.trim()) {
          throw new SetupUseCaseError("invalid_account", "La cuenta del borrador requiere un identificador.")
        }
        return {
          id: draftId,
          name: account.name,
          bank: account.bank ?? null,
          openingBalance,
          emoji: account.emoji?.trim() || "💳",
        }
      }),
    }
    await this.draftStore.save(draft)
    return draft
  }

  deleteDraft() {
    return this.draftStore.clear()
  }

  async completeSetup(input: CompleteSetupInput): Promise<SetupResult> {
    const state = await this.getState()
    if (state.status === "completed") {
      throw new SetupUseCaseError("already_completed", "La configuración inicial ya fue completada.")
    }
    if (state.status === "incomplete") {
      throw new SetupUseCaseError(
        "incomplete_installation",
        "La instalación contiene una configuración parcial y no puede operar.",
      )
    }
    const periodKey = this.validateInitialPeriod(input.periodKey)
    if (input.accounts.length === 0) {
      throw new SetupUseCaseError("invalid_account", "Debes crear al menos una cuenta.")
    }

    const occurredAt = this.now()
    const periodId = this.createId()
    const financialSettings: FinancialSettings = {
      key: "current",
      salaryReferenceAmount: nonnegativeAmount(
        input.salaryReferenceAmount,
        "El sueldo de referencia",
      ),
      currency: CURRENCY,
      timezone: CHILE_TIME_ZONE,
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    const period: Period = {
      id: periodId,
      periodKey,
      plannedSalaryAmount: financialSettings.salaryReferenceAmount,
      variableExpenseBudgetAmount: nonnegativeAmount(
        input.variableExpenseBudgetAmount,
        "El presupuesto variable del período",
      ),
      openedAt: occurredAt,
      status: "open",
      closedAt: null,
      snapshotId: null,
      revision: asRevision(1),
    }
    const accounts = input.accounts.map((draft) => {
      let openingBalance
      try {
        openingBalance = asClpAmount(draft.openingBalance, { allowNegative: true })
      } catch {
        throw new SetupUseCaseError(
          "invalid_amount",
          "El saldo inicial debe ser un entero CLP.",
        )
      }
      const account = assertAccountInvariant({
        id: this.createId(),
        emoji: draft.emoji?.trim() || "💳",
        name: requiredName(draft.name),
        bank: draft.bank?.trim() || null,
        openingBalance,
        currentBalance: openingBalance,
        status: "active",
        deletedAt: null,
        balanceAtDeletion: null,
        revision: asRevision(1),
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      assertInitialBalancePolicy({
        targetType: "account",
        duringSetup: true,
        openingBalance,
        currentBalance: openingBalance,
      })
      return account
    })
    const periodOpenings = accounts.map((account): PeriodOpening => ({
      id: this.createId(),
      periodId,
      targetType: "account",
      targetId: account.id,
      openingAmount: account.openingBalance,
    }))
    const warnings = accounts.flatMap((account): SetupWarning[] =>
      account.openingBalance < 0
        ? [{
            code: "negative_opening_balance",
            accountId: account.id,
            openingBalance: account.openingBalance,
          }]
        : [],
    )
    const auditEvents: AuditEvent[] = [
      this.createdAudit("financial_settings", "current", null, financialSettings, occurredAt),
      this.createdAudit("period", period.id, period.id, period, occurredAt),
      ...accounts.map((account) =>
        this.createdAudit("account", account.id, period.id, account, occurredAt),
      ),
    ]

    try {
      await this.repositories.setup.complete({
        financialSettings,
        period,
        accounts,
        periodOpenings,
        auditEvents,
      })
    } catch {
      throw new SetupUseCaseError(
        "persistence_conflict",
        "No fue posible completar la configuración de forma atómica.",
      )
    }
    await this.draftStore.clear()
    return { financialSettings, period, accounts, periodOpenings, warnings }
  }

  private suggestedPeriodKeys(): readonly [PeriodKey, PeriodKey] {
    const current = asPeriodKey(this.today().slice(0, 7))
    return [current, previousPeriodKey(current)]
  }

  private validateInitialPeriod(value: string) {
    let periodKey: PeriodKey
    try {
      periodKey = asPeriodKey(value)
    } catch {
      throw new SetupUseCaseError("invalid_period", "El período inicial no es válido.")
    }
    const currentPeriodKey = asPeriodKey(this.today().slice(0, 7))
    if (periodKey > currentPeriodKey) {
      throw new SetupUseCaseError(
        "invalid_period",
        "El período inicial no puede estar en el futuro.",
      )
    }
    return periodKey
  }

  private createdAudit(
    subjectType: "financial_settings" | "period" | "account",
    subjectId: "current" | EntityId,
    periodId: EntityId | null,
    nextValue: FinancialSettings | Period | Account,
    occurredAt: UtcTimestamp,
  ) {
    return assertAuditEventInvariant({
      id: this.createId(),
      periodId,
      commandType: "setup.complete",
      reason: null,
      occurredAt,
      subjectType,
      subjectId,
      action: "created",
      previousRevision: null,
      nextRevision: asRevision(1),
      previousValue: null,
      nextValue,
    } as AuditEvent)
  }
}

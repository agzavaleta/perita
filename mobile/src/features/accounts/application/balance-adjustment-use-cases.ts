import type { Account } from "@/domain/entities"
import {
  applyAccountMovementChange,
  assertOperationDateContext,
} from "@/domain/financial"
import { assertOperationMovementInvariant } from "@/domain/invariants"
import type {
  BalanceAdjustmentOperation,
  Movement,
} from "@/domain/operations"
import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asNonZeroClpDelta,
  asPositiveClpAmount,
  asRevision,
  asUtcTimestamp,
  type CivilDate,
  type EntityId,
  type Revision,
  type UtcTimestamp,
} from "@/domain/primitives"
import { PersistenceError } from "@/data/errors"
import type { PeritaRepositories } from "@/data/repositories"

export interface BalanceAdjustmentInput {
  readonly accountId: EntityId
  readonly expectedAccountRevision: Revision
  readonly operationDate: CivilDate
  readonly targetBalance: number
  readonly reason: string
}

export interface BalanceAdjustmentResult {
  readonly account: Account
  readonly operation: BalanceAdjustmentOperation
  readonly movement: Movement
}

export interface BalanceAdjustmentUseCasesPort {
  getCurrentDate(): CivilDate
  createAdjustment(input: BalanceAdjustmentInput): Promise<BalanceAdjustmentResult>
}

export class BalanceAdjustmentUseCaseError extends Error {
  readonly code:
    | "no_open_period"
    | "account_not_found"
    | "inactive_account"
    | "revision_conflict"
    | "invalid_amount"
    | "invalid_reason"
    | "no_changes"
    | "invalid_date"

  constructor(code: BalanceAdjustmentUseCaseError["code"], message: string) {
    super(message)
    this.name = "BalanceAdjustmentUseCaseError"
    this.code = code
  }
}

interface Options {
  readonly now?: () => UtcTimestamp
  readonly today?: () => CivilDate
  readonly createId?: () => EntityId
}

function defaultToday() {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Santiago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  )
  return asCivilDate(`${values.year}-${values.month}-${values.day}`)
}

export class BalanceAdjustmentUseCases implements BalanceAdjustmentUseCasesPort {
  private readonly repositories: PeritaRepositories
  private readonly now: () => UtcTimestamp
  private readonly today: () => CivilDate
  private readonly createId: () => EntityId

  constructor(repositories: PeritaRepositories, options: Options = {}) {
    this.repositories = repositories
    this.now = options.now ?? (() => asUtcTimestamp(new Date().toISOString()))
    this.today = options.today ?? defaultToday
    this.createId = options.createId ?? (() => asEntityId(globalThis.crypto.randomUUID()))
  }

  getCurrentDate() {
    return this.today()
  }

  async createAdjustment(input: BalanceAdjustmentInput) {
    const [periods, account] = await Promise.all([
      this.repositories.periods.listByStatus("open"),
      this.repositories.accounts.get(input.accountId),
    ])
    const period = periods[0]
    if (periods.length !== 1 || !period) {
      throw new BalanceAdjustmentUseCaseError(
        "no_open_period",
        "Debe existir un único período abierto.",
      )
    }
    if (!account) {
      throw new BalanceAdjustmentUseCaseError("account_not_found", "La cuenta no existe.")
    }
    if (account.status !== "active") {
      throw new BalanceAdjustmentUseCaseError(
        "inactive_account",
        "Solo se puede ajustar una cuenta activa.",
      )
    }
    if (account.revision !== input.expectedAccountRevision) {
      throw new BalanceAdjustmentUseCaseError(
        "revision_conflict",
        "La cuenta cambió desde que fue abierta.",
      )
    }
    let targetBalance
    try {
      targetBalance = asClpAmount(input.targetBalance)
    } catch {
      throw new BalanceAdjustmentUseCaseError(
        "invalid_amount",
        "Después del setup, el saldo corregido debe ser un entero CLP no negativo.",
      )
    }
    const delta = targetBalance - account.currentBalance
    if (delta === 0) {
      throw new BalanceAdjustmentUseCaseError("no_changes", "El saldo ya coincide con el valor indicado.")
    }
    let movementDelta
    try {
      movementDelta = asNonZeroClpDelta(delta)
    } catch {
      throw new BalanceAdjustmentUseCaseError("invalid_amount", "El ajuste excede el rango CLP permitido.")
    }
    const reason = input.reason.trim()
    if (!reason) {
      throw new BalanceAdjustmentUseCaseError("invalid_reason", "El motivo del ajuste es obligatorio.")
    }
    const occurredAt = this.now()
    const operation: BalanceAdjustmentOperation = {
      id: this.createId(),
      periodId: period.id,
      type: "balance_adjustment",
      operationDate: input.operationDate,
      amount: asPositiveClpAmount(Math.abs(movementDelta)),
      details: { accountId: account.id, reason },
      status: "posted",
      voidedAt: null,
      voidReason: null,
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    try {
      assertOperationDateContext(operation, period, this.today())
    } catch {
      throw new BalanceAdjustmentUseCaseError(
        "invalid_date",
        "La fecha debe pertenecer al período abierto y no puede ser futura.",
      )
    }
    const movement: Movement = {
      id: this.createId(),
      operationId: operation.id,
      periodId: period.id,
      targetType: "account",
      targetId: account.id,
      effectType: "asset_balance",
      delta: movementDelta,
      status: "posted",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    assertOperationMovementInvariant(operation, [movement])
    const updatedAccount = applyAccountMovementChange({
      account,
      previousDelta: null,
      nextDelta: movementDelta,
      occurredAt,
    })
    try {
      await this.repositories.operations.commit({
        kind: "create",
        period: { id: period.id, revision: period.revision },
        expectedAccounts: [{ id: account.id, revision: account.revision }],
        accounts: [updatedAccount],
        operation,
        movement,
      })
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "conflict") {
        throw new BalanceAdjustmentUseCaseError(
          "revision_conflict",
          "Los datos cambiaron antes de guardar el ajuste.",
        )
      }
      throw error
    }
    return { account: updatedAccount, operation, movement }
  }
}

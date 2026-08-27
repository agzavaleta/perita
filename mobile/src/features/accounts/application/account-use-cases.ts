import type { AuditEvent } from "@/domain/audit"
import type { Account } from "@/domain/entities"
import {
  assertAccountInvariant,
  assertAuditEventInvariant,
  assertInitialBalancePolicy,
} from "@/domain/invariants"
import type { Movement, Operation } from "@/domain/operations"
import type { PeriodOpening } from "@/domain/periods"
import {
  asClpAmount,
  asEntityId,
  asRevision,
  asUtcTimestamp,
  type EntityId,
  type Revision,
  type UtcTimestamp,
} from "@/domain/primitives"
import type { PeritaRepositories } from "@/data/repositories"

export type AccountUseCaseErrorCode =
  | "account_not_found"
  | "invalid_account_emoji"
  | "invalid_account_name"
  | "no_open_period"
  | "no_changes"
  | "revision_conflict"
  | "invalid_account_state"
  | "nonzero_balance"

export class AccountUseCaseError extends Error {
  readonly code: AccountUseCaseErrorCode

  constructor(code: AccountUseCaseErrorCode, message: string) {
    super(message)
    this.name = "AccountUseCaseError"
    this.code = code
  }
}

export interface AccountDraft {
  readonly name: string
  readonly bank: string | null
  readonly emoji?: string
}

export interface EditAccountInput extends AccountDraft {
  readonly accountId: EntityId
  readonly expectedRevision: Revision
}

export interface ChangeAccountStatusInput {
  readonly accountId: EntityId
  readonly expectedRevision: Revision
}

export interface AccountMovementHistoryItem {
  readonly operation: Operation
  readonly movement: Movement
  readonly title: string
  readonly description: string | null
  readonly signedAmount: number
}

export interface AccountUseCasesPort {
  listAccounts(): Promise<Account[]>
  getAccount(accountId: EntityId): Promise<Account>
  listRelatedMovements(accountId: EntityId): Promise<AccountMovementHistoryItem[]>
  createAccount(input: AccountDraft): Promise<Account>
  editAccount(input: EditAccountInput): Promise<Account>
  deactivateAccount(input: ChangeAccountStatusInput): Promise<Account>
  deleteAccount(input: ChangeAccountStatusInput): Promise<void>
}

interface AccountUseCasesOptions {
  readonly now?: () => UtcTimestamp
  readonly createId?: () => EntityId
}

function defaultNow() {
  return asUtcTimestamp(new Date().toISOString())
}

function defaultCreateId() {
  return asEntityId(globalThis.crypto.randomUUID())
}

function normalizeDraft(input: AccountDraft, fallbackEmoji: string): Required<AccountDraft> {
  const name = input.name.trim()
  if (!name) {
    throw new AccountUseCaseError(
      "invalid_account_name",
      "El nombre de la cuenta es obligatorio.",
    )
  }
  const bank = input.bank?.trim() || null
  const emoji = input.emoji === undefined ? fallbackEmoji : input.emoji.trim()
  if (!emoji) {
    throw new AccountUseCaseError(
      "invalid_account_emoji",
      "El emoji de la cuenta es obligatorio.",
    )
  }
  return { name, bank, emoji }
}

function historyTitle(operation: Operation) {
  switch (operation.type) {
    case "balance_adjustment":
      return "Ajuste de saldo"
    case "salary_receipt":
      return "Sueldo recibido"
    case "additional_income":
      return operation.details.concept ?? "Ingreso adicional"
    case "variable_expense":
      return operation.details.concept
    case "fixed_expense_payment":
      return "Pago de gasto fijo"
    case "debt_payment":
      return operation.details.concept ?? "Pago de deuda"
    case "transfer":
      return operation.details.concept ?? "Movimiento interno"
    case "savings_deposit":
      return operation.details.concept ?? "Aporte a meta"
    case "savings_withdrawal":
      return operation.details.concept ?? "Retiro de meta"
    case "debt_total_adjustment":
      return "Ajuste de deuda"
  }
}

function historyDescription(operation: Operation) {
  switch (operation.type) {
    case "balance_adjustment":
      return operation.details.reason
    case "additional_income":
    case "variable_expense":
    case "debt_payment":
    case "savings_deposit":
    case "savings_withdrawal":
    case "transfer":
      return operation.details.observation
    default:
      return null
  }
}

export class AccountUseCases implements AccountUseCasesPort {
  private readonly repositories: PeritaRepositories
  private readonly now: () => UtcTimestamp
  private readonly createId: () => EntityId

  constructor(
    repositories: PeritaRepositories,
    options: AccountUseCasesOptions = {},
  ) {
    this.repositories = repositories
    this.now = options.now ?? defaultNow
    this.createId = options.createId ?? defaultCreateId
  }

  async listAccounts() {
    const accounts = await this.repositories.accounts.getAll()
    return accounts.filter(({ status }) => status !== "deleted").toSorted((left, right) => {
      if (left.status !== right.status) return left.status === "active" ? -1 : 1
      return left.name.localeCompare(right.name, "es")
    })
  }

  async getAccount(accountId: EntityId) {
    return this.requireAccount(accountId)
  }

  async listRelatedMovements(accountId: EntityId) {
    await this.requireAccount(accountId)
    const movements = await this.repositories.movements.listByTarget(
      "account",
      accountId,
    )
    const records = await Promise.all(
      movements.map(async (movement) => ({
        movement,
        operation: await this.repositories.operations.get(movement.operationId),
      })),
    )
    return records
      .flatMap(({ movement, operation }) =>
        operation
          ? [{
              operation,
              movement,
              title: historyTitle(operation),
              description: historyDescription(operation),
              signedAmount: movement.delta,
            } satisfies AccountMovementHistoryItem]
          : [],
      )
      .toSorted(
        (left, right) =>
          right.operation.operationDate.localeCompare(
            left.operation.operationDate,
          ) || right.operation.createdAt.localeCompare(left.operation.createdAt),
      )
  }

  async createAccount(input: AccountDraft) {
    const draft = normalizeDraft(input, "💳")
    const period = await this.requireOpenPeriod()
    const occurredAt = this.now()
    const account = assertAccountInvariant({
      id: this.createId(),
      emoji: draft.emoji,
      name: draft.name,
      bank: draft.bank,
      openingBalance: asClpAmount(0),
      currentBalance: asClpAmount(0),
      status: "active",
      deletedAt: null,
      balanceAtDeletion: null,
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    })
    assertInitialBalancePolicy({
      targetType: "account",
      duringSetup: false,
      openingBalance: account.openingBalance,
      currentBalance: account.currentBalance,
    })

    const opening: PeriodOpening = {
      id: this.createId(),
      periodId: period.id,
      targetType: "account",
      targetId: account.id,
      openingAmount: asClpAmount(0),
    }
    const auditEvent = this.createdAudit(account, period.id, occurredAt)

    await this.repositories.accounts.addWithOpeningAndAudit(
      account,
      opening,
      auditEvent,
    )
    return account
  }

  async editAccount(input: EditAccountInput) {
    const period = await this.requireOpenPeriod()
    const previous = await this.requireAccount(input.accountId)
    const draft = normalizeDraft(input, previous.emoji)
    this.assertRevision(previous, input.expectedRevision)
    this.assertNotDeleted(previous)
    if (
      previous.name === draft.name &&
      previous.bank === draft.bank &&
      previous.emoji === draft.emoji
    ) {
      throw new AccountUseCaseError(
        "no_changes",
        "No hay cambios para guardar.",
      )
    }

    const occurredAt = this.now()
    const account = assertAccountInvariant({
      ...previous,
      emoji: draft.emoji,
      name: draft.name,
      bank: draft.bank,
      revision: this.nextRevision(previous.revision),
      updatedAt: occurredAt,
    })
    const auditEvent = this.changedAudit(
      "updated",
      "account.update",
      previous,
      account,
      period.id,
      occurredAt,
    )
    await this.repositories.accounts.putWithAudit(account, auditEvent)
    return account
  }

  async deactivateAccount(input: ChangeAccountStatusInput) {
    const period = await this.requireOpenPeriod()
    const previous = await this.requireAccount(input.accountId)
    this.assertRevision(previous, input.expectedRevision)
    this.assertNotDeleted(previous)
    if (previous.status !== "active") {
      throw new AccountUseCaseError(
        "invalid_account_state",
        "La cuenta ya está inactiva.",
      )
    }
    if (previous.currentBalance !== 0) {
      throw new AccountUseCaseError(
        "nonzero_balance",
        "La cuenta debe tener saldo $0 antes de desactivarla.",
      )
    }

    const occurredAt = this.now()
    const account = assertAccountInvariant({
      ...previous,
      status: "inactive",
      revision: this.nextRevision(previous.revision),
      updatedAt: occurredAt,
    })
    const auditEvent = this.changedAudit(
      "deactivated",
      "account.deactivate",
      previous,
      account,
      period.id,
      occurredAt,
    )
    await this.repositories.accounts.putWithAudit(account, auditEvent)
    return account
  }

  async deleteAccount(input: ChangeAccountStatusInput) {
    const [period, previous] = await Promise.all([
      this.requireOpenPeriod(),
      this.requireAccount(input.accountId),
    ])
    this.assertRevision(previous, input.expectedRevision)
    this.assertNotDeleted(previous)
    const occurredAt = this.now()
    const account = assertAccountInvariant({
      ...previous,
      status: "deleted",
      deletedAt: occurredAt,
      balanceAtDeletion: previous.currentBalance,
      revision: this.nextRevision(previous.revision),
      updatedAt: occurredAt,
    })
    const auditEvent = this.deletedAudit(previous, account, period.id, occurredAt)
    await this.repositories.accounts.putWithAudit(account, auditEvent)
  }

  private async requireOpenPeriod() {
    const periods = await this.repositories.periods.listByStatus("open")
    if (periods.length !== 1) {
      throw new AccountUseCaseError(
        "no_open_period",
        "Se necesita un período mensual abierto para modificar cuentas.",
      )
    }
    return periods[0]
  }

  private async requireAccount(accountId: EntityId) {
    const account = await this.repositories.accounts.get(accountId)
    if (!account) {
      throw new AccountUseCaseError(
        "account_not_found",
        "La cuenta solicitada no existe.",
      )
    }
    return assertAccountInvariant(account)
  }

  private assertRevision(account: Account, expectedRevision: Revision) {
    if (account.revision !== expectedRevision) {
      throw new AccountUseCaseError(
        "revision_conflict",
        "La cuenta cambió desde que fue abierta. Vuelve a intentarlo.",
      )
    }
  }

  private assertNotDeleted(account: Account) {
    if (account.status === "deleted") {
      throw new AccountUseCaseError(
        "invalid_account_state",
        "La cuenta eliminada no admite cambios.",
      )
    }
  }

  private nextRevision(revision: Revision) {
    return asRevision(Number(revision) + 1)
  }

  private createdAudit(
    account: Account,
    periodId: EntityId,
    occurredAt: UtcTimestamp,
  ): AuditEvent {
    return assertAuditEventInvariant({
      id: this.createId(),
      periodId,
      subjectType: "account",
      subjectId: account.id,
      action: "created",
      commandType: "account.create",
      previousRevision: null,
      nextRevision: account.revision,
      previousValue: null,
      nextValue: account,
      reason: null,
      occurredAt,
    })
  }

  private deletedAudit(
    previous: Account,
    account: Account,
    periodId: EntityId,
    occurredAt: UtcTimestamp,
  ): AuditEvent {
    return assertAuditEventInvariant({
      id: this.createId(),
      periodId,
      subjectType: "account",
      subjectId: account.id,
      action: "deleted",
      commandType: "account.delete",
      previousRevision: previous.revision,
      nextRevision: account.revision,
      previousValue: previous,
      nextValue: account,
      reason: null,
      occurredAt,
    })
  }

  private changedAudit(
    action: "updated" | "activated" | "deactivated",
    commandType: string,
    previous: Account,
    account: Account,
    periodId: EntityId,
    occurredAt: UtcTimestamp,
  ): AuditEvent {
    return assertAuditEventInvariant({
      id: this.createId(),
      periodId,
      subjectType: "account",
      subjectId: account.id,
      action,
      commandType,
      previousRevision: previous.revision,
      nextRevision: account.revision,
      previousValue: previous,
      nextValue: account,
      reason: null,
      occurredAt,
    })
  }
}

import type { AuditEvent } from "@/domain/audit"
import type { Account } from "@/domain/entities"
import {
  assertAccountInvariant,
  assertAuditEventInvariant,
  assertInitialBalancePolicy,
} from "@/domain/invariants"
import type { Movement } from "@/domain/operations"
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
}

export interface EditAccountInput extends AccountDraft {
  readonly accountId: EntityId
  readonly expectedRevision: Revision
}

export interface ChangeAccountStatusInput {
  readonly accountId: EntityId
  readonly expectedRevision: Revision
}

export interface AccountUseCasesPort {
  listAccounts(): Promise<Account[]>
  getAccount(accountId: EntityId): Promise<Account>
  listRelatedMovements(accountId: EntityId): Promise<Movement[]>
  createAccount(input: AccountDraft): Promise<Account>
  editAccount(input: EditAccountInput): Promise<Account>
  deactivateAccount(input: ChangeAccountStatusInput): Promise<Account>
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

function normalizeDraft(input: AccountDraft): AccountDraft {
  const name = input.name.trim()
  if (!name) {
    throw new AccountUseCaseError(
      "invalid_account_name",
      "El nombre de la cuenta es obligatorio.",
    )
  }
  const bank = input.bank?.trim() || null
  return { name, bank }
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
    return accounts.toSorted((left, right) => {
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
    return movements.toSorted((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    )
  }

  async createAccount(input: AccountDraft) {
    const draft = normalizeDraft(input)
    const period = await this.requireOpenPeriod()
    const occurredAt = this.now()
    const account = assertAccountInvariant({
      id: this.createId(),
      name: draft.name,
      bank: draft.bank,
      openingBalance: asClpAmount(0),
      currentBalance: asClpAmount(0),
      status: "active",
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
    const draft = normalizeDraft(input)
    const period = await this.requireOpenPeriod()
    const previous = await this.requireAccount(input.accountId)
    this.assertRevision(previous, input.expectedRevision)
    if (previous.name === draft.name && previous.bank === draft.bank) {
      throw new AccountUseCaseError(
        "no_changes",
        "No hay cambios para guardar.",
      )
    }

    const occurredAt = this.now()
    const account = assertAccountInvariant({
      ...previous,
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

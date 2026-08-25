import type {
  Account,
  Category,
  FixedExpenseInstance,
  SavingsGoal,
} from "@/domain/entities"
import {
  applyAccountMovementChange,
  applySavingsGoalMovementChange,
  assertOperationDateContext,
} from "@/domain/financial"
import { assertOperationMovementInvariant } from "@/domain/invariants"
import type {
  AdditionalIncomeOperation,
  BalanceAdjustmentOperation,
  FixedExpensePaymentOperation,
  Movement,
  Operation,
  OperationRevision,
  SalaryReceiptOperation,
  SavingsDepositOperation,
  SavingsWithdrawalOperation,
  TransferEndpointType,
  TransferOperation,
  VariableExpenseOperation,
} from "@/domain/operations"
import type { Period } from "@/domain/periods"
import {
  asCivilDate,
  asEntityId,
  asNonZeroClpDelta,
  asPositiveClpAmount,
  asRevision,
  asUtcTimestamp,
  type CivilDate,
  type EntityId,
  type PositiveClpAmount,
  type Revision,
  type UtcTimestamp,
} from "@/domain/primitives"
import { PersistenceError } from "@/data/errors"
import type {
  FinancialOperationMutation,
  InternalTransferMutation,
  PeritaRepositories,
} from "@/data/repositories"

export type SupportedMovementOperation =
  | AccountBalanceAdjustmentOperation
  | GoalBalanceAdjustmentOperation
  | SalaryReceiptOperation
  | AdditionalIncomeOperation
  | VariableExpenseOperation
  | FixedExpensePaymentOperation
  | SavingsDepositOperation
  | SavingsWithdrawalOperation
  | TransferOperation

export type MovementKind = "income" | "expense" | "transfer"
export type MovementListKind = MovementKind | "adjustment" | "savings"

type AccountBalanceAdjustmentOperation = BalanceAdjustmentOperation & {
  readonly details: {
    readonly accountId: EntityId
    readonly goalId?: never
    readonly reason: string
  }
}

type GoalBalanceAdjustmentOperation = BalanceAdjustmentOperation & {
  readonly details: {
    readonly accountId?: never
    readonly goalId: EntityId
    readonly reason: string
  }
}

type EditableMovementOperation = Exclude<
  SupportedMovementOperation,
  | AccountBalanceAdjustmentOperation
  | GoalBalanceAdjustmentOperation
  | SavingsDepositOperation
  | SavingsWithdrawalOperation
>

export interface MovementListItem {
  readonly operation: SupportedMovementOperation
  readonly movement: Movement
  readonly movements: readonly Movement[]
  readonly kind: MovementListKind
  readonly title: string
  readonly description: string | null
  readonly accountName: string
  readonly signedAmount: number
}

export interface MovementFilters {
  readonly query?: string
  readonly kind?: "all" | MovementListKind
  readonly status?: "all" | Operation["status"]
  readonly accountId?: "all" | EntityId
  readonly dateFrom?: CivilDate | null
  readonly dateTo?: CivilDate | null
}

export interface IncomeDraft {
  readonly incomeType: "salary" | "additional"
  readonly accountId: EntityId
  readonly operationDate: CivilDate
  readonly amount: number
  readonly concept?: string | null
  readonly observation?: string | null
}

export interface ExpenseDraft {
  readonly accountId: EntityId
  readonly categoryId: EntityId
  readonly operationDate: CivilDate
  readonly amount: number
  readonly concept: string
  readonly observation?: string | null
}

export interface FixedExpensePaymentDraft {
  readonly accountId: EntityId
  readonly fixedExpenseInstanceId: EntityId
  readonly operationDate: CivilDate
  readonly amount: number
}

export interface EditMovementInput {
  readonly operationId: EntityId
  readonly expectedRevision: Revision
  readonly accountId: EntityId
  readonly operationDate: CivilDate
  readonly amount: number
  readonly concept?: string | null
  readonly observation?: string | null
  readonly categoryId?: EntityId
}

export interface VoidMovementInput {
  readonly operationId: EntityId
  readonly expectedRevision: Revision
  readonly reason?: string | null
}

export interface TransferDraft {
  readonly sourceType: TransferEndpointType
  readonly sourceId: EntityId
  readonly destinationType: TransferEndpointType
  readonly destinationId: EntityId
  readonly operationDate: CivilDate
  readonly amount: number
  readonly concept?: string | null
  readonly observation?: string | null
}

export interface SavingsMovementDraft {
  readonly goalId: EntityId
  readonly operationDate: CivilDate
  readonly amount: number
  readonly concept?: string | null
  readonly observation?: string | null
}

export interface SavingsMovementResult {
  readonly goal: SavingsGoal
  readonly operation: SavingsDepositOperation | SavingsWithdrawalOperation
  readonly movement: Movement
}

export interface EditSavingsMovementInput {
  readonly operationId: EntityId
  readonly expectedRevision: Revision
  readonly operationDate: CivilDate
  readonly amount: number
  readonly concept?: string | null
  readonly observation?: string | null
}

export interface VoidSavingsMovementInput {
  readonly operationId: EntityId
  readonly expectedRevision: Revision
  readonly reason?: string | null
}

export interface EditTransferInput extends TransferDraft {
  readonly operationId: EntityId
  readonly expectedRevision: Revision
}

export interface TransferPreview {
  readonly source: {
    readonly name: string
    readonly currentBalance: number
    readonly resultingBalance: number
  }
  readonly destination: {
    readonly name: string
    readonly currentBalance: number
    readonly resultingBalance: number
  }
  readonly amount: number
  readonly operationDate: CivilDate
}

export interface MovementDetail extends MovementListItem {
  readonly revisions: readonly OperationRevision[]
}

export interface MovementFormOptions {
  readonly accounts: readonly Account[]
  readonly categories: readonly Category[]
  readonly currentDate: CivilDate
}

export interface TransferFormOptions {
  readonly accounts: readonly Account[]
  readonly savingsGoals: readonly SavingsGoal[]
  readonly currentDate: CivilDate
}

export interface MovementUseCasesPort {
  getCurrentDate(): CivilDate
  getOpenPeriodId(): Promise<EntityId>
  getFormOptions(): Promise<MovementFormOptions>
  getTransferFormOptions(): Promise<TransferFormOptions>
  listMovements(filters?: MovementFilters): Promise<MovementListItem[]>
  getMovementDetail(operationId: EntityId): Promise<MovementDetail>
  registerIncome(input: IncomeDraft): Promise<MovementListItem>
  registerExpense(input: ExpenseDraft): Promise<MovementListItem>
  registerFixedExpensePayment(
    input: FixedExpensePaymentDraft,
  ): Promise<MovementListItem>
  registerTransfer(input: TransferDraft): Promise<MovementListItem>
  previewTransfer(input: TransferDraft | EditTransferInput): Promise<TransferPreview>
  registerSavingsDeposit(input: SavingsMovementDraft): Promise<SavingsMovementResult>
  registerSavingsWithdrawal(
    input: SavingsMovementDraft,
  ): Promise<SavingsMovementResult>
  editSavingsMovement(input: EditSavingsMovementInput): Promise<SavingsMovementResult>
  voidSavingsMovement(input: VoidSavingsMovementInput): Promise<SavingsMovementResult>
  editMovement(input: EditMovementInput): Promise<MovementListItem>
  editTransfer(input: EditTransferInput): Promise<MovementListItem>
  voidMovement(input: VoidMovementInput): Promise<MovementListItem>
}

export type MovementUseCaseErrorCode =
  | "no_open_period"
  | "account_not_found"
  | "inactive_account"
  | "category_not_found"
  | "inactive_category"
  | "savings_goal_not_found"
  | "inactive_savings_goal"
  | "same_transfer_endpoint"
  | "operation_not_found"
  | "unsupported_operation"
  | "invalid_operation_state"
  | "invalid_amount"
  | "invalid_text"
  | "invalid_date"
  | "insufficient_balance"
  | "salary_already_posted"
  | "revision_conflict"
  | "no_changes"

export class MovementUseCaseError extends Error {
  readonly code: MovementUseCaseErrorCode

  constructor(code: MovementUseCaseErrorCode, message: string) {
    super(message)
    this.name = "MovementUseCaseError"
    this.code = code
  }
}

interface MovementUseCasesOptions {
  readonly now?: () => UtcTimestamp
  readonly today?: () => CivilDate
  readonly createId?: () => EntityId
}

function defaultNow() {
  return asUtcTimestamp(new Date().toISOString())
}

function defaultToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date())
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return asCivilDate(`${value.year}-${value.month}-${value.day}`)
}

function defaultCreateId() {
  return asEntityId(globalThis.crypto.randomUUID())
}

function optionalText(value: string | null | undefined) {
  return value?.trim() || null
}

function requiredText(value: string, field: string) {
  const normalized = value.trim()
  if (!normalized) {
    throw new MovementUseCaseError(
      "invalid_text",
      `${field} es obligatorio.`,
    )
  }
  return normalized
}

function positiveAmount(value: number): PositiveClpAmount {
  try {
    return asPositiveClpAmount(value)
  } catch {
    throw new MovementUseCaseError(
      "invalid_amount",
      "El monto debe ser un entero CLP mayor que cero.",
    )
  }
}

function isSupported(operation: Operation): operation is SupportedMovementOperation {
  return (
    operation.type === "balance_adjustment" ||
    operation.type === "salary_receipt" ||
    operation.type === "additional_income" ||
    operation.type === "variable_expense" ||
    operation.type === "fixed_expense_payment" ||
    operation.type === "savings_deposit" ||
    operation.type === "savings_withdrawal" ||
    operation.type === "transfer"
  )
}

function isEditable(
  operation: SupportedMovementOperation,
): operation is EditableMovementOperation {
  return (
    operation.type !== "balance_adjustment" &&
    operation.type !== "savings_deposit" &&
    operation.type !== "savings_withdrawal"
  )
}

function operationAccountId(
  operation:
    | AccountBalanceAdjustmentOperation
    | SalaryReceiptOperation
    | AdditionalIncomeOperation
    | VariableExpenseOperation
    | FixedExpensePaymentOperation,
) {
  return operation.details.accountId
}

function operationGoalId(
  operation:
    | GoalBalanceAdjustmentOperation
    | SavingsDepositOperation
    | SavingsWithdrawalOperation,
) {
  return operation.details.goalId
}

function isGoalOperation(
  operation: SupportedMovementOperation,
): operation is
  | GoalBalanceAdjustmentOperation
  | SavingsDepositOperation
  | SavingsWithdrawalOperation {
  return (
    operation.type === "savings_deposit" ||
    operation.type === "savings_withdrawal" ||
    (operation.type === "balance_adjustment" && "goalId" in operation.details)
  )
}

function operationTitle(operation: SupportedMovementOperation) {
  if (operation.type === "balance_adjustment") return "Ajuste de saldo"
  if (operation.type === "savings_deposit") return "Depósito"
  if (operation.type === "savings_withdrawal") return "Retiro"
  if (operation.type === "transfer") {
    return operation.details.concept ?? "Movimiento interno"
  }
  if (operation.type === "salary_receipt") return "Sueldo recibido"
  if (operation.type === "additional_income") {
    return operation.details.concept ?? "Ingreso adicional"
  }
  if (operation.type === "fixed_expense_payment") return "Pago de gasto fijo"
  return operation.details.concept
}

function operationDescription(operation: SupportedMovementOperation) {
  if (operation.type === "balance_adjustment") return operation.details.reason
  if (
    operation.type === "savings_deposit" ||
    operation.type === "savings_withdrawal"
  ) {
    return [operation.details.concept, operation.details.observation]
      .filter(Boolean)
      .join(" · ") || null
  }
  if (operation.type === "transfer") return operation.details.observation
  if (operation.type === "salary_receipt") return null
  if (operation.type === "variable_expense") {
    return operation.details.categoryName
  }
  if (operation.type === "fixed_expense_payment") return null
  return operation.details.observation
}

function targetKey(type: TransferEndpointType, id: EntityId) {
  return `${type}:${id}` as const
}

type TransferTargetRecord =
  | { readonly type: "account"; readonly entity: Account }
  | { readonly type: "savings_goal"; readonly entity: SavingsGoal }

type AccountMovementOperation = Exclude<
  EditableMovementOperation,
  TransferOperation
>

export class MovementUseCases implements MovementUseCasesPort {
  private readonly repositories: PeritaRepositories
  private readonly now: () => UtcTimestamp
  private readonly today: () => CivilDate
  private readonly createId: () => EntityId

  constructor(
    repositories: PeritaRepositories,
    options: MovementUseCasesOptions = {},
  ) {
    this.repositories = repositories
    this.now = options.now ?? defaultNow
    this.today = options.today ?? defaultToday
    this.createId = options.createId ?? defaultCreateId
  }

  async getFormOptions() {
    const [accounts, categories] = await Promise.all([
      this.repositories.accounts.getAll(),
      this.repositories.categories.getAll(),
    ])
    return {
      accounts: accounts
        .filter(({ status }) => status === "active")
        .toSorted((left, right) => left.name.localeCompare(right.name, "es")),
      categories: categories.toSorted((left, right) =>
        left.name.localeCompare(right.name, "es"),
      ),
      currentDate: this.today(),
    }
  }

  getCurrentDate() {
    return this.today()
  }

  async getOpenPeriodId() {
    return (await this.requireOpenPeriod()).id
  }

  async getTransferFormOptions() {
    const [accounts, savingsGoals] = await Promise.all([
      this.repositories.accounts.getAll(),
      this.repositories.savingsGoals.getAll(),
    ])
    return {
      accounts: accounts
        .filter(({ status }) => status === "active")
        .toSorted((left, right) => left.name.localeCompare(right.name, "es")),
      savingsGoals: savingsGoals
        .filter(({ lifecycleStatus }) => lifecycleStatus === "active")
        .toSorted((left, right) => left.name.localeCompare(right.name, "es")),
      currentDate: this.today(),
    }
  }

  async listMovements(filters: MovementFilters = {}) {
    const period = await this.requireOpenPeriod()
    const [operations, movements, accounts, savingsGoals, fixedInstances] = await Promise.all([
      this.repositories.operations.listByPeriod(period.id),
      this.repositories.movements.listByPeriod(period.id),
      this.repositories.accounts.getAll(),
      this.repositories.savingsGoals.getAll(),
      this.repositories.fixedExpenseInstances.listByPeriod(period.id),
    ])
    const accountMap = new Map(accounts.map((account) => [account.id, account]))
    const goalMap = new Map(savingsGoals.map((goal) => [goal.id, goal]))
    const fixedInstanceMap = new Map(
      fixedInstances.map((instance) => [instance.id, instance]),
    )
    const movementsByOperation = new Map<EntityId, Movement[]>()
    for (const movement of movements) {
      const related = movementsByOperation.get(movement.operationId) ?? []
      related.push(movement)
      movementsByOperation.set(movement.operationId, related)
    }
    const query = filters.query?.trim().toLocaleLowerCase("es") ?? ""

    return operations
      .filter(isSupported)
      .flatMap((operation) => {
        const related = movementsByOperation.get(operation.id) ?? []
        let item: MovementListItem
        if (operation.type === "transfer") {
          const sourceName =
            operation.details.sourceType === "account"
              ? accountMap.get(operation.details.sourceId)?.name
              : goalMap.get(operation.details.sourceId)?.name
          const destinationName =
            operation.details.destinationType === "account"
              ? accountMap.get(operation.details.destinationId)?.name
              : goalMap.get(operation.details.destinationId)?.name
          if (!sourceName || !destinationName || related.length !== 2) return []
          item = this.toListItem(
            operation,
            related,
            `${sourceName} → ${destinationName}`,
          )
        } else if (isGoalOperation(operation)) {
          const goal = goalMap.get(operationGoalId(operation))
          if (!goal || related.length !== 1) return []
          item = this.toListItem(operation, related, goal.name)
        } else {
          const account = accountMap.get(operationAccountId(operation))
          if (!account || related.length !== 1) return []
          item = this.toListItem(
            operation,
            related,
            account.name,
            operation.type === "fixed_expense_payment"
              ? fixedInstanceMap.get(operation.details.fixedExpenseInstanceId)
                  ?.nameSnapshot
              : undefined,
          )
        }
        const haystack = [
          item.title,
          item.description,
          item.accountName,
          operation.type === "variable_expense"
            ? operation.details.observation
            : operation.type === "additional_income"
              ? operation.details.observation
              : operation.type === "savings_deposit" ||
                  operation.type === "savings_withdrawal"
                ? [operation.details.concept, operation.details.observation]
                    .filter(Boolean)
                    .join(" ")
              : null,
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase("es")
        if (query && !haystack.includes(query)) return []
        if (filters.kind && filters.kind !== "all" && item.kind !== filters.kind) {
          return []
        }
        if (
          filters.status &&
          filters.status !== "all" &&
          operation.status !== filters.status
        ) {
          return []
        }
        if (
          filters.accountId &&
          filters.accountId !== "all" &&
          (operation.type === "transfer"
            ? !(
                (operation.details.sourceType === "account" &&
                  operation.details.sourceId === filters.accountId) ||
                (operation.details.destinationType === "account" &&
                  operation.details.destinationId === filters.accountId)
              )
            : isGoalOperation(operation)
              ? true
            : operationAccountId(operation) !== filters.accountId)
        ) {
          return []
        }
        if (filters.dateFrom && operation.operationDate < filters.dateFrom) return []
        if (filters.dateTo && operation.operationDate > filters.dateTo) return []
        return [item]
      })
      .toSorted(
        (left, right) =>
          right.operation.operationDate.localeCompare(
            left.operation.operationDate,
          ) || right.operation.createdAt.localeCompare(left.operation.createdAt),
      )
  }

  async getMovementDetail(operationId: EntityId) {
    const operation = await this.requireListedOperation(operationId)
    const [movements, revisions] = await Promise.all([
      this.requireMovements(operation),
      this.repositories.operationRevisions.listByOperation(operationId),
    ])
    let targetNames: string
    if (operation.type === "transfer") {
      const [source, destination] = await Promise.all([
        this.requireTarget(operation.details.sourceType, operation.details.sourceId, true),
        this.requireTarget(
          operation.details.destinationType,
          operation.details.destinationId,
          true,
        ),
      ])
      targetNames = `${source.name} → ${destination.name}`
    } else if (isGoalOperation(operation)) {
      targetNames = (
        await this.requireSavingsGoal(operationGoalId(operation), true)
      ).name
    } else {
      targetNames = (
        await this.requireAccount(operationAccountId(operation), true)
      ).name
    }
    return {
      ...this.toListItem(operation, movements, targetNames),
      revisions: revisions.toSorted(
        (left, right) => Number(right.revisionNumber) - Number(left.revisionNumber),
      ),
    }
  }

  async registerIncome(input: IncomeDraft) {
    const period = await this.requireOpenPeriod()
    const account = await this.requireAccount(input.accountId)
    const amount = positiveAmount(input.amount)
    if (input.incomeType === "salary") {
      const posted = await this.repositories.operations.listByType(
        period.id,
        "salary_receipt",
      )
      if (posted.some(({ status }) => status === "posted")) {
        throw new MovementUseCaseError(
          "salary_already_posted",
          "Solo puede existir un sueldo recibido vigente por período.",
        )
      }
    }
    const occurredAt = this.now()
    const common = {
      id: this.createId(),
      periodId: period.id,
      operationDate: input.operationDate,
      amount,
      status: "posted" as const,
      voidedAt: null,
      voidReason: null,
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    const operation: SupportedMovementOperation =
      input.incomeType === "salary"
        ? { ...common, type: "salary_receipt", details: { accountId: account.id } }
        : {
            ...common,
            type: "additional_income",
            details: {
              accountId: account.id,
              concept: optionalText(input.concept),
              observation: optionalText(input.observation),
            },
          }
    return this.createOperation(period, account, operation, amount)
  }

  async registerExpense(input: ExpenseDraft) {
    const period = await this.requireOpenPeriod()
    const [account, category] = await Promise.all([
      this.requireAccount(input.accountId),
      this.requireCategory(input.categoryId),
    ])
    const amount = positiveAmount(input.amount)
    const occurredAt = this.now()
    const operation: VariableExpenseOperation = {
      id: this.createId(),
      periodId: period.id,
      type: "variable_expense",
      operationDate: input.operationDate,
      amount,
      details: {
        accountId: account.id,
        categoryId: category.id,
        categoryName: category.name,
        concept: requiredText(input.concept, "El concepto"),
        observation: optionalText(input.observation),
      },
      status: "posted",
      voidedAt: null,
      voidReason: null,
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    return this.createOperation(period, account, operation, -amount, category)
  }

  async registerFixedExpensePayment(input: FixedExpensePaymentDraft) {
    const period = await this.requireOpenPeriod()
    const [account, instance] = await Promise.all([
      this.requireAccount(input.accountId),
      this.repositories.fixedExpenseInstances.get(input.fixedExpenseInstanceId),
    ])
    if (
      !instance ||
      instance.periodId !== period.id ||
      instance.status !== "pending" ||
      instance.activePaymentOperationId !== null
    ) {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "Solo se puede pagar un gasto fijo pendiente del período abierto.",
      )
    }
    const amount = positiveAmount(input.amount)
    const occurredAt = this.now()
    const operation: FixedExpensePaymentOperation = {
      id: this.createId(),
      periodId: period.id,
      type: "fixed_expense_payment",
      operationDate: input.operationDate,
      amount,
      details: {
        accountId: account.id,
        fixedExpenseInstanceId: instance.id,
      },
      status: "posted",
      voidedAt: null,
      voidReason: null,
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    const paidInstance: FixedExpenseInstance = {
      ...instance,
      status: "paid",
      activePaymentOperationId: operation.id,
      revision: asRevision(Number(instance.revision) + 1),
      updatedAt: occurredAt,
    }
    return this.createOperation(
      period,
      account,
      operation,
      -amount,
      undefined,
      instance,
      paidInstance,
    )
  }

  async registerTransfer(input: TransferDraft) {
    this.assertDistinctEndpoints(input)
    const period = await this.requireOpenPeriod()
    const [source, destination] = await Promise.all([
      this.requireTarget(input.sourceType, input.sourceId),
      this.requireTarget(input.destinationType, input.destinationId),
    ])
    const amount = positiveAmount(input.amount)
    const occurredAt = this.now()
    const operation: TransferOperation = {
      id: this.createId(),
      periodId: period.id,
      type: "transfer",
      operationDate: input.operationDate,
      amount,
      details: {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        destinationType: input.destinationType,
        destinationId: input.destinationId,
        concept: optionalText(input.concept),
        observation: optionalText(input.observation),
      },
      status: "posted",
      voidedAt: null,
      voidReason: null,
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    assertOperationDateContext(operation, period, this.today())
    const movements = this.transferMovements(operation, occurredAt)
    const targets = new Map<string, TransferTargetRecord>()
    targets.set(
      targetKey(input.sourceType, input.sourceId),
      input.sourceType === "account"
        ? { type: "account", entity: source as Account }
        : { type: "savings_goal", entity: source as SavingsGoal },
    )
    targets.set(
      targetKey(input.destinationType, input.destinationId),
      input.destinationType === "account"
        ? { type: "account", entity: destination as Account }
        : { type: "savings_goal", entity: destination as SavingsGoal },
    )
    const updates = this.applyTransferImpacts(targets, [], movements, occurredAt)
    await this.commitTransfer({
      kind: "create",
      period,
      expectedTargets: [...targets.values()],
      updates,
      operation,
      movements,
    })
    return this.toListItem(
      operation,
      movements,
      `${source.name} → ${destination.name}`,
    )
  }

  async previewTransfer(
    input: TransferDraft | EditTransferInput,
  ): Promise<TransferPreview> {
    this.assertDistinctEndpoints(input)
    const period = await this.requireOpenPeriod()
    const editing = "operationId" in input
    const previousOperation = editing
      ? await this.requireTransfer(input.operationId)
      : null
    if (previousOperation && previousOperation.status !== "posted") {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "Solo se puede editar un movimiento vigente.",
      )
    }
    if (previousOperation && editing) {
      this.assertRevision(previousOperation.revision, input.expectedRevision)
      assertOperationDateContext(previousOperation, period, this.today())
    }
    const previousMovements = previousOperation
      ? await this.requireMovements(previousOperation)
      : []
    const declarations = previousOperation
      ? [
          {
            type: previousOperation.details.sourceType,
            id: previousOperation.details.sourceId,
            active: false,
          },
          {
            type: previousOperation.details.destinationType,
            id: previousOperation.details.destinationId,
            active: false,
          },
          { type: input.sourceType, id: input.sourceId, active: true },
          { type: input.destinationType, id: input.destinationId, active: true },
        ] as const
      : [
          { type: input.sourceType, id: input.sourceId, active: true },
          { type: input.destinationType, id: input.destinationId, active: true },
        ] as const
    const targets = await this.loadTransferTargets(declarations)
    const amount = positiveAmount(input.amount)
    const occurredAt = previousOperation?.updatedAt ?? period.openedAt
    const operation: TransferOperation = previousOperation
      ? {
          ...previousOperation,
          operationDate: input.operationDate,
          amount,
          details: {
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            destinationType: input.destinationType,
            destinationId: input.destinationId,
            concept: optionalText(input.concept),
            observation: optionalText(input.observation),
          },
          updatedAt: occurredAt,
        }
      : {
          id: period.id,
          periodId: period.id,
          type: "transfer",
          operationDate: input.operationDate,
          amount,
          details: {
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            destinationType: input.destinationType,
            destinationId: input.destinationId,
            concept: optionalText(input.concept),
            observation: optionalText(input.observation),
          },
          status: "posted",
          voidedAt: null,
          voidReason: null,
          revision: asRevision(1),
          createdAt: occurredAt,
          updatedAt: occurredAt,
        }
    assertOperationDateContext(operation, period, this.today())
    const movements = this.transferMovements(
      operation,
      occurredAt,
      previousMovements,
      [input.sourceId, input.destinationId],
    )
    const updates = this.applyTransferImpacts(
      targets,
      previousMovements,
      movements,
      occurredAt,
    )
    const source = targets.get(targetKey(input.sourceType, input.sourceId))
    const destination = targets.get(
      targetKey(input.destinationType, input.destinationId),
    )
    if (!source || !destination) {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "No fue posible resolver los fondos del movimiento.",
      )
    }
    const resultingBalance = (target: TransferTargetRecord) => {
      const collection =
        target.type === "account" ? updates.accounts : updates.savingsGoals
      return (
        collection.find(({ id }) => id === target.entity.id)?.currentBalance ??
        target.entity.currentBalance
      )
    }
    return {
      source: {
        name: source.entity.name,
        currentBalance: source.entity.currentBalance,
        resultingBalance: resultingBalance(source),
      },
      destination: {
        name: destination.entity.name,
        currentBalance: destination.entity.currentBalance,
        resultingBalance: resultingBalance(destination),
      },
      amount,
      operationDate: input.operationDate,
    }
  }

  registerSavingsDeposit(input: SavingsMovementDraft) {
    return this.registerSavingsGoalMovement(input, "savings_deposit")
  }

  registerSavingsWithdrawal(input: SavingsMovementDraft) {
    return this.registerSavingsGoalMovement(input, "savings_withdrawal")
  }

  async editSavingsMovement(input: EditSavingsMovementInput) {
    const period = await this.requireOpenPeriod()
    const previousOperation = await this.requireSavingsMovementOperation(
      input.operationId,
    )
    this.assertPostedSavingsMovement(previousOperation)
    this.assertRevision(previousOperation.revision, input.expectedRevision)
    this.assertSavingsMovementPeriod(previousOperation, period)
    const previousMovement = await this.requireSavingsMovementProjection(
      previousOperation,
    )
    const goal = await this.requireSavingsGoal(previousOperation.details.goalId)
    const amount = positiveAmount(input.amount)
    const occurredAt = this.now()
    const operation = {
      ...previousOperation,
      operationDate: input.operationDate,
      amount,
      details: {
        goalId: previousOperation.details.goalId,
        concept:
          input.concept === undefined
            ? previousOperation.details.concept
            : optionalText(input.concept),
        observation:
          input.observation === undefined
            ? previousOperation.details.observation
            : optionalText(input.observation),
      },
      revision: asRevision(Number(previousOperation.revision) + 1),
      updatedAt: occurredAt,
    } satisfies SavingsDepositOperation | SavingsWithdrawalOperation
    if (
      operation.operationDate === previousOperation.operationDate &&
      operation.amount === previousOperation.amount &&
      JSON.stringify(operation.details) === JSON.stringify(previousOperation.details)
    ) {
      throw new MovementUseCaseError("no_changes", "No hay cambios para guardar.")
    }
    this.assertSavingsMovementPeriod(operation, period)
    const nextDelta = asNonZeroClpDelta(
      operation.type === "savings_deposit" ? amount : -amount,
    )
    const movement: Movement = {
      ...previousMovement,
      delta: nextDelta,
      updatedAt: occurredAt,
    }
    assertOperationMovementInvariant(operation, [movement])
    const goalDelta = nextDelta - previousMovement.delta
    const updatedGoal = this.applySavingsGoalNetChange(
      goal,
      goalDelta,
      occurredAt,
    )
    const operationRevision: OperationRevision = {
      id: this.createId(),
      operationId: operation.id,
      periodId: period.id,
      revisionNumber: previousOperation.revision,
      changeType: "edit",
      previousOperation,
      previousMovements: [previousMovement],
      reason: null,
      createdAt: occurredAt,
    }
    await this.commitSavingsGoalMovement({
      kind: "change",
      period,
      expectedGoal: goal,
      expectedOperation: previousOperation,
      goal: updatedGoal,
      operation,
      movement,
      operationRevision,
    })
    return { goal: updatedGoal, operation, movement }
  }

  async voidSavingsMovement(input: VoidSavingsMovementInput) {
    const period = await this.requireOpenPeriod()
    const previousOperation = await this.requireSavingsMovementOperation(
      input.operationId,
    )
    this.assertPostedSavingsMovement(previousOperation)
    this.assertRevision(previousOperation.revision, input.expectedRevision)
    this.assertSavingsMovementPeriod(previousOperation, period)
    const previousMovement = await this.requireSavingsMovementProjection(
      previousOperation,
    )
    const goal = await this.requireSavingsGoal(previousOperation.details.goalId)
    const occurredAt = this.now()
    const goalDelta = -previousMovement.delta
    const updatedGoal = this.applySavingsGoalNetChange(
      goal,
      goalDelta,
      occurredAt,
    )
    const reason = optionalText(input.reason)
    const operation = {
      ...previousOperation,
      status: "voided",
      voidedAt: occurredAt,
      voidReason: reason,
      revision: asRevision(Number(previousOperation.revision) + 1),
      updatedAt: occurredAt,
    } satisfies SavingsDepositOperation | SavingsWithdrawalOperation
    const movement: Movement = {
      ...previousMovement,
      status: "voided",
      updatedAt: occurredAt,
    }
    assertOperationMovementInvariant(operation, [movement])
    const operationRevision: OperationRevision = {
      id: this.createId(),
      operationId: operation.id,
      periodId: period.id,
      revisionNumber: previousOperation.revision,
      changeType: "void",
      previousOperation,
      previousMovements: [previousMovement],
      reason,
      createdAt: occurredAt,
    }
    await this.commitSavingsGoalMovement({
      kind: "change",
      period,
      expectedGoal: goal,
      expectedOperation: previousOperation,
      goal: updatedGoal,
      operation,
      movement,
      operationRevision,
    })
    return { goal: updatedGoal, operation, movement }
  }

  async editTransfer(input: EditTransferInput) {
    this.assertDistinctEndpoints(input)
    const period = await this.requireOpenPeriod()
    const previousOperation = await this.requireTransfer(input.operationId)
    if (previousOperation.status !== "posted") {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "Solo se puede editar un movimiento vigente.",
      )
    }
    this.assertRevision(previousOperation.revision, input.expectedRevision)
    assertOperationDateContext(previousOperation, period, this.today())
    const previousMovements = await this.requireMovements(previousOperation)
    const declarations = [
      {
        type: previousOperation.details.sourceType,
        id: previousOperation.details.sourceId,
        active: false,
      },
      {
        type: previousOperation.details.destinationType,
        id: previousOperation.details.destinationId,
        active: false,
      },
      { type: input.sourceType, id: input.sourceId, active: true },
      { type: input.destinationType, id: input.destinationId, active: true },
    ] as const
    const targets = await this.loadTransferTargets(declarations)
    const amount = positiveAmount(input.amount)
    const occurredAt = this.now()
    const operation: TransferOperation = {
      ...previousOperation,
      operationDate: input.operationDate,
      amount,
      details: {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        destinationType: input.destinationType,
        destinationId: input.destinationId,
        concept:
          input.concept === undefined
            ? previousOperation.details.concept
            : optionalText(input.concept),
        observation:
          input.observation === undefined
            ? previousOperation.details.observation
            : optionalText(input.observation),
      },
      revision: asRevision(Number(previousOperation.revision) + 1),
      updatedAt: occurredAt,
    }
    if (
      operation.operationDate === previousOperation.operationDate &&
      operation.amount === previousOperation.amount &&
      JSON.stringify(operation.details) === JSON.stringify(previousOperation.details)
    ) {
      throw new MovementUseCaseError("no_changes", "No hay cambios para guardar.")
    }
    assertOperationDateContext(operation, period, this.today())
    const movements = this.transferMovements(
      operation,
      occurredAt,
      previousMovements,
    )
    const updates = this.applyTransferImpacts(
      targets,
      previousMovements,
      movements,
      occurredAt,
    )
    const revision: OperationRevision = {
      id: this.createId(),
      operationId: operation.id,
      periodId: period.id,
      revisionNumber: previousOperation.revision,
      changeType: "edit",
      previousOperation,
      previousMovements,
      reason: null,
      createdAt: occurredAt,
    }
    await this.commitTransfer({
      kind: "change",
      period,
      expectedTargets: [...targets.values()],
      expectedOperation: previousOperation,
      updates,
      operation,
      movements,
      operationRevision: revision,
    })
    const source = targets.get(targetKey(input.sourceType, input.sourceId))
    const destination = targets.get(
      targetKey(input.destinationType, input.destinationId),
    )
    if (!source || !destination) {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "No fue posible resolver los fondos del movimiento.",
      )
    }
    return this.toListItem(
      operation,
      movements,
      `${source.entity.name} → ${destination.entity.name}`,
    )
  }

  async editMovement(input: EditMovementInput) {
    const period = await this.requireOpenPeriod()
    const previousOperation = await this.requireOperation(input.operationId)
    if (previousOperation.type === "transfer") {
      throw new MovementUseCaseError(
        "unsupported_operation",
        "Usa el editor de Mover dinero para este movimiento.",
      )
    }
    if (previousOperation.status !== "posted") {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "Solo se puede editar un movimiento vigente.",
      )
    }
    this.assertRevision(previousOperation.revision, input.expectedRevision)
    assertOperationDateContext(previousOperation, period, this.today())
    const previousMovement = await this.requireSingleMovement(previousOperation)
    const previousAccountId = operationAccountId(previousOperation)
    const [previousAccount, nextAccount] = await Promise.all([
      this.requireAccount(previousAccountId, true),
      previousAccountId === input.accountId
        ? this.requireAccount(previousAccountId, true)
        : this.requireAccount(input.accountId),
    ])
    const amount = positiveAmount(input.amount)
    const occurredAt = this.now()
    let nextDetails: SupportedMovementOperation["details"]
    let category: Category | undefined

    if (previousOperation.type === "salary_receipt") {
      nextDetails = { accountId: nextAccount.id }
      const salaries = await this.repositories.operations.listByType(
        period.id,
        "salary_receipt",
      )
      if (
        salaries.some(
          ({ id, status }) => id !== previousOperation.id && status === "posted",
        )
      ) {
        throw new MovementUseCaseError(
          "salary_already_posted",
          "Solo puede existir un sueldo recibido vigente por período.",
        )
      }
    } else if (previousOperation.type === "additional_income") {
      nextDetails = {
        accountId: nextAccount.id,
        concept:
          input.concept === undefined
            ? previousOperation.details.concept
            : optionalText(input.concept),
        observation:
          input.observation === undefined
            ? previousOperation.details.observation
            : optionalText(input.observation),
      }
    } else if (previousOperation.type === "variable_expense") {
      const categoryId = input.categoryId ?? previousOperation.details.categoryId
      category = await this.requireCategory(
        categoryId,
        categoryId === previousOperation.details.categoryId,
      )
      nextDetails = {
        accountId: nextAccount.id,
        categoryId: category.id,
        categoryName:
          category.id === previousOperation.details.categoryId
            ? previousOperation.details.categoryName
            : category.name,
        concept: requiredText(
          input.concept === undefined
            ? previousOperation.details.concept
            : (input.concept ?? ""),
          "El concepto",
        ),
        observation:
          input.observation === undefined
            ? previousOperation.details.observation
            : optionalText(input.observation),
      }
    } else {
      nextDetails = {
        accountId: nextAccount.id,
        fixedExpenseInstanceId:
          previousOperation.details.fixedExpenseInstanceId,
      }
    }

    const nextOperation = {
      ...previousOperation,
      operationDate: input.operationDate,
      amount,
      details: nextDetails,
      revision: asRevision(Number(previousOperation.revision) + 1),
      updatedAt: occurredAt,
    } as AccountMovementOperation
    const nextDelta = asNonZeroClpDelta(
      previousOperation.type === "variable_expense" ||
        previousOperation.type === "fixed_expense_payment"
        ? -amount
        : amount,
    )
    if (
      previousAccount.id === nextAccount.id &&
      nextOperation.operationDate === previousOperation.operationDate &&
      nextOperation.amount === previousOperation.amount &&
      JSON.stringify(nextOperation.details) === JSON.stringify(previousOperation.details)
    ) {
      throw new MovementUseCaseError("no_changes", "No hay cambios para guardar.")
    }

    assertOperationDateContext(nextOperation, period, this.today())
    const accounts = this.replaceAccountImpact(
      previousAccount,
      nextAccount,
      previousMovement.delta,
      nextDelta,
      occurredAt,
    )
    const nextMovement: Movement = {
      ...previousMovement,
      targetId: nextAccount.id,
      delta: nextDelta,
      updatedAt: occurredAt,
    }
    assertOperationMovementInvariant(nextOperation, [nextMovement])
    const revision: OperationRevision = {
      id: this.createId(),
      operationId: previousOperation.id,
      periodId: period.id,
      revisionNumber: previousOperation.revision,
      changeType: "edit",
      previousOperation,
      previousMovements: [previousMovement],
      reason: null,
      createdAt: occurredAt,
    }
    const fixedExpenseInstance =
      previousOperation.type === "fixed_expense_payment"
        ? await this.requirePaidFixedExpenseInstance(
            previousOperation.details.fixedExpenseInstanceId,
            previousOperation.id,
            period.id,
          )
        : undefined
    await this.commit({
      kind: "change",
      period,
      expectedAccounts: this.expectedAccounts(previousAccount, nextAccount),
      expectedOperation: previousOperation,
      expectedCategories: category ? [category] : [],
      accounts,
      operation: nextOperation,
      movement: nextMovement,
      operationRevision: revision,
      expectedFixedExpenseInstance: fixedExpenseInstance,
    })
    return this.toListItem(nextOperation, [nextMovement], nextAccount.name)
  }

  async voidMovement(input: VoidMovementInput) {
    const period = await this.requireOpenPeriod()
    const previousOperation = await this.requireOperation(input.operationId)
    if (previousOperation.type === "transfer") {
      return this.voidTransfer(period, previousOperation, input)
    }
    if (previousOperation.status !== "posted") {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "El movimiento ya está anulado.",
      )
    }
    this.assertRevision(previousOperation.revision, input.expectedRevision)
    assertOperationDateContext(previousOperation, period, this.today())
    const previousMovement = await this.requireSingleMovement(previousOperation)
    const account = await this.requireAccount(
      operationAccountId(previousOperation),
      true,
    )
    const occurredAt = this.now()
    const reason = optionalText(input.reason)
    const updatedAccount = this.applyImpact(
      account,
      previousMovement.delta,
      null,
      occurredAt,
    )
    const operation: AccountMovementOperation = {
      ...previousOperation,
      status: "voided",
      voidedAt: occurredAt,
      voidReason: reason,
      revision: asRevision(Number(previousOperation.revision) + 1),
      updatedAt: occurredAt,
    }
    const movement: Movement = {
      ...previousMovement,
      status: "voided",
      updatedAt: occurredAt,
    }
    assertOperationMovementInvariant(operation, [movement])
    const revision: OperationRevision = {
      id: this.createId(),
      operationId: operation.id,
      periodId: period.id,
      revisionNumber: previousOperation.revision,
      changeType: "void",
      previousOperation,
      previousMovements: [previousMovement],
      reason,
      createdAt: occurredAt,
    }
    const previousFixedExpenseInstance =
      previousOperation.type === "fixed_expense_payment"
        ? await this.requirePaidFixedExpenseInstance(
            previousOperation.details.fixedExpenseInstanceId,
            previousOperation.id,
            period.id,
          )
        : undefined
    const fixedExpenseInstance = previousFixedExpenseInstance
      ? ({
          ...previousFixedExpenseInstance,
          status: "pending",
          activePaymentOperationId: null,
          revision: asRevision(
            Number(previousFixedExpenseInstance.revision) + 1,
          ),
          updatedAt: occurredAt,
        } satisfies FixedExpenseInstance)
      : undefined
    await this.commit({
      kind: "change",
      period,
      expectedAccounts: [account],
      expectedOperation: previousOperation,
      accounts: updatedAccount === account ? [] : [updatedAccount],
      operation,
      movement,
      operationRevision: revision,
      expectedFixedExpenseInstance: previousFixedExpenseInstance,
      fixedExpenseInstance,
    })
    return this.toListItem(operation, [movement], account.name)
  }

  private async voidTransfer(
    period: Period,
    previousOperation: TransferOperation,
    input: VoidMovementInput,
  ) {
    if (previousOperation.status !== "posted") {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "El movimiento ya está anulado.",
      )
    }
    this.assertRevision(previousOperation.revision, input.expectedRevision)
    assertOperationDateContext(previousOperation, period, this.today())
    const previousMovements = await this.requireMovements(previousOperation)
    const targets = await this.loadTransferTargets([
      {
        type: previousOperation.details.sourceType,
        id: previousOperation.details.sourceId,
        active: false,
      },
      {
        type: previousOperation.details.destinationType,
        id: previousOperation.details.destinationId,
        active: false,
      },
    ])
    const occurredAt = this.now()
    const reason = optionalText(input.reason)
    const operation: TransferOperation = {
      ...previousOperation,
      status: "voided",
      voidedAt: occurredAt,
      voidReason: reason,
      revision: asRevision(Number(previousOperation.revision) + 1),
      updatedAt: occurredAt,
    }
    const movements = previousMovements.map((movement) => ({
      ...movement,
      status: "voided" as const,
      updatedAt: occurredAt,
    }))
    assertOperationMovementInvariant(operation, movements)
    const updates = this.applyTransferImpacts(
      targets,
      previousMovements,
      [],
      occurredAt,
    )
    const revision: OperationRevision = {
      id: this.createId(),
      operationId: operation.id,
      periodId: period.id,
      revisionNumber: previousOperation.revision,
      changeType: "void",
      previousOperation,
      previousMovements,
      reason,
      createdAt: occurredAt,
    }
    await this.commitTransfer({
      kind: "change",
      period,
      expectedTargets: [...targets.values()],
      expectedOperation: previousOperation,
      updates,
      operation,
      movements,
      operationRevision: revision,
    })
    const source = targets.get(
      targetKey(previousOperation.details.sourceType, previousOperation.details.sourceId),
    )
    const destination = targets.get(
      targetKey(
        previousOperation.details.destinationType,
        previousOperation.details.destinationId,
      ),
    )
    if (!source || !destination) {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "No fue posible resolver los fondos del movimiento.",
      )
    }
    return this.toListItem(
      operation,
      movements,
      `${source.entity.name} → ${destination.entity.name}`,
    )
  }

  private transferMovements(
    operation: TransferOperation,
    occurredAt: UtcTimestamp,
    previous: readonly Movement[] = [],
    previewIds?: readonly [EntityId, EntityId],
  ) {
    const sourceId = previous[0]?.id ?? previewIds?.[0] ?? this.createId()
    const destinationId = previous[1]?.id ?? previewIds?.[1] ?? this.createId()
    const common = {
      operationId: operation.id,
      periodId: operation.periodId,
      effectType: "asset_balance" as const,
      status: operation.status,
      updatedAt: occurredAt,
    }
    const movements: readonly [Movement, Movement] = [
      {
        ...common,
        id: sourceId,
        targetType: operation.details.sourceType,
        targetId: operation.details.sourceId,
        delta: asNonZeroClpDelta(-operation.amount),
        createdAt: previous[0]?.createdAt ?? occurredAt,
      },
      {
        ...common,
        id: destinationId,
        targetType: operation.details.destinationType,
        targetId: operation.details.destinationId,
        delta: asNonZeroClpDelta(operation.amount),
        createdAt: previous[1]?.createdAt ?? occurredAt,
      },
    ]
    assertOperationMovementInvariant(operation, movements)
    return movements
  }

  private async registerSavingsGoalMovement(
    input: SavingsMovementDraft,
    type: "savings_deposit" | "savings_withdrawal",
  ): Promise<SavingsMovementResult> {
    const period = await this.requireOpenPeriod()
    const goal = await this.requireSavingsGoal(input.goalId)
    const amount = positiveAmount(input.amount)
    if (type === "savings_withdrawal" && amount > goal.currentBalance) {
      throw new MovementUseCaseError(
        "insufficient_balance",
        "El retiro no puede superar el saldo disponible de la meta.",
      )
    }
    const occurredAt = this.now()
    const common = {
      id: this.createId(),
      periodId: period.id,
      operationDate: input.operationDate,
      amount,
      details: {
        goalId: goal.id,
        concept: optionalText(input.concept),
        observation: optionalText(input.observation),
      },
      status: "posted" as const,
      voidedAt: null,
      voidReason: null,
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    const operation: SavingsDepositOperation | SavingsWithdrawalOperation =
      type === "savings_deposit"
        ? { ...common, type: "savings_deposit" }
        : { ...common, type: "savings_withdrawal" }
    try {
      assertOperationDateContext(operation, period, this.today())
    } catch {
      throw new MovementUseCaseError(
        "invalid_date",
        "La fecha debe pertenecer al período abierto y no puede ser futura.",
      )
    }
    const movement: Movement = {
      id: this.createId(),
      operationId: operation.id,
      periodId: period.id,
      targetType: "savings_goal",
      targetId: goal.id,
      effectType: "asset_balance",
      delta: asNonZeroClpDelta(
        type === "savings_deposit" ? amount : -amount,
      ),
      status: "posted",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    assertOperationMovementInvariant(operation, [movement])
    const updatedGoal = applySavingsGoalMovementChange({
      goal,
      previousDelta: null,
      nextDelta: movement.delta,
      occurredAt,
    })
    try {
      await this.repositories.operations.commitSavingsGoalMovement({
        kind: "create",
        period: { id: period.id, revision: period.revision },
        expectedSavingsGoal: { id: goal.id, revision: goal.revision },
        savingsGoal: updatedGoal,
        operation,
        movement,
      })
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "conflict") {
        throw new MovementUseCaseError(
          "revision_conflict",
          "La meta cambió antes de guardar. Vuelve a intentarlo.",
        )
      }
      throw error
    }
    return { goal: updatedGoal, operation, movement }
  }

  private async requireSavingsMovementOperation(operationId: EntityId) {
    const operation = await this.repositories.operations.get(operationId)
    if (
      !operation ||
      (operation.type !== "savings_deposit" &&
        operation.type !== "savings_withdrawal")
    ) {
      throw new MovementUseCaseError(
        operation ? "unsupported_operation" : "operation_not_found",
        operation
          ? "La operación no es un depósito ni retiro de meta."
          : "El movimiento solicitado no existe.",
      )
    }
    return operation
  }

  private assertPostedSavingsMovement(
    operation: SavingsDepositOperation | SavingsWithdrawalOperation,
  ) {
    if (operation.status !== "posted") {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "El movimiento de ahorro ya está anulado.",
      )
    }
  }

  private assertSavingsMovementPeriod(
    operation: SavingsDepositOperation | SavingsWithdrawalOperation,
    period: Period,
  ) {
    try {
      assertOperationDateContext(operation, period, this.today())
    } catch {
      throw new MovementUseCaseError(
        "invalid_date",
        "El movimiento debe pertenecer al período abierto y no puede ser futuro.",
      )
    }
  }

  private async requireSavingsMovementProjection(
    operation: SavingsDepositOperation | SavingsWithdrawalOperation,
  ) {
    const movements = await this.repositories.movements.listByOperation(
      operation.id,
    )
    try {
      assertOperationMovementInvariant(operation, movements)
    } catch {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "El movimiento no tiene una proyección financiera íntegra.",
      )
    }
    const movement = movements[0]
    if (!movement) {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "El movimiento no tiene impacto financiero.",
      )
    }
    return movement
  }

  private applySavingsGoalNetChange(
    goal: SavingsGoal,
    delta: number,
    occurredAt: UtcTimestamp,
  ) {
    const finalBalance = goal.currentBalance + delta
    if (finalBalance < 0) {
      const missing = -finalBalance
      throw new MovementUseCaseError(
        "insufficient_balance",
        `Faltan ${new Intl.NumberFormat("es-CL", {
          style: "currency",
          currency: "CLP",
          maximumFractionDigits: 0,
        }).format(missing)} para completar este cambio.`,
      )
    }
    if (delta === 0) return goal
    return applySavingsGoalMovementChange({
      goal,
      previousDelta: null,
      nextDelta: asNonZeroClpDelta(delta),
      occurredAt,
    })
  }

  private async commitSavingsGoalMovement(input: {
    readonly kind: "create" | "change"
    readonly period: Period
    readonly expectedGoal: SavingsGoal
    readonly expectedOperation?: SavingsDepositOperation | SavingsWithdrawalOperation
    readonly goal: SavingsGoal
    readonly operation: SavingsDepositOperation | SavingsWithdrawalOperation
    readonly movement: Movement
    readonly operationRevision?: OperationRevision
  }) {
    try {
      await this.repositories.operations.commitSavingsGoalMovement({
        kind: input.kind,
        period: { id: input.period.id, revision: input.period.revision },
        expectedSavingsGoal: {
          id: input.expectedGoal.id,
          revision: input.expectedGoal.revision,
        },
        expectedOperation: input.expectedOperation
          ? {
              id: input.expectedOperation.id,
              revision: input.expectedOperation.revision,
            }
          : undefined,
        savingsGoal: input.goal,
        operation: input.operation,
        movement: input.movement,
        operationRevision: input.operationRevision,
      })
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "conflict") {
        throw new MovementUseCaseError(
          "revision_conflict",
          "La meta o el movimiento cambiaron antes de guardar.",
        )
      }
      throw error
    }
  }

  private async loadTransferTargets(
    declarations: readonly {
      readonly type: TransferEndpointType
      readonly id: EntityId
      readonly active: boolean
    }[],
  ) {
    const merged = new Map<
      string,
      { type: TransferEndpointType; id: EntityId; active: boolean }
    >()
    for (const declaration of declarations) {
      const key = targetKey(declaration.type, declaration.id)
      const previous = merged.get(key)
      merged.set(key, {
        ...declaration,
        active: declaration.active || previous?.active === true,
      })
    }
    const targets = new Map<string, TransferTargetRecord>()
    for (const declaration of merged.values()) {
      const entity = await this.requireTarget(
        declaration.type,
        declaration.id,
        !declaration.active,
      )
      const record =
        declaration.type === "account"
          ? ({ type: "account", entity: entity as Account } as const)
          : ({ type: "savings_goal", entity: entity as SavingsGoal } as const)
      targets.set(targetKey(declaration.type, declaration.id), record)
    }
    return targets
  }

  private applyTransferImpacts(
    targets: ReadonlyMap<string, TransferTargetRecord>,
    previousMovements: readonly Movement[],
    nextMovements: readonly Movement[],
    occurredAt: UtcTimestamp,
  ) {
    const accounts: Account[] = []
    const savingsGoals: SavingsGoal[] = []
    try {
      for (const [key, target] of targets) {
        const previousDelta =
          previousMovements.find(
            (movement) =>
              targetKey(
                movement.targetType as TransferEndpointType,
                movement.targetId,
              ) === key,
          )?.delta ?? null
        const nextDelta =
          nextMovements.find(
            (movement) =>
              targetKey(
                movement.targetType as TransferEndpointType,
                movement.targetId,
              ) === key,
          )?.delta ?? null
        if (target.type === "account") {
          const updated = applyAccountMovementChange({
            account: target.entity,
            previousDelta,
            nextDelta,
            occurredAt,
          })
          if (updated !== target.entity) accounts.push(updated)
        } else {
          const updated = applySavingsGoalMovementChange({
            goal: target.entity,
            previousDelta,
            nextDelta,
            occurredAt,
          })
          if (updated !== target.entity) savingsGoals.push(updated)
        }
      }
    } catch {
      throw new MovementUseCaseError(
        "insufficient_balance",
        "El origen o la reversión dejarían un fondo con saldo insuficiente.",
      )
    }
    return { accounts, savingsGoals }
  }

  private async commitTransfer(input: {
    readonly kind: "create" | "change"
    readonly period: Period
    readonly expectedTargets: readonly TransferTargetRecord[]
    readonly expectedOperation?: TransferOperation
    readonly updates: {
      readonly accounts: readonly Account[]
      readonly savingsGoals: readonly SavingsGoal[]
    }
    readonly operation: TransferOperation
    readonly movements: readonly Movement[]
    readonly operationRevision?: OperationRevision
  }) {
    const expectedAccounts = input.expectedTargets
      .filter((target): target is Extract<TransferTargetRecord, { type: "account" }> =>
        target.type === "account",
      )
      .map(({ entity: { id, revision } }) => ({ id, revision }))
    const expectedSavingsGoals = input.expectedTargets
      .filter(
        (target): target is Extract<
          TransferTargetRecord,
          { type: "savings_goal" }
        > => target.type === "savings_goal",
      )
      .map(({ entity: { id, revision } }) => ({ id, revision }))
    const mutation: InternalTransferMutation = {
      kind: input.kind,
      period: { id: input.period.id, revision: input.period.revision },
      expectedAccounts,
      expectedSavingsGoals,
      expectedOperation: input.expectedOperation
        ? {
            id: input.expectedOperation.id,
            revision: input.expectedOperation.revision,
          }
        : undefined,
      accounts: input.updates.accounts,
      savingsGoals: input.updates.savingsGoals,
      operation: input.operation,
      movements: input.movements,
      operationRevision: input.operationRevision,
    }
    try {
      await this.repositories.operations.commitTransfer(mutation)
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "conflict") {
        throw new MovementUseCaseError(
          "revision_conflict",
          "Los fondos cambiaron antes de guardar. Vuelve a intentarlo.",
        )
      }
      throw error
    }
  }

  private async createOperation(
    period: Period,
    account: Account,
    operation: AccountMovementOperation,
    delta: number,
    category?: Category,
    expectedFixedExpenseInstance?: FixedExpenseInstance,
    fixedExpenseInstance?: FixedExpenseInstance,
  ) {
    assertOperationDateContext(operation, period, this.today())
    const movement: Movement = {
      id: this.createId(),
      operationId: operation.id,
      periodId: period.id,
      targetType: "account",
      targetId: account.id,
      effectType: "asset_balance",
      delta: asNonZeroClpDelta(delta),
      status: "posted",
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    }
    assertOperationMovementInvariant(operation, [movement])
    const updatedAccount = this.applyImpact(
      account,
      null,
      movement.delta,
      operation.createdAt,
    )
    await this.commit({
      kind: "create",
      period,
      expectedAccounts: [account],
      expectedCategories: category ? [category] : [],
      expectedFixedExpenseInstance,
      accounts: updatedAccount === account ? [] : [updatedAccount],
      operation,
      movement,
      fixedExpenseInstance,
    })
    return this.toListItem(operation, [movement], account.name)
  }

  private replaceAccountImpact(
    previousAccount: Account,
    nextAccount: Account,
    previousDelta: Movement["delta"],
    nextDelta: Movement["delta"],
    occurredAt: UtcTimestamp,
  ) {
    if (previousAccount.id === nextAccount.id) {
      const account = this.applyImpact(
        previousAccount,
        previousDelta,
        nextDelta,
        occurredAt,
      )
      return account === previousAccount ? [] : [account]
    }
    return [
      this.applyImpact(previousAccount, previousDelta, null, occurredAt),
      this.applyImpact(nextAccount, null, nextDelta, occurredAt),
    ]
  }

  private applyImpact(
    account: Account,
    previousDelta: Movement["delta"] | null,
    nextDelta: Movement["delta"] | null,
    occurredAt: UtcTimestamp,
  ) {
    try {
      return applyAccountMovementChange({
        account,
        previousDelta,
        nextDelta,
        occurredAt,
      })
    } catch {
      throw new MovementUseCaseError(
        "insufficient_balance",
        "La operación dejaría la cuenta con saldo insuficiente.",
      )
    }
  }

  private expectedAccounts(previous: Account, next: Account) {
    return previous.id === next.id ? [previous] : [previous, next]
  }

  private async commit(input: {
    readonly kind: "create" | "change"
    readonly period: Period
    readonly expectedAccounts: readonly Account[]
    readonly expectedOperation?: AccountMovementOperation
    readonly expectedCategories?: readonly Category[]
    readonly expectedFixedExpenseInstance?: FixedExpenseInstance
    readonly accounts: readonly Account[]
    readonly operation: AccountMovementOperation
    readonly movement: Movement
    readonly operationRevision?: OperationRevision
    readonly fixedExpenseInstance?: FixedExpenseInstance
  }) {
    const mutation: FinancialOperationMutation = {
      ...input,
      period: { id: input.period.id, revision: input.period.revision },
      expectedAccounts: input.expectedAccounts.map(({ id, revision }) => ({
        id,
        revision,
      })),
      expectedOperation: input.expectedOperation
        ? {
            id: input.expectedOperation.id,
            revision: input.expectedOperation.revision,
          }
        : undefined,
      expectedCategories: input.expectedCategories?.map(({ id, revision }) => ({
        id,
        revision,
      })),
      expectedFixedExpenseInstance: input.expectedFixedExpenseInstance
        ? {
            id: input.expectedFixedExpenseInstance.id,
            revision: input.expectedFixedExpenseInstance.revision,
          }
        : undefined,
    }
    try {
      await this.repositories.operations.commit(mutation)
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "conflict") {
        throw new MovementUseCaseError(
          "revision_conflict",
          "Los datos cambiaron antes de guardar. Vuelve a intentarlo.",
        )
      }
      throw error
    }
  }

  private async requireOpenPeriod() {
    const periods = await this.repositories.periods.listByStatus("open")
    if (periods.length !== 1) {
      throw new MovementUseCaseError(
        "no_open_period",
        "Se necesita un período mensual abierto para registrar movimientos.",
      )
    }
    return periods[0]
  }

  private async requireAccount(accountId: EntityId, allowInactive = false) {
    const account = await this.repositories.accounts.get(accountId)
    if (!account) {
      throw new MovementUseCaseError(
        "account_not_found",
        "La cuenta solicitada no existe.",
      )
    }
    if (!allowInactive && account.status !== "active") {
      throw new MovementUseCaseError(
        "inactive_account",
        "La cuenta debe estar activa.",
      )
    }
    return account
  }

  private async requireCategory(categoryId: EntityId, allowInactive = false) {
    const category = await this.repositories.categories.get(categoryId)
    if (!category) {
      throw new MovementUseCaseError(
        "category_not_found",
        "La categoría solicitada no existe.",
      )
    }
    if (!allowInactive && category.status !== "active") {
      throw new MovementUseCaseError(
        "inactive_category",
        "La categoría debe estar activa.",
      )
    }
    return category
  }

  private async requireSavingsGoal(goalId: EntityId, allowInactive = false) {
    const goal = await this.repositories.savingsGoals.get(goalId)
    if (!goal) {
      throw new MovementUseCaseError(
        "savings_goal_not_found",
        "La meta de ahorro solicitada no existe.",
      )
    }
    if (!allowInactive && goal.lifecycleStatus !== "active") {
      throw new MovementUseCaseError(
        "inactive_savings_goal",
        "La meta de ahorro debe estar activa.",
      )
    }
    return goal
  }

  private requireTarget(
    type: TransferEndpointType,
    id: EntityId,
    allowInactive = false,
  ) {
    return type === "account"
      ? this.requireAccount(id, allowInactive)
      : this.requireSavingsGoal(id, allowInactive)
  }

  private assertDistinctEndpoints(input: {
    readonly sourceType: TransferEndpointType
    readonly sourceId: EntityId
    readonly destinationType: TransferEndpointType
    readonly destinationId: EntityId
  }) {
    if (
      input.sourceType === input.destinationType &&
      input.sourceId === input.destinationId
    ) {
      throw new MovementUseCaseError(
        "same_transfer_endpoint",
        "El origen y el destino deben ser fondos distintos.",
      )
    }
  }

  private async requirePaidFixedExpenseInstance(
    instanceId: EntityId,
    operationId: EntityId,
    periodId: EntityId,
  ) {
    const instance = await this.repositories.fixedExpenseInstances.get(instanceId)
    if (
      !instance ||
      instance.periodId !== periodId ||
      instance.status !== "paid" ||
      instance.activePaymentOperationId !== operationId
    ) {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "El gasto fijo no está vinculado al pago vigente.",
      )
    }
    return instance
  }

  private async requireOperation(operationId: EntityId) {
    const operation = await this.requireListedOperation(operationId)
    if (!isEditable(operation)) {
      throw new MovementUseCaseError(
        "unsupported_operation",
        "Este movimiento es solo de consulta en esta sección.",
      )
    }
    return operation
  }

  private async requireListedOperation(operationId: EntityId) {
    const operation = await this.repositories.operations.get(operationId)
    if (!operation) {
      throw new MovementUseCaseError(
        "operation_not_found",
        "El movimiento solicitado no existe.",
      )
    }
    if (!isSupported(operation)) {
      throw new MovementUseCaseError(
        "unsupported_operation",
        "Este tipo de movimiento no está disponible en esta sección.",
      )
    }
    return operation
  }

  private async requireTransfer(operationId: EntityId) {
    const operation = await this.requireOperation(operationId)
    if (operation.type !== "transfer") {
      throw new MovementUseCaseError(
        "unsupported_operation",
        "El movimiento solicitado no es un movimiento interno.",
      )
    }
    return operation
  }

  private async requireMovements(operation: SupportedMovementOperation) {
    const movements = await this.repositories.movements.listByOperation(operation.id)
    try {
      assertOperationMovementInvariant(operation, movements)
    } catch {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "El movimiento no tiene una proyección financiera íntegra.",
      )
    }
    if (operation.type !== "transfer") return movements
    const source = movements.find(
      (movement) =>
        movement.targetType === operation.details.sourceType &&
        movement.targetId === operation.details.sourceId,
    )
    const destination = movements.find(
      (movement) =>
        movement.targetType === operation.details.destinationType &&
        movement.targetId === operation.details.destinationId,
    )
    if (!source || !destination) {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "El movimiento interno no tiene ambos impactos financieros.",
      )
    }
    return [source, destination]
  }

  private async requireSingleMovement(operation: AccountMovementOperation) {
    const movements = await this.requireMovements(operation)
    const movement = movements[0]
    if (!movement) {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "El movimiento no tiene impacto financiero.",
      )
    }
    return movement
  }

  private assertRevision(actual: Revision, expected: Revision) {
    if (actual !== expected) {
      throw new MovementUseCaseError(
        "revision_conflict",
        "El movimiento cambió desde que fue abierto.",
      )
    }
  }

  private toListItem(
    operation: SupportedMovementOperation,
    movements: readonly Movement[],
    accountName: string,
    title?: string,
  ): MovementListItem {
    const movement = movements[0]
    if (!movement) {
      throw new MovementUseCaseError(
        "invalid_operation_state",
        "El movimiento no tiene impacto financiero.",
      )
    }
    return {
      operation,
      movement,
      movements,
      kind:
        operation.type === "transfer"
          ? "transfer"
          : operation.type === "balance_adjustment"
            ? "adjustment"
          : operation.type === "savings_deposit" ||
              operation.type === "savings_withdrawal"
            ? "savings"
          : operation.type === "variable_expense" ||
              operation.type === "fixed_expense_payment"
            ? "expense"
            : "income",
      title: title ?? operationTitle(operation),
      description: operationDescription(operation),
      accountName,
      signedAmount: operation.type === "transfer" ? 0 : movement.delta,
    }
  }
}

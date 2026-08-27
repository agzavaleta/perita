import type { AuditEvent } from "@/domain/audit"
import type { Account, Debt } from "@/domain/entities"
import {
  applyAccountMovementChange,
  assertOperationDateContext,
} from "@/domain/financial"
import {
  assertAuditEventInvariant,
  assertDebtInvariant,
  assertNewDebtOpening,
  assertOperationMovementInvariant,
  deriveDebtProgress,
  deriveDebtSchedule,
  type DebtSchedule,
} from "@/domain/invariants"
import type {
  DebtPaymentOperation,
  DebtTotalAdjustmentOperation,
  Movement,
  OperationRevision,
} from "@/domain/operations"
import type { Period, PeriodOpening } from "@/domain/periods"
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
import type { DebtOperationMutation, PeritaRepositories } from "@/data/repositories"

export interface DebtDraft {
  readonly name: string
  readonly totalAmount: number
  readonly currentOutstandingAmount?: number | null
  readonly dueDate?: CivilDate | null
  readonly monthlyPaymentAmount: number
  readonly paymentDay?: number | null
}

export interface EditDebtInput {
  readonly debtId: EntityId
  readonly expectedRevision: Revision
  readonly name: string
  readonly dueDate?: CivilDate | null
  readonly monthlyPaymentAmount: number
  readonly paymentDay?: number | null
}

export interface DebtPaymentDraft {
  readonly debtId: EntityId
  readonly accountId: EntityId
  readonly operationDate: CivilDate
  readonly amount: number
  readonly concept?: string | null
  readonly observation?: string | null
}

export interface EditDebtPaymentInput extends DebtPaymentDraft {
  readonly operationId: EntityId
  readonly expectedRevision: Revision
}

export interface DebtPaymentItem {
  readonly operation: DebtPaymentOperation
  readonly accountName: string
  readonly revisions: readonly OperationRevision[]
}

export interface DebtListItem {
  readonly debt: Debt
  readonly schedule: DebtSchedule
  readonly paidAmount: number
  readonly progressPercent: number
}

export interface DebtDetail extends DebtListItem {
  readonly payments: readonly DebtPaymentItem[]
  readonly adjustments: readonly DebtTotalAdjustmentOperation[]
  readonly auditEvents: readonly AuditEvent[]
  readonly canDelete: boolean
}

export interface DebtFormOptions {
  readonly accounts: readonly Account[]
  readonly currentDate: CivilDate
}

export interface DebtUseCasesPort {
  listDebts(): Promise<DebtListItem[]>
  getDebtDetail(debtId: EntityId): Promise<DebtDetail>
  getPaymentFormOptions(): Promise<DebtFormOptions>
  createDebt(input: DebtDraft): Promise<Debt>
  editDebt(input: EditDebtInput): Promise<Debt>
  adjustDebtTotal(
    debtId: EntityId,
    expectedRevision: Revision,
    operationDate: CivilDate,
    newTotalAmount: number,
  ): Promise<Debt>
  registerPayment(input: DebtPaymentDraft): Promise<DebtPaymentItem>
  editPayment(input: EditDebtPaymentInput): Promise<DebtPaymentItem>
  voidPayment(
    operationId: EntityId,
    expectedRevision: Revision,
    reason?: string | null,
  ): Promise<DebtPaymentItem>
  deleteDebt(debtId: EntityId, expectedRevision: Revision): Promise<void>
}

export type DebtErrorCode =
  | "no_open_period"
  | "debt_not_found"
  | "account_not_found"
  | "invalid_state"
  | "invalid_amount"
  | "invalid_day"
  | "invalid_text"
  | "invalid_date"
  | "insufficient_balance"
  | "operation_not_found"
  | "revision_conflict"
  | "no_changes"
  | "cannot_delete"

export class DebtUseCaseError extends Error {
  readonly code: DebtErrorCode

  constructor(
    code: DebtErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "DebtUseCaseError"
    this.code = code
  }
}

interface Options {
  readonly now?: () => UtcTimestamp
  readonly today?: () => CivilDate
  readonly createId?: () => EntityId
}

function defaultNow() {
  return asUtcTimestamp(new Date().toISOString())
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

function requiredName(value: string) {
  const name = value.trim()
  if (!name) throw new DebtUseCaseError("invalid_text", "El nombre es obligatorio.")
  return name
}

function optionalText(value: string | null | undefined) {
  return value?.trim() || null
}

function positiveAmount(value: number) {
  try {
    return asPositiveClpAmount(value)
  } catch {
    throw new DebtUseCaseError(
      "invalid_amount",
      "El monto debe ser un entero CLP mayor que cero.",
    )
  }
}

function openingOutstandingAmount(
  value: number | null | undefined,
  totalAmount: number,
) {
  if (value === null || value === undefined) return asClpAmount(totalAmount)
  const outstanding = positiveAmount(value)
  if (outstanding > totalAmount) {
    throw new DebtUseCaseError(
      "invalid_amount",
      "El saldo pendiente no puede superar el total de la deuda.",
    )
  }
  return asClpAmount(outstanding)
}

function optionalPaymentDay(value: number | null | undefined) {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 1 || value > 31) {
    throw new DebtUseCaseError("invalid_day", "El día de pago debe estar entre 1 y 31.")
  }
  return value
}

function optionalDueDate(value: CivilDate | null | undefined) {
  if (value === null || value === undefined) return null
  try {
    return asCivilDate(value)
  } catch {
    throw new DebtUseCaseError("invalid_date", "La fecha de vencimiento no es válida.")
  }
}

export class DebtUseCases implements DebtUseCasesPort {
  private readonly repositories: PeritaRepositories
  private readonly now: () => UtcTimestamp
  private readonly today: () => CivilDate
  private readonly createId: () => EntityId

  constructor(
    repositories: PeritaRepositories,
    options: Options = {},
  ) {
    this.repositories = repositories
    this.now = options.now ?? defaultNow
    this.today = options.today ?? defaultToday
    this.createId = options.createId ?? (() => asEntityId(globalThis.crypto.randomUUID()))
  }

  async listDebts() {
    const currentDate = this.today()
    return (await this.repositories.debts.getAll())
      .map(assertDebtInvariant)
      .map((debt) => ({
        debt,
        schedule: deriveDebtSchedule(debt, currentDate),
        ...deriveDebtProgress(debt),
      }))
      .toSorted((left, right) => {
        if (left.debt.paymentStatus !== right.debt.paymentStatus) {
          return left.debt.paymentStatus === "paid" ? 1 : -1
        }
        return left.debt.name.localeCompare(right.debt.name, "es")
      })
  }

  async getDebtDetail(debtId: EntityId) {
    const [debt, period, debtMovements, accounts, auditEvents] = await Promise.all([
      this.requireDebt(debtId),
      this.requireOpenPeriod(),
      this.repositories.movements.listByTarget("debt", debtId),
      this.repositories.accounts.getAll(),
      this.repositories.auditEvents.listBySubject("debt", debtId),
    ])
    const operations = (
      await Promise.all(
        [...new Set(debtMovements.map(({ operationId }) => operationId))].map(
          (operationId) => this.repositories.operations.get(operationId),
        ),
      )
    ).filter((operation): operation is NonNullable<typeof operation> => Boolean(operation))
    const accountNames = new Map(accounts.map((account) => [account.id, account.name]))
    const paymentOperations = operations.filter(
      (operation): operation is DebtPaymentOperation =>
        operation.type === "debt_payment" && operation.details.debtId === debtId,
    )
    const payments = await Promise.all(
      paymentOperations.map(async (operation) => ({
        operation,
        accountName: accountNames.get(operation.details.accountId) ?? "Cuenta eliminada",
        revisions: await this.repositories.operationRevisions.listByOperation(operation.id),
      })),
    )
    const adjustments = operations.filter(
      (operation): operation is DebtTotalAdjustmentOperation =>
        operation.type === "debt_total_adjustment" && operation.details.debtId === debtId,
    )
    const { canDelete } =
      await this.repositories.planning.getDebtDeletionEligibility({
        period: this.expected(period),
        entity: this.expected(debt),
      })
    return {
      debt,
      schedule: deriveDebtSchedule(debt, this.today()),
      ...deriveDebtProgress(debt),
      payments: payments.toSorted((a, b) =>
        b.operation.operationDate.localeCompare(a.operation.operationDate),
      ),
      adjustments: adjustments.toSorted((a, b) =>
        b.operationDate.localeCompare(a.operationDate),
      ),
      auditEvents: auditEvents.toSorted((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
      canDelete,
    }
  }

  async getPaymentFormOptions() {
    const accounts = (await this.repositories.accounts.getAll())
      .filter(({ status }) => status === "active")
      .toSorted((a, b) => a.name.localeCompare(b.name, "es"))
    return { accounts, currentDate: this.today() }
  }

  async createDebt(input: DebtDraft) {
    const period = await this.requireOpenPeriod()
    const occurredAt = this.now()
    const totalAmount = positiveAmount(input.totalAmount)
    const openingOutstanding = openingOutstandingAmount(
      input.currentOutstandingAmount,
      totalAmount,
    )
    const dueDate = optionalDueDate(input.dueDate)
    const debt = assertDebtInvariant({
      id: this.createId(),
      name: requiredName(input.name),
      totalAmount,
      openingOutstanding,
      outstandingAmount: openingOutstanding,
      dueDate,
      monthlyPaymentAmount: positiveAmount(input.monthlyPaymentAmount),
      paymentDay: optionalPaymentDay(input.paymentDay),
      lifecycleStatus: "active",
      paymentStatus: this.status(openingOutstanding, dueDate),
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    })
    const opening: PeriodOpening = {
      id: this.createId(),
      periodId: period.id,
      targetType: "debt",
      targetId: debt.id,
      openingAmount: openingOutstanding,
    }
    assertNewDebtOpening(debt, opening, period.id)
    const auditEvent = this.audit("created", null, debt, period.id, "debt.create", occurredAt)
    await this.persist(() =>
      this.repositories.planning.createDebt({
        period: this.expected(period),
        debt,
        opening,
        auditEvent,
      }),
    )
    return debt
  }

  async editDebt(input: EditDebtInput) {
    const [period, previous] = await Promise.all([
      this.requireOpenPeriod(),
      this.requireDebt(input.debtId),
    ])
    this.assertRevision(previous.revision, input.expectedRevision)
    if (previous.lifecycleStatus !== "active" || previous.paymentStatus === "paid") {
      throw new DebtUseCaseError("invalid_state", "Solo se puede editar una deuda activa pendiente.")
    }
    const occurredAt = this.now()
    const dueDate = input.dueDate === undefined
      ? previous.dueDate
      : optionalDueDate(input.dueDate)
    const nextPaymentDay = input.paymentDay === undefined
      ? previous.paymentDay
      : optionalPaymentDay(input.paymentDay)
    const debt = assertDebtInvariant({
      ...previous,
      name: requiredName(input.name),
      dueDate,
      monthlyPaymentAmount: positiveAmount(input.monthlyPaymentAmount),
      paymentDay: nextPaymentDay,
      paymentStatus: this.status(previous.outstandingAmount, dueDate),
      revision: asRevision(Number(previous.revision) + 1),
      updatedAt: occurredAt,
    })
    if (
      debt.name === previous.name &&
      debt.dueDate === previous.dueDate &&
      debt.monthlyPaymentAmount === previous.monthlyPaymentAmount &&
      debt.paymentDay === previous.paymentDay
    ) {
      throw new DebtUseCaseError("no_changes", "No hay cambios para guardar.")
    }
    const auditEvent = this.audit(
      "updated",
      previous,
      debt,
      period.id,
      "debt.update-name-and-due-date",
      occurredAt,
    )
    await this.persist(() =>
      this.repositories.planning.changeDebt({
        period: this.expected(period),
        expectedDebt: this.expected(previous),
        debt,
        auditEvent,
      }),
    )
    return debt
  }

  async registerPayment(input: DebtPaymentDraft) {
    const [period, debt, account] = await Promise.all([
      this.requireOpenPeriod(),
      this.requireDebt(input.debtId),
      this.requireAccount(input.accountId, true),
    ])
    const amount = positiveAmount(input.amount)
    if (debt.lifecycleStatus !== "active" || debt.paymentStatus === "paid") {
      throw new DebtUseCaseError("invalid_state", "La deuda no admite nuevos pagos.")
    }
    if (amount > debt.outstandingAmount) {
      throw new DebtUseCaseError("invalid_amount", "El pago supera el saldo pendiente.")
    }
    if (amount > account.currentBalance) {
      throw new DebtUseCaseError("insufficient_balance", "La cuenta no tiene saldo suficiente.")
    }
    const occurredAt = this.now()
    const operation = this.paymentOperation(input, period, amount, occurredAt)
    assertOperationDateContext(operation, period, this.today())
    const movements = this.paymentMovements(operation, occurredAt)
    const nextAccount = applyAccountMovementChange({
      account,
      previousDelta: null,
      nextDelta: movements[0].delta,
      occurredAt,
    })
    const nextDebt = this.applyDebtImpact(debt, null, movements[1].delta, occurredAt)
    await this.commitDebt({
      kind: "create",
      period,
      expectedAccounts: [account],
      expectedDebt: debt,
      accounts: [nextAccount],
      debt: nextDebt,
      operation,
      movements,
    })
    return { operation, accountName: account.name, revisions: [] }
  }

  async editPayment(input: EditDebtPaymentInput) {
    const period = await this.requireOpenPeriod()
    const previousOperation = await this.requirePayment(input.operationId)
    this.assertRevision(previousOperation.revision, input.expectedRevision)
    if (previousOperation.status !== "posted") {
      throw new DebtUseCaseError("invalid_state", "Solo se puede editar un pago vigente.")
    }
    assertOperationDateContext(previousOperation, period, this.today())
    if (previousOperation.details.debtId !== input.debtId) {
      throw new DebtUseCaseError("invalid_state", "El pago no pertenece a esta deuda.")
    }
    const previousMovements = await this.requirePaymentMovements(previousOperation)
    const previousAccountId = previousOperation.details.accountId
    const [debt, previousAccount, nextAccount] = await Promise.all([
      this.requireDebt(input.debtId),
      this.requireAccount(previousAccountId, false),
      this.requireAccount(input.accountId, true),
    ])
    const amount = positiveAmount(input.amount)
    const occurredAt = this.now()
    const operation = this.paymentOperation(input, period, amount, occurredAt, previousOperation)
    if (
      operation.operationDate === previousOperation.operationDate &&
      operation.amount === previousOperation.amount &&
      JSON.stringify(operation.details) === JSON.stringify(previousOperation.details)
    ) {
      throw new DebtUseCaseError("no_changes", "No hay cambios para guardar.")
    }
    assertOperationDateContext(operation, period, this.today())
    const movements = this.paymentMovements(operation, occurredAt, previousMovements)
    const accounts = this.replaceAccountImpact(
      previousAccount,
      nextAccount,
      previousMovements[0].delta,
      movements[0].delta,
      occurredAt,
    )
    const nextDebt = this.applyDebtImpact(
      debt,
      previousMovements[1].delta,
      movements[1].delta,
      occurredAt,
    )
    const revision = this.operationRevision(previousOperation, previousMovements, "edit", occurredAt)
    await this.commitDebt({
      kind: "change",
      period,
      expectedAccounts: this.uniqueAccounts(previousAccount, nextAccount),
      expectedDebt: debt,
      expectedOperation: previousOperation,
      accounts,
      debt: nextDebt,
      operation,
      movements,
      operationRevision: revision,
    })
    return { operation, accountName: nextAccount.name, revisions: [revision] }
  }

  async voidPayment(operationId: EntityId, expectedRevision: Revision, reason?: string | null) {
    const period = await this.requireOpenPeriod()
    const previousOperation = await this.requirePayment(operationId)
    this.assertRevision(previousOperation.revision, expectedRevision)
    if (previousOperation.status !== "posted") {
      throw new DebtUseCaseError("invalid_state", "El pago ya está anulado.")
    }
    assertOperationDateContext(previousOperation, period, this.today())
    const previousMovements = await this.requirePaymentMovements(previousOperation)
    const [debt, account] = await Promise.all([
      this.requireDebt(previousOperation.details.debtId),
      this.requireAccount(previousOperation.details.accountId, false),
    ])
    const occurredAt = this.now()
    const operation: DebtPaymentOperation = {
      ...previousOperation,
      status: "voided",
      voidedAt: occurredAt,
      voidReason: optionalText(reason),
      revision: asRevision(Number(previousOperation.revision) + 1),
      updatedAt: occurredAt,
    }
    const movements = previousMovements.map((movement) => ({
      ...movement,
      status: "voided" as const,
      updatedAt: occurredAt,
    })) as [Movement, Movement]
    assertOperationMovementInvariant(operation, movements)
    const nextAccount = applyAccountMovementChange({
      account,
      previousDelta: previousMovements[0].delta,
      nextDelta: null,
      occurredAt,
    })
    const nextDebt = this.applyDebtImpact(debt, previousMovements[1].delta, null, occurredAt)
    const revision = this.operationRevision(
      previousOperation,
      previousMovements,
      "void",
      occurredAt,
      optionalText(reason),
    )
    await this.commitDebt({
      kind: "change",
      period,
      expectedAccounts: [account],
      expectedDebt: debt,
      expectedOperation: previousOperation,
      accounts: [nextAccount],
      debt: nextDebt,
      operation,
      movements,
      operationRevision: revision,
    })
    return { operation, accountName: account.name, revisions: [revision] }
  }

  async adjustDebtTotal(
    debtId: EntityId,
    expectedRevision: Revision,
    operationDate: CivilDate,
    newTotalAmountValue: number,
  ) {
    const [period, debt] = await Promise.all([
      this.requireOpenPeriod(),
      this.requireDebt(debtId),
    ])
    this.assertRevision(debt.revision, expectedRevision)
    if (debt.lifecycleStatus !== "active" || debt.paymentStatus === "paid") {
      throw new DebtUseCaseError("invalid_state", "Una deuda pagada no admite ajustes.")
    }
    const debtMovements = await this.repositories.movements.listByTarget(
      "debt",
      debtId,
    )
    const relatedOperations = await Promise.all(
      [...new Set(debtMovements.map(({ operationId }) => operationId))].map(
        (operationId) => this.repositories.operations.get(operationId),
      ),
    )
    const postedPayments = relatedOperations
      .filter(
        (operation): operation is DebtPaymentOperation =>
          operation?.type === "debt_payment" &&
          operation.status === "posted" &&
          operation.details.debtId === debtId,
      )
    const postedPaymentsTotal = postedPayments.reduce(
      (sum, operation) => sum + operation.amount,
      0,
    )
    const { paidAmount } = deriveDebtProgress(debt)
    const newTotalAmount = positiveAmount(newTotalAmountValue)
    if (newTotalAmount < paidAmount) {
      throw new DebtUseCaseError(
        "invalid_amount",
        "El total no puede ser menor que el monto ya pagado.",
      )
    }
    const newOutstandingAmount = asClpAmount(newTotalAmount - paidAmount)
    const delta = newOutstandingAmount - debt.outstandingAmount
    if (delta === 0) throw new DebtUseCaseError("no_changes", "El nuevo total no produce cambios.")
    const occurredAt = this.now()
    const operation: DebtTotalAdjustmentOperation = {
      id: this.createId(),
      periodId: period.id,
      type: "debt_total_adjustment",
      operationDate,
      amount: positiveAmount(Math.abs(delta)),
      details: {
        debtId,
        previousTotalAmount: debt.totalAmount,
        newTotalAmount,
        previousOutstandingAmount: debt.outstandingAmount,
        newOutstandingAmount,
        validPostedPaymentsTotal: asClpAmount(postedPaymentsTotal),
      },
      status: "posted",
      voidedAt: null,
      voidReason: null,
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    assertOperationDateContext(operation, period, this.today())
    const movement: Movement = {
      id: this.createId(),
      operationId: operation.id,
      periodId: period.id,
      targetType: "debt",
      targetId: debtId,
      effectType: "debt_outstanding",
      delta: asNonZeroClpDelta(delta),
      status: "posted",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    assertOperationMovementInvariant(operation, [movement])
    const nextDebt = assertDebtInvariant({
      ...debt,
      totalAmount: newTotalAmount,
      outstandingAmount: newOutstandingAmount,
      paymentStatus: this.status(newOutstandingAmount, debt.dueDate),
      revision: asRevision(Number(debt.revision) + 1),
      updatedAt: occurredAt,
    })
    await this.commitDebt({
      kind: "create",
      period,
      expectedAccounts: [],
      expectedDebt: debt,
      accounts: [],
      debt: nextDebt,
      operation,
      movements: [movement],
    })
    return nextDebt
  }

  async deleteDebt(debtId: EntityId, expectedRevision: Revision) {
    const [period, debt] = await Promise.all([
      this.requireOpenPeriod(),
      this.requireDebt(debtId),
    ])
    this.assertRevision(debt.revision, expectedRevision)
    const deletion = {
      period: this.expected(period),
      entity: this.expected(debt),
    }
    if (!(await this.repositories.planning.getDebtDeletionEligibility(deletion)).canDelete) {
      throw new DebtUseCaseError(
        "cannot_delete",
        "La deuda ya tiene actividad o historial y no puede eliminarse.",
      )
    }
    await this.persist(() => this.repositories.planning.deleteUnusedDebt(deletion))
  }

  private paymentOperation(
    input: DebtPaymentDraft,
    period: Period,
    amount: ReturnType<typeof positiveAmount>,
    occurredAt: UtcTimestamp,
    previous?: DebtPaymentOperation,
  ): DebtPaymentOperation {
    return {
      id: previous?.id ?? this.createId(),
      periodId: period.id,
      type: "debt_payment",
      operationDate: input.operationDate,
      amount,
      details: {
        accountId: input.accountId,
        debtId: input.debtId,
        concept: input.concept === undefined && previous
          ? previous.details.concept
          : optionalText(input.concept),
        observation: input.observation === undefined && previous
          ? previous.details.observation
          : optionalText(input.observation),
      },
      status: "posted",
      voidedAt: null,
      voidReason: null,
      revision: previous
        ? asRevision(Number(previous.revision) + 1)
        : asRevision(1),
      createdAt: previous?.createdAt ?? occurredAt,
      updatedAt: occurredAt,
    }
  }

  private paymentMovements(
    operation: DebtPaymentOperation,
    occurredAt: UtcTimestamp,
    previous?: readonly Movement[],
  ): [Movement, Movement] {
    const movements: [Movement, Movement] = [
      {
        id: previous?.[0]?.id ?? this.createId(),
        operationId: operation.id,
        periodId: operation.periodId,
        targetType: "account",
        targetId: operation.details.accountId,
        effectType: "asset_balance",
        delta: asNonZeroClpDelta(-operation.amount),
        status: "posted",
        createdAt: previous?.[0]?.createdAt ?? occurredAt,
        updatedAt: occurredAt,
      },
      {
        id: previous?.[1]?.id ?? this.createId(),
        operationId: operation.id,
        periodId: operation.periodId,
        targetType: "debt",
        targetId: operation.details.debtId,
        effectType: "debt_outstanding",
        delta: asNonZeroClpDelta(-operation.amount),
        status: "posted",
        createdAt: previous?.[1]?.createdAt ?? occurredAt,
        updatedAt: occurredAt,
      },
    ]
    assertOperationMovementInvariant(operation, movements)
    return movements
  }

  private applyDebtImpact(
    debt: Debt,
    previousDelta: Movement["delta"] | null,
    nextDelta: Movement["delta"] | null,
    occurredAt: UtcTimestamp,
  ) {
    let outstanding: number = debt.outstandingAmount
    if (previousDelta !== null) outstanding -= previousDelta
    if (nextDelta !== null) outstanding += nextDelta
    if (!Number.isSafeInteger(outstanding) || outstanding < 0 || outstanding > debt.totalAmount) {
      throw new DebtUseCaseError("invalid_amount", "El pago deja un saldo pendiente inválido.")
    }
    return assertDebtInvariant({
      ...debt,
      outstandingAmount: asClpAmount(outstanding),
      paymentStatus: this.status(outstanding, debt.dueDate),
      revision: asRevision(Number(debt.revision) + 1),
      updatedAt: occurredAt,
    })
  }

  private replaceAccountImpact(
    previous: Account,
    next: Account,
    previousDelta: Movement["delta"],
    nextDelta: Movement["delta"],
    occurredAt: UtcTimestamp,
  ) {
    if (previous.id === next.id) {
      const balance = previous.currentBalance - previousDelta + nextDelta
      if (balance < 0) throw new DebtUseCaseError("insufficient_balance", "La cuenta no tiene saldo suficiente.")
      return [applyAccountMovementChange({ account: previous, previousDelta, nextDelta, occurredAt })]
    }
    if (next.currentBalance + nextDelta < 0) {
      throw new DebtUseCaseError("insufficient_balance", "La cuenta no tiene saldo suficiente.")
    }
    return [
      applyAccountMovementChange({ account: previous, previousDelta, nextDelta: null, occurredAt }),
      applyAccountMovementChange({ account: next, previousDelta: null, nextDelta, occurredAt }),
    ]
  }

  private operationRevision(
    operation: DebtPaymentOperation,
    movements: readonly Movement[],
    changeType: "edit" | "void",
    occurredAt: UtcTimestamp,
    reason: string | null = null,
  ): OperationRevision {
    return {
      id: this.createId(),
      operationId: operation.id,
      periodId: operation.periodId,
      revisionNumber: operation.revision,
      changeType,
      previousOperation: operation,
      previousMovements: movements,
      reason,
      createdAt: occurredAt,
    }
  }

  private async requirePayment(id: EntityId) {
    const operation = await this.repositories.operations.get(id)
    if (!operation || operation.type !== "debt_payment") {
      throw new DebtUseCaseError("operation_not_found", "El pago solicitado no existe.")
    }
    return operation
  }

  private async requirePaymentMovements(operation: DebtPaymentOperation) {
    const movements = await this.repositories.movements.listByOperation(operation.id)
    const account = movements.find((movement) => movement.targetType === "account")
    const debt = movements.find((movement) => movement.targetType === "debt")
    if (!account || !debt || movements.length !== 2) {
      throw new DebtUseCaseError("invalid_state", "El pago tiene movimientos inconsistentes.")
    }
    assertOperationMovementInvariant(operation, [account, debt])
    return [account, debt] as const
  }

  private async requireDebt(id: EntityId) {
    const debt = await this.repositories.debts.get(id)
    if (!debt) throw new DebtUseCaseError("debt_not_found", "La deuda solicitada no existe.")
    return assertDebtInvariant(debt)
  }

  private async requireAccount(id: EntityId, requireActive: boolean) {
    const account = await this.repositories.accounts.get(id)
    if (!account) throw new DebtUseCaseError("account_not_found", "La cuenta seleccionada no existe.")
    if (account.status === "deleted" || (requireActive && account.status !== "active")) {
      throw new DebtUseCaseError("invalid_state", "La cuenta seleccionada está inactiva.")
    }
    return account
  }

  private async requireOpenPeriod() {
    const periods = await this.repositories.periods.listByStatus("open")
    if (periods.length !== 1 || !periods[0]) {
      throw new DebtUseCaseError("no_open_period", "Debe existir un único período abierto.")
    }
    return periods[0]
  }

  private status(outstanding: number, dueDate: CivilDate | null): Debt["paymentStatus"] {
    if (outstanding === 0) return "paid"
    return dueDate !== null && dueDate < this.today() ? "overdue" : "active"
  }

  private expected(record: { readonly id: EntityId; readonly revision: Revision }) {
    return { id: record.id, revision: record.revision }
  }

  private uniqueAccounts(...accounts: Account[]) {
    return [...new Map(accounts.map((account) => [account.id, account])).values()]
  }

  private assertRevision(actual: Revision, expected: Revision) {
    if (actual !== expected) {
      throw new DebtUseCaseError("revision_conflict", "La información cambió; vuelve a cargar.")
    }
  }

  private audit(
    action: "created" | "updated",
    previousValue: Debt | null,
    nextValue: Debt,
    periodId: EntityId,
    commandType: string,
    occurredAt: UtcTimestamp,
  ): AuditEvent {
    return assertAuditEventInvariant({
      id: this.createId(),
      periodId,
      subjectType: "debt",
      subjectId: nextValue.id,
      action,
      commandType,
      previousRevision: previousValue?.revision ?? null,
      nextRevision: nextValue.revision,
      previousValue,
      nextValue,
      reason: null,
      occurredAt,
    } as AuditEvent)
  }

  private async commitDebt(mutation: Omit<DebtOperationMutation, "period" | "expectedDebt" | "expectedAccounts"> & {
    readonly period: Period
    readonly expectedDebt: Debt
    readonly expectedAccounts: readonly Account[]
  }) {
    await this.persist(() =>
      this.repositories.operations.commitDebt({
        ...mutation,
        period: this.expected(mutation.period),
        expectedDebt: this.expected(mutation.expectedDebt),
        expectedAccounts: mutation.expectedAccounts.map((account) => this.expected(account)),
      }),
    )
  }

  private async persist(action: () => Promise<void>) {
    try {
      await action()
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "conflict") {
        throw new DebtUseCaseError("revision_conflict", "La información cambió; vuelve a cargar.")
      }
      throw error
    }
  }
}

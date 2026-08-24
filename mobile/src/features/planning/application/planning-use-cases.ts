import type { AuditEvent } from "@/domain/audit"
import type {
  FixedExpenseInstance,
  FixedExpenseTemplate,
  SavingsGoal,
} from "@/domain/entities"
import {
  assertAuditEventInvariant,
  assertCurrentPeriodFixedExpenseInstance,
  assertFixedExpenseInstanceInvariant,
  assertFixedExpenseTemplateInvariant,
  assertInitialBalancePolicy,
  assertSavingsGoalInvariant,
  deriveSavingsGoalProgress,
} from "@/domain/invariants"
import type { Movement, Operation } from "@/domain/operations"
import type { PeriodOpening } from "@/domain/periods"
import {
  asClpAmount,
  asEntityId,
  asPositiveClpAmount,
  asRevision,
  asUtcTimestamp,
  type EntityId,
  type Revision,
  type UtcTimestamp,
} from "@/domain/primitives"
import { PersistenceError } from "@/data/errors"
import type { PeritaRepositories } from "@/data/repositories"

export interface SavingsGoalDraft {
  readonly name: string
  readonly bank?: string | null
  readonly emoji?: string
  readonly targetAmount: number
  readonly plannedMonthlyAmount: number
}

export interface EditSavingsGoalInput extends SavingsGoalDraft {
  readonly goalId: EntityId
  readonly expectedRevision: Revision
}

export interface GoalMovementItem {
  readonly movement: Movement
  readonly operation: Operation
}

export interface SavingsGoalDetail {
  readonly goal: SavingsGoal
  readonly relatedMovements: readonly GoalMovementItem[]
}

export interface FixedExpenseDraft {
  readonly name: string
  readonly referenceAmount: number
}

export interface EditFixedExpenseInput extends FixedExpenseDraft {
  readonly templateId: EntityId
  readonly expectedRevision: Revision
}

export interface FixedExpenseListItem {
  readonly template: FixedExpenseTemplate
  readonly currentInstance: FixedExpenseInstance | null
}

export interface PlanningUseCasesPort {
  listSavingsGoals(): Promise<SavingsGoal[]>
  getSavingsGoalDetail(goalId: EntityId): Promise<SavingsGoalDetail>
  createSavingsGoal(input: SavingsGoalDraft): Promise<SavingsGoal>
  editSavingsGoal(input: EditSavingsGoalInput): Promise<SavingsGoal>
  closeSavingsGoal(goalId: EntityId, expectedRevision: Revision): Promise<SavingsGoal>
  listFixedExpenses(): Promise<FixedExpenseListItem[]>
  getFixedExpenseDetail(templateId: EntityId): Promise<FixedExpenseListItem>
  createFixedExpense(input: FixedExpenseDraft): Promise<FixedExpenseListItem>
  editFixedExpense(input: EditFixedExpenseInput): Promise<FixedExpenseListItem>
  deactivateFixedExpense(
    templateId: EntityId,
    expectedRevision: Revision,
  ): Promise<FixedExpenseListItem>
  updateCurrentPlannedAmount(
    instanceId: EntityId,
    expectedRevision: Revision,
    plannedAmount: number,
  ): Promise<FixedExpenseInstance>
}

export type PlanningErrorCode =
  | "no_open_period"
  | "goal_not_found"
  | "fixed_expense_not_found"
  | "fixed_expense_instance_not_found"
  | "invalid_name"
  | "invalid_emoji"
  | "invalid_amount"
  | "invalid_state"
  | "nonzero_balance"
  | "no_changes"
  | "revision_conflict"

export class PlanningUseCaseError extends Error {
  readonly code: PlanningErrorCode

  constructor(
    code: PlanningErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "PlanningUseCaseError"
    this.code = code
  }
}

interface PlanningUseCasesOptions {
  readonly now?: () => UtcTimestamp
  readonly createId?: () => EntityId
}

function defaultNow() {
  return asUtcTimestamp(new Date().toISOString())
}

function defaultCreateId() {
  return asEntityId(globalThis.crypto.randomUUID())
}

function requiredName(value: string) {
  const name = value.trim()
  if (!name) {
    throw new PlanningUseCaseError("invalid_name", "El nombre es obligatorio.")
  }
  return name
}

function requiredEmoji(value: string | undefined, fallback: string) {
  const emoji = value === undefined ? fallback : value.trim()
  if (!emoji) {
    throw new PlanningUseCaseError(
      "invalid_emoji",
      "El emoji de la meta es obligatorio.",
    )
  }
  return emoji
}

function positiveAmount(value: number) {
  try {
    return asPositiveClpAmount(value)
  } catch {
    throw new PlanningUseCaseError(
      "invalid_amount",
      "El monto debe ser un entero CLP mayor que cero.",
    )
  }
}

function nonnegativeAmount(value: number) {
  try {
    return asClpAmount(value)
  } catch {
    throw new PlanningUseCaseError(
      "invalid_amount",
      "El aporte mensual debe ser un entero CLP igual o mayor que cero.",
    )
  }
}

export function savingsGoalProgressPercent(goal: SavingsGoal) {
  return Math.min(100, Math.floor((goal.currentBalance / goal.targetAmount) * 100))
}

type PlanningAuditSnapshot =
  | SavingsGoal
  | FixedExpenseTemplate
  | FixedExpenseInstance

export class PlanningUseCases implements PlanningUseCasesPort {
  private readonly now: () => UtcTimestamp
  private readonly createId: () => EntityId
  private readonly repositories: PeritaRepositories

  constructor(
    repositories: PeritaRepositories,
    options: PlanningUseCasesOptions = {},
  ) {
    this.repositories = repositories
    this.now = options.now ?? defaultNow
    this.createId = options.createId ?? defaultCreateId
  }

  async listSavingsGoals() {
    const goals = await this.repositories.savingsGoals.getAll()
    return goals
      .map(assertSavingsGoalInvariant)
      .toSorted((left, right) => {
        if (left.lifecycleStatus !== right.lifecycleStatus) {
          return left.lifecycleStatus === "active" ? -1 : 1
        }
        return left.name.localeCompare(right.name, "es")
      })
  }

  async getSavingsGoalDetail(goalId: EntityId) {
    const goal = await this.requireGoal(goalId)
    const movements = await this.repositories.movements.listByTarget(
      "savings_goal",
      goalId,
    )
    const related = await Promise.all(
      movements.map(async (movement) => {
        const operation = await this.repositories.operations.get(
          movement.operationId,
        )
        return operation ? { movement, operation } : null
      }),
    )
    const relatedMovements = related
      .filter((item): item is GoalMovementItem => item !== null)
      .toSorted(
        (left, right) =>
          right.operation.operationDate.localeCompare(
            left.operation.operationDate,
          ) || right.operation.createdAt.localeCompare(left.operation.createdAt),
      )
    return { goal, relatedMovements }
  }

  async createSavingsGoal(input: SavingsGoalDraft) {
    const period = await this.requireOpenPeriod()
    const occurredAt = this.now()
    const goal = assertSavingsGoalInvariant({
      id: this.createId(),
      emoji: requiredEmoji(input.emoji, "💰"),
      name: requiredName(input.name),
      bank: input.bank?.trim() || null,
      targetAmount: positiveAmount(input.targetAmount),
      openingBalance: asClpAmount(0),
      currentBalance: asClpAmount(0),
      plannedMonthlyAmount: nonnegativeAmount(input.plannedMonthlyAmount),
      lifecycleStatus: "active",
      progressStatus: "in_progress",
      closedAt: null,
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    })
    assertInitialBalancePolicy({
      targetType: "savings_goal",
      duringSetup: false,
      openingBalance: goal.openingBalance,
      currentBalance: goal.currentBalance,
    })
    const opening: PeriodOpening = {
      id: this.createId(),
      periodId: period.id,
      targetType: "savings_goal",
      targetId: goal.id,
      openingAmount: asClpAmount(0),
    }
    const auditEvent = this.createdAudit(
      "savings_goal",
      goal,
      period.id,
      "savings-goal.create",
      occurredAt,
    )
    await this.persist(() =>
      this.repositories.planning.createSavingsGoal({
        period: this.expected(period),
        goal,
        opening,
        auditEvent,
      }),
    )
    return goal
  }

  async editSavingsGoal(input: EditSavingsGoalInput) {
    const period = await this.requireOpenPeriod()
    const previous = await this.requireGoal(input.goalId)
    this.assertRevision(previous.revision, input.expectedRevision)
    if (previous.lifecycleStatus !== "active") {
      throw new PlanningUseCaseError(
        "invalid_state",
        "Una meta cerrada no se puede editar.",
      )
    }
    const name = requiredName(input.name)
    const emoji = requiredEmoji(input.emoji, previous.emoji)
    const bank = input.bank?.trim() || null
    const targetAmount = positiveAmount(input.targetAmount)
    const plannedMonthlyAmount = nonnegativeAmount(input.plannedMonthlyAmount)
    if (
      previous.name === name &&
      previous.emoji === emoji &&
      previous.bank === bank &&
      previous.targetAmount === targetAmount &&
      previous.plannedMonthlyAmount === plannedMonthlyAmount
    ) {
      throw new PlanningUseCaseError("no_changes", "No hay cambios para guardar.")
    }
    const occurredAt = this.now()
    const goal = assertSavingsGoalInvariant({
      ...previous,
      emoji,
      name,
      bank,
      targetAmount,
      plannedMonthlyAmount,
      progressStatus: deriveSavingsGoalProgress(
        previous.currentBalance,
        targetAmount,
      ),
      revision: this.nextRevision(previous.revision),
      updatedAt: occurredAt,
    })
    const auditEvent = this.changedAudit(
      "updated",
      "savings_goal",
      previous,
      goal,
      period.id,
      "savings-goal.update",
      occurredAt,
    )
    await this.persist(() =>
      this.repositories.planning.changeSavingsGoal({
        period: this.expected(period),
        expectedGoal: this.expected(previous),
        goal,
        auditEvent,
      }),
    )
    return goal
  }

  async closeSavingsGoal(goalId: EntityId, expectedRevision: Revision) {
    const period = await this.requireOpenPeriod()
    const previous = await this.requireGoal(goalId)
    this.assertRevision(previous.revision, expectedRevision)
    if (previous.lifecycleStatus !== "active") {
      throw new PlanningUseCaseError("invalid_state", "La meta ya está cerrada.")
    }
    if (previous.currentBalance !== 0) {
      throw new PlanningUseCaseError(
        "nonzero_balance",
        "La meta debe tener saldo $0 antes de cerrarla.",
      )
    }
    const occurredAt = this.now()
    const goal = assertSavingsGoalInvariant({
      ...previous,
      lifecycleStatus: "closed",
      closedAt: occurredAt,
      revision: this.nextRevision(previous.revision),
      updatedAt: occurredAt,
    })
    const auditEvent = this.changedAudit(
      "closed",
      "savings_goal",
      previous,
      goal,
      period.id,
      "savings-goal.close",
      occurredAt,
    )
    await this.persist(() =>
      this.repositories.planning.changeSavingsGoal({
        period: this.expected(period),
        expectedGoal: this.expected(previous),
        goal,
        auditEvent,
      }),
    )
    return goal
  }

  async listFixedExpenses() {
    const period = await this.requireOpenPeriod()
    const [templates, instances] = await Promise.all([
      this.repositories.fixedExpenseTemplates.getAll(),
      this.repositories.fixedExpenseInstances.listByPeriod(period.id),
    ])
    const instanceMap = new Map(
      instances
        .map(assertFixedExpenseInstanceInvariant)
        .map((instance) => [instance.templateId, instance]),
    )
    return templates
      .map(assertFixedExpenseTemplateInvariant)
      .map((template) => ({
        template,
        currentInstance: instanceMap.get(template.id) ?? null,
      }))
      .toSorted((left, right) => {
        if (left.template.status !== right.template.status) {
          return left.template.status === "active" ? -1 : 1
        }
        return left.template.name.localeCompare(right.template.name, "es")
      })
  }

  async getFixedExpenseDetail(templateId: EntityId) {
    const items = await this.listFixedExpenses()
    const item = items.find(({ template }) => template.id === templateId)
    if (!item) {
      throw new PlanningUseCaseError(
        "fixed_expense_not_found",
        "El gasto fijo solicitado no existe.",
      )
    }
    return item
  }

  async createFixedExpense(input: FixedExpenseDraft) {
    const period = await this.requireOpenPeriod()
    const occurredAt = this.now()
    const template = assertFixedExpenseTemplateInvariant({
      id: this.createId(),
      name: requiredName(input.name),
      referenceAmount: positiveAmount(input.referenceAmount),
      status: "active",
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    })
    const instance = assertFixedExpenseInstanceInvariant({
      id: this.createId(),
      periodId: period.id,
      templateId: template.id,
      nameSnapshot: template.name,
      plannedAmount: template.referenceAmount,
      status: "pending",
      activePaymentOperationId: null,
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    })
    assertCurrentPeriodFixedExpenseInstance({
      template,
      activePeriod: period,
      instance,
      instances: (
        await this.repositories.fixedExpenseInstances.listByPeriod(period.id)
      ).map(assertFixedExpenseInstanceInvariant),
    })
    const templateAudit = this.createdAudit(
      "fixed_expense_template",
      template,
      period.id,
      "fixed-expense-template.create",
      occurredAt,
    )
    const instanceAudit = this.createdAudit(
      "fixed_expense_instance",
      instance,
      period.id,
      "fixed-expense-template.create",
      occurredAt,
    )
    await this.persist(() =>
      this.repositories.planning.createFixedExpense({
        period: this.expected(period),
        template,
        instance,
        auditEvents: [templateAudit, instanceAudit],
      }),
    )
    return { template, currentInstance: instance }
  }

  async editFixedExpense(input: EditFixedExpenseInput) {
    const period = await this.requireOpenPeriod()
    const previous = await this.requireFixedExpense(input.templateId)
    this.assertRevision(previous.revision, input.expectedRevision)
    if (previous.status !== "active") {
      throw new PlanningUseCaseError(
        "invalid_state",
        "Un gasto fijo inactivo no se puede editar.",
      )
    }
    const name = requiredName(input.name)
    const referenceAmount = positiveAmount(input.referenceAmount)
    if (previous.name === name && previous.referenceAmount === referenceAmount) {
      throw new PlanningUseCaseError("no_changes", "No hay cambios para guardar.")
    }
    const occurredAt = this.now()
    const template = assertFixedExpenseTemplateInvariant({
      ...previous,
      name,
      referenceAmount,
      revision: this.nextRevision(previous.revision),
      updatedAt: occurredAt,
    })
    const auditEvent = this.changedAudit(
      "updated",
      "fixed_expense_template",
      previous,
      template,
      period.id,
      "fixed-expense-template.update",
      occurredAt,
    )
    await this.persist(() =>
      this.repositories.planning.changeFixedExpenseTemplate({
        period: this.expected(period),
        expectedTemplate: this.expected(previous),
        template,
        auditEvent,
      }),
    )
    const instances = await this.repositories.fixedExpenseInstances.listByPeriod(
      period.id,
    )
    return {
      template,
      currentInstance:
        instances.find((instance) => instance.templateId === template.id) ?? null,
    }
  }

  async deactivateFixedExpense(
    templateId: EntityId,
    expectedRevision: Revision,
  ) {
    const period = await this.requireOpenPeriod()
    const previous = await this.requireFixedExpense(templateId)
    this.assertRevision(previous.revision, expectedRevision)
    if (previous.status !== "active") {
      throw new PlanningUseCaseError(
        "invalid_state",
        "El gasto fijo ya está inactivo.",
      )
    }
    const occurredAt = this.now()
    const template = assertFixedExpenseTemplateInvariant({
      ...previous,
      status: "inactive",
      revision: this.nextRevision(previous.revision),
      updatedAt: occurredAt,
    })
    const auditEvent = this.changedAudit(
      "deactivated",
      "fixed_expense_template",
      previous,
      template,
      period.id,
      "fixed-expense-template.deactivate",
      occurredAt,
    )
    await this.persist(() =>
      this.repositories.planning.changeFixedExpenseTemplate({
        period: this.expected(period),
        expectedTemplate: this.expected(previous),
        template,
        auditEvent,
      }),
    )
    const instances = await this.repositories.fixedExpenseInstances.listByPeriod(
      period.id,
    )
    return {
      template,
      currentInstance:
        instances.find((instance) => instance.templateId === template.id) ?? null,
    }
  }

  async updateCurrentPlannedAmount(
    instanceId: EntityId,
    expectedRevision: Revision,
    plannedAmountValue: number,
  ) {
    const period = await this.requireOpenPeriod()
    const previous = await this.repositories.fixedExpenseInstances.get(instanceId)
    if (!previous) {
      throw new PlanningUseCaseError(
        "fixed_expense_instance_not_found",
        "La planificación mensual solicitada no existe.",
      )
    }
    if (previous.periodId !== period.id) {
      throw new PlanningUseCaseError(
        "invalid_state",
        "La planificación no pertenece al período abierto.",
      )
    }
    this.assertRevision(previous.revision, expectedRevision)
    const plannedAmount = positiveAmount(plannedAmountValue)
    if (previous.plannedAmount === plannedAmount) {
      throw new PlanningUseCaseError("no_changes", "No hay cambios para guardar.")
    }
    const occurredAt = this.now()
    const instance = assertFixedExpenseInstanceInvariant({
      ...previous,
      plannedAmount,
      revision: this.nextRevision(previous.revision),
      updatedAt: occurredAt,
    })
    const auditEvent = this.changedAudit(
      "updated",
      "fixed_expense_instance",
      previous,
      instance,
      period.id,
      "fixed-expense-instance.update-planned-amount",
      occurredAt,
    )
    await this.persist(() =>
      this.repositories.planning.changeFixedExpenseInstance({
        period: this.expected(period),
        expectedInstance: this.expected(previous),
        instance,
        auditEvent,
      }),
    )
    return instance
  }

  private async requireOpenPeriod() {
    const periods = await this.repositories.periods.listByStatus("open")
    if (periods.length !== 1) {
      throw new PlanningUseCaseError(
        "no_open_period",
        "Se necesita un período mensual abierto para planificar.",
      )
    }
    return periods[0]
  }

  private async requireGoal(goalId: EntityId) {
    const goal = await this.repositories.savingsGoals.get(goalId)
    if (!goal) {
      throw new PlanningUseCaseError(
        "goal_not_found",
        "La meta de ahorro solicitada no existe.",
      )
    }
    return assertSavingsGoalInvariant(goal)
  }

  private async requireFixedExpense(templateId: EntityId) {
    const template = await this.repositories.fixedExpenseTemplates.get(templateId)
    if (!template) {
      throw new PlanningUseCaseError(
        "fixed_expense_not_found",
        "El gasto fijo solicitado no existe.",
      )
    }
    return assertFixedExpenseTemplateInvariant(template)
  }

  private assertRevision(actual: Revision, expected: Revision) {
    if (actual !== expected) {
      throw new PlanningUseCaseError(
        "revision_conflict",
        "Los datos cambiaron desde que fueron abiertos.",
      )
    }
  }

  private nextRevision(revision: Revision) {
    return asRevision(Number(revision) + 1)
  }

  private expected(record: { readonly id: EntityId; readonly revision: Revision }) {
    return { id: record.id, revision: record.revision }
  }

  private createdAudit(
    subjectType: "savings_goal" | "fixed_expense_template" | "fixed_expense_instance",
    nextValue: PlanningAuditSnapshot,
    periodId: EntityId,
    commandType: string,
    occurredAt: UtcTimestamp,
  ): AuditEvent {
    return assertAuditEventInvariant({
      id: this.createId(),
      periodId,
      subjectType,
      subjectId: nextValue.id,
      action: "created",
      commandType,
      previousRevision: null,
      nextRevision: nextValue.revision,
      previousValue: null,
      nextValue,
      reason: null,
      occurredAt,
    })
  }

  private changedAudit(
    action: "updated" | "deactivated" | "closed",
    subjectType: "savings_goal" | "fixed_expense_template" | "fixed_expense_instance",
    previousValue: PlanningAuditSnapshot,
    nextValue: PlanningAuditSnapshot,
    periodId: EntityId,
    commandType: string,
    occurredAt: UtcTimestamp,
  ): AuditEvent {
    return assertAuditEventInvariant({
      id: this.createId(),
      periodId,
      subjectType,
      subjectId: nextValue.id,
      action,
      commandType,
      previousRevision: previousValue.revision,
      nextRevision: nextValue.revision,
      previousValue,
      nextValue,
      reason: null,
      occurredAt,
    })
  }

  private async persist(action: () => Promise<void>) {
    try {
      await action()
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "conflict") {
        throw new PlanningUseCaseError(
          "revision_conflict",
          "Los datos cambiaron antes de guardar. Vuelve a intentarlo.",
        )
      }
      throw error
    }
  }
}

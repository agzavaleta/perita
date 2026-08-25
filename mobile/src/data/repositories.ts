import type { AuditEvent } from "@/domain/audit"
import type {
  Account,
  Category,
  Debt,
  FinancialSettings,
  FixedExpenseInstance,
  FixedExpenseTemplate,
  SavingsGoal,
} from "@/domain/entities"
import type {
  BalanceAdjustmentOperation,
  Movement,
  Operation,
  OperationRevision,
} from "@/domain/operations"
import type {
  Period,
  PeriodOpening,
  PeriodSnapshot,
} from "@/domain/periods"
import type { EntityId, PeriodKey, Revision } from "@/domain/primitives"
import type { PeritaDataSnapshot } from "@/domain/data-snapshot"
import type { PeritaDatabase } from "@/data/database"
import { PersistenceError } from "@/data/errors"
import {
  INDEX_NAMES,
  STORE_NAMES,
  type StoreKey,
  type StoreName,
  type StoreValue,
} from "@/data/schema"
import type { TransactionContext } from "@/data/transaction"
import { canonicalJson } from "@/lib/integrity"

export interface Repository<Value, Key> {
  get(key: Key): Promise<Value | undefined>
  getAll(): Promise<Value[]>
  count(): Promise<number>
  add(value: Value): Promise<Key>
  put(value: Value): Promise<Key>
  delete(key: Key): Promise<void>
}

class IndexedDbRepository<Name extends StoreName>
  implements Repository<StoreValue<Name>, StoreKey<Name>>
{
  protected readonly database: PeritaDatabase
  protected readonly storeName: Name

  constructor(
    database: PeritaDatabase,
    storeName: Name,
  ) {
    this.database = database
    this.storeName = storeName
  }

  get(key: StoreKey<Name>) {
    return this.database.transaction(
      [this.storeName],
      "readonly",
      ({ store }) => store(this.storeName).get(key),
    )
  }

  getAll() {
    return this.database.transaction(
      [this.storeName],
      "readonly",
      ({ store }) => store(this.storeName).getAll(),
    )
  }

  count() {
    return this.database.transaction(
      [this.storeName],
      "readonly",
      ({ store }) => store(this.storeName).count(),
    )
  }

  add(value: StoreValue<Name>) {
    return this.database.transaction(
      [this.storeName],
      "readwrite",
      ({ store }) => store(this.storeName).add(value),
    )
  }

  put(value: StoreValue<Name>) {
    return this.database.transaction(
      [this.storeName],
      "readwrite",
      ({ store }) => store(this.storeName).put(value),
    )
  }

  delete(key: StoreKey<Name>) {
    return this.database.transaction(
      [this.storeName],
      "readwrite",
      ({ store }) => store(this.storeName).delete(key),
    )
  }

  protected listByIndex(indexName: string, query: IDBValidKey | IDBKeyRange) {
    return this.database.transaction(
      [this.storeName],
      "readonly",
      ({ store }) =>
        store(this.storeName).getAllFromIndex(indexName, query),
    )
  }
}

export interface PeriodRepository extends Repository<Period, EntityId> {
  getByPeriodKey(periodKey: PeriodKey): Promise<Period | undefined>
  listByStatus(status: Period["status"]): Promise<Period[]>
}

export interface AccountRepository extends Repository<Account, EntityId> {
  addWithOpeningAndAudit(
    account: Account,
    opening: PeriodOpening,
    auditEvent: AuditEvent,
  ): Promise<void>
  putWithAudit(account: Account, auditEvent: AuditEvent): Promise<void>
}

export interface CategoryRepository extends Repository<Category, EntityId> {
  ensureDefaults(
    categories: readonly Category[],
    auditEvents: readonly AuditEvent[],
  ): Promise<boolean>
  addWithAudit(
    expectedCategories: readonly Category[],
    category: Category,
    auditEvent: AuditEvent,
  ): Promise<void>
  putWithAudit(
    expectedCategories: readonly Category[],
    category: Category,
    auditEvent: AuditEvent,
  ): Promise<void>
}

export interface SetupRepository {
  complete(input: {
    readonly financialSettings: FinancialSettings
    readonly period: Period
    readonly accounts: readonly Account[]
    readonly periodOpenings: readonly PeriodOpening[]
    readonly auditEvents: readonly AuditEvent[]
  }): Promise<void>
}

class IndexedDbAccountRepository
  extends IndexedDbRepository<"accounts">
  implements AccountRepository
{
  addWithOpeningAndAudit(
    account: Account,
    opening: PeriodOpening,
    auditEvent: AuditEvent,
  ) {
    return this.database.transaction(
      [STORE_NAMES.accounts, STORE_NAMES.periodOpenings, STORE_NAMES.auditEvents],
      "readwrite",
      async ({ store }) => {
        await store(STORE_NAMES.accounts).add(account)
        await store(STORE_NAMES.periodOpenings).add(opening)
        await store(STORE_NAMES.auditEvents).add(auditEvent)
      },
    )
  }

  putWithAudit(account: Account, auditEvent: AuditEvent) {
    return this.database.transaction(
      [STORE_NAMES.accounts, STORE_NAMES.auditEvents],
      "readwrite",
      async ({ store }) => {
        await store(STORE_NAMES.accounts).put(account)
        await store(STORE_NAMES.auditEvents).add(auditEvent)
      },
    )
  }
}

class IndexedDbCategoryRepository
  extends IndexedDbRepository<"categories">
  implements CategoryRepository
{
  ensureDefaults(
    categories: readonly Category[],
    auditEvents: readonly AuditEvent[],
  ) {
    return this.database.transaction(
      [STORE_NAMES.categories, STORE_NAMES.auditEvents],
      "readwrite",
      async ({ store }) => {
        if ((await store(STORE_NAMES.categories).count()) !== 0) return false
        for (const category of categories) {
          await store(STORE_NAMES.categories).add(category)
        }
        for (const auditEvent of auditEvents) {
          await store(STORE_NAMES.auditEvents).add(auditEvent)
        }
        return true
      },
    )
  }

  addWithAudit(
    expectedCategories: readonly Category[],
    category: Category,
    auditEvent: AuditEvent,
  ) {
    return this.saveWithAudit(expectedCategories, category, auditEvent, "add")
  }

  putWithAudit(
    expectedCategories: readonly Category[],
    category: Category,
    auditEvent: AuditEvent,
  ) {
    return this.saveWithAudit(expectedCategories, category, auditEvent, "put")
  }

  private saveWithAudit(
    expectedCategories: readonly Category[],
    category: Category,
    auditEvent: AuditEvent,
    operation: "add" | "put",
  ) {
    return this.database.transaction(
      [STORE_NAMES.categories, STORE_NAMES.auditEvents],
      "readwrite",
      async ({ store }) => {
        const stored = await store(STORE_NAMES.categories).getAll()
        if (canonicalJson(stored) !== canonicalJson(expectedCategories)) {
          throw new PersistenceError(
            "conflict",
            "Categories changed before saving",
          )
        }
        await store(STORE_NAMES.categories)[operation](category)
        await store(STORE_NAMES.auditEvents).add(auditEvent)
      },
    )
  }
}

class IndexedDbPeriodRepository
  extends IndexedDbRepository<"periods">
  implements PeriodRepository
{
  async getByPeriodKey(periodKey: PeriodKey) {
    const [period] = await this.listByIndex(INDEX_NAMES.byPeriodKey, periodKey)
    return period
  }

  listByStatus(status: Period["status"]) {
    return this.listByIndex(INDEX_NAMES.byStatus, status)
  }
}

class PeriodIndexedRepository<Name extends StoreName> extends IndexedDbRepository<Name> {
  listByPeriod(periodId: EntityId) {
    return this.listByIndex(INDEX_NAMES.byPeriod, periodId)
  }
}

export interface ExpectedRecordState {
  readonly id: EntityId
  readonly revision: Revision
}

export interface PlanningRepository {
  createDebt(input: {
    readonly period: ExpectedRecordState
    readonly debt: Debt
    readonly opening: PeriodOpening
    readonly auditEvent: AuditEvent
  }): Promise<void>
  changeDebt(input: {
    readonly period: ExpectedRecordState
    readonly expectedDebt: ExpectedRecordState
    readonly debt: Debt
    readonly auditEvent: AuditEvent
  }): Promise<void>
  createSavingsGoal(input: {
    readonly period: ExpectedRecordState
    readonly goal: SavingsGoal
    readonly opening: PeriodOpening
    readonly auditEvents: readonly AuditEvent[]
    readonly adjustment?: SavingsGoalBalanceAdjustment
  }): Promise<void>
  changeSavingsGoal(input: {
    readonly period: ExpectedRecordState
    readonly expectedGoal: ExpectedRecordState
    readonly goal: SavingsGoal
    readonly auditEvent: AuditEvent
    readonly adjustment?: SavingsGoalBalanceAdjustment
  }): Promise<void>
  createFixedExpense(input: {
    readonly period: ExpectedRecordState
    readonly template: FixedExpenseTemplate
    readonly instance: FixedExpenseInstance
    readonly auditEvents: readonly [AuditEvent, AuditEvent]
  }): Promise<void>
  changeFixedExpenseTemplate(input: {
    readonly period: ExpectedRecordState
    readonly expectedTemplate: ExpectedRecordState
    readonly template: FixedExpenseTemplate
    readonly auditEvent: AuditEvent
  }): Promise<void>
  changeFixedExpenseInstance(input: {
    readonly period: ExpectedRecordState
    readonly expectedInstance: ExpectedRecordState
    readonly instance: FixedExpenseInstance
    readonly auditEvent: AuditEvent
  }): Promise<void>
}

export interface SavingsGoalBalanceAdjustment {
  readonly operation: BalanceAdjustmentOperation
  readonly movement: Movement
}

export interface FinancialOperationMutation {
  readonly kind: "create" | "change"
  readonly period: ExpectedRecordState
  readonly expectedAccounts: readonly ExpectedRecordState[]
  readonly expectedOperation?: ExpectedRecordState
  readonly expectedCategories?: readonly ExpectedRecordState[]
  readonly expectedFixedExpenseInstance?: ExpectedRecordState
  readonly accounts: readonly Account[]
  readonly operation: Operation
  readonly movement: Movement
  readonly operationRevision?: OperationRevision
  readonly fixedExpenseInstance?: FixedExpenseInstance
}

export interface InternalTransferMutation {
  readonly kind: "create" | "change"
  readonly period: ExpectedRecordState
  readonly expectedAccounts: readonly ExpectedRecordState[]
  readonly expectedSavingsGoals: readonly ExpectedRecordState[]
  readonly expectedOperation?: ExpectedRecordState
  readonly accounts: readonly Account[]
  readonly savingsGoals: readonly SavingsGoal[]
  readonly operation: Operation
  readonly movements: readonly Movement[]
  readonly operationRevision?: OperationRevision
}

export interface DebtOperationMutation {
  readonly kind: "create" | "change"
  readonly period: ExpectedRecordState
  readonly expectedAccounts: readonly ExpectedRecordState[]
  readonly expectedDebt: ExpectedRecordState
  readonly expectedOperation?: ExpectedRecordState
  readonly accounts: readonly Account[]
  readonly debt: Debt
  readonly operation: Operation
  readonly movements: readonly Movement[]
  readonly operationRevision?: OperationRevision
}

export interface MonthlyCloseSource {
  readonly financialSettings: FinancialSettings
  readonly periods: readonly Period[]
  readonly accounts: readonly Account[]
  readonly savingsGoals: readonly SavingsGoal[]
  readonly debts: readonly Debt[]
  readonly categories: readonly Category[]
  readonly fixedExpenseTemplates: readonly FixedExpenseTemplate[]
  readonly fixedExpenseInstances: readonly FixedExpenseInstance[]
  readonly operations: readonly Operation[]
  readonly movements: readonly Movement[]
  readonly periodOpenings: readonly PeriodOpening[]
  readonly auditEvents: readonly AuditEvent[]
  readonly periodSnapshots: readonly PeriodSnapshot[]
}

export interface MonthlyCloseMutation {
  readonly expected: MonthlyCloseSource
  readonly closedPeriod: Period
  readonly periodSnapshot: PeriodSnapshot
  readonly finalizedFixedExpenseInstances: readonly FixedExpenseInstance[]
  readonly nextPeriod: Period
  readonly nextPeriodOpenings: readonly PeriodOpening[]
  readonly nextFixedExpenseInstances: readonly FixedExpenseInstance[]
  readonly auditEvents: readonly AuditEvent[]
}

export interface MonthlyCloseRepository {
  commit(mutation: MonthlyCloseMutation): Promise<void>
}

export interface FinancialOperationRepository
  extends Repository<Operation, EntityId> {
  listByPeriod(periodId: EntityId): Promise<Operation[]>
  listByType(periodId: EntityId, type: Operation["type"]): Promise<Operation[]>
  commit(mutation: FinancialOperationMutation): Promise<void>
  commitTransfer(mutation: InternalTransferMutation): Promise<void>
  commitDebt(mutation: DebtOperationMutation): Promise<void>
}

function assertStoredRevision(
  record: { readonly id: EntityId; readonly revision: Revision } | undefined,
  expected: ExpectedRecordState,
  entity: string,
) {
  if (!record || record.id !== expected.id || record.revision !== expected.revision) {
    throw new PersistenceError(
      "conflict",
      `${entity} changed before the financial operation could be saved`,
    )
  }
}

class IndexedDbPlanningRepository implements PlanningRepository {
  private readonly database: PeritaDatabase

  constructor(database: PeritaDatabase) {
    this.database = database
  }

  private async assertOpenPeriod(
    store: TransactionContext["store"],
    expected: ExpectedRecordState,
  ) {
    const period = await store(STORE_NAMES.periods).get(expected.id)
    assertStoredRevision(period, expected, "Period")
    if (period?.status !== "open") {
      throw new PersistenceError("conflict", "The active Period is closed")
    }
  }

  createDebt(input: Parameters<PlanningRepository["createDebt"]>[0]) {
    return this.database.transaction(
      [
        STORE_NAMES.periods,
        STORE_NAMES.debts,
        STORE_NAMES.periodOpenings,
        STORE_NAMES.auditEvents,
      ],
      "readwrite",
      async ({ store }) => {
        await this.assertOpenPeriod(store, input.period)
        await store(STORE_NAMES.debts).add(input.debt)
        await store(STORE_NAMES.periodOpenings).add(input.opening)
        await store(STORE_NAMES.auditEvents).add(input.auditEvent)
      },
    )
  }

  changeDebt(input: Parameters<PlanningRepository["changeDebt"]>[0]) {
    return this.database.transaction(
      [STORE_NAMES.periods, STORE_NAMES.debts, STORE_NAMES.auditEvents],
      "readwrite",
      async ({ store }) => {
        await this.assertOpenPeriod(store, input.period)
        assertStoredRevision(
          await store(STORE_NAMES.debts).get(input.expectedDebt.id),
          input.expectedDebt,
          "Debt",
        )
        await store(STORE_NAMES.debts).put(input.debt)
        await store(STORE_NAMES.auditEvents).add(input.auditEvent)
      },
    )
  }

  createSavingsGoal(input: Parameters<PlanningRepository["createSavingsGoal"]>[0]) {
    return this.database.transaction(
      [
        STORE_NAMES.periods,
        STORE_NAMES.savingsGoals,
        STORE_NAMES.periodOpenings,
        STORE_NAMES.auditEvents,
        STORE_NAMES.operations,
        STORE_NAMES.movements,
      ],
      "readwrite",
      async ({ store }) => {
        await this.assertOpenPeriod(store, input.period)
        await store(STORE_NAMES.savingsGoals).add(input.goal)
        await store(STORE_NAMES.periodOpenings).add(input.opening)
        for (const auditEvent of input.auditEvents) {
          await store(STORE_NAMES.auditEvents).add(auditEvent)
        }
        if (input.adjustment) {
          await store(STORE_NAMES.operations).add(input.adjustment.operation)
          await store(STORE_NAMES.movements).add(input.adjustment.movement)
        }
      },
    )
  }

  changeSavingsGoal(input: Parameters<PlanningRepository["changeSavingsGoal"]>[0]) {
    return this.database.transaction(
      [
        STORE_NAMES.periods,
        STORE_NAMES.savingsGoals,
        STORE_NAMES.auditEvents,
        STORE_NAMES.operations,
        STORE_NAMES.movements,
      ],
      "readwrite",
      async ({ store }) => {
        await this.assertOpenPeriod(store, input.period)
        assertStoredRevision(
          await store(STORE_NAMES.savingsGoals).get(input.expectedGoal.id),
          input.expectedGoal,
          "SavingsGoal",
        )
        await store(STORE_NAMES.savingsGoals).put(input.goal)
        await store(STORE_NAMES.auditEvents).add(input.auditEvent)
        if (input.adjustment) {
          await store(STORE_NAMES.operations).add(input.adjustment.operation)
          await store(STORE_NAMES.movements).add(input.adjustment.movement)
        }
      },
    )
  }

  createFixedExpense(input: Parameters<PlanningRepository["createFixedExpense"]>[0]) {
    return this.database.transaction(
      [
        STORE_NAMES.periods,
        STORE_NAMES.fixedExpenseTemplates,
        STORE_NAMES.fixedExpenseInstances,
        STORE_NAMES.auditEvents,
      ],
      "readwrite",
      async ({ store }) => {
        await this.assertOpenPeriod(store, input.period)
        await store(STORE_NAMES.fixedExpenseTemplates).add(input.template)
        await store(STORE_NAMES.fixedExpenseInstances).add(input.instance)
        for (const auditEvent of input.auditEvents) {
          await store(STORE_NAMES.auditEvents).add(auditEvent)
        }
      },
    )
  }

  changeFixedExpenseTemplate(
    input: Parameters<PlanningRepository["changeFixedExpenseTemplate"]>[0],
  ) {
    return this.database.transaction(
      [
        STORE_NAMES.periods,
        STORE_NAMES.fixedExpenseTemplates,
        STORE_NAMES.auditEvents,
      ],
      "readwrite",
      async ({ store }) => {
        await this.assertOpenPeriod(store, input.period)
        assertStoredRevision(
          await store(STORE_NAMES.fixedExpenseTemplates).get(
            input.expectedTemplate.id,
          ),
          input.expectedTemplate,
          "FixedExpenseTemplate",
        )
        await store(STORE_NAMES.fixedExpenseTemplates).put(input.template)
        await store(STORE_NAMES.auditEvents).add(input.auditEvent)
      },
    )
  }

  changeFixedExpenseInstance(
    input: Parameters<PlanningRepository["changeFixedExpenseInstance"]>[0],
  ) {
    return this.database.transaction(
      [
        STORE_NAMES.periods,
        STORE_NAMES.fixedExpenseInstances,
        STORE_NAMES.auditEvents,
      ],
      "readwrite",
      async ({ store }) => {
        await this.assertOpenPeriod(store, input.period)
        assertStoredRevision(
          await store(STORE_NAMES.fixedExpenseInstances).get(
            input.expectedInstance.id,
          ),
          input.expectedInstance,
          "FixedExpenseInstance",
        )
        await store(STORE_NAMES.fixedExpenseInstances).put(input.instance)
        await store(STORE_NAMES.auditEvents).add(input.auditEvent)
      },
    )
  }
}

class IndexedDbOperationRepository
  extends PeriodIndexedRepository<"operations">
  implements FinancialOperationRepository
{
  listByType(periodId: EntityId, type: Operation["type"]) {
    return this.listByIndex(INDEX_NAMES.byPeriodType, [periodId, type])
  }

  commit(mutation: FinancialOperationMutation) {
    return this.database.transaction(
      [
        STORE_NAMES.periods,
        STORE_NAMES.accounts,
        STORE_NAMES.categories,
        STORE_NAMES.fixedExpenseInstances,
        STORE_NAMES.operations,
        STORE_NAMES.movements,
        STORE_NAMES.operationRevisions,
      ],
      "readwrite",
      async ({ store }) => {
        const period = await store(STORE_NAMES.periods).get(mutation.period.id)
        assertStoredRevision(period, mutation.period, "Period")
        if (period?.status !== "open") {
          throw new PersistenceError("conflict", "The active Period is closed")
        }
        for (const expected of mutation.expectedAccounts) {
          const account = await store(STORE_NAMES.accounts).get(expected.id)
          assertStoredRevision(account, expected, "Account")
        }
        for (const expected of mutation.expectedCategories ?? []) {
          const category = await store(STORE_NAMES.categories).get(expected.id)
          assertStoredRevision(category, expected, "Category")
        }
        if (mutation.expectedFixedExpenseInstance) {
          const instance = await store(STORE_NAMES.fixedExpenseInstances).get(
            mutation.expectedFixedExpenseInstance.id,
          )
          assertStoredRevision(
            instance,
            mutation.expectedFixedExpenseInstance,
            "FixedExpenseInstance",
          )
        }
        if (mutation.expectedOperation) {
          const operation = await store(STORE_NAMES.operations).get(
            mutation.expectedOperation.id,
          )
          assertStoredRevision(operation, mutation.expectedOperation, "Operation")
          if (operation?.status !== "posted") {
            throw new PersistenceError(
              "conflict",
              "The Operation is no longer posted",
            )
          }
        }
        if (mutation.operation.type === "salary_receipt") {
          const salaries = await store(STORE_NAMES.operations).getAllFromIndex(
            INDEX_NAMES.byPeriodType,
            [mutation.operation.periodId, "salary_receipt"],
          )
          if (
            salaries.some(
              ({ id, status }) =>
                id !== mutation.operation.id && status === "posted",
            )
          ) {
            throw new PersistenceError(
              "conflict",
              "A posted salary receipt already exists in the Period",
            )
          }
        }

        for (const account of mutation.accounts) {
          await store(STORE_NAMES.accounts).put(account)
        }
        if (mutation.fixedExpenseInstance) {
          await store(STORE_NAMES.fixedExpenseInstances).put(
            mutation.fixedExpenseInstance,
          )
        }
        if (mutation.kind === "create") {
          await store(STORE_NAMES.operations).add(mutation.operation)
          await store(STORE_NAMES.movements).add(mutation.movement)
          return
        }
        await store(STORE_NAMES.operations).put(mutation.operation)
        await store(STORE_NAMES.movements).put(mutation.movement)
        if (!mutation.operationRevision) {
          throw new PersistenceError(
            "transaction_failed",
            "A changed financial operation requires an OperationRevision",
          )
        }
        await store(STORE_NAMES.operationRevisions).add(
          mutation.operationRevision,
        )
      },
    )
  }

  commitTransfer(mutation: InternalTransferMutation) {
    return this.database.transaction(
      [
        STORE_NAMES.periods,
        STORE_NAMES.accounts,
        STORE_NAMES.savingsGoals,
        STORE_NAMES.operations,
        STORE_NAMES.movements,
        STORE_NAMES.operationRevisions,
      ],
      "readwrite",
      async ({ store }) => {
        const period = await store(STORE_NAMES.periods).get(mutation.period.id)
        assertStoredRevision(period, mutation.period, "Period")
        if (period?.status !== "open") {
          throw new PersistenceError("conflict", "The active Period is closed")
        }
        for (const expected of mutation.expectedAccounts) {
          assertStoredRevision(
            await store(STORE_NAMES.accounts).get(expected.id),
            expected,
            "Account",
          )
        }
        for (const expected of mutation.expectedSavingsGoals) {
          assertStoredRevision(
            await store(STORE_NAMES.savingsGoals).get(expected.id),
            expected,
            "SavingsGoal",
          )
        }
        if (mutation.expectedOperation) {
          const operation = await store(STORE_NAMES.operations).get(
            mutation.expectedOperation.id,
          )
          assertStoredRevision(operation, mutation.expectedOperation, "Operation")
          if (operation?.status !== "posted") {
            throw new PersistenceError(
              "conflict",
              "The Operation is no longer posted",
            )
          }
        }

        for (const account of mutation.accounts) {
          await store(STORE_NAMES.accounts).put(account)
        }
        for (const goal of mutation.savingsGoals) {
          await store(STORE_NAMES.savingsGoals).put(goal)
        }
        if (mutation.kind === "create") {
          await store(STORE_NAMES.operations).add(mutation.operation)
          for (const movement of mutation.movements) {
            await store(STORE_NAMES.movements).add(movement)
          }
          return
        }
        if (!mutation.operationRevision) {
          throw new PersistenceError(
            "transaction_failed",
            "A changed transfer requires an OperationRevision",
          )
        }
        await store(STORE_NAMES.operations).put(mutation.operation)
        for (const movement of mutation.movements) {
          await store(STORE_NAMES.movements).put(movement)
        }
        await store(STORE_NAMES.operationRevisions).add(
          mutation.operationRevision,
        )
      },
    )
  }

  commitDebt(mutation: DebtOperationMutation) {
    return this.database.transaction(
      [
        STORE_NAMES.periods,
        STORE_NAMES.accounts,
        STORE_NAMES.debts,
        STORE_NAMES.operations,
        STORE_NAMES.movements,
        STORE_NAMES.operationRevisions,
      ],
      "readwrite",
      async ({ store }) => {
        const period = await store(STORE_NAMES.periods).get(mutation.period.id)
        assertStoredRevision(period, mutation.period, "Period")
        if (period?.status !== "open") {
          throw new PersistenceError("conflict", "The active Period is closed")
        }
        for (const expected of mutation.expectedAccounts) {
          assertStoredRevision(
            await store(STORE_NAMES.accounts).get(expected.id),
            expected,
            "Account",
          )
        }
        assertStoredRevision(
          await store(STORE_NAMES.debts).get(mutation.expectedDebt.id),
          mutation.expectedDebt,
          "Debt",
        )
        if (mutation.expectedOperation) {
          const operation = await store(STORE_NAMES.operations).get(
            mutation.expectedOperation.id,
          )
          assertStoredRevision(operation, mutation.expectedOperation, "Operation")
          if (operation?.status !== "posted") {
            throw new PersistenceError("conflict", "The Operation is no longer posted")
          }
        }
        for (const account of mutation.accounts) {
          await store(STORE_NAMES.accounts).put(account)
        }
        await store(STORE_NAMES.debts).put(mutation.debt)
        if (mutation.kind === "create") {
          await store(STORE_NAMES.operations).add(mutation.operation)
          for (const movement of mutation.movements) {
            await store(STORE_NAMES.movements).add(movement)
          }
          return
        }
        if (!mutation.operationRevision) {
          throw new PersistenceError(
            "transaction_failed",
            "A changed Debt operation requires an OperationRevision",
          )
        }
        await store(STORE_NAMES.operations).put(mutation.operation)
        for (const movement of mutation.movements) {
          await store(STORE_NAMES.movements).put(movement)
        }
        await store(STORE_NAMES.operationRevisions).add(mutation.operationRevision)
      },
    )
  }
}

function assertExactState(actual: unknown, expected: unknown, name: string) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new PersistenceError(
      "conflict",
      `${name} changed while the monthly close was being prepared`,
    )
  }
}

class IndexedDbMonthlyCloseRepository implements MonthlyCloseRepository {
  private readonly database: PeritaDatabase

  constructor(database: PeritaDatabase) {
    this.database = database
  }

  commit(mutation: MonthlyCloseMutation) {
    return this.database.transaction(
      [
        STORE_NAMES.financialSettings,
        STORE_NAMES.periods,
        STORE_NAMES.accounts,
        STORE_NAMES.savingsGoals,
        STORE_NAMES.debts,
        STORE_NAMES.categories,
        STORE_NAMES.fixedExpenseTemplates,
        STORE_NAMES.fixedExpenseInstances,
        STORE_NAMES.operations,
        STORE_NAMES.movements,
        STORE_NAMES.periodOpenings,
        STORE_NAMES.auditEvents,
        STORE_NAMES.periodSnapshots,
      ],
      "readwrite",
      async ({ store }) => {
        assertExactState(
          await store(STORE_NAMES.financialSettings).get("current"),
          mutation.expected.financialSettings,
          "FinancialSettings",
        )
        const collections = [
          [STORE_NAMES.periods, mutation.expected.periods],
          [STORE_NAMES.accounts, mutation.expected.accounts],
          [STORE_NAMES.savingsGoals, mutation.expected.savingsGoals],
          [STORE_NAMES.debts, mutation.expected.debts],
          [STORE_NAMES.categories, mutation.expected.categories],
          [STORE_NAMES.fixedExpenseTemplates, mutation.expected.fixedExpenseTemplates],
          [STORE_NAMES.fixedExpenseInstances, mutation.expected.fixedExpenseInstances],
          [STORE_NAMES.operations, mutation.expected.operations],
          [STORE_NAMES.movements, mutation.expected.movements],
          [STORE_NAMES.periodOpenings, mutation.expected.periodOpenings],
          [STORE_NAMES.auditEvents, mutation.expected.auditEvents],
          [STORE_NAMES.periodSnapshots, mutation.expected.periodSnapshots],
        ] as const
        for (const [name, expected] of collections) {
          assertExactState(await store(name).getAll(), expected, name)
        }

        await store(STORE_NAMES.periods).put(mutation.closedPeriod)
        await store(STORE_NAMES.periodSnapshots).add(mutation.periodSnapshot)
        for (const instance of mutation.finalizedFixedExpenseInstances) {
          await store(STORE_NAMES.fixedExpenseInstances).put(instance)
        }
        await store(STORE_NAMES.periods).add(mutation.nextPeriod)
        for (const opening of mutation.nextPeriodOpenings) {
          await store(STORE_NAMES.periodOpenings).add(opening)
        }
        for (const instance of mutation.nextFixedExpenseInstances) {
          await store(STORE_NAMES.fixedExpenseInstances).add(instance)
        }
        for (const auditEvent of mutation.auditEvents) {
          await store(STORE_NAMES.auditEvents).add(auditEvent)
        }
      },
    )
  }
}

class MovementRepository extends PeriodIndexedRepository<"movements"> {
  listByOperation(operationId: EntityId) {
    return this.listByIndex(INDEX_NAMES.byOperation, operationId)
  }

  listByTarget(targetType: Movement["targetType"], targetId: EntityId) {
    return this.listByIndex(INDEX_NAMES.byTarget, [targetType, targetId])
  }
}

class OperationRevisionRepository extends IndexedDbRepository<"operationRevisions"> {
  listByOperation(operationId: EntityId) {
    return this.listByIndex(INDEX_NAMES.byOperation, operationId)
  }

  async getRevision(operationId: EntityId, revision: Revision) {
    const [record] = await this.listByIndex(
      INDEX_NAMES.byOperationRevision,
      [operationId, revision],
    )
    return record
  }
}

class AuditEventRepository extends PeriodIndexedRepository<"auditEvents"> {
  listBySubject(subjectType: AuditEvent["subjectType"], subjectId: IDBValidKey) {
    return this.listByIndex(INDEX_NAMES.bySubject, [subjectType, subjectId])
  }
}

class PeriodSnapshotRepository extends PeriodIndexedRepository<"periodSnapshots"> {
  async getByPeriod(periodId: EntityId) {
    const [snapshot] = await this.listByPeriod(periodId)
    return snapshot
  }

  async getByPeriodKey(periodKey: PeriodKey) {
    const [snapshot] = await this.listByIndex(
      INDEX_NAMES.byPeriodKey,
      periodKey,
    )
    return snapshot
  }
}

export interface PeritaRepositories {
  readonly administration: DataAdministrationRepository
  readonly setup: SetupRepository
  readonly planning: PlanningRepository
  readonly monthlyClose: MonthlyCloseRepository
  readonly financialSettings: Repository<FinancialSettings, "current">
  readonly periods: PeriodRepository
  readonly periodOpenings: Repository<PeriodOpening, EntityId> & {
    listByPeriod(periodId: EntityId): Promise<PeriodOpening[]>
  }
  readonly accounts: AccountRepository
  readonly savingsGoals: Repository<SavingsGoal, EntityId>
  readonly debts: Repository<Debt, EntityId>
  readonly categories: CategoryRepository
  readonly fixedExpenseTemplates: Repository<FixedExpenseTemplate, EntityId>
  readonly fixedExpenseInstances: Repository<FixedExpenseInstance, EntityId> & {
    listByPeriod(periodId: EntityId): Promise<FixedExpenseInstance[]>
  }
  readonly operations: FinancialOperationRepository
  readonly movements: Repository<Movement, EntityId> & {
    listByPeriod(periodId: EntityId): Promise<Movement[]>
    listByOperation(operationId: EntityId): Promise<Movement[]>
    listByTarget(
      targetType: Movement["targetType"],
      targetId: EntityId,
    ): Promise<Movement[]>
  }
  readonly operationRevisions: Repository<OperationRevision, EntityId> & {
    listByOperation(operationId: EntityId): Promise<OperationRevision[]>
    getRevision(
      operationId: EntityId,
      revision: Revision,
    ): Promise<OperationRevision | undefined>
  }
  readonly auditEvents: Repository<AuditEvent, EntityId> & {
    listByPeriod(periodId: EntityId): Promise<AuditEvent[]>
    listBySubject(
      subjectType: AuditEvent["subjectType"],
      subjectId: EntityId | "current",
    ): Promise<AuditEvent[]>
  }
  readonly periodSnapshots: Repository<PeriodSnapshot, EntityId> & {
    getByPeriod(periodId: EntityId): Promise<PeriodSnapshot | undefined>
    getByPeriodKey(periodKey: PeriodKey): Promise<PeriodSnapshot | undefined>
  }
}

export interface DataAdministrationRepository {
  readSnapshot(): Promise<PeritaDataSnapshot>
  replaceSnapshot(
    snapshot: PeritaDataSnapshot,
    expectedCurrent: PeritaDataSnapshot,
  ): Promise<void>
  clearAll(): Promise<void>
  saveFinancialSettings(
    expected: FinancialSettings | undefined,
    next: FinancialSettings,
    auditEvent: AuditEvent,
  ): Promise<void>
}

const ALL_STORE_NAMES = Object.values(STORE_NAMES)

class IndexedDbSetupRepository implements SetupRepository {
  private readonly database: PeritaDatabase

  constructor(database: PeritaDatabase) {
    this.database = database
  }

  complete(input: Parameters<SetupRepository["complete"]>[0]) {
    return this.database.transaction(
      ALL_STORE_NAMES,
      "readwrite",
      async ({ store }) => {
        for (const name of ALL_STORE_NAMES) {
          if ((await store(name).count()) !== 0) {
            throw new PersistenceError(
              "conflict",
              "Initial setup can only be completed on an empty installation",
            )
          }
        }
        await store(STORE_NAMES.financialSettings).add(input.financialSettings)
        await store(STORE_NAMES.periods).add(input.period)
        for (const account of input.accounts) {
          await store(STORE_NAMES.accounts).add(account)
        }
        for (const opening of input.periodOpenings) {
          await store(STORE_NAMES.periodOpenings).add(opening)
        }
        for (const auditEvent of input.auditEvents) {
          await store(STORE_NAMES.auditEvents).add(auditEvent)
        }
      },
    )
  }
}

class IndexedDbDataAdministrationRepository
  implements DataAdministrationRepository
{
  private readonly database: PeritaDatabase

  constructor(database: PeritaDatabase) {
    this.database = database
  }

  async readSnapshot(): Promise<PeritaDataSnapshot> {
    return this.database.transaction(ALL_STORE_NAMES, "readonly", async ({ store }) => ({
      financialSettings: await store(STORE_NAMES.financialSettings).getAll(),
      periods: await store(STORE_NAMES.periods).getAll(),
      periodOpenings: await store(STORE_NAMES.periodOpenings).getAll(),
      accounts: await store(STORE_NAMES.accounts).getAll(),
      savingsGoals: await store(STORE_NAMES.savingsGoals).getAll(),
      debts: await store(STORE_NAMES.debts).getAll(),
      categories: await store(STORE_NAMES.categories).getAll(),
      fixedExpenseTemplates: await store(STORE_NAMES.fixedExpenseTemplates).getAll(),
      fixedExpenseInstances: await store(STORE_NAMES.fixedExpenseInstances).getAll(),
      operations: await store(STORE_NAMES.operations).getAll(),
      movements: await store(STORE_NAMES.movements).getAll(),
      operationRevisions: await store(STORE_NAMES.operationRevisions).getAll(),
      auditEvents: await store(STORE_NAMES.auditEvents).getAll(),
      periodSnapshots: await store(STORE_NAMES.periodSnapshots).getAll(),
    }))
  }

  replaceSnapshot(snapshot: PeritaDataSnapshot, expectedCurrent: PeritaDataSnapshot) {
    return this.database.transaction(ALL_STORE_NAMES, "readwrite", async ({ store }) => {
      const current = Object.fromEntries(
        await Promise.all(
          ALL_STORE_NAMES.map(async (name) => [name, await store(name).getAll()] as const),
        ),
      )
      if (canonicalJson(current) !== canonicalJson(expectedCurrent)) {
        throw new PersistenceError("conflict", "Data changed after the preventive backup")
      }
      for (const name of ALL_STORE_NAMES) await store(name).clear()
      for (const [name, records] of Object.entries(snapshot) as [StoreName, readonly StoreValue<StoreName>[]][]) {
        for (const record of records) await store(name).add(record)
      }
    })
  }

  clearAll() {
    return this.database.transaction(ALL_STORE_NAMES, "readwrite", async ({ store }) => {
      for (const name of ALL_STORE_NAMES) await store(name).clear()
    })
  }

  saveFinancialSettings(
    expected: FinancialSettings | undefined,
    next: FinancialSettings,
    auditEvent: AuditEvent,
  ) {
    return this.database.transaction(
      [STORE_NAMES.financialSettings, STORE_NAMES.auditEvents],
      "readwrite",
      async ({ store }) => {
        const stored = await store(STORE_NAMES.financialSettings).get("current")
        if (canonicalJson(stored) !== canonicalJson(expected)) {
          throw new PersistenceError("conflict", "Financial settings changed before saving")
        }
        await store(STORE_NAMES.financialSettings).put(next)
        await store(STORE_NAMES.auditEvents).add(auditEvent)
      },
    )
  }
}

export function createRepositories(database: PeritaDatabase): PeritaRepositories {
  return {
    administration: new IndexedDbDataAdministrationRepository(database),
    setup: new IndexedDbSetupRepository(database),
    planning: new IndexedDbPlanningRepository(database),
    monthlyClose: new IndexedDbMonthlyCloseRepository(database),
    financialSettings: new IndexedDbRepository(
      database,
      STORE_NAMES.financialSettings,
    ),
    periods: new IndexedDbPeriodRepository(database, STORE_NAMES.periods),
    periodOpenings: new PeriodIndexedRepository(
      database,
      STORE_NAMES.periodOpenings,
    ),
    accounts: new IndexedDbAccountRepository(database, STORE_NAMES.accounts),
    savingsGoals: new IndexedDbRepository(database, STORE_NAMES.savingsGoals),
    debts: new IndexedDbRepository(database, STORE_NAMES.debts),
    categories: new IndexedDbCategoryRepository(database, STORE_NAMES.categories),
    fixedExpenseTemplates: new IndexedDbRepository(
      database,
      STORE_NAMES.fixedExpenseTemplates,
    ),
    fixedExpenseInstances: new PeriodIndexedRepository(
      database,
      STORE_NAMES.fixedExpenseInstances,
    ),
    operations: new IndexedDbOperationRepository(database, STORE_NAMES.operations),
    movements: new MovementRepository(database, STORE_NAMES.movements),
    operationRevisions: new OperationRevisionRepository(
      database,
      STORE_NAMES.operationRevisions,
    ),
    auditEvents: new AuditEventRepository(database, STORE_NAMES.auditEvents),
    periodSnapshots: new PeriodSnapshotRepository(
      database,
      STORE_NAMES.periodSnapshots,
    ),
  }
}

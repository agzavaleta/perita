import type { AuditEvent } from "@/domain/audit"
import type { Category } from "@/domain/entities"
import { assertAuditEventInvariant } from "@/domain/invariants"
import {
  asEntityId,
  asRevision,
  asUtcTimestamp,
  type EntityId,
  type Revision,
  type UtcTimestamp,
} from "@/domain/primitives"
import { PersistenceError } from "@/data/errors"
import type { PeritaRepositories } from "@/data/repositories"

export const DEFAULT_CATEGORY_NAMES = [
  "Alimentación",
  "Transporte",
  "Hogar",
  "Salud",
  "Ocio",
  "Otros",
] as const

export type CategoryUseCaseErrorCode =
  | "category_not_found"
  | "invalid_category_name"
  | "duplicate_category_name"
  | "invalid_category_state"
  | "no_changes"
  | "revision_conflict"

export class CategoryUseCaseError extends Error {
  readonly code: CategoryUseCaseErrorCode

  constructor(code: CategoryUseCaseErrorCode, message: string) {
    super(message)
    this.name = "CategoryUseCaseError"
    this.code = code
  }
}

export interface CategoryUseCasesPort {
  ensureDefaultCategories(): Promise<Category[]>
  listCategories(): Promise<Category[]>
  listActiveCategories(): Promise<Category[]>
  createCategory(name: string): Promise<Category>
  renameCategory(
    id: EntityId,
    expectedRevision: Revision,
    name: string,
  ): Promise<Category>
  deactivateCategory(
    id: EntityId,
    expectedRevision: Revision,
  ): Promise<Category>
}

interface CategoryUseCasesOptions {
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
    throw new CategoryUseCaseError(
      "invalid_category_name",
      "El nombre de la categoría es obligatorio.",
    )
  }
  return name
}

function comparableName(value: string) {
  return value.trim().toLocaleLowerCase("es-CL")
}

const defaultOrder = new Map(
  DEFAULT_CATEGORY_NAMES.map((name, index) => [comparableName(name), index]),
)

function sortCategories(categories: readonly Category[]) {
  return categories.toSorted((left, right) => {
    if (left.status !== right.status) return left.status === "active" ? -1 : 1
    const leftOrder = defaultOrder.get(comparableName(left.name))
    const rightOrder = defaultOrder.get(comparableName(right.name))
    if (leftOrder !== undefined || rightOrder !== undefined) {
      if (leftOrder === undefined) return 1
      if (rightOrder === undefined) return -1
      return leftOrder - rightOrder
    }
    return left.name.localeCompare(right.name, "es")
  })
}

export class CategoryUseCases implements CategoryUseCasesPort {
  private readonly repositories: PeritaRepositories
  private readonly now: () => UtcTimestamp
  private readonly createId: () => EntityId

  constructor(
    repositories: PeritaRepositories,
    options: CategoryUseCasesOptions = {},
  ) {
    this.repositories = repositories
    this.now = options.now ?? defaultNow
    this.createId = options.createId ?? defaultCreateId
  }

  async ensureDefaultCategories() {
    const existing = await this.repositories.categories.getAll()
    if (existing.length !== 0) return sortCategories(existing)

    const occurredAt = this.now()
    const categories = DEFAULT_CATEGORY_NAMES.map((name): Category => ({
      id: this.createId(),
      name,
      status: "active",
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }))
    const auditEvents = categories.map((category) =>
      this.createdAudit(category, occurredAt, "category.bootstrap"),
    )
    await this.repositories.categories.ensureDefaults(categories, auditEvents)
    return this.listCategories()
  }

  async listCategories() {
    return sortCategories(await this.repositories.categories.getAll())
  }

  async listActiveCategories() {
    return (await this.listCategories()).filter(({ status }) => status === "active")
  }

  async createCategory(value: string) {
    const name = requiredName(value)
    const expectedCategories = await this.repositories.categories.getAll()
    this.assertUniqueName(expectedCategories, name)
    const occurredAt = this.now()
    const category: Category = {
      id: this.createId(),
      name,
      status: "active",
      revision: asRevision(1),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    await this.persist(() =>
      this.repositories.categories.addWithAudit(
        expectedCategories,
        category,
        this.createdAudit(category, occurredAt, "category.create"),
      ),
    )
    return category
  }

  async renameCategory(
    id: EntityId,
    expectedRevision: Revision,
    value: string,
  ) {
    const name = requiredName(value)
    const categories = await this.repositories.categories.getAll()
    const previous = this.requireCategory(categories, id)
    this.assertRevision(previous, expectedRevision)
    this.assertUniqueName(categories, name, id)
    if (previous.name === name) {
      throw new CategoryUseCaseError("no_changes", "No hay cambios para guardar.")
    }
    const occurredAt = this.now()
    const category: Category = {
      ...previous,
      name,
      revision: asRevision(Number(previous.revision) + 1),
      updatedAt: occurredAt,
    }
    await this.persist(() =>
      this.repositories.categories.putWithAudit(
        categories,
        category,
        this.changedAudit("updated", previous, category, occurredAt, "category.rename"),
      ),
    )
    return category
  }

  async deactivateCategory(id: EntityId, expectedRevision: Revision) {
    const categories = await this.repositories.categories.getAll()
    const previous = this.requireCategory(categories, id)
    this.assertRevision(previous, expectedRevision)
    if (previous.status !== "active") {
      throw new CategoryUseCaseError(
        "invalid_category_state",
        "La categoría ya está inactiva.",
      )
    }
    const occurredAt = this.now()
    const category: Category = {
      ...previous,
      status: "inactive",
      revision: asRevision(Number(previous.revision) + 1),
      updatedAt: occurredAt,
    }
    await this.persist(() =>
      this.repositories.categories.putWithAudit(
        categories,
        category,
        this.changedAudit(
          "deactivated",
          previous,
          category,
          occurredAt,
          "category.deactivate",
        ),
      ),
    )
    return category
  }

  private requireCategory(categories: readonly Category[], id: EntityId) {
    const category = categories.find((candidate) => candidate.id === id)
    if (!category) {
      throw new CategoryUseCaseError(
        "category_not_found",
        "La categoría solicitada no existe.",
      )
    }
    return category
  }

  private assertRevision(category: Category, expectedRevision: Revision) {
    if (category.revision !== expectedRevision) {
      throw new CategoryUseCaseError(
        "revision_conflict",
        "La categoría cambió desde que fue abierta. Vuelve a intentarlo.",
      )
    }
  }

  private assertUniqueName(
    categories: readonly Category[],
    name: string,
    excludedId?: EntityId,
  ) {
    const normalized = comparableName(name)
    if (
      categories.some(
        (category) =>
          category.id !== excludedId && comparableName(category.name) === normalized,
      )
    ) {
      throw new CategoryUseCaseError(
        "duplicate_category_name",
        "Ya existe una categoría con ese nombre.",
      )
    }
  }

  private createdAudit(
    category: Category,
    occurredAt: UtcTimestamp,
    commandType: string,
  ): AuditEvent {
    return assertAuditEventInvariant({
      id: this.createId(),
      periodId: null,
      subjectType: "category",
      subjectId: category.id,
      action: "created",
      commandType,
      previousRevision: null,
      nextRevision: category.revision,
      previousValue: null,
      nextValue: category,
      reason: null,
      occurredAt,
    })
  }

  private changedAudit(
    action: "updated" | "deactivated",
    previous: Category,
    category: Category,
    occurredAt: UtcTimestamp,
    commandType: string,
  ): AuditEvent {
    return assertAuditEventInvariant({
      id: this.createId(),
      periodId: null,
      subjectType: "category",
      subjectId: category.id,
      action,
      commandType,
      previousRevision: previous.revision,
      nextRevision: category.revision,
      previousValue: previous,
      nextValue: category,
      reason: null,
      occurredAt,
    })
  }

  private async persist(action: () => Promise<void>) {
    try {
      await action()
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "conflict") {
        throw new CategoryUseCaseError(
          "revision_conflict",
          "Las categorías cambiaron antes de guardar. Vuelve a intentarlo.",
        )
      }
      throw error
    }
  }
}

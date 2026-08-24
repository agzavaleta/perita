import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Category } from "@/domain/entities"
import {
  asEntityId,
  asRevision,
  asUtcTimestamp,
  type EntityId,
} from "@/domain/primitives"
import { openPeritaDatabase, type PeritaDatabase } from "@/data/database"
import { createRepositories, type PeritaRepositories } from "@/data/repositories"
import {
  CategoryUseCases,
  DEFAULT_CATEGORY_NAMES,
} from "@/features/settings/application/category-use-cases"

const NOW = asUtcTimestamp("2026-08-24T12:00:00.000Z")

function idSequence() {
  let value = 1
  return () =>
    asEntityId(
      `c4000000-0000-4000-8000-${String(value++).padStart(12, "0")}`,
    )
}

function existingCategory(
  id: EntityId,
  status: Category["status"] = "active",
): Category {
  return {
    id,
    name: "Personalizada",
    status,
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

describe("CategoryUseCases", () => {
  let database: PeritaDatabase
  let repositories: PeritaRepositories
  let useCases: CategoryUseCases

  beforeEach(async () => {
    database = await openPeritaDatabase({
      name: `categories-${crypto.randomUUID()}`,
      indexedDB: new IDBFactory(),
    })
    repositories = createRepositories(database)
    useCases = new CategoryUseCases(repositories, {
      now: () => NOW,
      createId: idSequence(),
    })
  })

  afterEach(() => database.close())

  it("bootstraps exactly the six defaults in canonical order", async () => {
    const categories = await useCases.ensureDefaultCategories()

    expect(categories.map(({ name }) => name)).toEqual(DEFAULT_CATEGORY_NAMES)
    expect(categories.every(({ status, revision }) => status === "active" && revision === 1)).toBe(true)
    expect(await repositories.categories.count()).toBe(6)
    expect(await repositories.auditEvents.count()).toBe(6)
  })

  it("is idempotent and does not duplicate defaults", async () => {
    await useCases.ensureDefaultCategories()
    await useCases.ensureDefaultCategories()

    expect(await repositories.categories.count()).toBe(6)
    expect(await repositories.auditEvents.count()).toBe(6)
  })

  it.each(["active", "inactive"] as const)(
    "does not seed when an %s category already exists",
    async (status) => {
      const category = existingCategory(
        asEntityId("c4000000-0000-4000-8000-000000000099"),
        status,
      )
      await repositories.categories.add(category)

      expect(await useCases.ensureDefaultCategories()).toEqual([category])
      expect(await repositories.categories.getAll()).toEqual([category])
      expect(await repositories.auditEvents.count()).toBe(0)
    },
  )

  it("creates a trimmed category and rejects empty or duplicate names", async () => {
    const created = await useCases.createCategory("  Viajes  ")

    expect(created).toMatchObject({ name: "Viajes", status: "active", revision: 1 })
    await expect(useCases.createCategory("   ")).rejects.toMatchObject({
      code: "invalid_category_name",
    })
    await expect(useCases.createCategory(" viajes ")).rejects.toMatchObject({
      code: "duplicate_category_name",
    })
  })

  it("renames without replacing identity and rejects a duplicate name", async () => {
    const first = await useCases.createCategory("Mascotas")
    await useCases.createCategory("Viajes")

    const renamed = await useCases.renameCategory(
      first.id,
      first.revision,
      "  Animales  ",
    )
    expect(renamed).toMatchObject({
      id: first.id,
      name: "Animales",
      revision: 2,
      createdAt: first.createdAt,
    })
    await expect(
      useCases.renameCategory(renamed.id, renamed.revision, " VIAJES "),
    ).rejects.toMatchObject({ code: "duplicate_category_name" })
  })

  it("deactivates without deleting and excludes the category from active results", async () => {
    const created = await useCases.createCategory("Educación")
    const inactive = await useCases.deactivateCategory(
      created.id,
      created.revision,
    )

    expect(inactive).toMatchObject({ status: "inactive", revision: 2 })
    expect(await repositories.categories.get(created.id)).toEqual(inactive)
    expect(await useCases.listActiveCategories()).toEqual([])
    expect(await useCases.listCategories()).toEqual([inactive])
  })

  it("audits create, rename, and deactivate while preserving prior snapshots", async () => {
    const created = await useCases.createCategory("Educación")
    const renamed = await useCases.renameCategory(
      created.id,
      created.revision,
      "Estudios",
    )
    await useCases.deactivateCategory(renamed.id, renamed.revision)

    const events = await repositories.auditEvents.listBySubject(
      "category",
      created.id,
    )
    expect(events.map(({ action }) => action)).toEqual([
      "created",
      "updated",
      "deactivated",
    ])
    expect(events[1]).toMatchObject({
      previousValue: created,
      nextValue: renamed,
    })
  })

  it("respects expected revision conflicts", async () => {
    const created = await useCases.createCategory("Educación")

    await expect(
      useCases.renameCategory(created.id, asRevision(2), "Estudios"),
    ).rejects.toMatchObject({ code: "revision_conflict" })
    await expect(
      useCases.deactivateCategory(created.id, asRevision(2)),
    ).rejects.toMatchObject({ code: "revision_conflict" })
    expect(await repositories.auditEvents.count()).toBe(1)
  })
})

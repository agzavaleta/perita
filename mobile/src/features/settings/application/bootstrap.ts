import { openPeritaDatabase } from "@/data/database"
import { createRepositories } from "@/data/repositories"
import {
  CategoryUseCases,
  type CategoryUseCasesPort,
} from "@/features/settings/application/category-use-cases"
import { SettingsUseCases, type SettingsUseCasesPort } from "@/features/settings/application/settings-use-cases"

export interface SettingsModule {
  readonly useCases: SettingsUseCasesPort
  readonly categoryUseCases: CategoryUseCasesPort
  dispose(): void
}

export async function createSettingsModule(): Promise<SettingsModule> {
  const database = await openPeritaDatabase()
  const repositories = createRepositories(database)
  const categoryUseCases = new CategoryUseCases(repositories)
  await categoryUseCases.ensureDefaultCategories()
  return {
    useCases: new SettingsUseCases(repositories),
    categoryUseCases,
    dispose: () => database.close(),
  }
}

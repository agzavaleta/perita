import { openPeritaDatabase } from "@/data/database"
import { createRepositories } from "@/data/repositories"
import {
  HomeUseCases,
  type HomeUseCasesPort,
} from "@/features/home/application/home-use-cases"
import { CategoryUseCases } from "@/features/settings/application/category-use-cases"

export interface HomeModule {
  readonly useCases: HomeUseCasesPort
  dispose(): void
}

export async function createHomeModule(): Promise<HomeModule> {
  const database = await openPeritaDatabase()
  const repositories = createRepositories(database)
  await new CategoryUseCases(repositories).ensureDefaultCategories()
  return {
    useCases: new HomeUseCases(repositories),
    dispose: () => database.close(),
  }
}

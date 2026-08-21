import { openPeritaDatabase } from "@/data/database"
import { createRepositories } from "@/data/repositories"
import {
  HomeUseCases,
  type HomeUseCasesPort,
} from "@/features/home/application/home-use-cases"

export interface HomeModule {
  readonly useCases: HomeUseCasesPort
  dispose(): void
}

export async function createHomeModule(): Promise<HomeModule> {
  const database = await openPeritaDatabase()
  return {
    useCases: new HomeUseCases(createRepositories(database)),
    dispose: () => database.close(),
  }
}

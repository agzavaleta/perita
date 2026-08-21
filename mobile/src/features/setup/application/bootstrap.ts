import { openPeritaDatabase } from "@/data/database"
import { createRepositories } from "@/data/repositories"
import {
  SetupUseCases,
  type SetupUseCasesPort,
} from "@/features/setup/application/setup-use-cases"

export interface SetupModule {
  readonly useCases: SetupUseCasesPort
  dispose(): void
}

export async function createSetupModule(): Promise<SetupModule> {
  const database = await openPeritaDatabase()
  return {
    useCases: new SetupUseCases(createRepositories(database)),
    dispose: () => database.close(),
  }
}

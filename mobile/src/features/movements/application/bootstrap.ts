import { openPeritaDatabase } from "@/data/database"
import { createRepositories } from "@/data/repositories"
import {
  MovementUseCases,
  type MovementUseCasesPort,
} from "@/features/movements/application/movement-use-cases"

export interface MovementModule {
  readonly useCases: MovementUseCasesPort
  dispose(): void
}

export async function createMovementModule(): Promise<MovementModule> {
  const database = await openPeritaDatabase()
  return {
    useCases: new MovementUseCases(createRepositories(database)),
    dispose: () => database.close(),
  }
}

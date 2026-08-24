import { openPeritaDatabase } from "@/data/database"
import { createRepositories } from "@/data/repositories"
import {
  SetupUseCases,
  type SetupUseCasesPort,
} from "@/features/setup/application/setup-use-cases"
import { openSetupDraftStore } from "@/features/setup/data/setup-draft-store"

export interface SetupModule {
  readonly useCases: SetupUseCasesPort
  dispose(): void
}

export async function createSetupModule(): Promise<SetupModule> {
  const [database, draftStore] = await Promise.all([
    openPeritaDatabase(),
    openSetupDraftStore(),
  ])
  return {
    useCases: new SetupUseCases(createRepositories(database), { draftStore }),
    dispose: () => {
      database.close()
      draftStore.close()
    },
  }
}

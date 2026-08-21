import { openPeritaDatabase } from "@/data/database"
import { createRepositories } from "@/data/repositories"
import { SettingsUseCases, type SettingsUseCasesPort } from "@/features/settings/application/settings-use-cases"

export interface SettingsModule {
  readonly useCases: SettingsUseCasesPort
  dispose(): void
}

export async function createSettingsModule(): Promise<SettingsModule> {
  const database = await openPeritaDatabase()
  return {
    useCases: new SettingsUseCases(createRepositories(database)),
    dispose: () => database.close(),
  }
}

import { openPeritaDatabase } from "@/data/database"
import { createRepositories } from "@/data/repositories"
import {
  AccountUseCases,
  type AccountUseCasesPort,
} from "@/features/accounts/application/account-use-cases"
import {
  BalanceAdjustmentUseCases,
  type BalanceAdjustmentUseCasesPort,
} from "@/features/accounts/application/balance-adjustment-use-cases"

export interface AccountModule {
  readonly useCases: AccountUseCasesPort
  readonly balanceAdjustmentUseCases: BalanceAdjustmentUseCasesPort
  dispose(): void
}

export async function createAccountModule(): Promise<AccountModule> {
  const database = await openPeritaDatabase()
  const repositories = createRepositories(database)
  return {
    useCases: new AccountUseCases(repositories),
    balanceAdjustmentUseCases: new BalanceAdjustmentUseCases(repositories),
    dispose: () => database.close(),
  }
}

import { openPeritaDatabase } from "@/data/database"
import { createRepositories } from "@/data/repositories"
import {
  MovementUseCases,
  type MovementUseCasesPort,
} from "@/features/movements/application/movement-use-cases"
import {
  DebtUseCases,
  type DebtUseCasesPort,
} from "@/features/planning/application/debt-use-cases"
import {
  MonthlyCloseUseCases,
  type MonthlyCloseUseCasesPort,
} from "@/features/planning/application/monthly-close-use-cases"
import {
  PlanningUseCases,
  type PlanningUseCasesPort,
} from "@/features/planning/application/planning-use-cases"

export interface PlanningModule {
  readonly useCases: PlanningUseCasesPort
  readonly movementUseCases: MovementUseCasesPort
  readonly debtUseCases: DebtUseCasesPort
  readonly monthlyCloseUseCases: MonthlyCloseUseCasesPort
  dispose(): void
}

export async function createPlanningModule(): Promise<PlanningModule> {
  const database = await openPeritaDatabase()
  const repositories = createRepositories(database)
  return {
    useCases: new PlanningUseCases(repositories),
    movementUseCases: new MovementUseCases(repositories),
    debtUseCases: new DebtUseCases(repositories),
    monthlyCloseUseCases: new MonthlyCloseUseCases(repositories),
    dispose: () => database.close(),
  }
}

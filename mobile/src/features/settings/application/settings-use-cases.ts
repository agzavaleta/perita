import type { AuditEvent } from "@/domain/audit"
import { CHILE_TIME_ZONE, CURRENCY } from "@/domain/constants"
import type { FinancialSettings } from "@/domain/entities"
import {
  asClpAmount,
  asEntityId,
  asRevision,
  asUtcTimestamp,
  type UtcTimestamp,
} from "@/domain/primitives"
import type { PeritaRepositories } from "@/data/repositories"
import { BackupService, type BackupValidation, type PeritaBackup } from "@/features/settings/application/backup"

export interface SettingsUseCasesPort {
  getSettings(): Promise<FinancialSettings | null>
  updateReferenceSalary(amount: number): Promise<FinancialSettings>
  exportBackup(): Promise<PeritaBackup>
  validateBackup(input: unknown): Promise<BackupValidation>
  restoreBackup(input: unknown): Promise<{ restored: true; preventiveBackup: PeritaBackup }>
  deleteAllData(backup: unknown, confirmation: string): Promise<{ deleted: true }>
}

export class SettingsUseCases implements SettingsUseCasesPort {
  private readonly backup: BackupService
  private readonly repositories: PeritaRepositories

  constructor(
    repositories: PeritaRepositories,
    options: {
      readonly now?: () => UtcTimestamp
      readonly createId?: () => ReturnType<typeof asEntityId>
    } = {},
  ) {
    this.repositories = repositories
    this.now = options.now ?? (() => asUtcTimestamp(new Date().toISOString()))
    this.createId = options.createId ?? (() => asEntityId(globalThis.crypto.randomUUID()))
    this.backup = new BackupService(repositories.administration, this.now)
  }

  private readonly now: () => UtcTimestamp
  private readonly createId: () => ReturnType<typeof asEntityId>

  async getSettings() {
    return (await this.repositories.financialSettings.get("current")) ?? null
  }

  async updateReferenceSalary(amount: number) {
    const salaryReferenceAmount = asClpAmount(amount)
    const previous = await this.getSettings()
    if (previous?.salaryReferenceAmount === salaryReferenceAmount) {
      throw new Error("No hay cambios para guardar.")
    }
    const occurredAt = this.now()
    const next: FinancialSettings = previous
      ? {
          ...previous,
          salaryReferenceAmount,
          revision: asRevision(previous.revision + 1),
          updatedAt: occurredAt,
        }
      : {
          key: "current",
          salaryReferenceAmount,
          currency: CURRENCY,
          timezone: CHILE_TIME_ZONE,
          revision: asRevision(1),
          createdAt: occurredAt,
          updatedAt: occurredAt,
        }
    const auditEvent: AuditEvent = previous
      ? {
          id: this.createId(),
          periodId: null,
          commandType: "financial-settings.update-reference-salary",
          reason: null,
          occurredAt,
          subjectType: "financial_settings",
          subjectId: "current",
          action: "updated",
          previousRevision: previous.revision,
          nextRevision: next.revision,
          previousValue: previous,
          nextValue: next,
        }
      : {
          id: this.createId(),
          periodId: null,
          commandType: "financial-settings.create",
          reason: null,
          occurredAt,
          subjectType: "financial_settings",
          subjectId: "current",
          action: "created",
          previousRevision: null,
          nextRevision: next.revision,
          previousValue: null,
          nextValue: next,
        }
    await this.repositories.administration.saveFinancialSettings(previous ?? undefined, next, auditEvent)
    return next
  }

  exportBackup() { return this.backup.exportBackup() }
  validateBackup(input: unknown) { return this.backup.validateBackup(input) }
  restoreBackup(input: unknown) { return this.backup.restoreBackup(input) }
  deleteAllData(backup: unknown, confirmation: string) {
    return this.backup.deleteAllData(backup, confirmation)
  }
}

import { IDBFactory } from "fake-indexeddb"
import { describe, expect, it } from "vitest"

import {
  asClpAmount,
  asRevision,
  asUtcTimestamp,
  type FinancialSettings,
  type PeritaDataSnapshot,
} from "@/domain"
import { createRepositories, openPeritaDatabase } from "@/data"
import { BackupService } from "@/features/settings/application/backup"
import { SettingsUseCases } from "@/features/settings/application/settings-use-cases"
import { canonicalJson, sha256 } from "@/lib/integrity"

const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")

function settings(amount: number): FinancialSettings {
  return {
    key: "current",
    salaryReferenceAmount: asClpAmount(amount),
    currency: "CLP",
    timezone: "America/Santiago",
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function emptySnapshot(): PeritaDataSnapshot {
  return {
    financialSettings: [], periods: [], periodOpenings: [], accounts: [],
    savingsGoals: [], debts: [], categories: [], fixedExpenseTemplates: [],
    fixedExpenseInstances: [], operations: [], movements: [],
    operationRevisions: [], auditEvents: [], periodSnapshots: [],
  }
}

async function fixture(name: string) {
  const database = await openPeritaDatabase({ name, indexedDB: new IDBFactory() })
  const repositories = createRepositories(database)
  const backup = new BackupService(repositories.administration, () => NOW)
  return { database, repositories, backup }
}

describe("Configuración y respaldos", () => {
  it("exports the V1.1.0 envelope with a verifiable SHA-256 signature", async () => {
    const f = await fixture("settings-backup-export")
    await f.repositories.financialSettings.add(settings(900_000))

    const backup = await f.backup.exportBackup()

    expect(backup.documentType).toBe("perita-backup")
    expect(backup.backupFormatVersion).toBe("1.0.0")
    expect(backup.schemaVersion).toBe("1.1.0")
    expect(backup.integrity.payloadHash).toMatch(/^[a-f0-9]{64}$/)
    expect(await f.backup.validateBackup(JSON.stringify(backup))).toMatchObject({ status: "valid" })
    f.database.close()
  })

  it("rejects an altered backup before writing and keeps current data intact", async () => {
    const f = await fixture("settings-backup-invalid")
    await f.repositories.financialSettings.add(settings(750_000))
    const backup = await f.backup.exportBackup()
    const altered = JSON.parse(JSON.stringify(backup)) as {
      data: { financialSettings: FinancialSettings[] }
    }
    altered.data.financialSettings[0] = settings(1_500_000)

    await expect(f.backup.restoreBackup(altered)).rejects.toMatchObject({ code: "backup_invalid" })
    expect((await f.repositories.financialSettings.get("current"))?.salaryReferenceAmount).toBe(750_000)
    f.database.close()
  })

  it("rejects a correctly signed envelope whose declared revision is inconsistent", async () => {
    const f = await fixture("settings-backup-derived-revision")
    await f.repositories.financialSettings.add(settings(750_000))
    const backup = await f.backup.exportBackup()
    const tampered = {
      ...backup,
      dataRevision: backup.dataRevision + 1,
      integrity: { ...backup.integrity, payloadHash: "" },
    }
    const { integrity: _integrity, ...payload } = tampered
    tampered.integrity.payloadHash = await sha256(canonicalJson(payload))

    await expect(f.backup.validateBackup(tampered)).resolves.toMatchObject({
      status: "invalid",
      errors: ["La revisión declarada no coincide con los datos del respaldo."],
    })
    expect((await f.repositories.financialSettings.get("current"))?.salaryReferenceAmount).toBe(750_000)
    f.database.close()
  })

  it("replaces all data from a valid backup and returns the preventive backup", async () => {
    const source = await fixture("settings-backup-source")
    await source.repositories.financialSettings.add(settings(1_200_000))
    const targetBackup = await source.backup.exportBackup()

    const destination = await fixture("settings-backup-destination")
    await destination.repositories.financialSettings.add(settings(600_000))
    const result = await destination.backup.restoreBackup(targetBackup)

    expect(result.preventiveBackup.data.financialSettings[0]?.salaryReferenceAmount).toBe(600_000)
    expect((await destination.repositories.financialSettings.get("current"))?.salaryReferenceAmount).toBe(1_200_000)
    source.database.close()
    destination.database.close()
  })

  it("rolls back a replacement transaction when any imported record fails", async () => {
    const f = await fixture("settings-backup-atomic")
    await f.repositories.financialSettings.add(settings(800_000))
    const current = await f.repositories.administration.readSnapshot()
    const duplicate = { ...emptySnapshot(), financialSettings: [settings(1), settings(2)] }

    await expect(f.repositories.administration.replaceSnapshot(duplicate, current)).rejects.toBeDefined()
    expect((await f.repositories.financialSettings.get("current"))?.salaryReferenceAmount).toBe(800_000)
    f.database.close()
  })

  it("requires an external valid backup and exact ELIMINAR before clearing", async () => {
    const f = await fixture("settings-delete")
    await f.repositories.financialSettings.add(settings(500_000))
    const backup = await f.backup.exportBackup()

    await expect(f.backup.deleteAllData(backup, "Eliminar")).rejects.toMatchObject({ code: "confirmation_invalid" })
    expect(await f.repositories.financialSettings.count()).toBe(1)
    await expect(f.backup.deleteAllData(backup, "ELIMINAR")).resolves.toEqual({ deleted: true })
    expect(await f.repositories.financialSettings.count()).toBe(0)
    f.database.close()
  })

  it("persists the allowed salary preference with an audit revision", async () => {
    const f = await fixture("settings-preference")
    const useCases = new SettingsUseCases(f.repositories, {
      now: () => NOW,
      createId: () => "00000000-0000-4000-8000-000000000001" as ReturnType<typeof import("@/domain").asEntityId>,
    })

    const saved = await useCases.updateReferenceSalary(950_000)

    expect(saved.salaryReferenceAmount).toBe(950_000)
    expect(await f.repositories.auditEvents.count()).toBe(1)
    f.database.close()
  })
})

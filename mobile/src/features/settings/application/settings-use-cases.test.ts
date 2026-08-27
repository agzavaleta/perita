import { IDBFactory } from "fake-indexeddb"
import { describe, expect, it } from "vitest"

import {
  asClpAmount,
  asEntityId,
  asPeriodKey,
  asPositiveClpAmount,
  asRevision,
  asUtcTimestamp,
  type Account,
  type FinancialSettings,
  type MonthlySummary,
  type PeritaDataSnapshot,
  type Period,
  type PeriodSnapshot,
  type SavingsGoal,
} from "@/domain"
import { createRepositories, openPeritaDatabase } from "@/data"
import {
  BackupService,
  type PeritaBackup,
} from "@/features/settings/application/backup"
import { SettingsUseCases } from "@/features/settings/application/settings-use-cases"
import { canonicalJson, sha256 } from "@/lib/integrity"

const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")
const PERIOD_ID = asEntityId("91000000-0000-4000-8000-000000000001")
const ACCOUNT_ID = asEntityId("91000000-0000-4000-8000-000000000002")
const GOAL_ID = asEntityId("91000000-0000-4000-8000-000000000003")
const SNAPSHOT_ID = asEntityId("91000000-0000-4000-8000-000000000004")

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

function period(): Period {
  return {
    id: PERIOD_ID,
    periodKey: asPeriodKey("2026-08"),
    plannedSalaryAmount: asClpAmount(900_000),
    variableExpenseBudgetAmount: asClpAmount(250_000),
    openedAt: NOW,
    status: "open",
    closedAt: null,
    snapshotId: null,
    revision: asRevision(1),
  }
}

function account(): Account {
  return {
    id: ACCOUNT_ID,
    emoji: "🏦",
    name: "Principal",
    bank: null,
    openingBalance: asClpAmount(0),
    currentBalance: asClpAmount(0),
    status: "active",
    deletedAt: null,
    balanceAtDeletion: null,
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function goal(): SavingsGoal {
  return {
    id: GOAL_ID,
    emoji: "✈️",
    name: "Viaje",
    bank: null,
    targetAmount: asPositiveClpAmount(1_000_000),
    openingBalance: asClpAmount(0),
    currentBalance: asClpAmount(0),
    plannedMonthlyAmount: asClpAmount(50_000),
    lifecycleStatus: "active",
    progressStatus: "in_progress",
    closedAt: null,
    revision: asRevision(1),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

interface EditableBackup extends Record<string, unknown> {
  data: {
    periods: Record<string, unknown>[]
    accounts: Record<string, unknown>[]
    savingsGoals: Record<string, unknown>[]
    periodSnapshots: Record<string, unknown>[]
  } & Record<string, unknown>
  integrity: {
    payloadHash: string
  } & Record<string, unknown>
}

function editableBackup(backup: PeritaBackup): EditableBackup {
  return JSON.parse(JSON.stringify(backup)) as EditableBackup
}

function isEditableIntegrity(
  value: unknown,
): value is { payloadHash: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "payloadHash" in value &&
    typeof value.payloadHash === "string",
  )
}

async function resign(backup: EditableBackup) {
  const { integrity: _integrity, ...payload } = backup
  backup.integrity.payloadHash = await sha256(canonicalJson(payload))
  return backup
}

async function legacyBackup(backup: PeritaBackup) {
  const legacy = editableBackup(backup)
  for (const item of legacy.data.periods) {
    delete item.variableExpenseBudgetAmount
  }
  for (const item of legacy.data.accounts) delete item.emoji
  for (const item of legacy.data.savingsGoals) delete item.emoji
  return resign(legacy)
}

async function seedCurrentContracts(
  f: Awaited<ReturnType<typeof fixture>>,
) {
  await f.repositories.financialSettings.add(settings(900_000))
  await f.repositories.periods.add(period())
  await f.repositories.accounts.add(account())
  await f.repositories.savingsGoals.add(goal())
}

function zeroSummary(closedPeriod: Period): MonthlySummary {
  return {
    periodId: closedPeriod.id,
    periodKey: closedPeriod.periodKey,
    plannedSalaryAmount: closedPeriod.plannedSalaryAmount,
    receivedSalaryAmount: asClpAmount(0),
    additionalIncomeAmount: asClpAmount(0),
    totalIncomeAmount: asClpAmount(0),
    fixedExpensePlannedAmount: asClpAmount(0),
    fixedExpensePaidAmount: asClpAmount(0),
    fixedExpenseUnpaidAmount: asClpAmount(0),
    variableExpenseAmount: asClpAmount(0),
    debtPaymentAmount: asClpAmount(0),
    netSavingsAmount: asClpAmount(0),
    availableAmount: asClpAmount(0),
  }
}

async function legacyHistoricalRecords() {
  const closedPeriod: Period = {
    ...period(),
    plannedSalaryAmount: asClpAmount(0),
    variableExpenseBudgetAmount: asClpAmount(0),
    status: "closed",
    closedAt: NOW,
    snapshotId: SNAPSHOT_ID,
    revision: asRevision(2),
  }
  const payload = {
    id: SNAPSHOT_ID,
    periodId: PERIOD_ID,
    periodKey: closedPeriod.periodKey,
    schemaVersion: "1.1.0",
    snapshotKind: "canonical",
    closedAt: NOW,
    data: {
      periodPlan: { plannedSalaryAmount: asClpAmount(0) },
      operations: [],
      movements: [],
      fixedExpenses: [],
      periodOpenings: [],
      auditEvents: [],
      entitySnapshots: {
        accounts: [],
        savingsGoals: [],
        debts: [],
        categories: [],
      },
      openingBalances: {},
      closingBalances: {},
      totals: zeroSummary(closedPeriod),
      warnings: [],
    },
  } as const
  const snapshot = {
    ...payload,
    integrity: {
      algorithm: "SHA-256",
      payloadHash: await sha256(canonicalJson(payload)),
    },
  } as unknown as PeriodSnapshot
  return { closedPeriod, snapshot }
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
    await seedCurrentContracts(f)

    const backup = await f.backup.exportBackup()

    expect(backup.documentType).toBe("perita-backup")
    expect(backup.backupFormatVersion).toBe("1.0.0")
    expect(backup.schemaVersion).toBe("1.1.0")
    expect(backup.integrity.payloadHash).toMatch(/^[a-f0-9]{64}$/)
    expect(backup.data.periods[0]?.variableExpenseBudgetAmount).toBe(250_000)
    expect(backup.data.accounts[0]?.emoji).toBe("🏦")
    expect(backup.data.savingsGoals[0]?.emoji).toBe("✈️")
    expect(await f.backup.validateBackup(JSON.stringify(backup))).toMatchObject({ status: "valid" })
    f.database.close()
  })

  it("validates and restores a correctly signed pre-C1B backup with current defaults", async () => {
    const source = await fixture("settings-backup-legacy-source")
    await seedCurrentContracts(source)
    const legacy = await legacyBackup(await source.backup.exportBackup())

    const validation = await source.backup.validateBackup(legacy)
    expect(validation).toMatchObject({
      status: "valid",
      backup: {
        data: {
          periods: [{ variableExpenseBudgetAmount: 0 }],
          accounts: [{ emoji: "💳" }],
          savingsGoals: [{ emoji: "💰" }],
        },
      },
    })

    const destination = await fixture("settings-backup-legacy-destination")
    await destination.backup.restoreBackup(legacy)
    expect((await destination.repositories.periods.get(PERIOD_ID))?.variableExpenseBudgetAmount).toBe(0)
    expect((await destination.repositories.accounts.get(ACCOUNT_ID))?.emoji).toBe("💳")
    expect((await destination.repositories.savingsGoals.get(GOAL_ID))?.emoji).toBe("💰")
    source.database.close()
    destination.database.close()
  })

  it("rejects a pre-C1B backup altered after its original signature", async () => {
    const f = await fixture("settings-backup-legacy-altered")
    await seedCurrentContracts(f)
    const legacy = await legacyBackup(await f.backup.exportBackup())
    legacy.data.accounts[0]!.name = "Alterada después de firmar"

    await expect(f.backup.validateBackup(legacy)).resolves.toMatchObject({
      status: "invalid",
      errors: ["La firma de integridad no coincide."],
    })
    f.database.close()
  })

  it("accepts an intact pre-C1B historical snapshot without rewriting its hash", async () => {
    const f = await fixture("settings-backup-legacy-snapshot")
    const { closedPeriod, snapshot } = await legacyHistoricalRecords()
    await f.repositories.periods.add(closedPeriod)
    await f.repositories.periodSnapshots.add(snapshot)
    const backup = await f.backup.exportBackup()
    const originalHash = snapshot.integrity.payloadHash

    const validation = await f.backup.validateBackup(backup)

    expect(validation.status).toBe("valid")
    if (validation.status === "valid") {
      expect(validation.backup.data.periodSnapshots[0]?.integrity.payloadHash).toBe(originalHash)
      expect(
        Object.hasOwn(
          validation.backup.data.periodSnapshots[0]!.data.periodPlan,
          "variableExpenseBudgetAmount",
        ),
      ).toBe(false)
    }
    const destination = await fixture("settings-backup-legacy-snapshot-destination")
    await destination.backup.restoreBackup(backup)
    const restoredSnapshot = await destination.repositories.periodSnapshots.get(SNAPSHOT_ID)
    expect(restoredSnapshot?.integrity.payloadHash).toBe(originalHash)
    expect(
      Object.hasOwn(
        restoredSnapshot!.data.periodPlan,
        "variableExpenseBudgetAmount",
      ),
    ).toBe(false)
    f.database.close()
    destination.database.close()
  })

  it("rejects a historical snapshot with an invalid inner hash", async () => {
    const f = await fixture("settings-backup-invalid-snapshot")
    const { closedPeriod, snapshot } = await legacyHistoricalRecords()
    await f.repositories.periods.add(closedPeriod)
    await f.repositories.periodSnapshots.add(snapshot)
    const backup = editableBackup(await f.backup.exportBackup())
    const storedSnapshot = backup.data.periodSnapshots[0]
    if (!storedSnapshot || !isEditableIntegrity(storedSnapshot.integrity)) {
      throw new Error("fixture snapshot integrity missing")
    }
    storedSnapshot.integrity.payloadHash = "0".repeat(64)
    await resign(backup)

    await expect(f.backup.validateBackup(backup)).resolves.toMatchObject({
      status: "invalid",
      errors: ["La integridad de un mes histórico no coincide."],
    })
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

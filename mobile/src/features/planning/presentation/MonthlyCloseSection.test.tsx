import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { PeriodSnapshot } from "@/domain/periods"
import {
  asClpAmount,
  asEntityId,
  asPeriodKey,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import type { MonthlyCloseUseCasesPort } from "@/features/planning/application/monthly-close-use-cases"
import { MonthlyCloseSection } from "@/features/planning/presentation/MonthlyCloseSection"

const NOW = asUtcTimestamp("2026-08-31T22:00:00.000Z")
const PERIOD_ID = asEntityId("90000000-0000-4000-8000-000000000001")
const SNAPSHOT_ID = asEntityId("90000000-0000-4000-8000-000000000002")

const totals = {
  periodId: PERIOD_ID,
  periodKey: asPeriodKey("2026-08"),
  plannedSalaryAmount: asClpAmount(0),
  receivedSalaryAmount: asClpAmount(0),
  additionalIncomeAmount: asClpAmount(100_000),
  totalIncomeAmount: asClpAmount(100_000),
  fixedExpensePlannedAmount: asClpAmount(25_000),
  fixedExpensePaidAmount: asClpAmount(0),
  fixedExpenseUnpaidAmount: asClpAmount(25_000),
  variableExpenseAmount: asClpAmount(10_000),
  debtPaymentAmount: asClpAmount(0),
  netSavingsAmount: asClpAmount(20_000),
  availableAmount: asClpAmount(70_000),
}

const snapshot: PeriodSnapshot = {
  id: SNAPSHOT_ID,
  periodId: PERIOD_ID,
  periodKey: asPeriodKey("2026-08"),
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
    entitySnapshots: { accounts: [], savingsGoals: [], debts: [], categories: [] },
    openingBalances: {},
    closingBalances: {},
    totals,
    warnings: [],
  },
  integrity: { algorithm: "SHA-256", payloadHash: "a".repeat(64) },
}

function service(overrides: Partial<MonthlyCloseUseCasesPort> = {}): MonthlyCloseUseCasesPort {
  return {
    getClosePreview: vi.fn().mockResolvedValue({
      period: {
        id: PERIOD_ID,
        periodKey: asPeriodKey("2026-08"),
        plannedSalaryAmount: asClpAmount(0),
        openedAt: NOW,
        status: "open",
        closedAt: null,
        snapshotId: null,
        revision: asRevision(1),
      },
      summary: totals,
      pendingFixedExpenses: 1,
      nextPeriodKey: asPeriodKey("2026-09"),
      blockers: [],
    }),
    closeCurrentPeriod: vi.fn().mockResolvedValue({}),
    listMonthlyHistory: vi.fn().mockResolvedValue([
      { periodKey: snapshot.periodKey, closedAt: NOW, totals, snapshotId: SNAPSHOT_ID },
    ]),
    getMonthlyHistoryDetail: vi.fn().mockResolvedValue(snapshot),
    ...overrides,
  }
}

describe("MonthlyCloseSection", () => {
  it("requires confirmation and delegates the transactional close", async () => {
    const closeCurrentPeriod = vi.fn().mockResolvedValue({})
    render(<MonthlyCloseSection useCases={service({ closeCurrentPeriod })} />)

    fireEvent.click(await screen.findByRole("button", { name: /Cerrar Agosto de 2026/ }))
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cerrar y continuar" }))
    await waitFor(() => expect(closeCurrentPeriod).toHaveBeenCalledOnce())
  })

  it("opens historical detail from the stored snapshot", async () => {
    const getMonthlyHistoryDetail = vi.fn().mockResolvedValue(snapshot)
    render(
      <MonthlyCloseSection
        useCases={service({ getMonthlyHistoryDetail })}
      />,
    )
    fireEvent.click(
      await screen.findByRole("button", { name: "Ver historial de Agosto de 2026" }),
    )
    expect(await screen.findByText(/Archivo inmutable validado/)).toBeInTheDocument()
    expect(getMonthlyHistoryDetail).toHaveBeenCalledWith(asPeriodKey("2026-08"))
  })
})

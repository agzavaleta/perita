import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { HomeDashboard, HomeUseCasesPort } from "@/features/home/application/home-use-cases"
import {
  asCivilDate,
  asClpAmount,
  asEntityId,
  asPeriodKey,
  asPositiveClpAmount,
  asRevision,
  asUtcTimestamp,
} from "@/domain/primitives"
import { HomePage } from "@/features/home/presentation/HomePage"

const NOW = asUtcTimestamp("2026-08-21T12:00:00.000Z")
const PERIOD_ID = asEntityId("b0000000-0000-4000-8000-000000000001")
const ACCOUNT_ID = asEntityId("b0000000-0000-4000-8000-000000000002")
const GOAL_ID = asEntityId("b0000000-0000-4000-8000-000000000003")
const DEBT_ID = asEntityId("b0000000-0000-4000-8000-000000000004")

const dashboard: HomeDashboard = {
  period: {
    id: PERIOD_ID,
    periodKey: asPeriodKey("2026-08"),
    plannedSalaryAmount: asClpAmount(0),
    variableExpenseBudgetAmount: asClpAmount(0),
    openedAt: NOW,
    status: "open",
    closedAt: null,
    snapshotId: null,
    revision: asRevision(1),
  },
  summary: {
    periodId: PERIOD_ID,
    periodKey: asPeriodKey("2026-08"),
    plannedSalaryAmount: asClpAmount(0),
    receivedSalaryAmount: asClpAmount(0),
    additionalIncomeAmount: asClpAmount(100_000),
    totalIncomeAmount: asClpAmount(100_000),
    fixedExpensePlannedAmount: asClpAmount(0),
    fixedExpensePaidAmount: asClpAmount(0),
    fixedExpenseUnpaidAmount: asClpAmount(0),
    variableExpenseAmount: asClpAmount(20_000),
    debtPaymentAmount: asClpAmount(30_000),
    netSavingsAmount: asClpAmount(10_000),
    availableAmount: asClpAmount(40_000),
  },
  totalBalance: asClpAmount(150_000),
  totalAccountBalance: asClpAmount(140_000),
  totalSavingsBalance: asClpAmount(10_000),
  periodExpenseAmount: asClpAmount(50_000),
  accounts: [{
    id: ACCOUNT_ID,
    emoji: "💳",
    name: "Principal",
    bank: "Banco",
    openingBalance: asClpAmount(100_000),
    currentBalance: asClpAmount(140_000),
    status: "active",
    revision: asRevision(5),
    createdAt: NOW,
    updatedAt: NOW,
  }],
  relevantGoals: [{
    goal: {
      id: GOAL_ID,
      emoji: "💰",
      name: "Viaje",
      bank: null,
      targetAmount: asPositiveClpAmount(100_000),
      openingBalance: asClpAmount(0),
      currentBalance: asClpAmount(10_000),
      plannedMonthlyAmount: asClpAmount(10_000),
      lifecycleStatus: "active",
      progressStatus: "in_progress",
      closedAt: null,
      revision: asRevision(2),
      createdAt: NOW,
      updatedAt: NOW,
    },
    progressPercent: 10,
  }],
  relevantDebts: [{
    debt: {
      id: DEBT_ID,
      name: "Crédito",
      totalAmount: asPositiveClpAmount(100_000),
      openingOutstanding: asClpAmount(100_000),
      outstandingAmount: asClpAmount(70_000),
      dueDate: null,
      monthlyPaymentAmount: asPositiveClpAmount(25_000),
      paymentDay: 31,
      lifecycleStatus: "active",
      paymentStatus: "active",
      revision: asRevision(2),
      createdAt: NOW,
      updatedAt: NOW,
    },
    schedule: {
      remainingInstallments: 3,
      nextPaymentDate: asCivilDate("2026-08-31"),
      estimatedEndDate: asCivilDate("2026-10-31"),
    },
    progressPercent: 30,
  }],
  isEmpty: false,
}

function service(value: HomeDashboard): HomeUseCasesPort {
  return { getDashboard: vi.fn().mockResolvedValue(value) }
}

describe("HomePage", () => {
  it("renders the canonical totals and only the relevant financial context", async () => {
    render(<HomePage useCases={service(dashboard)} />)

    expect(await screen.findByText("Saldo total")).toBeInTheDocument()
    expect(screen.getByText("$150.000")).toBeInTheDocument()
    expect(screen.getByText("$100.000")).toBeInTheDocument()
    expect(screen.getByText("$50.000")).toBeInTheDocument()
    expect(screen.getByText("$40.000")).toBeInTheDocument()
    expect(screen.getByText("Principal")).toBeInTheDocument()
    expect(screen.getByText("Viaje")).toBeInTheDocument()
    expect(screen.getByRole("progressbar", { name: "Progreso de Viaje" })).toHaveAttribute("aria-valuenow", "10")
    expect(screen.getByText("Crédito")).toBeInTheDocument()
    expect(
      screen.getByRole("progressbar", { name: "Progreso de deuda Crédito" }),
    ).toHaveAttribute("aria-valuenow", "30")
    expect(screen.getByText("Agosto de 2026")).toBeInTheDocument()
  })

  it("shows the planned salary as pending until a salary receipt exists", async () => {
    render(<HomePage useCases={service({
      ...dashboard,
      summary: {
        ...dashboard.summary,
        plannedSalaryAmount: asClpAmount(900_000),
        receivedSalaryAmount: asClpAmount(0),
      },
    })} />)

    expect(await screen.findByText("Sueldo pendiente de recepción")).toBeInTheDocument()
    expect(screen.getByText(/todavía no existe un sueldo recibido vigente/i)).toBeInTheDocument()
  })

  it("keeps debt status and outstanding amount alongside derived progress", async () => {
    const debtItem = dashboard.relevantDebts[0]
    if (!debtItem) throw new Error("Missing debt fixture")
    render(<HomePage useCases={service({
      ...dashboard,
      relevantDebts: [{
        ...debtItem,
        debt: {
          ...debtItem.debt,
          dueDate: asCivilDate("2026-08-01"),
          paymentStatus: "overdue",
        },
      }],
    })} />)

    expect(await screen.findByText("$70.000")).toBeInTheDocument()
    expect(screen.getByText("Atrasada")).toBeInTheDocument()
    expect(
      screen.getByRole("progressbar", { name: "Progreso de deuda Crédito" }),
    ).toHaveAttribute("aria-valuenow", "30")
  })

  it("shows an actionable empty state", async () => {
    const onNavigate = vi.fn()
    render(
      <HomePage
        useCases={service({
          ...dashboard,
          summary: {
            ...dashboard.summary,
            additionalIncomeAmount: asClpAmount(0),
            totalIncomeAmount: asClpAmount(0),
            variableExpenseAmount: asClpAmount(0),
            debtPaymentAmount: asClpAmount(0),
            netSavingsAmount: asClpAmount(0),
            availableAmount: asClpAmount(0),
          },
          totalBalance: asClpAmount(0),
          totalAccountBalance: asClpAmount(0),
          totalSavingsBalance: asClpAmount(0),
          periodExpenseAmount: asClpAmount(0),
          accounts: [],
          relevantGoals: [],
          relevantDebts: [],
          isEmpty: true,
        })}
        onNavigate={onNavigate}
      />,
    )
    expect(await screen.findByText("Tu Inicio está listo")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Crear cuenta" }))
    expect(onNavigate).toHaveBeenCalledWith("accounts")
  })
})

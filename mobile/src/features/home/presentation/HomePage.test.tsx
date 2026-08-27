import { fireEvent, render, screen, within } from "@testing-library/react"
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
  netWorth: asClpAmount(80_000, { allowNegative: true }),
  totalAccountBalance: asClpAmount(140_000),
  totalSavingsBalance: asClpAmount(10_000),
  periodExpenseAmount: asClpAmount(50_000),
  expenseToIncomePercent: 50,
  savingsToIncomePercent: 10,
  accounts: [{
    id: ACCOUNT_ID,
    emoji: "💳",
    name: "Principal",
    bank: "Banco",
    openingBalance: asClpAmount(100_000),
    currentBalance: asClpAmount(140_000),
    status: "active",
    deletedAt: null,
    balanceAtDeletion: null,
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
  activeDebts: [{
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

    expect(await screen.findByText("Patrimonio neto")).toBeInTheDocument()
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
    expect(screen.getByText("Tu panorama financiero de un vistazo.")).toHaveClass("whitespace-nowrap")
    expect(screen.queryByRole("heading", { name: "Inicio" })).toBeNull()

    const netWorthCard = screen
      .getByText("Patrimonio neto")
      .closest<HTMLElement>('[data-slot="card"]')
    const savingsSummaryCard = screen
      .getByText("Total en metas")
      .closest<HTMLElement>('[data-slot="card"]')
    const availableCard = screen
      .getByText("Saldo disponible")
      .closest<HTMLElement>('[data-slot="card"]')
    if (!netWorthCard || !savingsSummaryCard || !availableCard) {
      throw new Error("Missing financial cards")
    }
    expect(within(netWorthCard).getByText("$80.000")).toBeInTheDocument()
    expect(within(savingsSummaryCard).getByText("$10.000")).toBeInTheDocument()
    expect(within(availableCard).getByText("Ingresos del período")).toBeInTheDocument()
    expect(within(availableCard).getByText("$100.000")).toBeInTheDocument()
    expect(within(availableCard).getByText("Gastos del período")).toBeInTheDocument()
    expect(within(availableCard).getByText("$50.000")).toBeInTheDocument()

    const monthCard = screen
      .getByText("Así va tu mes")
      .closest<HTMLElement>('[data-slot="card"]')
    const goalsCard = screen
      .getByText("Metas de ahorro")
      .closest<HTMLElement>('[data-slot="card"]')
    const accountsCard = screen
      .getByText("Cuentas")
      .closest<HTMLElement>('[data-slot="card"]')
    const debtsCard = screen
      .getByText("Deudas")
      .closest<HTMLElement>('[data-slot="card"]')
    if (!monthCard || !goalsCard || !accountsCard || !debtsCard) {
      throw new Error("Missing Home cards")
    }
    const titleClasses = [
      "text-money-label",
      "font-medium",
      "uppercase",
      "tracking-wide",
      "text-muted-foreground",
    ]
    for (const title of [
      "Patrimonio neto",
      "Total en metas",
      "Saldo disponible",
      "Así va tu mes",
      "Metas de ahorro",
      "Cuentas",
      "Deudas",
    ]) {
      expect(screen.getByText(title)).toHaveClass(...titleClasses)
      expect(screen.getByText(title)).not.toHaveClass("type-section-title", "text-base")
    }
    const netWorthAmount = within(netWorthCard).getByText("$80.000")
    const savingsAmount = within(savingsSummaryCard).getByText("$10.000")
    const availableAmount = within(availableCard).getByText("$40.000")
    expect(savingsAmount.className).toBe(netWorthAmount.className)
    expect(availableAmount.className).toBe(netWorthAmount.className)
    expect(netWorthCard.querySelector(".lucide-badge-dollar-sign")).toBeInTheDocument()
    const monthTitle = within(monthCard).getByText("Así va tu mes")
    expect(monthTitle.parentElement?.querySelector(".lucide-chart-no-axes-combined"))
      .toBeInTheDocument()
    expect(within(monthCard).getByText("$50.000 de $100.000")).toBeInTheDocument()
    expect(within(monthCard).getByText("50%")).toBeInTheDocument()
    expect(within(monthCard).getByText("Ahorro del período")).toBeInTheDocument()
    expect(within(monthCard).getByText("10% de los ingresos")).toBeInTheDocument()
    expect(within(goalsCard).getByText("10%")).toBeInTheDocument()
    expect(within(goalsCard).getByText("Ahorrado este período")).toBeInTheDocument()
    expect(within(goalsCard).getByText("Total ahorrado").nextElementSibling).toHaveClass("text-2xl")
    expect(netWorthCard.compareDocumentPosition(savingsSummaryCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(savingsSummaryCard.compareDocumentPosition(availableCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(availableCard.compareDocumentPosition(monthCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(monthCard.compareDocumentPosition(goalsCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(goalsCard.compareDocumentPosition(accountsCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(accountsCard.compareDocumentPosition(debtsCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Ver movimientos" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Planificar" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Ver todas" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Registrar ingreso" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Crear una meta o deuda" })).toBeNull()
    expect(screen.queryByText("Tu dinero")).toBeNull()
    expect(screen.queryByText("Deudas relevantes")).toBeNull()
  })

  it("renders every active goal supplied for Home", async () => {
    const first = dashboard.relevantGoals[0]
    if (!first) throw new Error("Missing goal fixture")
    const goals = [
      first,
      {
        goal: { ...first.goal, id: asEntityId("b0000000-0000-4000-8000-000000000005"), name: "Emergencias" },
        progressPercent: 20,
      },
      {
        goal: { ...first.goal, id: asEntityId("b0000000-0000-4000-8000-000000000006"), name: "Vivienda" },
        progressPercent: 30,
      },
    ]
    render(<HomePage useCases={service({ ...dashboard, relevantGoals: goals })} />)

    expect(await screen.findByText("Viaje")).toBeInTheDocument()
    expect(screen.getByText("Emergencias")).toBeInTheDocument()
    expect(screen.getByText("Vivienda")).toBeInTheDocument()
    expect(screen.getByText("Metas de ahorro")).toBeInTheDocument()
  })

  it("renders every active pending debt in the supplied order", async () => {
    const first = dashboard.activeDebts[0]
    if (!first) throw new Error("Missing debt fixture")
    const activeDebts = [
      {
        ...first,
        debt: {
          ...first.debt,
          name: "Atrasada menor",
          outstandingAmount: asClpAmount(25_000),
          paymentStatus: "overdue" as const,
        },
      },
      {
        ...first,
        debt: {
          ...first.debt,
          id: asEntityId("b0000000-0000-4000-8000-000000000007"),
          name: "Mayor saldo",
          outstandingAmount: asClpAmount(90_000),
        },
      },
      {
        ...first,
        debt: {
          ...first.debt,
          id: asEntityId("b0000000-0000-4000-8000-000000000008"),
          name: "Menor saldo",
          outstandingAmount: asClpAmount(40_000),
        },
      },
    ]
    render(<HomePage useCases={service({ ...dashboard, activeDebts })} />)

    const overdue = await screen.findByText("Atrasada menor")
    const larger = screen.getByText("Mayor saldo")
    const smaller = screen.getByText("Menor saldo")
    expect(overdue.compareDocumentPosition(larger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(larger.compareDocumentPosition(smaller) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("shows the real expense percentage while limiting the visual bar to 100%", async () => {
    render(<HomePage useCases={service({
      ...dashboard,
      periodExpenseAmount: asClpAmount(150_000),
      expenseToIncomePercent: 150,
    })} />)

    expect(await screen.findByText("150%")).toBeInTheDocument()
    const progress = screen.getByRole("progressbar", { name: "Gasto respecto de ingresos" })
    expect(progress).toHaveAttribute("aria-valuenow", "100")
    expect(progress.firstElementChild).toHaveStyle({ width: "100%" })
  })

  it("omits percentages when income is zero and keeps redundant actions hidden", async () => {
    render(<HomePage useCases={service({
      ...dashboard,
      summary: {
        ...dashboard.summary,
        additionalIncomeAmount: asClpAmount(0),
        totalIncomeAmount: asClpAmount(0),
        netSavingsAmount: asClpAmount(0),
      },
      expenseToIncomePercent: null,
      savingsToIncomePercent: null,
      relevantGoals: [],
      activeDebts: [],
    })} />)

    const monthCard = (await screen.findByText("Así va tu mes"))
      .closest<HTMLElement>('[data-slot="card"]')
    if (!monthCard) throw new Error("Missing month card")
    expect(within(monthCard).getByText("$50.000 de $0")).toBeInTheDocument()
    expect(within(monthCard).queryByText(/%/)).toBeNull()
    expect(screen.queryByRole("button", { name: "Registrar ingreso" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Crear una meta o deuda" })).toBeNull()
  })

  it("presents negative net savings as a withdrawal without a negative percentage", async () => {
    render(<HomePage useCases={service({
      ...dashboard,
      summary: {
        ...dashboard.summary,
        netSavingsAmount: asClpAmount(-25_000, { allowNegative: true }),
      },
      savingsToIncomePercent: null,
    })} />)

    const withdrawal = await screen.findByRole("region", { name: "Retirado de metas" })
    expect(within(withdrawal).getByText("$25.000")).toBeInTheDocument()
    expect(within(withdrawal).queryByText(/de los ingresos/)).toBeNull()
    expect(screen.queryByText("Ahorrado este período")).toBeNull()
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

    const alertTitle = await screen.findByText("Sueldo pendiente de recepción")
    expect(screen.getByText(/todavía no existe un sueldo recibido vigente/i)).toBeInTheDocument()
    const alert = alertTitle.closest<HTMLElement>('[role="alert"]')
    const availableCard = screen
      .getByText("Saldo disponible")
      .closest<HTMLElement>('[data-slot="card"]')
    const monthCard = screen
      .getByText("Así va tu mes")
      .closest<HTMLElement>('[data-slot="card"]')
    if (!alert || !availableCard || !monthCard) throw new Error("Missing ordered content")
    expect(availableCard.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(alert.compareDocumentPosition(monthCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("keeps debt status and outstanding amount alongside derived progress", async () => {
    const debtItem = dashboard.activeDebts[0]
    if (!debtItem) throw new Error("Missing debt fixture")
    render(<HomePage useCases={service({
      ...dashboard,
      activeDebts: [{
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
          netWorth: asClpAmount(0),
          totalAccountBalance: asClpAmount(0),
          totalSavingsBalance: asClpAmount(0),
          periodExpenseAmount: asClpAmount(0),
          expenseToIncomePercent: null,
          savingsToIncomePercent: null,
          accounts: [],
          relevantGoals: [],
          activeDebts: [],
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

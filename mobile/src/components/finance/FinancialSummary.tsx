import { MoneyAmount } from "@/components/finance/MoneyAmount"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

type SummaryItem = {
  label: string
  value: string
}

type FinancialSummaryProps = {
  title: string
  amountLabel: string
  amount: string
  items: SummaryItem[]
}

export function FinancialSummary({
  title,
  amountLabel,
  amount,
  items,
}: FinancialSummaryProps) {
  return (
    <Card className="rounded-surface ring-border">
      <CardHeader>
        <CardTitle className="type-section-title">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-section">
        <MoneyAmount label={amountLabel} value={amount} />
        {items.length > 0 ? (
          <dl className="grid grid-cols-2 gap-card border-t pt-card">
            {items.map(({ label, value }) => (
              <div key={label} className="space-y-1">
                <dt className="text-money-label text-muted-foreground">{label}</dt>
                <dd className="money-figure text-money-secondary font-medium">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </CardContent>
    </Card>
  )
}

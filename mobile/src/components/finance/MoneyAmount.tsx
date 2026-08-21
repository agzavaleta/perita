import { cn } from "@/lib/utils"

type MoneyAmountProps = {
  label: string
  value: string
  className?: string
}

export function MoneyAmount({ label, value, className }: MoneyAmountProps) {
  return (
    <div className={cn("space-y-1", className)}>
      <p className="text-money-label font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <p className="money-figure text-money-primary font-semibold text-foreground">
        {value}
      </p>
    </div>
  )
}

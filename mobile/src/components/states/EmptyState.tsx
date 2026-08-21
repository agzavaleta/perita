import { Inbox } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"

type EmptyStateProps = {
  title: string
  description: string
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <Card className="rounded-surface border-dashed ring-border">
      <CardContent className="flex flex-col items-center py-section text-center">
        <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <Inbox aria-hidden="true" className="size-5" />
        </div>
        <h2 className="type-section-title mt-card">{title}</h2>
        <p className="mt-1 max-w-64 text-sm leading-5 text-muted-foreground">
          {description}
        </p>
      </CardContent>
    </Card>
  )
}

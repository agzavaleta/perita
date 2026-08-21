import { Skeleton } from "@/components/ui/skeleton"

type LoadingStateProps = {
  label?: string
}

export function LoadingState({ label = "Cargando contenido" }: LoadingStateProps) {
  return (
    <div
      className="surface-raised space-y-card p-card"
      role="status"
      aria-label={label}
    >
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className="h-8 w-3/4" />
      <div className="grid grid-cols-2 gap-card border-t pt-card">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    </div>
  )
}

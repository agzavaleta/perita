import type { Category } from "@/domain/entities"
import { Badge } from "@/components/ui/badge"
import { categoryBadgeClassName } from "@/features/movements/presentation/category-badge-style"
import { cn } from "@/lib/utils"

export function CategoryBadge({
  category,
  className,
}: {
  readonly category: Pick<Category, "id" | "name">
  readonly className?: string
}) {
  return (
    <Badge
      variant="outline"
      className={cn(categoryBadgeClassName(category.id), className)}
    >
      {category.name}
    </Badge>
  )
}

import * as React from "react"

import { SheetContent } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

export interface FormSheetContentProps extends Omit<
  React.ComponentProps<typeof SheetContent>,
  "showCloseButton" | "side"
> {}

export function FormSheetContent({
  children,
  className,
  onOpenAutoFocus,
  ...props
}: FormSheetContentProps) {
  return (
    <SheetContent
      {...props}
      side="bottom"
      className={cn(
        "mx-auto max-h-[92dvh] w-full max-w-[430px] rounded-t-xl",
        className,
      )}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        onOpenAutoFocus?.(event)
      }}
    >
      {children}
    </SheetContent>
  )
}

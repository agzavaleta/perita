import type { ReactElement } from "react"
import { ArrowRightLeft, CircleMinus, CirclePlus } from "lucide-react"

import type { QuickAction } from "@/app/quick-actions"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetClose,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"

type QuickActionsSheetProps = {
  children: ReactElement
  onSelect: (action: QuickAction) => void
}

const quickActions = [
  { action: "income", label: "Registrar ingreso", icon: CirclePlus, enabled: true },
  { action: "expense", label: "Registrar gasto", icon: CircleMinus, enabled: true },
  { action: "transfer", label: "Mover dinero", icon: ArrowRightLeft, enabled: true },
] satisfies readonly {
  readonly action: QuickAction
  readonly label: string
  readonly icon: typeof ArrowRightLeft
  readonly enabled: boolean
}[]

export function QuickActionsSheet({ children, onSelect }: QuickActionsSheetProps) {
  return (
    <div className="flex h-16 items-start justify-center">
      <Sheet>
        <SheetTrigger asChild>{children}</SheetTrigger>
        <SheetContent
          side="bottom"
          className="mx-auto w-full max-w-[430px] rounded-t-2xl"
        >
          <SheetHeader className="pb-2">
            <SheetTitle>¿Qué quieres hacer?</SheetTitle>
            <SheetDescription>
              Elige una acción rápida para continuar.
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-2 px-4">
            {quickActions.map(({ action, label, icon: Icon, enabled }) =>
              enabled ? (
                <SheetClose asChild key={action}>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-12 justify-start gap-3"
                    onClick={() => onSelect(action)}
                  >
                    <Icon aria-hidden="true" className="size-5 text-brand" />
                    {label}
                  </Button>
                </SheetClose>
              ) : null,
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

import { CircleAlert } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

type ErrorMessageProps = {
  title: string
  description: string
}

export function ErrorMessage({ title, description }: ErrorMessageProps) {
  return (
    <Alert variant="destructive" className="rounded-surface p-card">
      <CircleAlert aria-hidden="true" className="size-5" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  )
}

import { Toaster as Sonner, type ToasterProps } from "sonner"

export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="light"
      position="top-center"
      richColors
      closeButton
      offset="calc(env(safe-area-inset-top) + 0.75rem)"
      toastOptions={{
        classNames: {
          toast: "max-w-[calc(100vw-2rem)]",
        },
      }}
      {...props}
    />
  )
}

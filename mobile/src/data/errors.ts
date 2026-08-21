export type PersistenceErrorCode =
  | "open_failed"
  | "request_failed"
  | "transaction_failed"
  | "constraint"
  | "quota"
  | "version"
  | "blocked"
  | "aborted"
  | "conflict"

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode
  override readonly cause: unknown

  constructor(code: PersistenceErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = "PersistenceError"
    this.code = code
    this.cause = cause
  }
}

function codeForDomException(
  error: DOMException,
  fallback: PersistenceErrorCode,
): PersistenceErrorCode {
  if (error.name === "ConstraintError") return "constraint"
  if (error.name === "QuotaExceededError") return "quota"
  if (error.name === "VersionError") return "version"
  if (error.name === "AbortError") return "aborted"
  return fallback
}

export function toPersistenceError(
  error: unknown,
  fallback: PersistenceErrorCode,
  message: string,
) {
  if (error instanceof PersistenceError) return error
  const code =
    error instanceof DOMException
      ? codeForDomException(error, fallback)
      : fallback
  return new PersistenceError(code, message, error)
}

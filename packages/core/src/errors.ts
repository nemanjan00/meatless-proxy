/** Base class for errors the harness knows how to handle. */
export class MpError extends Error {
  readonly code: string
  readonly details: Record<string, unknown> | undefined

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.details = details
  }
}

export class NotFoundError extends MpError {
  constructor(what: string, id?: string, details?: Record<string, unknown>) {
    super('not_found', id ? `${what} ${id} not found` : `${what} not found`, details)
  }
}

/** A compare-and-swap or uniqueness check failed. */
export class ConflictError extends MpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('conflict', message, details)
  }
}

export class ValidationError extends MpError {
  readonly issues: string[]
  constructor(message: string, issues: string[] = [], details?: Record<string, unknown>) {
    super('validation', issues.length ? `${message}: ${issues.join('; ')}` : message, details)
    this.issues = issues
  }
}

/** Not allowed: permissions, allow lists, protected branches, hard limits. */
export class DeniedError extends MpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('denied', message, details)
  }
}

/** A configured limit or budget was reached. */
export class LimitError extends MpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('limit', message, details)
  }
}

/** A dependency (database, provider, MCP server) is unavailable. Usually worth a retry. */
export class UnavailableError extends MpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('unavailable', message, details)
  }
}

export function isMpError(e: unknown, code?: string): e is MpError {
  return e instanceof MpError && (code === undefined || e.code === code)
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
